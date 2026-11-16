import React, { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "./app";
import { useEmitter, FileMeta } from "./store";
import { Tab } from "./workspace";
import { createEditor } from "./editor";
import { EditorView } from "@codemirror/view";
import { renderNote } from "./render";
import { Icon, IconButton, showMenu, toast, prompt } from "./ui";
import { api } from "./api";
import { displayName, dirname, basename, checkName, joinPath } from "../shared/paths";
import { parseFrontmatter, asList } from "../shared/parse";
import { setFrontmatter } from "../shared/templates";
import { inferTypeClient, usePropTypes } from "./props";
import { typeLabel } from "./Panes";

export function NoteView({ tab, fileId }: { tab: Tab; fileId: number }) {
  const app = useApp(); const { store, ws } = app; useEmitter(store);
  const f = store.file(fileId);
  const [text, setText] = useState<string | null>(store.cached(fileId) ?? null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { store.note(fileId).then(t => { setText(t); window.dispatchEvent(new Event("doc-changed")); }).catch(e => setErr(e.message)); }, [fileId]);
  // Follow edits from other tabs/devices
  useEffect(() => store.on(() => { const c = store.cached(fileId); if (c !== undefined) setText(c); }), [fileId]);
  const mode = tab.mode ?? store.settings.defaultMode;
  if (!f) return <div className="pane-empty">This file no longer exists.</div>;
  if (err) return <div className="pane-empty" role="alert">{err}</div>;
  if (text === null) return <div className="pane-empty">Loading…</div>;
  const propsMode = store.settings.propertiesInDocument;
  const showProps = mode !== "source" && propsMode === "visible";
  return (
    <div className={`note-view mode-${mode} ${store.settings.readableLineLength ? "readable" : ""}`}>
      <ViewHeader f={f} tab={tab} mode={mode} />
      <div className="note-scroll">
        {showProps && <PropertiesPanel f={f} text={text} tabId={tab.id} />}
        {mode === "reading" ? <ReadingView f={f} text={text} tab={tab} /> : <EditorPane f={f} tab={tab} mode={mode} initial={text} />}
      </div>
    </div>
  );
}

function ViewHeader({ f, tab, mode }: { f: FileMeta; tab: Tab; mode: string }) {
  const app = useApp(); const { ws } = app;
  const [name, setName] = useState(displayName(f.path));
  useEffect(() => setName(displayName(f.path)), [f.path]);
  const commit = async () => {
    const n = name.trim();
    if (n === displayName(f.path)) return;
    const e = checkName(n); if (e) { toast(e); setName(displayName(f.path)); return; }
    await app.moveTo(f.id, joinPath(dirname(f.path), n + ".md"));
  };
  const folder = dirname(f.path);
  const editMode = app.store.settings.defaultMode === "reading" ? "live" : app.store.settings.defaultMode;
  return (
    <div className="view-header">
      <div className="breadcrumb">{folder && <span className="crumb-folder">{folder.split("/").join(" / ")} / </span>}
        <input className="view-title-input" aria-label="Note name" value={name} onChange={e => setName(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") { setName(displayName(f.path)); (e.target as HTMLInputElement).blur(); } }} />
      </div>
      <div className="view-actions">
        <IconButton icon={mode === "reading" ? "edit" : "book"} label={mode === "reading" ? "Edit (Ctrl/Cmd+E)" : "Reading view (Ctrl/Cmd+E)"} onClick={() => ws.setMode(tab.id, mode === "reading" ? (editMode as any) : "reading")} />
        <IconButton icon="more" label="More options" onClick={e => showMenu(e, [
          { label: mode === "source" ? "Live preview" : "Source mode", icon: "code", disabled: mode === "reading", onClick: () => ws.setMode(tab.id, mode === "source" ? "live" : "source") },
          { label: "Add file property", icon: "property", onClick: () => window.dispatchEvent(new CustomEvent("add-property", { detail: tab.id })) },
          { label: "Open local graph", icon: "graph", onClick: () => ws.setRight({ open: true, tab: "localgraph" }) },
          { label: "Bookmark", icon: "bookmark", onClick: () => app.bookmarkActive() },
          { label: "Open to the right", icon: "split", onClick: () => ws.splitActive("row") },
          { separator: true, label: "" },
          { label: "Rename…", icon: "edit", onClick: () => app.rename(f.id) },
          { label: "Move file to…", onClick: () => app.setModal({ kind: "move", arg: f.id }) },
          { label: "Make a copy", onClick: () => app.duplicate(f.id) },
          { label: "Delete file", icon: "trash", danger: true, onClick: () => app.remove(f.id) },
        ])} />
      </div>
    </div>
  );
}

function EditorPane({ f, tab, mode, initial }: { f: FileMeta; tab: Tab; mode: "live" | "source" | "reading"; initial: string }) {
  const app = useApp(); const { store } = app;
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<ReturnType<typeof createEditor> | null>(null);
  const pathRef = useRef(f.path); pathRef.current = f.path;
  const tagsRef = useRef<string[]>([]);
  useEffect(() => { api(`${store.base()}/tags`).then((t: any[]) => { tagsRef.current = t.map(x => x.tag); }).catch(() => {}); }, []);
  useEffect(() => {
    const e = createEditor(host.current!, initial, {
      store, path: () => pathRef.current,
      openLink: (href, newTab) => app.openLink(href, pathRef.current, newTab),
      openTag: tag => app.ws.search(`tag:#${tag}`),
      upload: files => app.upload(files, pathRef.current),
      tags: () => tagsRef.current,
    }, { mode: mode === "source" ? "source" : "live", onChange: t => { store.setText(f.id, t); window.dispatchEvent(new Event("doc-changed")); }, extraKeys: [], readableWidth: store.settings.readableLineLength, propsSource: () => store.settings.propertiesInDocument === "source" });
    ed.current = e; app.editors.set(tab.id, { view: e.view, fileId: f.id });
    if (app.ws.activeTab().id === tab.id && !document.querySelector(".modal")) e.view.focus();
    const offStore = store.on(() => { const c = store.cached(f.id); if (c !== undefined && !e.view.hasFocus && c !== e.view.state.doc.toString()) e.replaceDoc(c); else e.refresh(); });
    const offRemote = store.remote.on(() => { const c = store.cached(f.id); if (c !== undefined && c !== e.view.state.doc.toString()) e.replaceDoc(c); });
    return () => { offStore(); offRemote(); app.editors.delete(tab.id); e.destroy(); ed.current = null; };
  }, [f.id]);
  useEffect(() => { ed.current?.setMode(mode === "source" ? "source" : "live"); }, [mode]);
  useEffect(() => {
    if (!tab.jump || !ed.current) return;
    const v = ed.current.view; const line = v.state.doc.line(Math.min(tab.jump.line + 1, v.state.doc.lines));
    v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 40 }) }); v.focus();
  }, [tab.jump?.n]);
  return <div className="editor-host" ref={host} />;
}

function ReadingView({ f, text, tab }: { f: FileMeta; text: string; tab: Tab }) {
  const app = useApp(); const { store } = app;
  const [n, setN] = useState(0);
  const html = useMemo(() => renderNote(text, { store, sourcePath: f.path, depth: 0, seen: new Set([f.id]), onNeed: () => setN(x => x + 1) }), [text, f.path, n, store.seq]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tab.jump || !ref.current) return;
    const els = [...ref.current.querySelectorAll<HTMLElement>("[data-line]")];
    const el = els.filter(x => Number(x.dataset.line) <= tab.jump!.line).pop(); el?.scrollIntoView({ block: "start" });
  }, [tab.jump?.n, html]);
  const click = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLElement>("a.internal-link");
    if (a) { e.preventDefault(); app.openLink(a.dataset.href || "", f.path, e.ctrlKey || e.metaKey); return; }
    const tg = t.closest<HTMLElement>("a.tag"); if (tg) { e.preventDefault(); app.ws.search(`tag:#${tg.dataset.tag}`); return; }
    if (t instanceof HTMLInputElement && t.classList.contains("task-box")) {
      const ln = Number(t.dataset.line); const lines = text.split("\n");
      const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[(.)\]/.exec(lines[ln] ?? "");
      if (m) { lines[ln] = lines[ln].slice(0, m[1].length) + `[${m[2] === " " ? "x" : " "}]` + lines[ln].slice(m[1].length + 3); store.setText(f.id, lines.join("\n")); }
    }
  };
  return <article ref={ref} className="reading markdown-body" onClick={click} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------------- Properties ----------------
export function PropertiesPanel({ f, text, tabId }: { f: FileMeta; text: string; tabId: string }) {
  const app = useApp(); const { store } = app;
  const types = usePropTypes(store);
  const fm = parseFrontmatter(text);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(true);
  useEffect(() => { const h = (e: Event) => { if ((e as CustomEvent).detail === tabId) { setOpen(true); setAdding(true); } }; window.addEventListener("add-property", h); return () => window.removeEventListener("add-property", h); }, [tabId]);
  const write = (data: Record<string, unknown>) => {
    const next = setFrontmatter(text, data);
    const ed = [...app.editors.values()].find(x => x.fileId === f.id);
    if (ed) { const v = ed.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next } }); }
    else store.setText(f.id, next);
  };
  if (!fm.present && !adding) return null;
  if (fm.present && !fm.valid) return <div className="props invalid" role="alert">These properties are not valid YAML. Switch to source mode to fix them.</div>;
  const data = fm.data;
  const entries = Object.entries(data);
  const typeOf = (k: string, v: unknown) => k.toLowerCase() === "tags" ? "tags" : types[k.toLowerCase()] || inferTypeClient(k, v);
  const setVal = (k: string, v: unknown) => write({ ...data, [k]: v });
  return (
    <section className="props" aria-label="Properties">
      <button className="props-head" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name={open ? "chevronDown" : "chevronRight"} size={12} />Properties</button>
      {open && <>
        {entries.map(([k, v]) => {
          const type = typeOf(k, v);
          return (
            <div className="prop-row" key={k}>
              <button className="prop-key" title={`${typeLabel(type)} property`} onClick={e => showMenu(e, [
                { label: "Rename…", icon: "edit", onClick: async () => { const nk = await prompt("Rename property", { value: k }); if (nk && nk.trim() && nk !== k) { const out: Record<string, unknown> = {}; for (const [a, b] of entries) out[a === k ? nk.trim() : a] = b; write(out); } } },
                ...(k.toLowerCase() === "tags" ? [] : ["text", "list", "number", "checkbox", "date", "datetime"].map(t => ({ label: (type === t ? "✓ " : "") + typeLabel(t), onClick: async () => { await api(`${store.base()}/properties/${encodeURIComponent(k)}/type`, { method: "PUT", body: { type: t } }); window.dispatchEvent(new Event("prop-types-changed")); setVal(k, convert(v, t)); } }))),
                { separator: true, label: "" },
                { label: "Remove", icon: "trash", danger: true, onClick: () => { const out = { ...data }; delete out[k]; write(out); } },
              ])}><Icon name={typeIcon(type)} size={14} /><span>{k}</span></button>
              <div className="prop-value"><ValueEditor type={type} value={v} onChange={nv => setVal(k, nv)} name={k} onOpen={href => app.openLink(href, f.path, false)} dailyFor={d => app.openDaily({ y: +d.slice(0, 4), mo: +d.slice(5, 7), d: +d.slice(8, 10), h: 0, mi: 0, s: 0 })} /></div>
            </div>
          );
        })}
        {adding ? <AddProperty existing={entries.map(([k]) => k.toLowerCase())} onDone={(k) => { setAdding(false); if (k) { const t = types[k.toLowerCase()]; write({ ...data, [k]: t === "list" || t === "tags" ? [] : t === "checkbox" ? false : t === "number" ? null : "" }); } }} />
          : <button className="link-btn add-prop" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add property</button>}
      </>}
    </section>
  );
}
function AddProperty({ existing, onDone }: { existing: string[]; onDone: (k: string | null) => void }) {
  const [k, setK] = useState(""); const [err, setErr] = useState("");
  return <form className="prop-add" onSubmit={e => { e.preventDefault(); const n = k.trim(); if (!n) { onDone(null); return; } if (existing.includes(n.toLowerCase())) { setErr("This note already has that property"); return; } if (/[:#\[\]{}]/.test(n)) { setErr("Use letters, numbers, spaces, - and _"); return; } onDone(n); }}>
    <input autoFocus aria-label="Property name" placeholder="Property name" value={k} onChange={e => { setK(e.target.value); setErr(""); }} onKeyDown={e => { if (e.key === "Escape") onDone(null); }} onBlur={() => { if (!k.trim()) onDone(null); }} />
    {err && <span className="field-error">{err}</span>}
  </form>;
}
function typeIcon(t: string) { return ({ text: "property", list: "list", number: "code", checkbox: "check", date: "calendar", datetime: "calendar", tags: "tag" } as Record<string, string>)[t] || "property"; }
function convert(v: unknown, t: string): unknown {
  if (t === "list") return asList(v);
  if (t === "number") { const x = Array.isArray(v) ? v[0] : v; if (x == null || x === "") return null; const n = Number(x); return Number.isFinite(n) ? n : null; }
  if (t === "checkbox") return v === true || v === "true";
  if (t === "text" || t === "date" || t === "datetime") return Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
  return v;
}
function ValueEditor({ type, value, onChange, name, onOpen, dailyFor }: { type: string; value: unknown; onChange: (v: unknown) => void; name: string; onOpen: (href: string) => void; dailyFor: (d: string) => void }) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => setDraft(value == null ? "" : Array.isArray(value) ? "" : String(value)), [value]);
  if (type === "list" || type === "tags") {
    const items = asList(value);
    return <div className="chips">{items.map((it, i) => {
      const link = /^\[\[([^\]]+)\]\]$/.exec(it);
      return <span key={i} className={`chip ${type === "tags" ? "chip-tag" : ""}`}>{link ? <a href="#" className="internal-link" onClick={e => { e.preventDefault(); onOpen(link[1].split("|")[0]); }}>{link[1].split("|").pop()}</a> : it}<button aria-label={`Remove ${it}`} onClick={() => onChange(items.filter((_, j) => j !== i))}><Icon name="x" size={10} /></button></span>;
    })}<input aria-label={`Add to ${name}`} placeholder="Add…" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && draft.trim()) { e.preventDefault(); onChange([...items, type === "tags" ? draft.trim().replace(/^#/, "") : draft.trim()]); setDraft(""); } }} /></div>;
  }
  if (type === "checkbox") return <input type="checkbox" aria-label={name} checked={value === true} onChange={e => onChange(e.target.checked)} />;
  if (type === "number") return <input type="number" aria-label={name} value={draft} onChange={e => setDraft(e.target.value)} onBlur={() => { const n = draft === "" ? null : Number(draft); if (n !== value) onChange(n); }} onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />;
  if (type === "date") return <span className="date-prop"><input type="date" aria-label={name} value={draft} onChange={e => onChange(e.target.value)} />{draft && <IconButton icon="calendar" label="Open daily note" onClick={() => dailyFor(draft)} />}</span>;
  if (type === "datetime") return <input type="datetime-local" aria-label={name} value={draft.slice(0, 16)} onChange={e => onChange(e.target.value)} />;
  const link = /^\[\[([^\]]+)\]\]$/.exec(draft.trim());
  return <span className="text-prop"><input aria-label={name} value={draft} onChange={e => setDraft(e.target.value)} onBlur={() => draft !== String(value ?? "") && onChange(draft)} onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />{link && <IconButton icon="link" label="Open link" onClick={() => onOpen(link[1].split("|")[0])} />}</span>;
}

export function FileView({ fileId }: { fileId: number }) {
  const app = useApp(); const { store } = app; useEmitter(store);
  const f = store.file(fileId); if (!f) return <div className="pane-empty">This file no longer exists.</div>;
  const url = store.rawUrl(f);
  return (
    <div className="file-view">
      <div className="view-header"><div className="breadcrumb">{dirname(f.path) && <span className="crumb-folder">{dirname(f.path)} / </span>}<strong>{basename(f.path)}</strong></div>
        <div className="view-actions"><IconButton icon="more" label="More options" onClick={e => showMenu(e, [{ label: "Open in a new browser tab", onClick: () => window.open(url, "_blank", "noopener") }, { label: "Rename…", icon: "edit", onClick: () => app.rename(f.id) }, { label: "Move file to…", onClick: () => app.setModal({ kind: "move", arg: f.id }) }, { label: "Delete file", icon: "trash", danger: true, onClick: () => app.remove(f.id) }])} /></div></div>
      <div className="file-body">
        {f.mime?.startsWith("image/") && <img src={url} alt={f.path} />}
        {f.mime?.startsWith("audio/") && <audio controls src={url} />}
        {f.mime?.startsWith("video/") && <video controls src={url} />}
        {f.mime === "application/pdf" && <iframe title={f.path} src={url} />}
      </div>
    </div>
  );
}
