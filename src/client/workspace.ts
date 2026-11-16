// The workspace: tab groups in nested splits, sidebars, history and recent files. Saved per vault on this device.
import { Emitter } from "./store";

export type View = { type: "note" | "file"; fileId: number } | { type: "graph" } | { type: "empty" };
export interface Tab { id: string; view: View; mode?: "live" | "source" | "reading"; back: View[]; fwd: View[]; pinned?: boolean; jump?: { line: number; n: number } }
export interface Group { kind: "group"; id: string; tabs: Tab[]; active: string }
export interface Split { kind: "split"; id: string; dir: "row" | "col"; children: LayoutNode[]; sizes: number[] }
export type LayoutNode = Group | Split;
export type LeftTab = "files" | "search" | "bookmarks" | "tags";
export type RightTab = "backlinks" | "outgoing" | "outline" | "localgraph" | "properties";
export interface WsState {
  root: LayoutNode; activeGroup: string;
  left: { open: boolean; tab: LeftTab; width: number }; right: { open: boolean; tab: RightTab; width: number };
  recent: number[]; search: { query: string; n: number }; expanded: string[];
}
let n = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;
export const newTab = (view: View = { type: "empty" }): Tab => ({ id: uid("t"), view, back: [], fwd: [] });
const newGroup = (tab = newTab()): Group => ({ kind: "group", id: uid("g"), tabs: [tab], active: tab.id });

export class Workspace extends Emitter {
  s: WsState;
  constructor(public vaultId: number) {
    super();
    const g = newGroup();
    const def: WsState = { root: g, activeGroup: g.id, left: { open: true, tab: "files", width: 260 }, right: { open: true, tab: "backlinks", width: 280 }, recent: [], search: { query: "", n: 0 }, expanded: [] };
    try { const saved = JSON.parse(localStorage.getItem(this.key()) || "null"); this.s = saved?.root ? { ...def, ...saved } : def; } catch { this.s = def; }
    if (!this.groups().some(x => x.id === this.s.activeGroup)) this.s.activeGroup = this.groups()[0].id;
  }
  key() { return `ws:${this.vaultId}`; }
  save() { try { localStorage.setItem(this.key(), JSON.stringify(this.s)); } catch { /* full */ } this.emit(); }

  groups(node: LayoutNode = this.s.root): Group[] { return node.kind === "group" ? [node] : node.children.flatMap(c => this.groups(c)); }
  group(id = this.s.activeGroup) { return this.groups().find(g => g.id === id) ?? this.groups()[0]; }
  activeTab() { const g = this.group(); return g.tabs.find(t => t.id === g.active) ?? g.tabs[0]; }
  findTab(tabId: string) { for (const g of this.groups()) { const t = g.tabs.find(x => x.id === tabId); if (t) return { g, t }; } return null; }
  parentOf(id: string, node: LayoutNode = this.s.root): Split | null {
    if (node.kind === "group") return null;
    if (node.children.some(c => c.id === id)) return node;
    for (const c of node.children) { const p = this.parentOf(id, c); if (p) return p; }
    return null;
  }

  focusGroup(id: string) { if (this.s.activeGroup !== id) { this.s.activeGroup = id; this.save(); } }
  activate(groupId: string, tabId: string) { const g = this.group(groupId); g.active = tabId; this.s.activeGroup = g.id; this.save(); }
  touchRecent(fileId: number) { this.s.recent = [fileId, ...this.s.recent.filter(x => x !== fileId)].slice(0, 30); }

  /** Open a view. "same" replaces the active tab (unless pinned), "tab" adds a tab, "split" opens to the right. */
  open(view: View, how: "same" | "tab" | "split" = "same", jump?: number) {
    if (how === "split") { this.splitActive("row", view); }
    else {
      const g = this.group(); const cur = this.activeTab();
      if (how === "tab" || cur.pinned) { const t = newTab(view); g.tabs.splice(g.tabs.indexOf(cur) + 1, 0, t); g.active = t.id; }
      else if (!sameView(cur.view, view)) { if (cur.view.type !== "empty") cur.back.push(cur.view); cur.fwd = []; cur.view = view; cur.mode = undefined; }
    }
    if ("fileId" in view) this.touchRecent(view.fileId);
    const t = this.activeTab(); if (jump != null) t.jump = { line: jump, n: (t.jump?.n ?? 0) + 1 };
    this.save();
  }
  newTab() { const g = this.group(); const t = newTab(); g.tabs.push(t); g.active = t.id; this.save(); }
  closeTab(groupId: string, tabId: string) {
    const g = this.group(groupId); const i = g.tabs.findIndex(t => t.id === tabId); if (i < 0) return;
    g.tabs.splice(i, 1);
    if (!g.tabs.length) {
      if (this.groups().length > 1) { this.removeGroup(g.id); this.save(); return; }
      const t = newTab(); g.tabs.push(t);
    }
    if (g.active === tabId) g.active = g.tabs[Math.max(0, i - 1)].id;
    this.save();
  }
  closeOthers(groupId: string, tabId: string) { const g = this.group(groupId); g.tabs = g.tabs.filter(t => t.id === tabId || t.pinned); g.active = tabId; this.save(); }
  togglePin(groupId: string, tabId: string) { const t = this.group(groupId).tabs.find(x => x.id === tabId); if (t) { t.pinned = !t.pinned; this.save(); } }
  private removeGroup(id: string) {
    const p = this.parentOf(id); if (!p) return;
    const i = p.children.findIndex(c => c.id === id);
    p.children.splice(i, 1); p.sizes.splice(i, 1);
    const tot = p.sizes.reduce((a, b) => a + b, 0) || 1; p.sizes = p.sizes.map(s => s / tot);
    if (p.children.length === 1) { const only = p.children[0]; const gp = this.parentOf(p.id); if (gp) { gp.children[gp.children.indexOf(p)] = only; } else this.s.root = only; }
    if (this.s.activeGroup === id) this.s.activeGroup = this.groups()[0].id;
  }
  /** Split the active group; the new group shows `view` (or a copy of the active tab). */
  splitActive(dir: "row" | "col", view?: View, groupId = this.s.activeGroup) {
    const g = this.group(groupId); const cur = g.tabs.find(t => t.id === g.active)!;
    const ng = newGroup(newTab(view ?? cur.view));
    ng.tabs[0].mode = view ? undefined : cur.mode;
    const p = this.parentOf(g.id);
    if (p && p.dir === dir) { const i = p.children.indexOf(g); p.children.splice(i + 1, 0, ng); p.sizes = p.children.map(() => 1 / p.children.length); }
    else {
      const sp: Split = { kind: "split", id: uid("s"), dir, children: [g, ng], sizes: [0.5, 0.5] };
      if (p) p.children[p.children.indexOf(g)] = sp; else this.s.root = sp;
    }
    this.s.activeGroup = ng.id; this.save();
  }
  moveTab(tabId: string, toGroup: string, index: number) {
    const f = this.findTab(tabId); if (!f) return;
    const to = this.group(toGroup);
    const from = f.g; const i = from.tabs.indexOf(f.t);
    from.tabs.splice(i, 1);
    if (from === to && index > i) index--;
    to.tabs.splice(Math.min(index, to.tabs.length), 0, f.t); to.active = f.t.id; this.s.activeGroup = to.id;
    if (!from.tabs.length) { if (from !== to) this.removeGroup(from.id); }
    else if (from.active === tabId) from.active = from.tabs[Math.max(0, i - 1)].id;
    this.save();
  }
  resize(splitId: string, sizes: number[]) { const find = (nd: LayoutNode): Split | null => nd.kind === "split" ? (nd.id === splitId ? nd : nd.children.map(find).find(Boolean) ?? null) : null; const sp = find(this.s.root); if (sp) { sp.sizes = sizes; this.save(); } }
  go(dir: -1 | 1) {
    const t = this.activeTab();
    const from = dir < 0 ? t.back : t.fwd, to = dir < 0 ? t.fwd : t.back;
    const v = from.pop(); if (!v) return;
    if (t.view.type !== "empty") to.push(t.view);
    t.view = v; if ("fileId" in v) this.touchRecent(v.fileId); this.save();
  }
  cycleTab(dir: 1 | -1) { const g = this.group(); const i = g.tabs.findIndex(t => t.id === g.active); g.active = g.tabs[(i + dir + g.tabs.length) % g.tabs.length].id; this.save(); }
  goToTab(i: number) { const g = this.group(); const t = i >= 8 ? g.tabs[g.tabs.length - 1] : g.tabs[i]; if (t) { g.active = t.id; this.save(); } }
  setMode(tabId: string, mode: Tab["mode"]) { const f = this.findTab(tabId); if (f) { f.t.mode = mode; this.save(); } }
  /** Drop views of files that no longer exist. */
  prune(exists: (id: number) => boolean) {
    let changed = false;
    for (const g of this.groups()) for (const t of g.tabs) {
      if ("fileId" in t.view && !exists(t.view.fileId)) { t.view = { type: "empty" }; changed = true; }
      const keep = (v: View) => !("fileId" in v) || exists(v.fileId);
      if (t.back.some(v => !keep(v)) || t.fwd.some(v => !keep(v))) { t.back = t.back.filter(keep); t.fwd = t.fwd.filter(keep); changed = true; }
    }
    const r = this.s.recent.filter(exists); if (r.length !== this.s.recent.length) { this.s.recent = r; changed = true; }
    if (changed) this.save();
  }
  setLeft(p: Partial<WsState["left"]>) { this.s.left = { ...this.s.left, ...p }; this.save(); }
  setRight(p: Partial<WsState["right"]>) { this.s.right = { ...this.s.right, ...p }; this.save(); }
  search(query: string) { this.s.search = { query, n: this.s.search.n + 1 }; this.s.left = { ...this.s.left, open: true, tab: "search" }; this.save(); }
  toggleExpanded(path: string, open?: boolean) { const has = this.s.expanded.includes(path); const want = open ?? !has; this.s.expanded = want ? [...new Set([...this.s.expanded, path])] : this.s.expanded.filter(p => p !== path); this.save(); }
}
export function sameView(a: View, b: View) { return a.type === b.type && ("fileId" in a ? "fileId" in b && a.fileId === b.fileId : true); }
