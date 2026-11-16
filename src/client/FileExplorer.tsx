import React, { useState } from "react";
import { useApp } from "./app";
import { useEmitter, FileMeta } from "./store";
import { Icon, IconButton, showMenu, toast } from "./ui";
import { basename, dirname, displayName, joinPath, lc } from "../shared/paths";
import { api } from "./api";

type Sort = "name-asc" | "name-desc" | "mtime-desc" | "mtime-asc" | "ctime-desc" | "ctime-asc";
interface Node { f: FileMeta; children: Node[] }

export function FileExplorer() {
  const app = useApp(); const { store, ws } = app;
  useEmitter(store); useEmitter(ws);
  const [sort, setSortS] = useState<Sort>(() => (localStorage.getItem("explorerSort") as Sort) || "name-asc");
  const setSort = (s: Sort) => { localStorage.setItem("explorerSort", s); setSortS(s); };
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const active = app.activeFile();
  // Build the tree
  const byDir = new Map<string, FileMeta[]>();
  for (const f of store.list()) { const d = dirname(f.path); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d)!.push(f); }
  const cmp = (a: FileMeta, b: FileMeta) => {
    if (a.kind === "folder" && b.kind !== "folder") return -1; if (b.kind === "folder" && a.kind !== "folder") return 1;
    const name = (x: FileMeta) => (x.kind === "note" ? displayName(x.path) : basename(x.path));
    if (a.kind === "folder" || sort.startsWith("name")) { const r = name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: "base" }); return sort === "name-desc" && a.kind !== "folder" ? -r : r; }
    const k = sort.startsWith("mtime") ? "mtime" : "ctime"; const r = a[k].localeCompare(b[k]); return sort.endsWith("desc") ? -r : r;
  };
  const build = (dir: string): Node[] => (byDir.get(dir) || []).sort(cmp).map(f => ({ f, children: f.kind === "folder" ? build(f.path) : [] }));
  const tree = build("");
  const expanded = new Set(ws.s.expanded);
  const visible: FileMeta[] = [];
  const walk = (ns: Node[]) => { for (const n of ns) { visible.push(n.f); if (n.f.kind === "folder" && expanded.has(n.f.path)) walk(n.children); } };
  walk(tree);

  const move = async (id: number, folder: string) => {
    const f = store.file(id); if (!f) return;
    if (dirname(f.path) === folder) return;
    if (f.kind === "folder" && (folder === f.path || folder.startsWith(f.path + "/"))) { toast("A folder cannot go inside itself"); return; }
    await app.moveTo(id, joinPath(folder, basename(f.path)));
    ws.toggleExpanded(folder, true);
  };
  const onDrop = async (e: React.DragEvent, folder: string) => {
    e.preventDefault(); e.stopPropagation(); setDropTarget(null);
    const id = Number(e.dataTransfer.getData("application/x-file-id"));
    if (id) { await move(id, folder); return; }
    const files = [...e.dataTransfer.files];
    for (const file of files) { try { await store.upload(joinPath(folder, file.name), file); } catch (x) { toast((x as Error).message); } }
  };
  const allowDrop = (e: React.DragEvent, folder: string) => {
    if (e.dataTransfer.types.includes("application/x-file-id") || e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.stopPropagation(); setDropTarget(folder); }
  };
  const fileMenu = (e: React.MouseEvent, f: FileMeta) => {
    const isFolder = f.kind === "folder";
    showMenu(e, [
      ...(isFolder ? [
        { label: "New note", icon: "newNote", onClick: () => app.newNote(f.path) },
        { label: "New folder", icon: "newFolder", onClick: () => app.newFolder(f.path) },
        { label: "Search in folder", icon: "search", onClick: () => ws.search(`path:"${f.path}/"`) },
      ] : [
        { label: "Open in new tab", onClick: () => app.openFile(f.id, "tab") },
        { label: "Open to the right", icon: "split", onClick: () => app.openFile(f.id, "split") },
        ...(f.kind === "note" ? [{ label: "Make a copy", onClick: () => app.duplicate(f.id) }] : []),
      ]),
      { label: isFolder ? "Move folder to…" : "Move file to…", onClick: () => app.setModal({ kind: "move", arg: f.id }) },
      { label: "Bookmark", icon: "bookmark", onClick: async () => { await api(`${store.base()}/bookmarks`, { body: { type: isFolder ? "folder" : "file", path: f.path } }); window.dispatchEvent(new Event("bookmarks-changed")); toast("Bookmarked"); } },
      { label: "Copy path", onClick: () => navigator.clipboard?.writeText(f.path).then(() => toast("Path copied")) },
      { separator: true, label: "" },
      { label: "Rename…", icon: "edit", onClick: () => app.rename(f.id) },
      { label: "Delete", icon: "trash", danger: true, onClick: () => app.remove(f.id) },
    ]);
  };
  const onKey = (e: React.KeyboardEvent, f: FileMeta) => {
    const i = visible.findIndex(x => x.id === f.id);
    const focus = (x?: FileMeta) => x && document.querySelector<HTMLElement>(`[data-path="${CSS.escape(x.path)}"]`)?.focus();
    if (e.key === "ArrowDown") { e.preventDefault(); focus(visible[i + 1]); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focus(visible[i - 1]); }
    else if (e.key === "ArrowRight" && f.kind === "folder") { e.preventDefault(); ws.toggleExpanded(f.path, true); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); if (f.kind === "folder" && expanded.has(f.path)) ws.toggleExpanded(f.path, false); else focus(store.byPathGet(dirname(f.path))); }
    else if (e.key === "Enter") { e.preventDefault(); f.kind === "folder" ? ws.toggleExpanded(f.path) : app.openFile(f.id, e.ctrlKey || e.metaKey ? "tab" : "same"); }
    else if (e.key === "F2") { e.preventDefault(); e.stopPropagation(); app.rename(f.id); }
    else if (e.key === "Delete") { e.preventDefault(); app.remove(f.id); }
  };
  const row = (n: Node, depth: number): React.ReactNode => {
    const f = n.f; const isFolder = f.kind === "folder"; const open = expanded.has(f.path);
    const name = f.kind === "note" ? displayName(f.path) : basename(f.path);
    return (
      <li key={f.id} role="treeitem" aria-expanded={isFolder ? open : undefined} aria-selected={active?.id === f.id}>
        <div className={`tree-row ${active?.id === f.id ? "is-active" : ""} ${dropTarget === f.path && isFolder ? "is-drop" : ""}`} style={{ paddingLeft: 8 + depth * 16 }}
          tabIndex={0} data-path={f.path} draggable
          onDragStart={e => { e.dataTransfer.setData("application/x-file-id", String(f.id)); e.dataTransfer.setData("application/x-vault-path", f.path); e.dataTransfer.setData("text/plain", f.path); e.dataTransfer.effectAllowed = "copyMove"; }}
          onDragOver={e => allowDrop(e, isFolder ? f.path : dirname(f.path))} onDrop={e => onDrop(e, isFolder ? f.path : dirname(f.path))}
          onClick={e => isFolder ? ws.toggleExpanded(f.path) : app.openFile(f.id, e.ctrlKey || e.metaKey ? "tab" : "same")}
          onAuxClick={e => { if (e.button === 1 && !isFolder) app.openFile(f.id, "tab"); }}
          onContextMenu={e => fileMenu(e, f)} onKeyDown={e => onKey(e, f)}>
          {isFolder ? <Icon name={open ? "chevronDown" : "chevronRight"} size={14} /> : <span className="tree-spacer" />}
          <span className="tree-name">{name}</span>
          {f.kind === "attachment" && <span className="tree-ext">{f.path.split(".").pop()!.toUpperCase()}</span>}
        </div>
        {isFolder && open && n.children.length > 0 && <ul role="group">{n.children.map(c => row(c, depth + 1))}</ul>}
      </li>
    );
  };
  const sortMenu = (e: React.MouseEvent) => showMenu(e, ([["name-asc", "File name (A to Z)"], ["name-desc", "File name (Z to A)"], ["mtime-desc", "Modified time (new to old)"], ["mtime-asc", "Modified time (old to new)"], ["ctime-desc", "Created time (new to old)"], ["ctime-asc", "Created time (old to new)"]] as [Sort, string][]).map(([k, l]) => ({ label: (sort === k ? "✓ " : "") + l, onClick: () => setSort(k) })));
  const allFolders = store.list().filter(f => f.kind === "folder").map(f => f.path);
  return (
    <div className="explorer">
      <div className="pane-toolbar">
        <IconButton icon="newNote" label="New note" onClick={() => app.newNote()} />
        <IconButton icon="newFolder" label="New folder" onClick={() => app.newFolder()} />
        <IconButton icon="sort" label="Change sort order" onClick={sortMenu} />
        <IconButton icon={ws.s.expanded.length ? "collapse" : "expand"} label={ws.s.expanded.length ? "Collapse all" : "Expand all"} onClick={() => { ws.s.expanded = ws.s.expanded.length ? [] : allFolders; ws.save(); }} />
      </div>
      <ul className={`tree ${dropTarget === "" ? "is-drop" : ""}`} role="tree" aria-label="Files" onDragOver={e => allowDrop(e, "")} onDragLeave={() => setDropTarget(null)} onDrop={e => onDrop(e, "")}
        onContextMenu={e => { if (e.target === e.currentTarget) showMenu(e, [{ label: "New note", icon: "newNote", onClick: () => app.newNote("") }, { label: "New folder", icon: "newFolder", onClick: () => app.newFolder("") }]); }}>
        {tree.map(n => row(n, 0))}
        {!tree.length && <li className="pane-empty">This vault is empty. Create a note to start.</li>}
      </ul>
    </div>
  );
}
export { lc };
