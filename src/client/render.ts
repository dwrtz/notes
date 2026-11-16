// Reading view renderer: Markdown to HTML with wikilinks, embeds, tags, highlights, callouts and task boxes.
import MarkdownIt from "markdown-it";
import { parseNote, resolveSubpath, splitWikiInner, TAG_RE, isValidTag, normTag } from "../shared/parse";
import type { VaultStore, FileMeta } from "./store";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function linkLabel(linkpath: string, subpath: string, display: string | null) {
  if (display) return display;
  const parts = subpath ? subpath.slice(1).split("#").filter(Boolean).map(s => s.replace(/^\^/, "")) : [];
  return [linkpath, ...parts].filter(Boolean).join(" > ");
}

// Inline rule: [[link]] and ![[embed]]
md.inline.ruler.before("link", "wikilink", (state, silent) => {
  const src = state.src, pos = state.pos;
  const embed = src.charCodeAt(pos) === 0x21 && src.startsWith("[[", pos + 1);
  if (!embed && !src.startsWith("[[", pos)) return false;
  const start = pos + (embed ? 3 : 2);
  const end = src.indexOf("]]", start);
  if (end < 0) return false;
  const inner = src.slice(start, end);
  if (!inner.trim() || inner.includes("[[") || inner.includes("\n")) return false;
  if (!silent) { const t = state.push(embed ? "wikiembed" : "wikilink", "", 0); t.content = inner; }
  state.pos = end + 2; return true;
});
// ==highlight==
md.inline.ruler.before("emphasis", "mark", (state, silent) => {
  const src = state.src, pos = state.pos;
  if (!src.startsWith("==", pos)) return false;
  const end = src.indexOf("==", pos + 2);
  if (end <= pos + 2) return false;
  if (!silent) { const t = state.push("mark_html", "", 0); t.content = src.slice(pos + 2, end); }
  state.pos = end + 2; return true;
});
// #tags
md.inline.ruler.push("tag", (state, silent) => {
  const src = state.src, pos = state.pos;
  if (src[pos] !== "#") return false;
  if (pos > 0 && !/[\s(,;]/.test(src[pos - 1])) return false;
  TAG_RE.lastIndex = 0;
  const m = TAG_RE.exec(src.slice(pos)); if (!m || m.index !== 0 || m[1] !== "") return false;
  const tag = normTag(m[2]); if (!isValidTag(tag)) return false;
  if (!silent) { const t = state.push("hashtag", "", 0); t.content = tag; }
  state.pos = pos + 1 + m[2].length; return true;
});
// " ^block-id" at the end of a paragraph is hidden
md.core.ruler.push("block_ids", state => {
  for (const tok of state.tokens) if (tok.type === "inline" && tok.children) {
    const last = tok.children[tok.children.length - 1];
    if (last?.type === "text") last.content = last.content.replace(/\s\^[A-Za-z0-9-]+\s*$/, "");
    for (const c of tok.children) if (c.type === "text" && /^\^[A-Za-z0-9-]+$/.test(c.content.trim())) c.content = "";
  }
});

export interface RenderEnv { [k: string]: any; store: VaultStore; sourcePath: string; depth: number; seen: Set<number>; onNeed: () => void }

md.renderer.rules.wikilink = (tokens, i, _o, env: any) => {
  const { linkpath, subpath, display } = splitWikiInner(tokens[i].content);
  const target = env.store.resolve(linkpath, env.sourcePath);
  const href = (linkpath || "") + subpath;
  return `<a class="internal-link${target || !linkpath ? "" : " is-unresolved"}" data-href="${esc(href)}" href="#" title="${esc(target?.path || linkpath)}">${esc(linkLabel(linkpath, subpath, display))}</a>`;
};
md.renderer.rules.wikiembed = (tokens, i, _o, env: any) => renderEmbed(tokens[i].content, env);
md.renderer.rules.mark_html = (tokens, i) => `<mark>${esc(tokens[i].content)}</mark>`;
md.renderer.rules.hashtag = (tokens, i) => `<a class="tag" data-tag="${esc(tokens[i].content)}" href="#">#${esc(tokens[i].content)}</a>`;

// Markdown links to vault files become internal links; others open in a new tab.
const defaultLinkOpen = md.renderer.rules.link_open || ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, i, o, env: any, self) => {
  const href = String(tokens[i].attrGet("href") || "");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("#")) {
    let dec = href; try { dec = decodeURIComponent(href); } catch { /* keep */ }
    const h = dec.indexOf("#"); const lp = h >= 0 ? dec.slice(0, h) : dec;
    const target = env.store.resolve(lp, env.sourcePath);
    return `<a class="internal-link${target ? "" : " is-unresolved"}" data-href="${esc(dec)}" href="#">`;
  }
  tokens[i].attrSet("target", "_blank"); tokens[i].attrSet("rel", "noopener noreferrer"); tokens[i].attrJoin("class", "external-link");
  return defaultLinkOpen(tokens, i, o, env, self);
};
// Images with a vault path load from the vault; "![200](url)" sets the width.
md.renderer.rules.image = (tokens, i, _o, env: any) => {
  const t = tokens[i]; const src = String(t.attrGet("src") || ""); const alt = t.content;
  const size = /^(\d+)(?:x(\d+))?$/.exec(alt.trim());
  const dims = size ? ` width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ""}` : "";
  if (/^https?:/i.test(src)) return `<img src="${esc(src)}" alt="${esc(size ? "" : alt)}"${dims} loading="lazy" referrerpolicy="no-referrer">`;
  let dec = src; try { dec = decodeURIComponent(src); } catch { /* keep */ }
  const f = env.store.resolve(dec, env.sourcePath);
  if (!f) return `<span class="embed-missing">${esc(dec)}</span>`;
  return `<img src="${esc(env.store.rawUrl(f))}" alt="${esc(size ? f.path : alt)}"${dims}>`;
};
// Block elements remember their source line, so views can scroll to a line.
md.core.ruler.push("source_lines", state => {
  for (const t of state.tokens) if (t.map && t.nesting === 1) t.attrSet("data-line", String(t.map[0]));
});
// Task list items get real checkboxes that toggle the source line.
md.core.ruler.push("tasks", state => {
  const toks = state.tokens;
  for (let i = 2; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== "inline" || toks[i - 1].type !== "paragraph_open" || toks[i - 2].type !== "list_item_open") continue;
    const m = /^\[([ xX\-/>])\]\s?/.exec(t.content); if (!m || !t.children?.length) continue;
    const first = t.children[0]; if (first.type !== "text" || !first.content.startsWith(m[0].trimEnd().slice(0, 3))) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token("html_inline", "", 0);
    const line = toks[i - 2].map ? toks[i - 2].map![0] : -1;
    box.content = `<input type="checkbox" class="task-box" data-line="${line}"${m[1] !== " " ? " checked" : ""} aria-label="Done">`;
    t.children.unshift(box);
    toks[i - 2].attrJoin("class", "task-item" + (m[1] !== " " ? " is-done" : ""));
  }
});
// Callouts: a quote whose first line is "[!type] Title".
md.core.ruler.push("callouts", state => {
  const toks = state.tokens;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].type !== "blockquote_open") continue;
    const inline = toks[i + 2]; if (!inline || inline.type !== "inline") continue;
    const m = /^\[!(\w+)\]([+-]?)\s*([^\n]*)/.exec(inline.content); if (!m) continue;
    toks[i].attrJoin("class", `callout callout-${m[1].toLowerCase()}`);
    const title = m[3] || m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    const rest = inline.content.slice(m[0].length).replace(/^\n/, "");
    const head = new state.Token("html_block", "", 0); head.content = `<div class="callout-title">${esc(title)}</div>`;
    toks.splice(i + 1, 0, head);
    inline.content = rest;
    inline.children = [];
    state.md.inline.parse(rest, state.md, state.env, inline.children);
  }
});

function renderEmbed(inner: string, env: RenderEnv): string {
  const { linkpath, subpath, display } = splitWikiInner(inner);
  const f = env.store.resolve(linkpath, env.sourcePath);
  if (!f) return `<span class="embed-missing">"${esc(linkpath)}" could not be found.</span>`;
  return embedHtml(f, subpath, display, env);
}
export function embedHtml(f: FileMeta, subpath: string, display: string | null, env: RenderEnv): string {
  const url = env.store.rawUrl(f);
  if (f.kind === "attachment") {
    const m = /^(\d+)(?:x(\d+))?$/.exec((display || "").trim());
    const dims = m ? ` width="${m[1]}"${m[2] ? ` height="${m[2]}"` : ""}` : "";
    if (f.mime?.startsWith("image/")) return `<img class="embed-image" src="${esc(url)}" alt="${esc(f.path)}"${dims}>`;
    if (f.mime?.startsWith("audio/")) return `<audio class="embed-audio" controls src="${esc(url)}"></audio>`;
    if (f.mime?.startsWith("video/")) return `<video class="embed-video" controls src="${esc(url)}"${dims}></video>`;
    if (f.mime === "application/pdf") {
      const page = /page=(\d+)/.exec(subpath)?.[1]; const h = /height=(\d+)/.exec(subpath)?.[1];
      return `<iframe class="embed-pdf" title="${esc(f.path)}" src="${esc(url)}${page ? "#page=" + page : ""}" style="height:${h || 600}px"></iframe>`;
    }
    return `<a class="internal-link" data-href="${esc(f.path)}" href="#">${esc(f.path)}</a>`;
  }
  if (f.kind !== "note") return "";
  const title = `<div class="embed-title"><a class="internal-link" data-href="${esc(f.path + subpath)}" href="#">${esc(linkLabel(f.path.replace(/\.md$/i, "").split("/").pop()!, subpath, null))}</a></div>`;
  if (env.depth >= 3 || env.seen.has(f.id)) return `<div class="markdown-embed is-cut">${title}<div class="embed-note">Embedded too deeply.</div></div>`;
  const text = env.store.cached(f.id);
  if (text === undefined) { env.store.note(f.id).then(env.onNeed, () => {}); return `<div class="markdown-embed">${title}<div class="embed-loading">Loading…</div></div>`; }
  let part = stripFrontmatter(text);
  if (subpath) {
    const p = parseNote(text); const r = resolveSubpath(p, subpath);
    if (!r) return `<div class="markdown-embed">${title}<div class="embed-missing">"${esc(subpath.slice(1))}" is not in this note.</div></div>`;
    part = p.lines.slice(r.startLine, r.endLine + 1).join("\n");
  }
  const seen = new Set(env.seen); seen.add(f.id);
  return `<div class="markdown-embed" data-file="${f.id}">${title}<div class="markdown-embed-content">${md.render(part, { ...env, sourcePath: f.path, depth: env.depth + 1, seen } as any)}</div></div>`;
}
export function stripFrontmatter(text: string) { const p = parseNote(text); return p.frontmatter.present ? text.slice(p.frontmatter.bodyStart) : text; }
/** Render a note's body (frontmatter and %%comments%% removed). Source lines stay aligned for task boxes. */
export function renderNote(text: string, env: RenderEnv) {
  const p = parseNote(text);
  const lines = text.split("\n");
  if (p.frontmatter.present) for (let i = 0; i <= p.frontmatter.endLine; i++) lines[i] = "";
  const clean = lines.join("\n").replace(/%%[\s\S]*?%%/g, m => m.replace(/[^\n]/g, ""));
  return md.render(clean, env as any);
}
export function renderMarkdown(text: string, env: RenderEnv) { return md.render(text, env as any); }
