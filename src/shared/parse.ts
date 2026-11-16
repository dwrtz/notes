// Markdown note parser: frontmatter, headings, blocks, links, embeds, tags, tasks.
// Pure and shared by the Worker (indexing) and the client (editor, panes).
import { parse as parseYamlText } from "yaml";

export type LinkKind = "link" | "embed";
export interface ParsedLink {
  kind: LinkKind; format: "wiki" | "md";
  raw: string;          // exact source text, e.g. "![[Note#H|Shown]]"
  linkpath: string;     // "Note" ("" for same-note links)
  subpath: string;      // "" or "#H" / "#^id" / "#A#B"
  display: string | null; // text after "|" (wiki) or link text (md)
  start: number; end: number; // offsets in the whole text
  line: number;         // 0-based line
  frontmatterKey?: string; // set when the link is inside a property value
}
export interface Heading { level: number; text: string; line: number; start: number }
export interface Block { id: string; line: number; startLine: number; endLine: number; text: string }
export interface Tag { tag: string; line: number; start: number; end: number; inFrontmatter: boolean }
export interface Task { line: number; done: boolean; text: string }
export interface Frontmatter { present: boolean; valid: boolean; data: Record<string, unknown>; raw: string; endLine: number; bodyStart: number }
export interface ParsedNote {
  frontmatter: Frontmatter; headings: Heading[]; blocks: Block[]; links: ParsedLink[];
  tags: Tag[]; tasks: Task[]; aliases: string[]; lines: string[]; lineStarts: number[];
  masked: boolean[]; // per line: true when the whole line is code/frontmatter/comment
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
export const TAG_RE = /(^|[\s(,;])#([\p{L}\p{N}\p{Extended_Pictographic}_\-/]+)/gu;
const BLOCK_ID_END = /\s\^([A-Za-z0-9-]+)\s*$/;
const BLOCK_ID_LINE = /^\s*\^([A-Za-z0-9-]+)\s*$/;
const TASK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s?(.*)$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function isValidTag(t: string) { return /[^\d/]/u.test(t) && !/^\//.test(t); }
export function normTag(t: string) { return t.replace(/^#/, "").replace(/\/+$/, ""); }

/** Split "path#sub|display" (wikilink inner text). A "\|" (escaped in tables) also splits. */
export function splitWikiInner(inner: string) {
  const bar = inner.search(/\\?\|/);
  let target = inner, display: string | null = null;
  if (bar >= 0) {
    const len = inner[bar] === "\\" ? 2 : 1;
    target = inner.slice(0, bar); display = inner.slice(bar + len);
  }
  if (target.endsWith("\\")) target = target.slice(0, -1);
  const hash = target.indexOf("#");
  const linkpath = (hash >= 0 ? target.slice(0, hash) : target).trim();
  const subpath = hash >= 0 ? "#" + target.slice(hash + 1).trim() : "";
  return { linkpath, subpath, display };
}

export function parseFrontmatter(text: string): Frontmatter {
  const none: Frontmatter = { present: false, valid: true, data: {}, raw: "", endLine: -1, bodyStart: 0 };
  if (!text.startsWith("---")) return none;
  const lines = text.split("\n");
  if (lines[0].replace(/\r$/, "").trim() !== "---") return none;
  let end = -1;
  for (let i = 1; i < lines.length; i++) { const l = lines[i].replace(/\r$/, ""); if (l === "---" || l === "...") { end = i; break; } }
  if (end < 0) return none;
  const raw = lines.slice(1, end).join("\n");
  const bodyStart = lines.slice(0, end + 1).join("\n").length + (end + 1 < lines.length ? 1 : 0);
  try {
    const data = raw.trim() ? parseYamlText(raw) : {};
    if (data !== null && typeof data === "object" && !Array.isArray(data)) return { present: true, valid: true, data: data as Record<string, unknown>, raw, endLine: end, bodyStart };
    return { present: true, valid: false, data: {}, raw, endLine: end, bodyStart };
  } catch { return { present: true, valid: false, data: {}, raw, endLine: end, bodyStart }; }
}

/** A list property may be written as a YAML list or a single string. */
export function asList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter(x => x != null && x !== "").map(x => String(x));
  if (typeof v === "string") return v.trim() ? [v] : [];
  return [String(v)];
}

/** Replace inline code spans and %%comments%% on one line with spaces so offsets are kept. */
function maskInline(line: string, inComment: { on: boolean }): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (inComment.on) {
      const e = line.indexOf("%%", i);
      if (e < 0) { out += " ".repeat(line.length - i); i = line.length; break; }
      out += " ".repeat(e + 2 - i); i = e + 2; inComment.on = false; continue;
    }
    if (line.startsWith("%%", i)) { inComment.on = true; out += "  "; i += 2; continue; }
    if (line[i] === "`") {
      let n = 0; while (line[i + n] === "`") n++;
      const ticks = "`".repeat(n);
      const close = line.indexOf(ticks, i + n);
      if (close >= 0 && line[close + n] !== "`") { out += " ".repeat(close + n - i); i = close + n; continue; }
      out += line.slice(i, i + n); i += n; continue;
    }
    out += line[i]; i++;
  }
  return out;
}

export function parseNote(text: string): ParsedNote {
  const lines = text.split("\n");
  const lineStarts: number[] = []; { let p = 0; for (const l of lines) { lineStarts.push(p); p += l.length + 1; } }
  const fm = parseFrontmatter(text);
  const masked = lines.map(() => false);
  const headings: Heading[] = [], blocks: Block[] = [], links: ParsedLink[] = [], tags: Tag[] = [], tasks: Task[] = [];
  const firstBody = fm.present ? fm.endLine + 1 : 0;
  for (let i = 0; i < firstBody; i++) masked[i] = true;

  // Frontmatter links and tags.
  if (fm.present && fm.valid) {
    const fmStart = lineStarts[1] ?? 0;
    for (const [key, value] of Object.entries(fm.data)) {
      const vals = Array.isArray(value) ? value : [value];
      for (const v of vals) {
        if (typeof v !== "string") continue;
        const re = /\[\[([^\[\]]+?)\]\]/g; let m: RegExpExecArray | null;
        while ((m = re.exec(v))) {
          const { linkpath, subpath, display } = splitWikiInner(m[1]);
          const pos = text.indexOf(m[0], fmStart);
          const line = pos >= 0 ? lineOf(lineStarts, pos) : 0;
          links.push({ kind: "link", format: "wiki", raw: m[0], linkpath, subpath, display, start: pos, end: pos + m[0].length, line, frontmatterKey: key });
        }
      }
    }
    const tagKey = Object.keys(fm.data).find(k => k.toLowerCase() === "tags");
    if (tagKey) {
      const v = fm.data[tagKey];
      const list = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[,\s]+/) : [];
      for (const t of list) { const n = normTag(String(t).trim()); if (n && isValidTag(n)) tags.push({ tag: n, line: 0, start: -1, end: -1, inFrontmatter: true }); }
    }
  }
  const aliasKey = fm.valid ? Object.keys(fm.data).find(k => k.toLowerCase() === "aliases") : undefined;
  const aliases = aliasKey ? asList(fm.data[aliasKey]).map(s => s.trim()).filter(Boolean) : [];

  let fence: { ch: string; len: number } | null = null;
  const comment = { on: false };
  let paraStart = -1; // start line of the current block (paragraph / list item)
  for (let i = firstBody; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    const fm2 = FENCE.exec(raw);
    if (fence) {
      masked[i] = true;
      if (fm2 && fm2[1][0] === fence.ch && fm2[1].length >= fence.len && raw.trim() === fm2[1]) fence = null;
      continue;
    }
    if (fm2 && !comment.on) { fence = { ch: fm2[1][0], len: fm2[1].length }; masked[i] = true; paraStart = -1; continue; }
    const wasComment = comment.on;
    const line = maskInline(raw, comment);
    if (wasComment && comment.on && !line.trim()) { masked[i] = true; continue; }
    const base = lineStarts[i];

    // Headings
    const h = /^(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/.exec(line);
    if (h) headings.push({ level: h[1].length, text: h[2].replace(BLOCK_ID_END, "").trim(), line: i, start: base });

    // Blocks: paragraphs, list items (each item is a block), quotes, headings.
    const blank = !line.trim();
    const isList = /^\s*(?:[-*+]|\d+[.)])\s/.test(line);
    const idLine = BLOCK_ID_LINE.exec(line);
    if (idLine) {
      // An id on its own line names the block just above it (one blank line between is allowed).
      let e = i - 1;
      if (e >= firstBody && !lines[e].trim()) e--;
      let s = e; while (s - 1 >= firstBody && lines[s - 1].trim() && !masked[s - 1]) s--;
      if (e >= firstBody && lines[e].trim()) blocks.push({ id: idLine[1], line: i, startLine: s, endLine: e, text: lines.slice(s, e + 1).join("\n").trim() });
      paraStart = -1; continue;
    }
    if (blank) paraStart = -1;
    else if (h || isList || paraStart < 0) paraStart = i;
    const endId = !blank ? BLOCK_ID_END.exec(line) : null;
    if (endId) blocks.push({ id: endId[1], line: i, startLine: paraStart >= 0 ? paraStart : i, endLine: i, text: lines.slice(paraStart >= 0 ? paraStart : i, i + 1).join("\n").replace(BLOCK_ID_END, "").trim() });
    if (h) paraStart = -1;

    // Tasks
    const t = TASK_RE.exec(line);
    if (t) tasks.push({ line: i, done: t[1] !== " ", text: t[2] });

    // Wikilinks and embeds
    const wl = /(!?)\[\[([^\[\]\n]*?)\]\]/g; let m: RegExpExecArray | null;
    const taken: [number, number][] = [];
    while ((m = wl.exec(line))) {
      const inner = m[2]; if (!inner.trim()) continue;
      const { linkpath, subpath, display } = splitWikiInner(inner);
      links.push({ kind: m[1] ? "embed" : "link", format: "wiki", raw: raw.slice(m.index, m.index + m[0].length), linkpath, subpath, display, start: base + m.index, end: base + m.index + m[0].length, line: i });
      taken.push([m.index, m.index + m[0].length]);
    }
    // Markdown links to vault files (not URLs)
    const ml = /(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
    while ((m = ml.exec(line))) {
      if (taken.some(([a, b]) => m!.index < b && m!.index + m![0].length > a)) continue;
      let dest = m[3]; if (dest.startsWith("<")) dest = dest.slice(1, -1);
      if (URL_SCHEME.test(dest) || dest.startsWith("#") && dest.length === 1) continue;
      let decoded = dest; try { decoded = decodeURIComponent(dest); } catch { /* keep */ }
      const hash = decoded.indexOf("#");
      const linkpath = (hash >= 0 ? decoded.slice(0, hash) : decoded).trim();
      const subpath = hash >= 0 ? "#" + decoded.slice(hash + 1) : "";
      links.push({ kind: m[1] ? "embed" : "link", format: "md", raw: raw.slice(m.index, m.index + m[0].length), linkpath, subpath, display: m[2], start: base + m.index, end: base + m.index + m[0].length, line: i });
      taken.push([m.index, m.index + m[0].length]);
    }
    // Tags (not inside links, not a heading marker)
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(line))) {
      const s = m.index + m[1].length;
      if (taken.some(([a, b]) => s >= a && s < b)) continue;
      const tg = normTag(m[2]);
      if (!tg || !isValidTag(tg)) continue;
      tags.push({ tag: tg, line: i, start: base + s, end: base + s + 1 + m[2].length, inFrontmatter: false });
    }
  }
  return { frontmatter: fm, headings, blocks, links, tags, tasks, aliases, lines, lineStarts, masked };
}

export function lineOf(lineStarts: number[], pos: number) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
  return lo;
}

/** Find the line range a subpath ("#A#B" heading chain or "#^id" block) points at. */
export function resolveSubpath(p: ParsedNote, subpath: string): { startLine: number; endLine: number; kind: "heading" | "block" } | null {
  if (!subpath || subpath === "#") return null;
  const parts = subpath.slice(1).split("#").map(s => s.trim()).filter(Boolean);
  if (parts.length === 1 && parts[0].startsWith("^")) {
    const id = parts[0].slice(1).toLowerCase();
    const b = p.blocks.find(x => x.id.toLowerCase() === id);
    return b ? { startLine: b.startLine, endLine: b.endLine, kind: "block" } : null;
  }
  const same = (a: string, b: string) => cleanHeading(a) === cleanHeading(b);
  let from = 0, idx = -1, minLevel = 0;
  for (const part of parts) {
    idx = p.headings.findIndex((h, k) => k >= from && h.level > minLevel && same(h.text, part));
    if (idx < 0) return null;
    from = idx + 1; minLevel = p.headings[idx].level;
  }
  const h = p.headings[idx];
  const next = p.headings.find((x, k) => k > idx && x.level <= h.level);
  return { startLine: h.line, endLine: (next ? next.line : p.lines.length) - 1, kind: "heading" };
}
/** Headings are compared without case and ignoring characters that links cannot hold. */
export function cleanHeading(s: string) { return s.replace(/[#|^:\[\]%]/g, " ").replace(/\s+/g, " ").trim().toLowerCase(); }
