import React, { useEffect, useMemo, useState } from "react";
import { useApp } from "./app";
import { useEmitter, FileMeta } from "./store";
import { api, ApiError } from "./api";
import { Icon, IconButton, showMenu, toast, prompt } from "./ui";
import { displayName, basename, wikilink, mdlink } from "../shared/paths";
import { parseNote } from "../shared/parse";
import { findMentionsClient } from "./mentions";

function Highlight({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: React.ReactNode[] = []; let at = 0;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) { if (a < at) continue; parts.push(text.slice(at, a)); parts.push(<mark key={a}>{text.slice(a, b)}</mark>); at = b; }
  parts.push(text.slice(at)); return <>{parts}</>;
}
function useDebounced<T>(v: T, ms: number) { const [d, setD] = useState(v); useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]); return d; }

// ---------------- Search ----------------
interface Result { id: number; path: string; kind: string; matches: { line: number; text: string; ranges: [number, number][] }[]; matchCount: number }
export function SearchPane() {
  const app = useApp(); const { store, ws } = app; useEmitter(ws);
  const [q, setQ] = useState(ws.s.search.query);
  const [matchCase, setMatchCase] = useState(false);
  const [sort, setSort] = useState("name-asc");
  const [explainOn, setExplainOn] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [more, setMore] = useState(false);
  const [res, setRes] = useState<{ results: Result[]; total: number; explain: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const recent: string[] = JSON.parse(localStorage.getItem(`recentSearch:${store.vault.id}`) || "[]");
  useEffect(() => { setQ(ws.s.search.query); }, [ws.s.search.n]);
  const dq = useDebounced(q, 250);
  useEffect(() => {
    if (!dq.trim()) { setRes(null); setErr(null); return; }
    let live = true;
    api(`${store.base()}/search?q=${encodeURIComponent(dq)}&sort=${sort}${matchCase ? "&case=1" : ""}`).then(r => {
      if (!live) return; setRes(r); setErr(null);
      const rs = [dq, ...recent.filter(x => x !== dq)].slice(0, 10); localStorage.setItem(`recentSearch:${store.vault.id}`, JSON.stringify(rs));
    }).catch(e => live && (setErr(e instanceof ApiError ? e.message : "Search failed"), setRes(null)));
    return () => { live = false; };
  }, [dq, sort, matchCase, store.seq]);
  const copy = () => { if (!res) return; navigator.clipboard?.writeText(res.results.map(r => `- ${wikilink(store.linktext(store.file(r.id)!, ""))}`).join("\n")).then(() => toast("Results copied")); };
  return (
    <div className="search-pane">
      <div className="search-row">
        <Icon name="search" />
        <input className="search-input" value={q} onChange={e => setQ(e.target.value)} placeholder="Search…" aria-label="Search" spellCheck={false} />
        {q && <IconButton icon="x" label="Clear search" onClick={() => setQ("")} />}
        <IconButton icon="code" label="Match case" active={matchCase} onClick={() => setMatchCase(!matchCase)} />
      </div>
      <div className="search-options">
        <label className="check"><input type="checkbox" checked={explainOn} onChange={e => setExplainOn(e.target.checked)} /> Explain search term</label>
        <label className="check"><input type="checkbox" checked={collapsed} onChange={e => setCollapsed(e.target.checked)} /> Collapse results</label>
        <label className="check"><input type="checkbox" checked={more} onChange={e => setMore(e.target.checked)} /> Show more context</label>
      </div>
      {err && <div className="field-error" role="alert">{err}</div>}
      {explainOn && res?.explain && <pre className="explain">{res.explain}</pre>}
      {!q.trim() && recent.length > 0 && <div className="recent"><div className="pane-label">Recent searches</div>{recent.map(r => <button key={r} className="recent-item" onClick={() => setQ(r)}>{r}</button>)}</div>}
      {res && <div className="results-head">
        <span>{res.total} {res.total === 1 ? "result" : "results"}</span>
        <select aria-label="Sort results" value={sort} onChange={e => setSort(e.target.value)}>
          <option value="name-asc">File name (A to Z)</option><option value="name-desc">File name (Z to A)</option>
          <option value="mtime-desc">Modified time (new to old)</option><option value="mtime-asc">Modified time (old to new)</option>
          <option value="ctime-desc">Created time (new to old)</option><option value="ctime-asc">Created time (old to new)</option>
        </select>
        <IconButton icon="more" label="More search options" onClick={e => showMenu(e, [{ label: "Copy search results", onClick: copy }, { label: "Bookmark this search", icon: "bookmark", onClick: async () => { await api(`${store.base()}/bookmarks`, { body: { type: "search", query: q } }); window.dispatchEvent(new Event("bookmarks-changed")); toast("Bookmarked"); } }])} />
      </div>}
      <ul className="results" aria-label="Search results">
        {res?.results.map(r => (
          <li key={r.id} className="result">
            <div className="result-title">
              {r.matches.length > 0 && <button className="icon-btn small" aria-label={closed.has(r.id) ? "Expand" : "Collapse"} onClick={() => { const s = new Set(closed); s.has(r.id) ? s.delete(r.id) : s.add(r.id); setClosed(s); }}><Icon name={collapsed || closed.has(r.id) ? "chevronRight" : "chevronDown"} size={12} /></button>}
              <button className="link-btn" onClick={e => app.openFile(r.id, e.ctrlKey || e.metaKey ? "tab" : "same")}>{r.kind === "note" ? displayName(r.path) : basename(r.path)}</button>
              <span className="result-count">{r.matchCount || ""}</span>
            </div>
            {!collapsed && !closed.has(r.id) && r.matches.map(m => (
              <button key={m.line} className="result-match" onClick={e => app.openFile(r.id, e.ctrlKey || e.metaKey ? "tab" : "same", m.line)}>
                <Highlight text={more ? m.text : clip(m.text, m.ranges)} ranges={more ? m.ranges : shift(m.text, m.ranges)} />
              </button>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
function clipStart(text: string, ranges: [number, number][]) { const a = ranges[0]?.[0] ?? 0; return a > 60 ? a - 40 : 0; }
function clip(text: string, ranges: [number, number][]) { const s = clipStart(text, ranges); return (s ? "…" : "") + text.slice(s, s + 160); }
function shift(text: string, ranges: [number, number][]) { const s = clipStart(text, ranges); const d = s ? s - 1 : 0; return ranges.map(([a, b]) => [a - d, b - d] as [number, number]).filter(([a]) => a >= 0 && a < 161); }

// ---------------- Bookmarks ----------------
interface Bm { id: number; parentId: number | null; position: number; type: string; title: string | null; path: string | null; subpath: string | null; query: string | null }
export function BookmarksPane() {
  const app = useApp(); const { store, ws } = app; useEmitter(store);
  const [list, setList] = useState<Bm[]>([]);
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const [drop, setDrop] = useState<string | null>(null);
  const load = () => api<Bm[]>(`${store.base()}/bookmarks`).then(setList).catch(() => {});
  useEffect(() => { load(); const h = () => load(); window.addEventListener("bookmarks-changed", h); return () => window.removeEventListener("bookmarks-changed", h); }, []);
  const label = (b: Bm) => b.title || (b.type === "search" ? b.query : b.type === "graph" ? "Graph" : b.path ? displayName(b.path) + (b.subpath ? " > " + b.subpath.slice(1).replace(/^\^/, "") : "") : "Bookmark");
  const icon = (b: Bm) => ({ group: "folder", file: "file", folder: "folder", search: "search", heading: "list", block: "list", graph: "graph" } as Record<string, string>)[b.type];
  const open = (b: Bm, e: React.MouseEvent) => {
    if (b.type === "group") { const s = new Set(closed); s.has(b.id) ? s.delete(b.id) : s.add(b.id); setClosed(s); return; }
    if (b.type === "search") { ws.search(b.query || ""); return; }
    if (b.type === "graph") { ws.open({ type: "graph" }, "tab"); return; }
    const f = b.path ? store.byPathGet(b.path) : undefined;
    if (!f) { toast("That file is no longer in this vault"); return; }
    if (b.type === "folder") { const parts = f.path.split("/"); for (let i = 1; i <= parts.length; i++) ws.toggleExpanded(parts.slice(0, i).join("/"), true); ws.setLeft({ tab: "files" }); return; }
    app.openLink(f.path + (b.subpath || ""), "", e.ctrlKey || e.metaKey);
  };
  const patch = async (id: number, body: object) => { await api(`${store.base()}/bookmarks/${id}`, { method: "PATCH", body }); load(); };
  const menu = (e: React.MouseEvent, b: Bm) => showMenu(e, [
    { label: b.type === "group" ? "Rename" : "Edit title", icon: "edit", onClick: async () => { const t = await prompt(b.type === "group" ? "Rename group" : "Edit bookmark", { value: b.title || "", label: "Title" }); if (t != null) patch(b.id, { title: t }); } },
    ...(b.type !== "group" ? [{ label: "Move out of group", disabled: !b.parentId, onClick: () => patch(b.id, { parentId: null }) }] : []),
    { label: "Remove", icon: "trash", danger: true, onClick: async () => { await api(`${store.base()}/bookmarks/${b.id}`, { method: "DELETE" }); load(); } },
  ]);
  const onDrop = async (e: React.DragEvent, target: Bm | null, into: boolean) => {
    e.preventDefault(); e.stopPropagation(); setDrop(null);
    const id = Number(e.dataTransfer.getData("application/x-bookmark")); if (!id || id === target?.id) return;
    if (target && into && target.type === "group") { await patch(id, { parentId: target.id, position: Math.max(0, ...list.filter(x => x.parentId === target.id).map(x => x.position)) + 1 }); return; }
    if (!target) { await patch(id, { parentId: null, position: Math.max(0, ...list.map(x => x.position)) + 1 }); return; }
    const sibs = list.filter(x => x.parentId === target.parentId).sort((a, b) => a.position - b.position);
    const i = sibs.findIndex(x => x.id === target.id); const prev = sibs[i - 1]?.position ?? target.position - 1;
    await patch(id, { parentId: target.parentId, position: (prev + target.position) / 2 });
  };
  const item = (b: Bm): React.ReactNode => (
    <li key={b.id}>
      <div className={`tree-row ${drop === String(b.id) ? "is-drop" : ""}`} data-bookmark={b.id} tabIndex={0} draggable onClick={e => open(b, e)} onKeyDown={e => { if (e.key === "Enter") open(b, e as any); }} onContextMenu={e => menu(e, b)}
        onDragStart={e => { e.dataTransfer.setData("application/x-bookmark", String(b.id)); }}
        onDragOver={e => { if (e.dataTransfer.types.includes("application/x-bookmark")) { e.preventDefault(); setDrop(String(b.id)); } }}
        onDrop={e => onDrop(e, b, b.type === "group")} title={b.path || b.query || ""}>
        {b.type === "group" ? <Icon name={closed.has(b.id) ? "chevronRight" : "chevronDown"} size={14} /> : <Icon name={icon(b)} size={14} />}
        <span className="tree-name">{label(b)}</span>
      </div>
      {b.type === "group" && !closed.has(b.id) && <ul>{list.filter(x => x.parentId === b.id).map(item)}</ul>}
    </li>
  );
  return (
    <div className="bookmarks">
      <div className="pane-toolbar">
        <IconButton icon="bookmark" label="Bookmark the active tab" onClick={async () => { await app.bookmarkActive(); load(); }} />
        <IconButton icon="newFolder" label="New bookmark group" onClick={async () => { const t = await prompt("New bookmark group", { label: "Name", ok: "Create" }); if (t?.trim()) { await api(`${store.base()}/bookmarks`, { body: { type: "group", title: t } }); load(); } }} />
      </div>
      <ul className="tree" onDragOver={e => { if (e.dataTransfer.types.includes("application/x-bookmark")) e.preventDefault(); }} onDrop={e => onDrop(e, null, false)}>
        {list.filter(b => !b.parentId).map(item)}
        {!list.length && <li className="pane-empty">No bookmarks yet. Bookmark a note, folder, search or the graph to find it here.</li>}
      </ul>
    </div>
  );
}

// ---------------- Tags ----------------
export function TagsPane() {
  const app = useApp(); const { store, ws } = app; useEmitter(store);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [byCount, setByCount] = useState(false); const [nested, setNested] = useState(true);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  useEffect(() => { api(`${store.base()}/tags`).then(setTags).catch(() => {}); }, [store.seq]);
  const click = (tag: string, e: React.MouseEvent) => {
    const term = `tag:#${tag}`;
    if (e.ctrlKey || e.metaKey) { const q = ws.s.search.query; ws.search(q.includes(term) ? q.replace(term, "").trim() : `${q} ${term}`.trim()); }
    else ws.search(term);
  };
  type T = { name: string; full: string; count: number; total: number; kids: Map<string, T> };
  const root: T = { name: "", full: "", count: 0, total: 0, kids: new Map() };
  for (const t of tags) {
    if (!nested) { root.kids.set(t.tag, { name: t.tag, full: t.tag, count: t.count, total: t.count, kids: new Map() }); continue; }
    let cur = root; const parts = t.tag.split("/");
    parts.forEach((p, i) => { const full = parts.slice(0, i + 1).join("/"); const k = p.toLowerCase(); if (!cur.kids.has(k)) cur.kids.set(k, { name: p, full, count: 0, total: 0, kids: new Map() }); cur = cur.kids.get(k)!; cur.total += t.count; if (i === parts.length - 1) cur.count = t.count; });
  }
  const sorted = (m: Map<string, T>) => [...m.values()].sort((a, b) => byCount ? b.total - a.total || a.name.localeCompare(b.name) : a.name.localeCompare(b.name));
  const node = (t: T, depth: number): React.ReactNode => (
    <li key={t.full}>
      <div className="tree-row tag-row" style={{ paddingLeft: 8 + depth * 16 }}>
        {t.kids.size ? <button className="icon-btn small" aria-label={closed.has(t.full) ? `Expand ${t.full}` : `Collapse ${t.full}`} onClick={() => { const s = new Set(closed); s.has(t.full) ? s.delete(t.full) : s.add(t.full); setClosed(s); }}><Icon name={closed.has(t.full) ? "chevronRight" : "chevronDown"} size={12} /></button> : <span className="tree-spacer" />}
        <button className="tag-name" onClick={e => click(t.full, e)}>#{t.name}</button>
        <span className="tag-count">{t.total}</span>
      </div>
      {t.kids.size > 0 && !closed.has(t.full) && <ul>{sorted(t.kids).map(k => node(k, depth + 1))}</ul>}
    </li>
  );
  return (
    <div className="tags-pane">
      <div className="pane-toolbar">
        <IconButton icon="sort" label={byCount ? "Sort by tag name" : "Sort by frequency"} onClick={() => setByCount(!byCount)} />
        <IconButton icon="list" label={nested ? "Show tags as a flat list" : "Show nested tags"} onClick={() => setNested(!nested)} />
        <IconButton icon="expand" label="Expand all" onClick={() => setClosed(new Set())} />
        <IconButton icon="collapse" label="Collapse all" onClick={() => setClosed(new Set(tags.map(t => t.tag.split("/")[0]).concat(tags.map(t => t.tag))))} />
      </div>
      <ul className="tree" aria-label="Tags">{sorted(root.kids).map(t => node(t, 0))}</ul>
      {!tags.length && <div className="pane-empty">No tags yet. Add #tags to notes or a tags property.</div>}
    </div>
  );
}

// ---------------- Backlinks ----------------
interface Mention { line: number; text: string; start?: number; end?: number; name?: string }
interface BlFile { id: number; path: string; mtime: string; mentions: Mention[] }
export function BacklinksPane({ file }: { file?: FileMeta }) {
  const app = useApp(); const { store } = app; useEmitter(store);
  const [data, setData] = useState<{ linked: BlFile[]; unlinked: BlFile[] } | null>(null);
  const [open, setOpen] = useState({ linked: true, unlinked: true });
  const [collapsed, setCollapsed] = useState(false); const [more, setMore] = useState(false);
  const [filter, setFilter] = useState(""); const [showFilter, setShowFilter] = useState(false);
  const [sortDesc, setSortDesc] = useState(false);
  const seq = useDebounced(store.seq, 400);
  useEffect(() => { if (!file) { setData(null); return; } let live = true; api(`${store.base()}/files/${file.id}/backlinks`).then(d => live && setData(d)).catch(() => {}); return () => { live = false; }; }, [file?.id, seq]);
  if (!file) return <div className="pane-empty">No file is open.</div>;
  const f = filter.toLowerCase();
  const show = (xs: BlFile[]) => xs.filter(x => !f || x.path.toLowerCase().includes(f) || x.mentions.some(m => m.text.toLowerCase().includes(f))).sort((a, b) => sortDesc ? b.mtime.localeCompare(a.mtime) : a.path.localeCompare(b.path));
  const linkIt = async (src: BlFile, m: Mention) => {
    const text = await store.note(src.id);
    const lines = text.split("\n"); const line = lines[m.line] ?? "";
    const got = line.slice(m.start!, m.end!);
    if (got.toLowerCase() !== (m.name || "").toLowerCase()) { toast("That note changed. Try again."); return; }
    const lt = store.linktext(file, src.path); const nameOnly = displayName(file.path);
    const link = store.settings.useWikilinks ? wikilink(lt, "", got === nameOnly ? null : got) : mdlink(file.path, lt, "", got);
    lines[m.line] = line.slice(0, m.start) + link + line.slice(m.end);
    store.setText(src.id, lines.join("\n")); await store.flush(src.id);
    store.remoteChanged.add(src.id); store.remote.emit();
    setData(await api(`${store.base()}/files/${file.id}/backlinks`));
  };
  const section = (key: "linked" | "unlinked", title: string, xs: BlFile[]) => (
    <div className="bl-section">
      <button className="bl-head" aria-expanded={open[key]} onClick={() => setOpen({ ...open, [key]: !open[key] })}><Icon name={open[key] ? "chevronDown" : "chevronRight"} size={12} />{title}<span className="tag-count">{xs.length}</span></button>
      {open[key] && <ul className="results">{xs.map(x => (
        <li key={x.id} className="result">
          <div className="result-title"><button className="link-btn" onClick={e => app.openFile(x.id, e.ctrlKey || e.metaKey ? "tab" : "same")}>{displayName(x.path)}</button><span className="result-count">{x.mentions.length}</span></div>
          {!collapsed && x.mentions.map((m, i) => (
            <div key={i} className="result-match-row">
              <button className="result-match" onClick={() => app.openFile(x.id, "same", m.line)}>{m.start != null ? <Highlight text={more ? m.text : m.text.slice(0, 200)} ranges={[[m.start, m.end!]]} /> : (more ? m.text : m.text.slice(0, 200))}</button>
              {key === "unlinked" && <button className="btn small" onClick={() => linkIt(x, m)}>Link</button>}
            </div>
          ))}
        </li>))}
        {!xs.length && <li className="pane-empty">{key === "linked" ? "No backlinks found." : "No unlinked mentions found."}</li>}
      </ul>}
    </div>
  );
  return (
    <div className="backlinks">
      <div className="pane-toolbar">
        <IconButton icon="list" label={collapsed ? "Expand results" : "Collapse results"} active={collapsed} onClick={() => setCollapsed(!collapsed)} />
        <IconButton icon="expand" label="Show more context" active={more} onClick={() => setMore(!more)} />
        <IconButton icon="sort" label={sortDesc ? "Sort by file name" : "Sort by modified time"} onClick={() => setSortDesc(!sortDesc)} />
        <IconButton icon="search" label="Show search filter" active={showFilter} onClick={() => setShowFilter(!showFilter)} />
      </div>
      {showFilter && <input className="pane-filter" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter…" aria-label="Filter backlinks" />}
      <div className="pane-label">Backlinks for {displayName(file.path)}</div>
      {!data ? <div className="pane-empty">Loading…</div> : <>{section("linked", "Linked mentions", show(data.linked))}{section("unlinked", "Unlinked mentions", show(data.unlinked))}</>}
    </div>
  );
}

// ---------------- Outgoing links ----------------
export function OutgoingPane({ file }: { file?: FileMeta }) {
  const app = useApp(); const { store } = app; useEmitter(store);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => { if (file?.kind === "note") store.note(file.id).then(setText).catch(() => {}); else setText(null); }, [file?.id, file?.version, store.seq]);
  const t = file ? store.cached(file.id) ?? text : null;
  const parsed = useMemo(() => (t != null ? parseNote(t) : null), [t]);
  if (!file || file.kind !== "note") return <div className="pane-empty">No note is open.</div>;
  if (!parsed) return <div className="pane-empty">Loading…</div>;
  const seen = new Set<string>(); const links: { key: string; label: string; f?: FileMeta; href: string }[] = [];
  for (const l of parsed.links) {
    if (!l.linkpath) continue;
    const f = store.resolve(l.linkpath, file.path) ?? undefined; const key = f ? `f${f.id}` : `u${l.linkpath.toLowerCase()}`;
    if (seen.has(key)) continue; seen.add(key);
    links.push({ key, label: f ? (f.kind === "note" ? displayName(f.path) : basename(f.path)) : l.linkpath, f, href: l.linkpath });
  }
  const mentions = findMentionsClient(t!, store.list().filter(f => f.id !== file.id && f.kind === "note"));
  const linkMention = (m: { line: number; start: number; end: number; target: FileMeta; text: string }) => {
    const ed = app.activeEditor();
    const lt = store.linktext(m.target, file.path); const shown = m.text === displayName(m.target.path) ? null : m.text;
    const link = store.settings.useWikilinks ? wikilink(lt, "", shown) : mdlink(m.target.path, lt, "", m.text);
    if (ed && ed.fileId === file.id) { const l = ed.view.state.doc.line(m.line + 1); ed.view.dispatch({ changes: { from: l.from + m.start, to: l.from + m.end, insert: link } }); }
    else { const lines = t!.split("\n"); lines[m.line] = lines[m.line].slice(0, m.start) + link + lines[m.line].slice(m.end); store.setText(file.id, lines.join("\n")); store.remoteChanged.add(file.id); store.remote.emit(); }
  };
  return (
    <div className="outgoing">
      <div className="pane-label">Outgoing links from {displayName(file.path)}</div>
      <div className="bl-head static">Links<span className="tag-count">{links.length}</span></div>
      <ul className="results">
        {links.map(l => <li key={l.key} className="tree-row"><Icon name={l.f ? "file" : "plus"} size={14} /><button className={`link-btn ${l.f ? "" : "is-unresolved"}`} title={l.f ? l.f.path : "Not created yet"} onClick={e => app.openLink(l.href, file.path, e.ctrlKey || e.metaKey)}>{l.label}</button></li>)}
        {!links.length && <li className="pane-empty">No links in this note.</li>}
      </ul>
      <div className="bl-head static">Unlinked mentions<span className="tag-count">{mentions.length}</span></div>
      <ul className="results">
        {mentions.map((m, i) => <li key={i} className="result-match-row"><span className="result-match"><Highlight text={m.lineText.slice(0, 200)} ranges={[[m.start, m.end]]} /></span><button className="btn small" title={m.target.path} onClick={() => linkMention(m)}>{displayName(m.target.path)}</button></li>)}
        {!mentions.length && <li className="pane-empty">No unlinked mentions found.</li>}
      </ul>
    </div>
  );
}

// ---------------- Outline ----------------
export function OutlinePane({ file }: { file?: FileMeta }) {
  const app = useApp(); const { store } = app; useEmitter(store);
  const [, force] = useState(0);
  useEffect(() => { const h = () => force(x => x + 1); window.addEventListener("doc-changed", h); return () => window.removeEventListener("doc-changed", h); }, []);
  useEffect(() => { if (file?.kind === "note") store.note(file.id).then(() => force(x => x + 1)).catch(() => {}); }, [file?.id]);
  if (!file || file.kind !== "note") return <div className="pane-empty">No note is open.</div>;
  const t = store.cached(file.id); if (t == null) return <div className="pane-empty">Loading…</div>;
  const hs = parseNote(t).headings;
  const min = Math.min(...hs.map(h => h.level));
  return (
    <div className="outline">
      <div className="pane-label">Outline of {displayName(file.path)}</div>
      <ul className="tree">{hs.map((h, i) => <li key={i}><button className="tree-row outline-row" style={{ paddingLeft: 8 + (h.level - min) * 14 }} onClick={() => app.openFile(file.id, "same", h.line)}>{h.text || "(empty heading)"}</button></li>)}</ul>
      {!hs.length && <div className="pane-empty">No headings in this note.</div>}
    </div>
  );
}

// ---------------- All properties ----------------
export function AllPropertiesPane() {
  const app = useApp(); const { store, ws } = app; useEmitter(store);
  const [props, setProps] = useState<{ key: string; count: number; type: string }[]>([]);
  const load = () => api(`${store.base()}/properties`).then(setProps).catch(() => {});
  useEffect(() => { load(); }, [store.seq]);
  const types = ["text", "list", "number", "checkbox", "date", "datetime"];
  return (
    <div className="all-props">
      <div className="pane-label">All properties</div>
      <ul className="tree">{props.map(p => (
        <li key={p.key} className="tree-row" onContextMenu={e => p.key.toLowerCase() !== "tags" && showMenu(e, types.map(t => ({ label: (p.type === t ? "✓ " : "") + typeLabel(t), onClick: async () => { await api(`${store.base()}/properties/${encodeURIComponent(p.key)}/type`, { method: "PUT", body: { type: t } }); load(); window.dispatchEvent(new Event("prop-types-changed")); } })))}>
          <Icon name="property" size={14} /><button className="link-btn" onClick={() => ws.search(`[${p.key}]`)}>{p.key}</button><span className="prop-type">{typeLabel(p.type)}</span><span className="tag-count">{p.count}</span>
        </li>))}</ul>
      {!props.length && <div className="pane-empty">No properties yet.</div>}
    </div>
  );
}
export function typeLabel(t: string) { return ({ text: "Text", list: "List", number: "Number", checkbox: "Checkbox", date: "Date", datetime: "Date & time", tags: "Tags" } as Record<string, string>)[t] || t; }
