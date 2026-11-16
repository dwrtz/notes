// App actions shared by every pane: opening links, files, daily notes, templates and the command list.
import { createContext, useContext } from "react";
import { EditorView } from "@codemirror/view";
import { VaultStore, FileMeta } from "./store";
import { Workspace, View } from "./workspace";
import { api, ApiError } from "./api";
import { prompt, confirm, toast, openModal } from "./ui";
import { basename, dirname, displayName, joinPath, lc, checkName, extname } from "../shared/paths";
import { formatDate, partsInZone, parseDate, addDays, dayKey, Parts } from "../shared/dates";
import { applyVariables, insertTemplate } from "../shared/templates";
import { wrap, toggleTask, insertMdLink } from "./editor";

export interface EditorHandle { view: EditorView; fileId: number }
export interface Command { id: string; name: string; key?: string; run: () => void | Promise<void>; check?: () => boolean }

export class App {
  editors = new Map<string, EditorHandle>(); // tabId -> editor
  modal: null | { kind: "switcher" | "palette" | "settings" | "templates" | "move"; arg?: any } = null;
  modalListeners = new Set<() => void>();
  constructor(public store: VaultStore, public ws: Workspace, public now: () => string, public signOut: () => void, public switchVault: (id: number) => void) {}

  setModal(m: App["modal"]) { this.modal = m; for (const l of this.modalListeners) l(); }
  activeFile(): FileMeta | undefined { const v = this.ws.activeTab().view; return "fileId" in v ? this.store.file(v.fileId) : undefined; }
  activeEditor(): EditorHandle | undefined { return this.editors.get(this.ws.activeTab().id); }

  openFile(id: number, how: "same" | "tab" | "split" = "same", line?: number) {
    const f = this.store.file(id); if (!f) return;
    if (f.kind === "folder") { this.ws.toggleExpanded(f.path, true); this.ws.setLeft({ open: true, tab: "files" }); return; }
    this.ws.open({ type: f.kind === "note" ? "note" : "file", fileId: id } as View, how, line);
    if (window.innerWidth < 768) { this.ws.setLeft({ open: false }); this.ws.setRight({ open: false }); }
  }
  /** Follow "path#sub" from `sourcePath`. Unresolved links create the note. */
  async openLink(href: string, sourcePath: string, newTab = false) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { window.open(href, "_blank", "noopener"); return; }
    const hash = href.indexOf("#");
    const lp = (hash >= 0 ? href.slice(0, hash) : href).trim(); const sub = hash >= 0 ? href.slice(hash) : "";
    let f = lp ? this.store.resolve(lp, sourcePath) : this.store.byPathGet(sourcePath);
    if (!f) {
      const folder = lp.includes("/") ? dirname(lp) : this.store.newNoteFolder(sourcePath);
      const name = basename(lp).replace(/\.md$/i, "");
      const err = checkName(name); if (err) { toast(err); return; }
      try { f = await this.store.createNote(joinPath(folder, name + ".md")); } catch (e) { toast((e as Error).message); return; }
    }
    let line: number | undefined;
    if (sub && f.kind === "note") {
      const { parseNote, resolveSubpath } = await import("../shared/parse");
      const r = resolveSubpath(parseNote(await this.store.note(f.id)), sub); line = r?.startLine;
    }
    this.openFile(f.id, newTab ? "tab" : "same", line);
  }
  async newNote(folder?: string, how: "same" | "tab" = "same") {
    const dir = folder ?? this.store.newNoteFolder(this.activeFile()?.path);
    try {
      const f = await this.store.createNote(this.store.freePath(dir, "Untitled"));
      this.openFile(f.id, how);
      this.ws.toggleExpanded(dir, true);
      setTimeout(() => document.querySelector<HTMLInputElement>(".view-title-input")?.select(), 50);
    } catch (e) { toast((e as Error).message); }
  }
  async newFolder(parent = "") {
    const name = await prompt("New folder", { value: this.store.freePath(parent, "Untitled", "").split("/").pop(), ok: "Create", validate: checkName });
    if (name == null) return;
    try { await this.store.createFolder(joinPath(parent, name.trim())); this.ws.toggleExpanded(parent, true); } catch (e) { toast((e as Error).message); }
  }
  confirmLinks = (n: { updatedNotes: number; updatedLinks: number }) => confirm("Update links?", `Update ${n.updatedLinks} link${n.updatedLinks === 1 ? "" : "s"} in ${n.updatedNotes} note${n.updatedNotes === 1 ? "" : "s"} to point at the new name?`, "Update", false);
  async rename(id: number, newName?: string) {
    const f = this.store.file(id); if (!f) return;
    const isNote = f.kind === "note";
    const cur = isNote ? displayName(f.path) : basename(f.path);
    const name = newName ?? await prompt(`Rename ${f.kind === "folder" ? "folder" : "file"}`, { value: cur, selectStem: f.kind === "attachment", validate: v => { const s = f.kind === "attachment" ? v.replace(/\.[^.]+$/, "") : v; return checkName(s); } });
    if (name == null || name.trim() === cur) return;
    if (f.kind === "attachment" && extname(name) !== extname(f.path)) { toast("Keep the file's extension"); return; }
    await this.moveTo(id, joinPath(dirname(f.path), name.trim() + (isNote ? ".md" : "")));
  }
  async moveTo(id: number, path: string) {
    try { await this.store.move(id, path, this.confirmLinks); }
    catch (e) { toast(e instanceof ApiError ? e.message : "Could not move the file"); }
  }
  async remove(id: number) {
    const f = this.store.file(id); if (!f) return;
    const permanent = this.store.settings.deleteBehavior === "permanent";
    const ok = await confirm(`Delete ${f.kind === "folder" ? "folder" : "file"}`, `Delete "${basename(f.path)}"${f.kind === "folder" ? " and everything in it" : ""}? ${permanent ? "This cannot be undone." : "You can restore it from the trash in Settings."}`);
    if (!ok) return;
    try { await this.store.remove(id); this.ws.prune(x => !!this.store.file(x)); } catch (e) { toast((e as Error).message); }
  }
  async duplicate(id: number) {
    const f = this.store.file(id); if (!f || f.kind !== "note") return;
    const text = await this.store.note(id);
    const p = this.store.freePath(dirname(f.path), displayName(f.path));
    const n = await this.store.createNote(p, text); this.openFile(n.id);
  }
  /** Upload files as attachments; returns the embed text for each. */
  async upload(files: File[], fromPath?: string): Promise<string[]> {
    const out: string[] = [];
    for (const file of files) {
      const ext = (file.name.includes(".") ? file.name.split(".").pop()! : (file.type.split("/")[1] || "bin")).toLowerCase().replace("jpeg", "jpg");
      const pasted = !file.name || file.name === "image.png";
      const stamp = formatDate(partsInZone(this.now(), Intl.DateTimeFormat().resolvedOptions().timeZone), "YYYYMMDDHHmmss");
      const base = pasted ? `Pasted image ${stamp}` : file.name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|#^[\]]/g, "-");
      const folder = this.store.attachmentFolder(fromPath);
      try {
        const f = await this.store.upload(joinPath(folder, `${base}.${ext}`), file);
        const lt = fromPath ? this.store.linktext(f, fromPath) : f.path;
        out.push(this.store.settings.useWikilinks ? `![[${lt}]]` : `![](${lt.split("/").map(encodeURIComponent).join("/")})`);
      } catch (e) { toast((e as Error).message); }
    }
    return out;
  }

  // ---------- Daily notes ----------
  zone() { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  dailyPath(p: Parts) { const s = this.store.settings; return joinPath(s.dailyFolder.replace(/^\/+|\/+$/g, ""), formatDate(p, s.dailyFormat) + ".md"); }
  async openDaily(p?: Parts) {
    const day = p ?? partsInZone(this.now(), this.zone());
    const path = this.dailyPath(day);
    let f = this.store.byPathGet(path);
    if (!f) {
      let content = "";
      const s = this.store.settings;
      if (s.dailyTemplate.trim()) {
        const tp = s.dailyTemplate.trim().replace(/\.md$/i, "") + ".md";
        const t = this.store.byPathGet(tp) ?? this.store.resolve(s.dailyTemplate.trim(), "");
        if (t && t.kind === "note") content = applyVariables(await this.store.note(t.id), { title: displayName(path), now: { ...day, ...timeParts(this.now(), this.zone()) }, dateFormat: s.dailyFormat, timeFormat: s.templateTimeFormat });
        else toast(`The daily note template "${s.dailyTemplate}" was not found.`);
      }
      try { f = await this.store.createNote(path, content); } catch (e) { toast((e as Error).message); return; }
    }
    this.openFile(f.id);
  }
  /** Previous/next existing daily note relative to the open one. */
  stepDaily(dir: -1 | 1) {
    const s = this.store.settings; const folder = s.dailyFolder.replace(/^\/+|\/+$/g, "");
    const cur = this.activeFile();
    const parse = (f: FileMeta) => { const rel = folder ? (lc(f.path).startsWith(lc(folder) + "/") ? f.path.slice(folder.length + 1) : null) : f.path; return rel ? parseDate(rel.replace(/\.md$/i, ""), s.dailyFormat) : null; };
    const days = this.store.list().filter(f => f.kind === "note").map(f => ({ f, d: parse(f) })).filter(x => x.d).map(x => ({ f: x.f, k: dayKey(x.d!) })).sort((a, b) => a.k.localeCompare(b.k));
    const curDay = cur ? parse(cur) : null;
    const k = curDay ? dayKey(curDay) : dayKey(partsInZone(this.now(), this.zone()));
    const pick = dir < 0 ? [...days].reverse().find(x => x.k < k) : days.find(x => x.k > k);
    if (pick) this.openFile(pick.f.id); else toast(dir < 0 ? "No earlier daily note" : "No later daily note");
  }

  // ---------- Templates ----------
  templates() {
    const folder = this.store.settings.templatesFolder.replace(/^\/+|\/+$/g, "");
    return this.store.list().filter(f => f.kind === "note" && folder && lc(f.path).startsWith(lc(folder) + "/")).sort((a, b) => a.path.localeCompare(b.path));
  }
  async insertTemplate(t: FileMeta) {
    const ed = this.activeEditor(); const f = this.activeFile();
    if (!ed || !f) { toast("Open a note in editing view first"); return; }
    const s = this.store.settings; const nowP = partsInZone(this.now(), this.zone());
    const text = applyVariables(await this.store.note(t.id), { title: displayName(f.path), now: nowP, dateFormat: s.templateDateFormat, timeFormat: s.templateTimeFormat });
    const v = ed.view; const doc = v.state.doc.toString();
    const r = insertTemplate(doc, v.state.selection.main.head, text);
    v.dispatch({ changes: { from: 0, to: doc.length, insert: r.text }, selection: { anchor: r.cursor } }); v.focus();
  }
  insertText(text: string) { const ed = this.activeEditor(); if (!ed) { toast("Open a note in editing view first"); return; } const v = ed.view; const r = v.state.selection.main; v.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length } }); v.focus(); }

  async bookmarkActive() {
    const v = this.ws.activeTab().view;
    const body = v.type === "graph" ? { type: "graph", title: "Graph" } : "fileId" in v ? { type: "file", path: this.store.file(v.fileId)?.path } : null;
    if (!body) { toast("Nothing to bookmark here"); return; }
    await api(`${this.store.base()}/bookmarks`, { body }); window.dispatchEvent(new Event("bookmarks-changed")); toast("Bookmarked");
  }
  setTheme(t: "light" | "dark" | "system") {
    localStorage.setItem("theme", t);
    const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light"; window.dispatchEvent(new Event("theme-changed"));
  }

  commands(): Command[] {
    const ed = () => this.activeEditor()?.view;
    const withEd = (fn: (v: EditorView) => unknown) => () => { const v = ed(); if (v) { fn(v); v.focus(); } else toast("Open a note in editing view first"); };
    const file = () => this.activeFile();
    const list: Command[] = [
      { id: "switcher:open", name: "Quick switcher: Open", key: "Mod+O", run: () => this.setModal({ kind: "switcher" }) },
      { id: "palette:open", name: "Command palette: Open", key: "Mod+P", run: () => this.setModal({ kind: "palette" }) },
      { id: "file:new", name: "Create new note", key: "Mod+N", run: () => this.newNote() },
      { id: "file:new-tab", name: "Create new note in new tab", key: "Mod+Shift+N", run: () => this.newNote(undefined, "tab") },
      { id: "file:new-folder", name: "Create new folder", run: () => this.newFolder() },
      { id: "file:rename", name: "Rename file", key: "F2", check: () => !!file(), run: () => { const f = file(); if (f) this.rename(f.id); } },
      { id: "file:move", name: "Move current file to another folder", check: () => !!file(), run: () => { const f = file(); if (f) this.setModal({ kind: "move", arg: f.id }); } },
      { id: "file:duplicate", name: "Make a copy of the current file", check: () => file()?.kind === "note", run: () => { const f = file(); if (f) this.duplicate(f.id); } },
      { id: "file:delete", name: "Delete current file", check: () => !!file(), run: () => { const f = file(); if (f) this.remove(f.id); } },
      { id: "file:reveal", name: "Reveal current file in navigation", check: () => !!file(), run: () => { const f = file(); if (!f) return; const parts = f.path.split("/"); for (let i = 1; i < parts.length; i++) this.ws.toggleExpanded(parts.slice(0, i).join("/"), true); this.ws.setLeft({ open: true, tab: "files" }); setTimeout(() => document.querySelector(`[data-path="${CSS.escape(f.path)}"]`)?.scrollIntoView({ block: "center" }), 50); } },
      { id: "editor:toggle-reading", name: "Toggle reading view", key: "Mod+E", check: () => file()?.kind === "note", run: () => { const t = this.ws.activeTab(); const cur = t.mode ?? this.store.settings.defaultMode; const edit = this.store.settings.defaultMode === "reading" ? "live" : this.store.settings.defaultMode; this.ws.setMode(t.id, cur === "reading" ? (edit as any) : "reading"); } },
      { id: "editor:toggle-source", name: "Toggle live preview/source mode", check: () => file()?.kind === "note", run: () => { const t = this.ws.activeTab(); const cur = t.mode ?? this.store.settings.defaultMode; this.ws.setMode(t.id, cur === "source" ? "live" : "source"); } },
      { id: "editor:bold", name: "Toggle bold", key: "Mod+B", run: withEd(v => wrap(v, "**")) },
      { id: "editor:italic", name: "Toggle italics", key: "Mod+I", run: withEd(v => wrap(v, "*")) },
      { id: "editor:highlight", name: "Toggle highlight", run: withEd(v => wrap(v, "==")) },
      { id: "editor:code", name: "Toggle code", run: withEd(v => wrap(v, "`")) },
      { id: "editor:md-link", name: "Insert Markdown link", key: "Mod+K", run: withEd(insertMdLink) },
      { id: "editor:internal-link", name: "Add internal link", run: withEd(v => { const r = v.state.selection.main; const t = v.state.sliceDoc(r.from, r.to); v.dispatch({ changes: { from: r.from, to: r.to, insert: `[[${t}]]` }, selection: { anchor: r.from + 2 + t.length } }); }) },
      { id: "editor:task", name: "Toggle checkbox status", key: "Mod+Enter", run: withEd(toggleTask) },
      { id: "editor:add-property", name: "Add file property", key: "Mod+;", check: () => file()?.kind === "note", run: () => window.dispatchEvent(new CustomEvent("add-property", { detail: this.ws.activeTab().id })) },
      { id: "search:open", name: "Search: Search in all files", key: "Mod+Shift+F", run: () => { const v = ed(); const sel = v ? v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) : ""; this.ws.search(sel || this.ws.s.search.query); setTimeout(() => document.querySelector<HTMLInputElement>(".search-input")?.focus(), 30); } },
      { id: "find:in-note", name: "Search current file", key: "Mod+F", run: withEd(v => { import("@codemirror/search").then(m => m.openSearchPanel(v)); }) },
      { id: "graph:open", name: "Graph view: Open graph view", key: "Mod+G", run: () => this.ws.open({ type: "graph" }, "tab") },
      { id: "graph:local", name: "Graph view: Open local graph", run: () => this.ws.setRight({ open: true, tab: "localgraph" }) },
      { id: "daily:today", name: "Daily notes: Open today's daily note", run: () => this.openDaily() },
      { id: "daily:prev", name: "Daily notes: Open previous daily note", run: () => this.stepDaily(-1) },
      { id: "daily:next", name: "Daily notes: Open next daily note", run: () => this.stepDaily(1) },
      { id: "templates:insert", name: "Templates: Insert template", run: () => { if (!this.activeEditor()) { toast("Open a note in editing view first"); return; } if (!this.templates().length) { toast(`No templates found. Add notes to the "${this.store.settings.templatesFolder}" folder.`); return; } this.setModal({ kind: "templates" }); } },
      { id: "templates:date", name: "Templates: Insert current date", run: () => this.insertText(formatDate(partsInZone(this.now(), this.zone()), this.store.settings.templateDateFormat)) },
      { id: "templates:time", name: "Templates: Insert current time", run: () => this.insertText(formatDate(partsInZone(this.now(), this.zone()), this.store.settings.templateTimeFormat)) },
      { id: "bookmarks:add", name: "Bookmarks: Bookmark current view", key: "Mod+D", run: () => this.bookmarkActive() },
      { id: "bookmarks:show", name: "Bookmarks: Show bookmarks", run: () => this.ws.setLeft({ open: true, tab: "bookmarks" }) },
      { id: "files:show", name: "Files: Show file explorer", run: () => this.ws.setLeft({ open: true, tab: "files" }) },
      { id: "tags:show", name: "Tags: Show tags", run: () => this.ws.setLeft({ open: true, tab: "tags" }) },
      { id: "backlinks:show", name: "Backlinks: Show backlinks", run: () => this.ws.setRight({ open: true, tab: "backlinks" }) },
      { id: "outgoing:show", name: "Outgoing links: Show outgoing links", run: () => this.ws.setRight({ open: true, tab: "outgoing" }) },
      { id: "outline:show", name: "Outline: Show outline", run: () => this.ws.setRight({ open: true, tab: "outline" }) },
      { id: "properties:show", name: "Properties: Show all properties", run: () => this.ws.setRight({ open: true, tab: "properties" }) },
      { id: "tab:new", name: "New tab", key: "Mod+T", run: () => this.ws.newTab() },
      { id: "tab:close", name: "Close current tab", key: "Mod+W", run: () => { const g = this.ws.group(); this.ws.closeTab(g.id, g.active); } },
      { id: "tab:next", name: "Go to next tab", key: "Ctrl+Tab", run: () => this.ws.cycleTab(1) },
      { id: "tab:prev", name: "Go to previous tab", key: "Ctrl+Shift+Tab", run: () => this.ws.cycleTab(-1) },
      { id: "tab:split-right", name: "Split right", run: () => this.ws.splitActive("row") },
      { id: "tab:split-down", name: "Split down", run: () => this.ws.splitActive("col") },
      { id: "nav:back", name: "Navigate back", key: "Mod+Alt+ArrowLeft", run: () => this.ws.go(-1) },
      { id: "nav:forward", name: "Navigate forward", key: "Mod+Alt+ArrowRight", run: () => this.ws.go(1) },
      { id: "sidebar:left", name: "Toggle left sidebar", key: "Mod+\\", run: () => this.ws.setLeft({ open: !this.ws.s.left.open }) },
      { id: "sidebar:right", name: "Toggle right sidebar", key: "Mod+Shift+\\", run: () => this.ws.setRight({ open: !this.ws.s.right.open }) },
      { id: "random:open", name: "Open random note", run: () => { const ns = this.store.list().filter(f => f.kind === "note"); if (ns.length) this.openFile(ns[Math.floor(Math.random() * ns.length)].id); } },
      { id: "theme:toggle", name: "Toggle light/dark mode", run: () => this.setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark") },
      { id: "settings:open", name: "Open settings", key: "Mod+,", run: () => this.setModal({ kind: "settings" }) },
      { id: "app:sign-out", name: "Sign out", run: () => this.signOut() },
    ];
    for (let i = 1; i <= 8; i++) list.push({ id: `tab:goto-${i}`, name: i === 8 ? "Go to last tab" : `Go to tab #${i}`, key: `Mod+${i}`, run: () => this.ws.goToTab(i === 8 ? 8 : i - 1) });
    const over = this.store.settings.hotkeys;
    return list.map(c => (c.id in over ? { ...c, key: over[c.id] || undefined } : c));
  }
  async createFromSwitcher(name: string, how: "same" | "tab") {
    const n = name.trim().replace(/\.md$/i, "");
    const err = n.split("/").map(s => checkName(s)).find(Boolean); if (err) { toast(err); return; }
    const path = n.includes("/") ? n + ".md" : joinPath(this.store.newNoteFolder(this.activeFile()?.path), n + ".md");
    try { const f = await this.store.createNote(path); this.openFile(f.id, how); } catch (e) { toast((e as Error).message); }
  }
}
function timeParts(iso: string, zone: string) { const p = partsInZone(iso, zone); return { h: p.h, mi: p.mi, s: p.s }; }
export { addDays, openModal };
export const AppCtx = createContext<App>(null as any);
export const useApp = () => useContext(AppCtx);

/** "Mod+Shift+K" from a keyboard event. Mod = Ctrl, or Cmd on a Mac. */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export function comboOf(e: KeyboardEvent) {
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("Mod");
  if (isMac && e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let k = e.key;
  if (k === " ") k = "Space";
  if (["Control", "Meta", "Alt", "Shift"].includes(k)) return null;
  if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (k.length === 1) k = k.toUpperCase();
  if (e.code === "Backslash") k = "\\";
  if (e.code === "Semicolon") k = ";";
  if (e.code === "Comma") k = ",";
  parts.push(k);
  return parts.join("+");
}
export function comboLabel(c?: string) { if (!c) return ""; return c.replace("Mod", isMac ? "⌘" : "Ctrl").replace("Alt", isMac ? "⌥" : "Alt").replace("Shift", isMac ? "⇧" : "Shift").replace("ArrowLeft", "←").replace("ArrowRight", "→").replace(/\+/g, isMac ? "" : "+"); }
