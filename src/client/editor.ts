// The note editor: CodeMirror 6 with Markdown, live preview, link and tag suggestions, attachments.
import { EditorState, Compartment, StateField, Range, EditorSelection, Extension, Transaction } from "@codemirror/state";
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, WidgetType, keymap, drawSelection, placeholder as cmPlaceholder } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree, syntaxHighlighting, HighlightStyle, indentOnInput } from "@codemirror/language";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { search, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { splitWikiInner, parseNote, TAG_RE, isValidTag, normTag, parseFrontmatter } from "../shared/parse";
import { fuzzyScore } from "../shared/fuzzy";
import { displayName, wikilink, mdlink } from "../shared/paths";
import type { VaultStore, FileMeta } from "./store";
import { linkLabel, embedHtml } from "./render";

export interface EditorEnv {
  store: VaultStore;
  path: () => string;
  openLink: (href: string, newTab: boolean) => void;
  openTag: (tag: string) => void;
  upload: (files: File[]) => Promise<string[]>;
  tags: () => string[];
}
export type Mode = "live" | "source";

const hl = HighlightStyle.define([
  { tag: t.heading1, class: "cm-h1" }, { tag: t.heading2, class: "cm-h2" }, { tag: t.heading3, class: "cm-h3" },
  { tag: t.heading4, class: "cm-h4" }, { tag: t.heading5, class: "cm-h5" }, { tag: t.heading6, class: "cm-h6" },
  { tag: t.strong, fontWeight: "700" }, { tag: t.emphasis, fontStyle: "italic" }, { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, class: "cm-inline-code" }, { tag: t.link, class: "cm-md-linktext" }, { tag: t.url, class: "cm-url" },
  { tag: t.processingInstruction, class: "cm-formatting" }, { tag: t.meta, class: "cm-formatting" }, { tag: t.quote, class: "cm-quote-text" },
]);

// ---------- Widgets ----------
class LinkWidget extends WidgetType {
  constructor(readonly href: string, readonly label: string, readonly unresolved: boolean, readonly title: string) { super(); }
  eq(o: LinkWidget) { return o.href === this.href && o.label === this.label && o.unresolved === this.unresolved; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-wikilink" + (this.unresolved ? " is-unresolved" : ""); s.dataset.href = this.href; s.textContent = this.label; s.title = this.title; return s; }
  ignoreEvent() { return false; }
}
class EmbedWidget extends WidgetType {
  constructor(readonly inner: string, readonly env: EditorEnv, readonly stamp: string) { super(); }
  eq(o: EmbedWidget) { return o.inner === this.inner && o.stamp === this.stamp; }
  toDOM(view: EditorView) {
    const el = document.createElement("div"); el.className = "cm-embed";
    const { linkpath, subpath, display } = splitWikiInner(this.inner);
    const f = this.env.store.resolve(linkpath, this.env.path());
    if (!f) { el.innerHTML = ""; el.className = "cm-embed embed-missing"; el.textContent = `"${linkpath}" could not be found.`; return el; }
    el.innerHTML = embedHtml(f, subpath, display, { store: this.env.store, sourcePath: this.env.path(), depth: 0, seen: new Set(), onNeed: () => view.dispatch({ effects: [] , annotations: Transaction.userEvent.of("embed-loaded") }) });
    el.addEventListener("load", () => view.requestMeasure(), true);
    return el;
  }
  ignoreEvent(e: Event) { return e.type !== "mousedown" || !(e.target as HTMLElement).closest(".internal-link"); }
}
class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  eq(o: CheckboxWidget) { return o.checked === this.checked; }
  toDOM() { const i = document.createElement("input"); i.type = "checkbox"; i.className = "cm-task-box"; i.checked = this.checked; i.setAttribute("aria-label", "Done"); return i; }
  ignoreEvent() { return false; }
}
class HrWidget extends WidgetType { toDOM() { const d = document.createElement("hr"); d.className = "cm-hr"; return d; } eq() { return true; } }
class BulletWidget extends WidgetType { toDOM() { const s = document.createElement("span"); s.className = "cm-bullet"; s.textContent = "•"; return s; } eq() { return true; } }

const hide = Decoration.replace({});

function touches(sel: EditorSelection, from: number, to: number) { return sel.ranges.some(r => r.from <= to && r.to >= from); }

/** Frontmatter is hidden in live preview (the properties panel shows it) from the moment the note opens.
 *  A StateField hides the whole block; a transaction filter keeps an empty cursor out of it. */
function fmEnd(s: EditorState): number {
  const text = s.doc.sliceString(0, Math.min(s.doc.length, 50000));
  const fm = parseFrontmatter(text);
  return fm.present ? Math.min(fm.bodyStart, s.doc.length) : 0;
}
/** Where the cursor goes when the note opens or would land inside the hidden block. */
export function bodyStart(s: EditorState): number { return fmEnd(s); }
function frontmatterField(showSource: () => boolean) {
  const field = StateField.define<DecorationSet>({
    create: s => fmDeco(s, showSource()),
    update: (v, tr) => (tr.docChanged || tr.reconfigured || tr.isUserEvent("embed-loaded") ? fmDeco(tr.state, showSource()) : v),
    provide: f => EditorView.decorations.from(f),
  });
  const guard = EditorState.transactionFilter.of(tr => {
    if (showSource() || (!tr.selection && !tr.docChanged)) return tr;
    const st = tr.state; const end = fmEnd(st); if (end <= 0) return tr;
    const sel = st.selection.main;
    // A block that is all frontmatter with no newline after it: leave the cursor where it is.
    if (end >= st.doc.length && st.doc.sliceString(end - 1, end) !== "\n") return tr;
    if (sel.empty && sel.head < end) return [tr, { selection: { anchor: end }, sequential: true }];
    return tr;
  });
  return [field, guard];
}
function fmDeco(s: EditorState, showSource: boolean): DecorationSet {
  if (showSource) return Decoration.none;
  const end = fmEnd(s);
  if (end <= 0) return Decoration.none;
  return Decoration.set([Decoration.replace({ block: true }).range(0, end > 0 && s.doc.sliceString(end - 1, end) === "\n" ? end - 1 : end)]);
}

function livePreview(env: EditorEnv) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = this.build(v); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged || u.selectionSet || u.transactions.some(tr => tr.isUserEvent("embed-loaded"))) this.decorations = this.build(u.view); }
    build(view: EditorView): DecorationSet {
      const out: Range<Decoration>[] = [];
      const st = view.state, sel = st.selection, doc = st.doc;
      const fm = parseFrontmatter(doc.sliceString(0, Math.min(doc.length, 50000)));
      const fmEnd = fm.present ? fm.bodyStart : 0;
      const stamp = String(env.store.seq);
      for (const { from, to } of view.visibleRanges) {
        const taken: [number, number][] = [];
        const code: [number, number][] = [];
        syntaxTree(st).iterate({ from, to, enter: n => { if (n.name === "FencedCode" || n.name === "CodeBlock" || n.name === "InlineCode" || n.name === "Comment") code.push([n.from, n.to]); } });
        const inCode = (a: number, b: number) => code.some(([x, y]) => a < y && b > x);
        // Regex pass, line by line: wikilinks, embeds, tags, highlights, block ids, comments.
        for (let pos = from; pos <= to;) {
          const line = doc.lineAt(pos); pos = line.to + 1;
          if (line.from < fmEnd) continue;
          const text = line.text;
          const wl = /(!?)\[\[([^\[\]\n]+?)\]\]/g; let m: RegExpExecArray | null;
          while ((m = wl.exec(text))) {
            const a = line.from + m.index, b = a + m[0].length;
            if (inCode(a, b)) continue;
            taken.push([a, b]);
            if (touches(sel, a, b)) { out.push(Decoration.mark({ class: m[1] ? "cm-embed-src" : "cm-wikilink-src" }).range(a, b)); continue; }
            const { linkpath, subpath, display } = splitWikiInner(m[2]);
            const target = env.store.resolve(linkpath, env.path());
            if (m[1]) out.push(Decoration.replace({ widget: new EmbedWidget(m[2], env, stamp) }).range(a, b));
            else out.push(Decoration.replace({ widget: new LinkWidget(linkpath + subpath, linkLabel(linkpath, subpath, display), !target && !!linkpath, target?.path || linkpath) }).range(a, b));
          }
          TAG_RE.lastIndex = 0;
          while ((m = TAG_RE.exec(text))) {
            const a = line.from + m.index + m[1].length, b = a + 1 + m[2].length;
            if (inCode(a, b) || taken.some(([x, y]) => a < y && b > x) || /^#{1,6}\s/.test(text.slice(m.index + m[1].length))) continue;
            const tg = normTag(m[2]); if (!isValidTag(tg)) continue;
            out.push(Decoration.mark({ class: "cm-tag", attributes: { "data-tag": tg } }).range(a, b));
          }
          const hlre = /==([^=\n]+)==/g;
          while ((m = hlre.exec(text))) {
            const a = line.from + m.index, b = a + m[0].length; if (inCode(a, b)) continue;
            out.push(Decoration.mark({ class: "cm-highlight" }).range(a + 2, b - 2));
            if (!touches(sel, a, b)) { out.push(hide.range(a, a + 2)); out.push(hide.range(b - 2, b)); }
          }
          const bid = /\s(\^[A-Za-z0-9-]+)\s*$/.exec(text);
          if (bid) { const a = line.from + bid.index + 1; out.push((touches(sel, line.from, line.to) ? Decoration.mark({ class: "cm-block-id" }) : hide).range(a, a + bid[1].length)); }
          const cm = /%%[^\n]*?%%/g;
          while ((m = cm.exec(text))) { const a = line.from + m.index; out.push(Decoration.mark({ class: "cm-comment" }).range(a, a + m[0].length)); }
        }
        // Syntax-tree pass: hide Markdown marks away from the cursor.
        syntaxTree(st).iterate({ from, to, enter: n => {
          if (n.from < fmEnd) return;
          if (taken.some(([x, y]) => n.from < y && n.to > x)) return;
          const name = n.name;
          if (/^ATXHeading\d/.test(name)) {
            const lvl = name.slice(-1); const line = doc.lineAt(n.from);
            out.push(Decoration.line({ class: `cm-heading-line cm-heading-${lvl}` }).range(line.from));
            const mark = n.node.getChild("HeaderMark");
            if (mark && !touches(sel, line.from, line.to)) out.push(hide.range(mark.from, Math.min(mark.to + 1, line.to)));
            return;
          }
          if (name === "Emphasis" || name === "StrongEmphasis" || name === "Strikethrough" || name === "InlineCode") {
            if (touches(sel, n.from, n.to)) return;
            const markName = name === "Strikethrough" ? "StrikethroughMark" : name === "InlineCode" ? "CodeMark" : "EmphasisMark";
            for (const c of n.node.getChildren(markName)) out.push(hide.range(c.from, c.to));
            return;
          }
          if (name === "Link") {
            const marks = n.node.getChildren("LinkMark"); const url = n.node.getChild("URL");
            if (!url || marks.length < 2) return;
            const label = doc.sliceString(marks[0].to, marks[1].from);
            const href = doc.sliceString(url.from, url.to);
            if (touches(sel, n.from, n.to)) return false;
            const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
            const isImage = doc.sliceString(n.from - 1, n.from) === "!";
            if (isImage) return false;
            let dec = href; try { dec = decodeURIComponent(href); } catch { /* keep */ }
            const unresolved = !external && !env.store.resolve(dec.split("#")[0], env.path());
            out.push(Decoration.replace({ widget: new LinkWidget(external ? href : dec, label || href, unresolved, href) }).range(n.from, n.to));
            return false;
          }
          if (name === "Image") {
            if (touches(sel, n.from, n.to)) return false;
            const url = n.node.getChild("URL"); if (!url) return false;
            let dec = doc.sliceString(url.from, url.to); try { dec = decodeURIComponent(dec); } catch { /* keep */ }
            if (/^https?:/i.test(dec)) return false;
            out.push(Decoration.replace({ widget: new EmbedWidget(dec, env, stamp) }).range(n.from, n.to));
            return false;
          }
          if (name === "TaskMarker") {
            const checked = /\[[^ ]\]/.test(doc.sliceString(n.from, n.to));
            out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(n.from, n.to));
            if (checked) { const line = doc.lineAt(n.from); out.push(Decoration.line({ class: "cm-task-done" }).range(line.from)); }
            return;
          }
          if (name === "ListMark") {
            const txt = doc.sliceString(n.from, n.to); const line = doc.lineAt(n.from);
            const isTask = /^\s*[-*+]\s+\[.\]/.test(line.text);
            if (/^[-*+]$/.test(txt) && !isTask && !touches(sel, n.from, n.to)) out.push(Decoration.replace({ widget: new BulletWidget() }).range(n.from, n.to));
            if (isTask && !touches(sel, n.from, n.to + 1)) out.push(hide.range(n.from, n.to + 1));
            return;
          }
          if (name === "HorizontalRule") { const line = doc.lineAt(n.from); if (!touches(sel, line.from, line.to)) out.push(Decoration.replace({ widget: new HrWidget() }).range(n.from, n.to)); return; }
          if (name === "Blockquote") {
            for (let p = n.from; p <= n.to;) { const line = doc.lineAt(p); out.push(Decoration.line({ class: "cm-quote-line" + (/^\s*>\s*\[!\w+\]/.test(line.text) ? " cm-callout-head" : "") }).range(line.from)); p = line.to + 1; }
            return;
          }
          if (name === "QuoteMark") { const line = doc.lineAt(n.from); if (!touches(sel, line.from, line.to)) out.push(hide.range(n.from, Math.min(n.to + 1, line.to))); return; }
          if (name === "FencedCode") {
            for (let p = n.from; p <= n.to;) { const line = doc.lineAt(p); out.push(Decoration.line({ class: "cm-codeblock" }).range(line.from)); p = line.to + 1; }
            return false;
          }
        } });
      }
      return Decoration.set(out, true);
    }
  }, { decorations: v => v.decorations });
}

// ---------- Suggestions ----------
function linkSource(env: EditorEnv) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const m = /(!?)\[\[([^\[\]|]*)$/.exec(before);
    if (!m) return null;
    const typed = m[2]; const start = ctx.pos - typed.length;
    const after = line.text.slice(ctx.pos - line.from);
    const closeLen = after.startsWith("]]") ? 2 : 0;
    const src = env.path();
    // [[## heading anywhere in the vault
    if (typed.startsWith("##")) {
      const q = typed.slice(2).trim();
      const rows = await fetch(`${env.store.base()}/headings?q=${encodeURIComponent(q)}`).then(r => r.json()).catch(() => []);
      return { from: start, to: ctx.pos + closeLen, filter: false, options: rows.map((h: any) => {
        const f = env.store.file(h.id)!; const lt = f ? env.store.linktext(f, src) : h.path;
        return { label: h.text, detail: displayName(h.path), apply: `${lt}#${h.text}]]`, type: "heading" };
      }) };
    }
    const hash = typed.indexOf("#");
    if (hash >= 0) {
      // [[Note#heading or [[Note#^block
      const lp = typed.slice(0, hash); const sub = typed.slice(hash + 1);
      const target = lp ? env.store.resolve(lp, src) : env.store.byPathGet(src);
      if (!target || target.kind !== "note") return null;
      const text = target.path === src ? ctx.state.doc.toString() : await env.store.note(target.id);
      const p = parseNote(text);
      const from = start + hash + 1;
      if (sub.startsWith("^")) {
        const q = sub.slice(1).toLowerCase();
        const blocks: Completion[] = [];
        const seen = new Set<number>();
        for (const b of p.blocks) { seen.add(b.endLine); blocks.push({ label: "^" + b.id, detail: b.text.slice(0, 60), apply: `^${b.id}]]` }); }
        // Paragraphs without an id get one when chosen.
        let paraStart = -1;
        p.lines.forEach((l, i) => {
          const blank = !l.trim() || p.masked[i];
          if (!blank && paraStart < 0) paraStart = i;
          const next = p.lines[i + 1];
          const ends = !blank && (next === undefined || !next.trim() || /^\s*([-*+]|\d+[.)])\s/.test(next) || /^#{1,6}\s/.test(l));
          if (ends && !seen.has(i)) {
            const txt = p.lines.slice(paraStart, i + 1).join(" ").trim();
            const lineNo = i;
            blocks.push({ label: txt.slice(0, 80), detail: "", apply: (view, _c, f, t2) => {
              const id = Math.random().toString(36).slice(2, 8);
              const ins = `^${id}]]`;
              view.dispatch({ changes: { from: f, to: t2, insert: ins }, selection: { anchor: f + ins.length } });
              if (target.path === src) {
                const l2 = view.state.doc.line(lineNo + 1); view.dispatch({ changes: { from: l2.to, insert: ` ^${id}` } });
              } else {
                const lines = text.split("\n"); lines[lineNo] = lines[lineNo] + ` ^${id}`; env.store.setText(target.id, lines.join("\n"));
              }
            } });
          }
          if (blank || ends) paraStart = -1;
        });
        return { from: from, to: ctx.pos + closeLen, filter: false, options: blocks.filter(b => !q || (b.label + " " + (b.detail || "")).toLowerCase().includes(q)).slice(0, 50) };
      }
      const q = sub.toLowerCase();
      return { from, to: ctx.pos + closeLen, filter: false, options: p.headings.filter(h => !q || h.text.toLowerCase().includes(q)).map(h => ({ label: h.text, detail: "H" + h.level, apply: h.text + "]]", type: "heading" })) };
    }
    const q = typed.trim();
    const opts: { c: Completion; s: number }[] = [];
    for (const f of env.store.list()) {
      if (f.kind === "folder") continue;
      const name = displayName(f.path);
      const s = fuzzyScore(q, name) ?? (fuzzyScore(q, f.path) != null ? fuzzyScore(q, f.path)! + 20 : null);
      if (s != null) opts.push({ s, c: { label: name, detail: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "", type: f.kind === "note" ? "note" : "file", apply: env.store.linktext(f, src) + "]]" } });
      for (const a of f.aliases || []) {
        const sa = fuzzyScore(q, a);
        if (sa != null) opts.push({ s: sa + 0.5, c: { label: a, detail: "↳ " + name, type: "alias", apply: `${env.store.linktext(f, src)}|${a}]]` } });
      }
    }
    opts.sort((a, b) => a.s - b.s || a.c.label.localeCompare(b.c.label));
    const options = opts.slice(0, 50).map(o => o.c);
    if (q && !opts.some(o => o.c.label.toLowerCase() === q.toLowerCase())) options.push({ label: q, detail: "Link to a new note", type: "new", apply: q + "]]" });
    return { from: start, to: ctx.pos + closeLen, filter: false, options };
  };
}
function tagSource(env: EditorEnv) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/(?:^|[\s(])#[\p{L}\p{N}_\-/]*$/u);
    if (!m) return null;
    const hashAt = m.text.indexOf("#");
    const from = m.from + hashAt + 1; const q = m.text.slice(hashAt + 1).toLowerCase();
    if (!q && !ctx.explicit) return null;
    return { from, filter: false, options: env.tags().filter(tg => tg.toLowerCase().startsWith(q) || tg.toLowerCase().includes("/" + q)).slice(0, 30).map(tg => ({ label: tg, type: "tag" })) };
  };
}

// ---------- Formatting commands ----------
export function wrap(view: EditorView, mark: string) {
  view.dispatch(view.state.changeByRange(r => {
    const text = view.state.sliceDoc(r.from, r.to);
    const outer = view.state.sliceDoc(r.from - mark.length, r.to + mark.length);
    if (outer.startsWith(mark) && outer.endsWith(mark) && r.from >= mark.length) {
      return { changes: [{ from: r.from - mark.length, to: r.from }, { from: r.to, to: r.to + mark.length }], range: EditorSelection.range(r.from - mark.length, r.to - mark.length) };
    }
    return { changes: { from: r.from, to: r.to, insert: mark + text + mark }, range: EditorSelection.range(r.from + mark.length, r.to + mark.length) };
  }));
  return true;
}
export function toggleTask(view: EditorView) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[(.)\]/.exec(line.text);
  if (m) { const at = line.from + m[1].length + 1; view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === " " ? "x" : " " } }); return true; }
  const lm = /^(\s*)([-*+]\s+)?/.exec(line.text)!;
  const insertAt = line.from + lm[0].length;
  view.dispatch({ changes: { from: lm[2] ? insertAt : line.from + lm[1].length, insert: lm[2] ? "[ ] " : "- [ ] " } });
  return true;
}
export function insertMdLink(view: EditorView) {
  const r = view.state.selection.main; const text = view.state.sliceDoc(r.from, r.to);
  const ins = `[${text}]()`;
  view.dispatch({ changes: { from: r.from, to: r.to, insert: ins }, selection: { anchor: r.from + (text ? ins.length - 1 : 1) } });
  return true;
}
/** Selected text + "[[" turns the selection into a link. */
const linkFromSelection = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== "[" || from === to) return false;
  const prev = view.state.sliceDoc(from - 1, from);
  const sel = view.state.sliceDoc(from, to);
  if (prev === "[" ) { view.dispatch({ changes: { from: from - 1, to, insert: `[[${sel}]]` }, selection: { anchor: from + 1, head: from + 1 + sel.length } }); return true; }
  view.dispatch({ changes: { from, to, insert: `[${sel}]` }, selection: { anchor: from + 1, head: from + 1 + sel.length } });
  return true;
});

function initialBody(doc: string) { const fm = parseFrontmatter(doc.slice(0, 50000)); if (!fm.present) return 0; const end = Math.min(fm.bodyStart, doc.length); return end; }
export function createEditor(parent: HTMLElement, doc: string, env: EditorEnv, opts: { mode: Mode; onChange: (text: string) => void; extraKeys: Extension; readableWidth: boolean; propsSource: () => boolean }) {
  const modeC = new Compartment();
  const modeExt = (mode: Mode): Extension => mode === "live" ? [livePreview(env), frontmatterField(opts.propsSource), EditorView.contentAttributes.of({ "data-mode": "live" })] : [EditorView.contentAttributes.of({ "data-mode": "source" })];
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      // In live preview the note opens with the cursor at the start of the body, below the hidden properties.
      selection: opts.mode === "live" && !opts.propsSource() ? { anchor: initialBody(doc) } : undefined,
      extensions: [
        opts.extraKeys,
        history(), drawSelection(), indentOnInput(), closeBrackets(), search({ top: true }),
        markdown({ base: markdownLanguage }), syntaxHighlighting(hl),
        EditorView.lineWrapping,
        cmPlaceholder("Start writing…"),
        autocompletion({ override: [linkSource(env), tagSource(env)], icons: false, activateOnTyping: true }),
        linkFromSelection,
        keymap.of([
          { key: "Mod-b", run: v => wrap(v, "**") }, { key: "Mod-i", run: v => wrap(v, "*") },
          { key: "Mod-k", run: insertMdLink }, { key: "Mod-Enter", run: toggleTask },
          ...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap,
        ]),
        modeC.of(modeExt(opts.mode)),
        EditorView.updateListener.of(u => { if (u.docChanged && !u.transactions.every(tr => tr.annotation(Transaction.remote))) opts.onChange(u.state.doc.toString()); }),
        EditorView.domEventHandlers({
          mousedown: (e, v) => {
            const el = e.target as HTMLElement;
            if (el.classList.contains("cm-task-box")) {
              const pos = v.posAtDOM(el); const line = v.state.doc.lineAt(pos);
              const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[(.)\]/.exec(line.text);
              if (m) { const at = line.from + m[1].length + 1; v.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === " " ? "x" : " " } }); }
              e.preventDefault(); return true;
            }
            const link = el.closest<HTMLElement>(".cm-wikilink, .internal-link");
            if (link && e.button === 0) { e.preventDefault(); env.openLink(link.dataset.href || "", e.ctrlKey || e.metaKey); return true; }
            const tag = el.closest<HTMLElement>(".cm-tag");
            if (tag && (v.contentDOM.dataset.mode === "live" || e.ctrlKey || e.metaKey)) { if (v.contentDOM.dataset.mode === "live" && !(e.ctrlKey || e.metaKey) && v.hasFocus) return false; e.preventDefault(); env.openTag(tag.dataset.tag || ""); return true; }
            if ((e.ctrlKey || e.metaKey) && e.button === 0) {
              // Source mode: Ctrl/Cmd+click on [[link]] text follows it.
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }); if (pos == null) return false;
              const line = v.state.doc.lineAt(pos); const off = pos - line.from;
              const re = /!?\[\[([^\[\]\n]+?)\]\]/g; let m: RegExpExecArray | null;
              while ((m = re.exec(line.text))) if (off >= m.index && off <= m.index + m[0].length) { const s = splitWikiInner(m[1]); e.preventDefault(); env.openLink(s.linkpath + s.subpath, true); return true; }
            }
            return false;
          },
          paste: (e, v) => {
            const files = [...(e.clipboardData?.files || [])]; if (!files.length) return false;
            e.preventDefault(); insertUploads(v, env, files, v.state.selection.main.head); return true;
          },
          drop: (e, v) => {
            const files = [...(e.dataTransfer?.files || [])];
            const path = e.dataTransfer?.getData("application/x-vault-path");
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
            if (files.length) { e.preventDefault(); insertUploads(v, env, files, pos); return true; }
            if (path) {
              e.preventDefault();
              const f = env.store.byPathGet(path); if (!f) return true;
              const lt = env.store.linktext(f, env.path());
              const embed = f.kind === "attachment";
              const ins = env.store.settings.useWikilinks ? wikilink(lt, "", null, embed) : mdlink(f.path, lt, "", displayName(f.path), embed);
              v.dispatch({ changes: { from: pos, insert: ins }, selection: { anchor: pos + ins.length } }); v.focus(); return true;
            }
            return false;
          },
        }),
        EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6" }, ".cm-content": { maxWidth: opts.readableWidth ? "720px" : "none", margin: "0 auto", padding: "24px 32px 40vh" } }),
      ],
    }),
  });
  return {
    view,
    setMode(mode: Mode) {
      view.dispatch({ effects: modeC.reconfigure(modeExt(mode)) });
      if (mode === "live" && !opts.propsSource()) { const end = fmEnd(view.state); if (view.state.selection.main.empty && view.state.selection.main.head < end) view.dispatch({ selection: { anchor: end } }); }
    },
    replaceDoc(text: string) {
      const cur = view.state.doc.toString(); if (cur === text) return;
      // Keep the cursor near where it was: same line and column when the line still exists.
      const head = view.state.selection.main.head; const ln = view.state.doc.lineAt(head); const col = head - ln.from;
      view.dispatch({ changes: { from: 0, to: cur.length, insert: text }, annotations: Transaction.remote.of(true) });
      const l2 = view.state.doc.line(Math.min(ln.number, view.state.doc.lines));
      view.dispatch({ selection: { anchor: Math.min(l2.from + col, l2.to) }, annotations: Transaction.remote.of(true) });
    },
    refresh() { view.dispatch({ annotations: Transaction.userEvent.of("embed-loaded") }); },
    destroy() { view.destroy(); },
  };
}

async function insertUploads(v: EditorView, env: EditorEnv, files: File[], pos: number) {
  try {
    const texts = await env.upload(files);
    const ins = texts.join("\n");
    v.dispatch({ changes: { from: pos, insert: ins }, selection: { anchor: pos + ins.length } });
  } catch { /* the uploader shows a toast */ }
}
export type { FileMeta };
