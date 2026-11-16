// Rewrite links in a note after files move, so every link keeps pointing at the same file.
import { parseNote, ParsedLink } from "./parse";
import { linktextFor, LinkFormat, mdlink, wikilink } from "./paths";

export interface RewriteContext {
  /** Where each link resolved before the change (null = unresolved). */
  before: (link: ParsedLink) => string | null;
  /** Where the same link text resolves after the change, evaluated from the note's new path. */
  after: (link: ParsedLink) => string | null;
  /** New path of a file that moved; the old path when it did not move. */
  moved: (oldPath: string) => string;
  sourcePathAfter: string;
  allPathsAfter: string[];
  format: LinkFormat;
}

/** Returns the new text, or null when nothing changed. Links that were unresolved stay as written. */
export function rewriteLinks(text: string, ctx: RewriteContext): string | null {
  const p = parseNote(text);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const l of p.links) {
    if (l.start < 0 || !l.linkpath) continue; // same-note links never change
    const was = ctx.before(l);
    if (!was) continue;
    const want = ctx.moved(was);
    const now = ctx.after(l);
    // Links to a file that moved are always rewritten; other links only when they would break.
    if (want === was && now && now.toLowerCase() === want.toLowerCase()) continue;
    const text2 = renderLink(l, want, ctx);
    if (text2 !== l.raw) edits.push({ start: l.start, end: l.end, text: text2 });
  }
  if (!edits.length) return null;
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** A rewritten link keeps the form it was written in: "./" or "../" stays relative,
 *  a path with folders stays a full vault path, and a bare name uses the vault's link format. */
export function renderLink(l: ParsedLink, targetPath: string, ctx: Pick<RewriteContext, "sourcePathAfter" | "allPathsAfter" | "format">) {
  const lp = l.linkpath.trim();
  const format: LinkFormat = /^\.\.?\//.test(lp) ? "relative" : lp.includes("/") ? "absolute" : ctx.format;
  const lt = linktextFor(targetPath, ctx.sourcePathAfter, ctx.allPathsAfter, format);
  if (l.format === "md") return mdlink(targetPath, lt, l.subpath, l.display ?? "", l.kind === "embed");
  return wikilink(lt, l.subpath, l.display, l.kind === "embed");
}
