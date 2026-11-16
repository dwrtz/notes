import React, { useEffect, useMemo, useRef, useState } from "react";
import { settings } from "../shared/settings";
import { displayName, basename } from "../shared/paths";
import { VaultStore, Vault, useEmitter } from "./store";
import { Workspace, Group, LayoutNode, Tab, LeftTab, RightTab } from "./workspace";
import { App, AppCtx, useApp, comboOf } from "./app";
import { Icon, IconButton, showMenu, toast } from "./ui";
import { FileExplorer } from "./FileExplorer";
import { SearchPane, BookmarksPane, TagsPane, BacklinksPane, OutgoingPane, OutlinePane, AllPropertiesPane } from "./Panes";
import { NoteView, FileView } from "./NoteView";
import { GraphView } from "./Graph";
import { Modals } from "./Modals";

export function VaultApp(p: { vault: Vault; vaults: Vault[]; me: { name: string; email: string }; now: () => string; signOut: () => void; switchVault: (id: number) => void; reloadVaults: () => void }) {
  const app = useMemo(() => { const st = new VaultStore(p.vault); st.now = p.now; return new App(st, new Workspace(p.vault.id), p.now, p.signOut, p.switchVault); }, [p.vault.id]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    localStorage.setItem("lastVault", String(p.vault.id));
    app.store.load().then(() => { app.ws.prune(id => !!app.store.file(id)); setReady(true); if (app.store.settings.openDailyOnStart) app.openDaily(); }).catch(e => toast(e.message));
    const stop = app.store.startPolling();
    const off = app.store.on(() => app.ws.prune(id => !!app.store.file(id)));
    const flush = () => { app.store.flushAll(); };
    window.addEventListener("beforeunload", flush); document.addEventListener("visibilitychange", flush);
    return () => { stop(); off(); window.removeEventListener("beforeunload", flush); document.removeEventListener("visibilitychange", flush); app.store.flushAll(); };
  }, [app]);
  // Global hotkeys (the editor handles its own formatting keys first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || app.modal) return;
      const combo = comboOf(e); if (!combo) return;
      const inField = (e.target as HTMLElement)?.closest?.("input, textarea, select");
      const cmd = app.commands().find(c => c.key === combo);
      if (!cmd) return;
      if (inField && !combo.includes("Mod") && !/^F\d+$/.test(combo)) return;
      if (cmd.check && !cmd.check()) return;
      e.preventDefault(); cmd.run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [app]);
  if (!ready) return <div className="splash" role="status">Opening {p.vault.name}…</div>;
  return <AppCtx.Provider value={app}><ShellView {...p} /></AppCtx.Provider>;
}

function ShellView(p: { vault: Vault; vaults: Vault[]; me: { name: string; email: string }; reloadVaults: () => void }) {
  const app = useApp(); const { ws, store } = app;
  useEmitter(ws); useEmitter(store);
  const [mobile, setMobile] = useState(window.innerWidth < 768);
  // On a phone the sidebars are drawers: start with both closed.
  useEffect(() => { if (window.innerWidth < 768) { ws.setLeft({ open: false }); ws.setRight({ open: false }); } }, []);
  useEffect(() => { const r = () => setMobile(window.innerWidth < 768); window.addEventListener("resize", r); return () => window.removeEventListener("resize", r); }, []);
  const s = ws.s;
  const active = ws.activeTab();
  const activeFile = "fileId" in active.view ? store.file(active.view.fileId) : undefined;
  useEffect(() => { document.title = activeFile ? `${displayName(activeFile.path)} - ${p.vault.name} - ${settings.appName}` : `${p.vault.name} - ${settings.appName}`; }, [activeFile?.path]);
  const leftTabs: [LeftTab, string, string][] = [["files", "folder", "Files"], ["search", "search", "Search"], ["bookmarks", "bookmark", "Bookmarks"], ["tags", "tag", "Tags"]];
  const rightTabs: [RightTab, string, string][] = [["backlinks", "arrowIn", "Backlinks"], ["outgoing", "arrowOut", "Outgoing links"], ["outline", "list", "Outline"], ["localgraph", "graph", "Local graph"], ["properties", "property", "All properties"]];
  const vaultMenu = (e: React.MouseEvent) => showMenu(e, [
    ...p.vaults.map(v => ({ label: v.name + (v.id === p.vault.id ? " ✓" : ""), icon: "book", onClick: () => v.id !== p.vault.id && app.switchVault(v.id) })),
    { separator: true, label: "" }, { label: "Manage vaults…", icon: "gear", onClick: () => app.setModal({ kind: "settings", arg: "vaults" }) },
  ]);
  return (
    <div className={`app ${s.left.open ? "left-open" : ""} ${s.right.open ? "right-open" : ""} ${mobile ? "is-mobile" : ""}`}>
      {!mobile && <nav className="ribbon" aria-label="Ribbon">
        <IconButton icon="sidebarLeft" label="Toggle left sidebar" onClick={() => ws.setLeft({ open: !s.left.open })} />
        <IconButton icon="search" label="Open quick switcher" onClick={() => app.setModal({ kind: "switcher" })} />
        <IconButton icon="graph" label="Open graph view" onClick={() => ws.open({ type: "graph" }, "tab")} />
        <IconButton icon="calendar" label="Open today's daily note" onClick={() => app.openDaily()} />
        <IconButton icon="template" label="Insert template" onClick={() => app.commands().find(c => c.id === "templates:insert")!.run()} />
        <IconButton icon="command" label="Open command palette" onClick={() => app.setModal({ kind: "palette" })} />
        <IconButton icon="dice" label="Open random note" onClick={() => app.commands().find(c => c.id === "random:open")!.run()} />
        <div className="grow" />
        <IconButton icon={document.documentElement.dataset.theme === "dark" ? "sun" : "moon"} label="Toggle light/dark mode" onClick={() => app.setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")} />
        <IconButton icon="gear" label="Settings" onClick={() => app.setModal({ kind: "settings" })} />
      </nav>}
      {mobile && <header className="mobile-top">
        <IconButton icon="menu" label="Open left sidebar" onClick={() => ws.setLeft({ open: !s.left.open })} />
        <div className="mobile-title">{activeFile ? displayName(activeFile.path) : active.view.type === "graph" ? "Graph" : "New tab"}</div>
        <IconButton icon="sidebarRight" label="Open right sidebar" onClick={() => ws.setRight({ open: !s.right.open })} />
      </header>}
      {s.left.open && <aside className="sidebar left" style={{ width: mobile ? undefined : s.left.width }} aria-label="Left sidebar">
        <div className="side-tabs" role="tablist">
          {leftTabs.map(([k, ic, label]) => <button key={k} role="tab" aria-selected={s.left.tab === k} className={`side-tab ${s.left.tab === k ? "is-active" : ""}`} title={label} aria-label={label} onClick={() => ws.setLeft({ tab: k })}><Icon name={ic} /></button>)}
        </div>
        <div className="side-body">
          {s.left.tab === "files" && <FileExplorer />}
          {s.left.tab === "search" && <SearchPane />}
          {s.left.tab === "bookmarks" && <BookmarksPane />}
          {s.left.tab === "tags" && <TagsPane />}
        </div>
        <div className="vault-footer">
          <button className="vault-switch" onClick={vaultMenu} aria-label="Switch vault"><Icon name="book" /><span>{p.vault.name}</span><Icon name="chevronDown" size={12} /></button>
          {mobile && <IconButton icon="gear" label="Settings" onClick={() => app.setModal({ kind: "settings" })} />}
        </div>
        {!mobile && <Resizer side="left" />}
      </aside>}
      <main className="workspace">
        <LayoutView node={s.root} />
      </main>
      {s.right.open && <aside className="sidebar right" style={{ width: mobile ? undefined : s.right.width }} aria-label="Right sidebar">
        {!mobile && <Resizer side="right" />}
        <div className="side-tabs" role="tablist">
          {rightTabs.map(([k, ic, label]) => <button key={k} role="tab" aria-selected={s.right.tab === k} className={`side-tab ${s.right.tab === k ? "is-active" : ""}`} title={label} aria-label={label} onClick={() => ws.setRight({ tab: k })}><Icon name={ic} /></button>)}
        </div>
        <div className="side-body">
          {s.right.tab === "backlinks" && <BacklinksPane file={activeFile} />}
          {s.right.tab === "outgoing" && <OutgoingPane file={activeFile} />}
          {s.right.tab === "outline" && <OutlinePane file={activeFile} />}
          {s.right.tab === "localgraph" && (activeFile ? <GraphView local={activeFile.id} /> : <div className="pane-empty">No file is open.</div>)}
          {s.right.tab === "properties" && <AllPropertiesPane />}
        </div>
      </aside>}
      {mobile && (s.left.open || s.right.open) && <div className="drawer-bg" onClick={() => { ws.setLeft({ open: false }); ws.setRight({ open: false }); }} />}
      {!mobile && <StatusBar />}
      {mobile && <nav className="mobile-bar" aria-label="Toolbar">
        <IconButton icon="back" label="Navigate back" onClick={() => ws.go(-1)} />
        <IconButton icon="forward" label="Navigate forward" onClick={() => ws.go(1)} />
        <IconButton icon="plus" label="Create new note" onClick={() => app.newNote()} />
        <IconButton icon="search" label="Open quick switcher" onClick={() => app.setModal({ kind: "switcher" })} />
        <button className="tab-count" aria-label="Tabs" onClick={e => showMenu(e, ws.group().tabs.map(t => ({ label: tabTitle(app, t), onClick: () => ws.activate(ws.group().id, t.id) })))}>{ws.group().tabs.length}</button>
        <IconButton icon="command" label="Open command palette" onClick={() => app.setModal({ kind: "palette" })} />
      </nav>}
      <Modals vaults={p.vaults} me={p.me} reloadVaults={p.reloadVaults} />
    </div>
  );
}

function Resizer({ side }: { side: "left" | "right" }) {
  const app = useApp();
  const down = (e: React.PointerEvent) => {
    e.preventDefault(); const start = e.clientX; const w0 = side === "left" ? app.ws.s.left.width : app.ws.s.right.width;
    const move = (ev: PointerEvent) => { const w = Math.max(180, Math.min(520, w0 + (side === "left" ? ev.clientX - start : start - ev.clientX))); side === "left" ? app.ws.setLeft({ width: w }) : app.ws.setRight({ width: w }); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  return <div className={`resizer resizer-${side}`} onPointerDown={down} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" />;
}

function StatusBar() {
  const app = useApp(); const { store, ws } = app;
  const [, bump] = useState(0);
  useEffect(() => { const h = () => bump(x => x + 1); window.addEventListener("doc-changed", h); return () => window.removeEventListener("doc-changed", h); }, []);
  const t = ws.activeTab(); const f = "fileId" in t.view ? store.file(t.view.fileId) : undefined;
  const text = f && f.kind === "note" ? store.cached(f.id) ?? "" : "";
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const words = (body.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  const mode = t.mode ?? store.settings.defaultMode;
  return (
    <footer className="statusbar">
      <span className="sync" data-state={store.syncState}>{({ saved: "Saved", saving: "Saving…", offline: "Offline – changes are kept here until you reconnect", error: "Not saved – retrying" } as Record<string, string>)[store.syncState]}</span>
      {f?.kind === "note" && <>
        <button className="status-btn" onClick={() => ws.setRight({ open: true, tab: "backlinks" })}>Backlinks</button>
        <span>{words} {words === 1 ? "word" : "words"} {body.length} characters</span>
        <button className="status-btn" aria-label="Change view mode" onClick={e => showMenu(e, [
          { label: "Live preview", onClick: () => ws.setMode(t.id, "live") }, { label: "Source mode", onClick: () => ws.setMode(t.id, "source") }, { label: "Reading view", onClick: () => ws.setMode(t.id, "reading") }])}>
          {mode === "reading" ? "Reading" : mode === "source" ? "Source" : "Live preview"}
        </button>
      </>}
    </footer>
  );
}

export function tabTitle(app: App, t: Tab) {
  if (t.view.type === "graph") return "Graph view";
  if (t.view.type === "empty") return "New tab";
  const f = app.store.file(t.view.fileId); return f ? (f.kind === "note" ? displayName(f.path) : basename(f.path)) : "Missing file";
}

function LayoutView({ node }: { node: LayoutNode }) {
  const app = useApp();
  if (node.kind === "group") return <GroupView g={node} />;
  const startResize = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    const el = (e.currentTarget as HTMLElement).parentElement!; const rect = el.getBoundingClientRect();
    const total = node.dir === "row" ? rect.width : rect.height; const sizes0 = [...node.sizes];
    const start = node.dir === "row" ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => {
      const d = ((node.dir === "row" ? ev.clientX : ev.clientY) - start) / total;
      const a = Math.max(0.1, sizes0[i] + d), b = Math.max(0.1, sizes0[i] + sizes0[i + 1] - a);
      const s = [...sizes0]; s[i] = sizes0[i] + sizes0[i + 1] - b; s[i + 1] = b; app.ws.resize(node.id, s);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  return (
    <div className={`split split-${node.dir}`}>
      {node.children.map((c, i) => (
        <React.Fragment key={c.id}>
          <div className="split-child" style={{ flex: `${node.sizes[i]} 1 0` }}><LayoutView node={c} /></div>
          {i < node.children.length - 1 && <div className={`split-handle split-handle-${node.dir}`} role="separator" onPointerDown={e => startResize(i, e)} />}
        </React.Fragment>
      ))}
    </div>
  );
}

function GroupView({ g }: { g: Group }) {
  const app = useApp(); const { ws } = app;
  const active = g.tabs.find(t => t.id === g.active) ?? g.tabs[0];
  const isActiveGroup = ws.s.activeGroup === g.id && ws.groups().length > 1;
  const [dropAt, setDropAt] = useState<number | null>(null);
  const tabMenu = (e: React.MouseEvent, t: Tab) => showMenu(e, [
    { label: "Close", icon: "x", onClick: () => ws.closeTab(g.id, t.id) },
    { label: "Close others", onClick: () => ws.closeOthers(g.id, t.id) },
    { label: t.pinned ? "Unpin" : "Pin", icon: "pin", onClick: () => ws.togglePin(g.id, t.id) },
    { separator: true, label: "" },
    { label: "Split right", icon: "split", onClick: () => { ws.activate(g.id, t.id); ws.splitActive("row"); } },
    { label: "Split down", onClick: () => { ws.activate(g.id, t.id); ws.splitActive("col"); } },
    ...("fileId" in t.view || t.view.type === "graph" ? [{ label: "Bookmark", icon: "bookmark", onClick: () => { ws.activate(g.id, t.id); app.bookmarkActive(); } }] : []),
  ]);
  return (
    <section className={`tab-group ${ws.s.activeGroup === g.id ? "is-current" : ""} ${isActiveGroup ? "is-focused" : ""}`} onMouseDown={() => ws.focusGroup(g.id)} aria-label="Tab group">
      <div className="tab-bar" role="tablist" onDragOver={e => { if (e.dataTransfer.types.includes("application/x-tab")) { e.preventDefault(); setDropAt(g.tabs.length); } }} onDragLeave={() => setDropAt(null)}
        onDrop={e => { const id = e.dataTransfer.getData("application/x-tab"); if (id) { e.preventDefault(); ws.moveTab(id, g.id, dropAt ?? g.tabs.length); } setDropAt(null); }}>
        <IconButton icon="back" label="Navigate back" disabled={!active.back.length} onClick={() => { ws.activate(g.id, active.id); ws.go(-1); }} />
        <IconButton icon="forward" label="Navigate forward" disabled={!active.fwd.length} onClick={() => { ws.activate(g.id, active.id); ws.go(1); }} />
        <div className="tabs">
          {g.tabs.map((t, i) => (
            <div key={t.id} role="tab" aria-selected={t.id === active.id} tabIndex={0} draggable className={`tab ${t.id === active.id ? "is-active" : ""} ${dropAt === i ? "drop-before" : ""}`}
              onClick={() => ws.activate(g.id, t.id)} onAuxClick={e => { if (e.button === 1) ws.closeTab(g.id, t.id); }} onContextMenu={e => tabMenu(e, t)}
              onKeyDown={e => { if (e.key === "Enter") ws.activate(g.id, t.id); }}
              onDragStart={e => { e.dataTransfer.setData("application/x-tab", t.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={e => { if (e.dataTransfer.types.includes("application/x-tab")) { e.preventDefault(); e.stopPropagation(); setDropAt(i); } }}
              onDrop={e => { const id = e.dataTransfer.getData("application/x-tab"); if (id) { e.preventDefault(); e.stopPropagation(); ws.moveTab(id, g.id, i); } setDropAt(null); }}>
              {t.pinned && <Icon name="pin" size={12} />}
              <span className="tab-title">{tabTitle(app, t)}</span>
              {!t.pinned && <button className="tab-close" aria-label={`Close ${tabTitle(app, t)}`} onClick={e => { e.stopPropagation(); ws.closeTab(g.id, t.id); }}><Icon name="x" size={12} /></button>}
            </div>
          ))}
          <IconButton icon="plus" label="New tab" onClick={() => { ws.focusGroup(g.id); ws.newTab(); }} />
        </div>
        <IconButton icon="more" label="Tab group options" onClick={e => showMenu(e, [
          { label: "Split right", icon: "split", onClick: () => ws.splitActive("row", undefined, g.id) },
          { label: "Split down", onClick: () => ws.splitActive("col", undefined, g.id) },
          { label: "Close all tabs", icon: "x", onClick: () => [...g.tabs].forEach(t => ws.closeTab(g.id, t.id)) },
        ])} />
      </div>
      <div className="tab-content" key={active.id}>
        <TabContent tab={active} group={g} />
      </div>
    </section>
  );
}

function TabContent({ tab, group }: { tab: Tab; group: Group }) {
  const app = useApp();
  const v = tab.view;
  if (v.type === "note") return <NoteView key={v.fileId} tab={tab} fileId={v.fileId} />;
  if (v.type === "file") return <FileView fileId={v.fileId} />;
  if (v.type === "graph") return <GraphView />;
  void group;
  return (
    <div className="empty-view">
      <div className="empty-actions">
        <button className="link-btn" onClick={() => app.newNote()}>Create new note <kbd>{isMacLabel("Mod+N")}</kbd></button>
        <button className="link-btn" onClick={() => app.setModal({ kind: "switcher" })}>Go to file <kbd>{isMacLabel("Mod+O")}</kbd></button>
        <button className="link-btn" onClick={() => app.openDaily()}>Open today's daily note</button>
        <button className="link-btn" onClick={() => { const g = app.ws.group(); app.ws.closeTab(g.id, g.active); }}>Close</button>
      </div>
    </div>
  );
}
import { comboLabel as isMacLabel } from "./app";
export { useRef };
