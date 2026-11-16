import React, { useEffect, useMemo, useRef, useState } from "react";
import { useApp, comboLabel, comboOf, Command } from "./app";
import { useEmitter, Vault, FileMeta } from "./store";
import { api } from "./api";
import { Modal, Icon, toast, confirm, relTime } from "./ui";
import { fuzzyScore, fuzzyIndexes } from "../shared/fuzzy";
import { displayName, dirname, basename, joinPath, extname } from "../shared/paths";
import { VaultSettings } from "../shared/vaultSettings";
import { formatDate } from "../shared/dates";
import { settings, ACCESS_LABELS } from "../shared/settings";
import type { SiteConfig } from "./Auth";

export function Modals({ vaults, me, reloadVaults }: { vaults: Vault[]; me: { name: string; email: string }; reloadVaults: () => void }) {
  const app = useApp();
  const [, force] = useState(0);
  useEffect(() => { const l = () => force(x => x + 1); app.modalListeners.add(l); return () => { app.modalListeners.delete(l); }; }, []);
  const m = app.modal; if (!m) return null;
  const close = () => app.setModal(null);
  if (m.kind === "switcher") return <QuickSwitcher close={close} />;
  if (m.kind === "palette") return <CommandPalette close={close} />;
  if (m.kind === "templates") return <TemplatePicker close={close} />;
  if (m.kind === "move") return <MoveModal close={close} fileId={m.arg} />;
  if (m.kind === "settings") return <Settings close={close} tab={m.arg} vaults={vaults} me={me} reloadVaults={reloadVaults} />;
  return null;
}

function Highlight({ text, idx }: { text: string; idx: number[] }) {
  if (!idx.length) return <>{text}</>;
  const set = new Set(idx);
  return <>{[...text].map((c, i) => set.has(i) ? <mark key={i}>{c}</mark> : <React.Fragment key={i}>{c}</React.Fragment>)}</>;
}

/** Keyboard-driven list used by the switcher, palette and pickers. */
function PickerList<T>({ items, render, onPick, empty, footer, query, setQuery, placeholder, onKey }: { items: T[]; render: (t: T, active: boolean) => React.ReactNode; onPick: (t: T, e: React.KeyboardEvent | React.MouseEvent) => void; empty?: React.ReactNode; footer?: React.ReactNode; query: string; setQuery: (q: string) => void; placeholder: string; onKey?: (e: React.KeyboardEvent, active: T | undefined) => boolean }) {
  const [i, setI] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setI(0), [query]);
  useEffect(() => { list.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" }); }, [i]);
  const key = (e: React.KeyboardEvent) => {
    if (onKey && onKey(e, items[i])) return;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); setI(x => Math.min(items.length - 1, x + 1)); }
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); setI(x => Math.max(0, x - 1)); }
    else if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); if (items[i] !== undefined) onPick(items[i], e); }
  };
  return (
    <div className="picker">
      <input className="picker-input" autoFocus placeholder={placeholder} aria-label={placeholder} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={key} role="combobox" aria-expanded="true" aria-controls="picker-list" />
      <div className="picker-list" id="picker-list" role="listbox" ref={list}>
        {items.length === 0 && <div className="picker-empty">{empty ?? "No matches."}</div>}
        {items.map((t, j) => <div key={j} role="option" aria-selected={j === i} className={`picker-item ${j === i ? "is-active" : ""}`} onMouseMove={() => setI(j)} onClick={e => onPick(t, e)}>{render(t, j === i)}</div>)}
      </div>
      {footer && <div className="picker-footer">{footer}</div>}
    </div>
  );
}

type SwItem = { kind: "file"; f: FileMeta; label: string; alias?: string; idx: number[] } | { kind: "create"; name: string };
function QuickSwitcher({ close }: { close: () => void }) {
  const app = useApp(); const { store, ws } = app;
  const [q, setQ] = useState("");
  const items = useMemo<SwItem[]>(() => {
    const files = store.list().filter(f => f.kind !== "folder");
    if (!q.trim()) {
      const rec = ws.s.recent.map(id => store.file(id)).filter((f): f is FileMeta => !!f && f.kind !== "folder");
      const rest = files.filter(f => !rec.includes(f)).sort((a, b) => b.mtime.localeCompare(a.mtime));
      return [...rec, ...rest].slice(0, 50).map(f => ({ kind: "file" as const, f, label: f.kind === "note" ? f.path.replace(/\.md$/i, "") : f.path, idx: [] }));
    }
    const out: (SwItem & { s: number })[] = [];
    for (const f of files) {
      const label = f.kind === "note" ? f.path.replace(/\.md$/i, "") : f.path;
      // Lower is better. Matches on the file name beat matches on the folder path.
      const s1 = fuzzyScore(q, label), s2 = fuzzyScore(q, f.kind === "note" ? displayName(f.path) : basename(f.path));
      let best = Math.min(s1 == null ? Infinity : s1 + 0.5, s2 == null ? Infinity : s2);
      let item: SwItem & { s: number } = { kind: "file", f, label, idx: s1 != null ? fuzzyIndexes(q, label) : [], s: best };
      for (const a of f.aliases || []) { const sa = fuzzyScore(q, a); if (sa != null && sa + 0.25 < best) { best = sa + 0.25; item = { kind: "file", f, label, alias: a, idx: fuzzyIndexes(q, a), s: best }; } }
      if (best < Infinity) out.push(item);
    }
    out.sort((a, b) => a.s - b.s || (a as any).label.length - (b as any).label.length);
    const list: SwItem[] = out.slice(0, 50);
    const exact = files.some(f => f.kind === "note" && (displayName(f.path).toLowerCase() === q.trim().toLowerCase().replace(/\.md$/, "") || f.path.replace(/\.md$/i, "").toLowerCase() === q.trim().toLowerCase()));
    if (!exact) list.push({ kind: "create", name: q.trim() });
    return list;
  }, [q, store.seq]);
  const pick = (t: SwItem, e: React.KeyboardEvent | React.MouseEvent) => {
    const how = e.ctrlKey || e.metaKey ? (e.altKey ? "split" : "tab") : "same";
    close();
    if (t.kind === "create") app.createFromSwitcher(t.name, how === "split" ? "tab" : how);
    else app.openFile(t.f.id, how);
  };
  return (
    <Modal title="Quick switcher" onClose={close} className="modal-picker">
      <PickerList items={items} query={q} setQuery={setQ} placeholder="Find or create a note…" onPick={pick}
        onKey={(e) => { if (e.key === "Enter" && e.shiftKey && q.trim()) { e.preventDefault(); close(); app.createFromSwitcher(q.trim(), e.ctrlKey || e.metaKey ? "tab" : "same"); return true; } return false; }}
        render={t => t.kind === "create"
          ? <div className="sw-create"><span>{t.name}</span><kbd>Enter to create</kbd></div>
          : <div className="sw-file"><div className="sw-name"><span>{t.alias ? <><Icon name="link" size={12} /> <Highlight text={t.alias} idx={t.idx} /></> : <Highlight text={t.label} idx={t.idx} />}</span>{t.f.kind === "attachment" && <span className="badge">{extname(t.f.path).slice(1).toUpperCase()}</span>}</div>{t.alias && <div className="sw-sub">{t.label}</div>}</div>}
        footer={<><span><kbd>↑↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>{comboLabel("Mod")}↵</kbd> new tab</span><span><kbd>⇧↵</kbd> create</span><span><kbd>esc</kbd> dismiss</span></>} />
    </Modal>
  );
}

function CommandPalette({ close }: { close: () => void }) {
  const app = useApp(); const { store } = app;
  const [q, setQ] = useState("");
  const recentKey = "recent-commands";
  const all = useMemo(() => app.commands().filter(c => c.id !== "palette:open" && (!c.check || c.check())), []);
  const items = useMemo(() => {
    const pinned = store.settings.pinnedCommands; const recent: string[] = JSON.parse(localStorage.getItem(recentKey) || "[]");
    if (!q.trim()) {
      const order = (c: Command) => pinned.includes(c.id) ? pinned.indexOf(c.id) - 1000 : recent.includes(c.id) ? recent.indexOf(c.id) - 500 : 0;
      return [...all].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name)).map(c => ({ c, idx: [] as number[] }));
    }
    return all.map(c => ({ c, s: fuzzyScore(q, c.name) })).filter(x => x.s != null).sort((a, b) => a.s! - b.s!).map(x => ({ c: x.c, idx: fuzzyIndexes(q, x.c.name) }));
  }, [q]);
  const pick = (t: { c: Command }) => {
    const recent: string[] = JSON.parse(localStorage.getItem(recentKey) || "[]");
    localStorage.setItem(recentKey, JSON.stringify([t.c.id, ...recent.filter(x => x !== t.c.id)].slice(0, 10)));
    close(); setTimeout(() => t.c.run(), 0);
  };
  const pinned = store.settings.pinnedCommands;
  return (
    <Modal title="Command palette" onClose={close} className="modal-picker">
      <PickerList items={items} query={q} setQuery={setQ} placeholder="Type a command…" onPick={pick} empty="No commands found."
        render={t => <div className="cmd-row">{pinned.includes(t.c.id) && <Icon name="pin" size={12} />}<span className="cmd-name"><Highlight text={t.c.name} idx={t.idx} /></span>{t.c.key && <kbd>{comboLabel(t.c.key)}</kbd>}</div>}
        footer={<><span><kbd>↑↓</kbd> navigate</span><span><kbd>↵</kbd> use</span><span><kbd>esc</kbd> dismiss</span></>} />
    </Modal>
  );
}

function TemplatePicker({ close }: { close: () => void }) {
  const app = useApp(); const [q, setQ] = useState("");
  const folder = app.store.settings.templatesFolder;
  const items = app.templates().map(f => ({ f, name: f.path.slice(folder.replace(/\/+$/, "").length + 1).replace(/\.md$/i, "") })).map(x => ({ ...x, s: q ? fuzzyScore(q, x.name) : 0 })).filter(x => x.s != null).sort((a, b) => (a.s as number) - (b.s as number));
  return <Modal title="Insert template" onClose={close} className="modal-picker"><PickerList items={items} query={q} setQuery={setQ} placeholder="Choose a template…" onPick={t => { close(); app.insertTemplate(t.f); }} render={t => <span>{t.name}</span>} empty="No templates match." /></Modal>;
}

function MoveModal({ close, fileId }: { close: () => void; fileId: number }) {
  const app = useApp(); const { store } = app; const [q, setQ] = useState("");
  const f = store.file(fileId);
  const folders = ["", ...store.list().filter(x => x.kind === "folder" && (!f || f.kind !== "folder" || (x.path !== f.path && !x.path.startsWith(f.path + "/")))).map(x => x.path)].filter(p => !f || p !== dirname(f.path));
  const items = folders.map(p => ({ p, s: q ? fuzzyScore(q, p || "/") : 0 })).filter(x => x.s != null).sort((a, b) => (a.s as number) - (b.s as number) || a.p.localeCompare(b.p));
  if (!f) return null;
  return <Modal title={`Move "${basename(f.path)}" to…`} onClose={close} className="modal-picker"><PickerList items={items} query={q} setQuery={setQ} placeholder="Type a folder…" onPick={t => { close(); app.moveTo(f.id, joinPath(t.p, basename(f.path))); }} render={t => <span><Icon name="folder" size={14} /> {t.p || "/ (vault root)"}</span>} empty="No folders match." /></Modal>;
}

// ---------------- Settings ----------------
const TABS = [["account", "Account"], ["people", "People"], ["vaults", "Vaults"], ["editor", "Editor"], ["files", "Files & links"], ["appearance", "Appearance"], ["hotkeys", "Hotkeys"], ["daily", "Daily notes"], ["templates", "Templates"], ["trash", "Trash"], ["about", "About"]] as const;
function Settings({ close, tab, vaults, me, reloadVaults }: { close: () => void; tab?: string; vaults: Vault[]; me: { name: string; email: string; role?: string }; reloadVaults: () => void }) {
  const [t, setT] = useState<string>(tab || "editor");
  const [cfg, setCfg] = useState<SiteConfig | null>(null);
  useEffect(() => { api<SiteConfig>("/api/config").then(setCfg).catch(() => {}); }, []);
  // "People" is for the owner of an invite-only site.
  const tabs = TABS.filter(([id]) => id !== "people" || (me.role === "owner" && cfg?.access === "invite_only"));
  return (
    <Modal title="Settings" onClose={close} wide className="modal-settings">
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">{tabs.map(([id, label]) => <button key={id} className={t === id ? "is-active" : ""} aria-current={t === id ? "page" : undefined} onClick={() => setT(id)}>{label}</button>)}</nav>
        <div className="settings-body">
          {t === "account" && <AccountSettings me={me} reloadVaults={reloadVaults} />}
          {t === "vaults" && <VaultSettingsTab vaults={vaults} reloadVaults={reloadVaults} close={close} />}
          {t === "editor" && <EditorSettings />}
          {t === "files" && <FilesSettings />}
          {t === "appearance" && <AppearanceSettings />}
          {t === "hotkeys" && <HotkeySettings />}
          {t === "daily" && <DailySettings />}
          {t === "templates" && <TemplateSettings />}
          {t === "trash" && <TrashSettings />}
          {t === "people" && <PeopleSettings />}
          {t === "about" && <AboutSettings cfg={cfg} />}
        </div>
      </div>
    </Modal>
  );
}
function Row({ name, desc, children }: { name: string; desc?: React.ReactNode; children: React.ReactNode }) {
  return <div className="setting-row"><div className="setting-info"><div className="setting-name">{name}</div>{desc && <div className="setting-desc">{desc}</div>}</div><div className="setting-control">{children}</div></div>;
}
function useSettings(): [VaultSettings, (p: Partial<VaultSettings>) => void] {
  const app = useApp(); useEmitter(app.store);
  return [app.store.settings, p => { app.store.saveSettings(p).catch(e => toast(e.message)); }];
}
function Switch({ v, on, label }: { v: boolean; on: (v: boolean) => void; label: string }) { return <input type="checkbox" role="switch" aria-label={label} checked={v} onChange={e => on(e.target.checked)} />; }
function TextSetting({ value, onSave, label, placeholder }: { value: string; onSave: (v: string) => void; label: string; placeholder?: string }) {
  const [v, setV] = useState(value); useEffect(() => setV(value), [value]);
  return <input aria-label={label} value={v} placeholder={placeholder} onChange={e => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />;
}
function FolderSetting({ value, onSave, label }: { value: string; onSave: (v: string) => void; label: string }) {
  const app = useApp(); const id = "dl-" + label.replace(/\W/g, "");
  return <><TextSetting value={value} onSave={v => onSave(v.replace(/^\/+|\/+$/g, ""))} label={label} placeholder="Vault root" /><datalist id={id}>{app.store.list().filter(f => f.kind === "folder").map(f => <option key={f.id} value={f.path} />)}</datalist></>;
}

function AccountSettings({ me, reloadVaults }: { me: { name: string; email: string }; reloadVaults: () => void }) {
  const app = useApp();
  const [name, setName] = useState(me.name); const [cur, setCur] = useState(""); const [next, setNext] = useState(""); const [msg, setMsg] = useState("");
  return <>
    <h3>Account</h3>
    <Row name="Email">{me.email}</Row>
    <form className="setting-row" onSubmit={async e => { e.preventDefault(); try { await api("/api/me", { method: "PATCH", body: { name } }); toast("Name saved"); reloadVaults(); } catch (er) { toast((er as Error).message); } }}>
      <div className="setting-info"><label className="setting-name" htmlFor="acct-name">Name</label></div>
      <div className="setting-control"><input id="acct-name" value={name} onChange={e => setName(e.target.value)} /><button className="btn">Save</button></div>
    </form>
    <h4>Change password</h4>
    <form className="form" onSubmit={async e => { e.preventDefault(); setMsg(""); try { await api("/api/me/password", { body: { current: cur, next } }); setCur(""); setNext(""); toast("Password changed"); } catch (er) { setMsg((er as Error).message); } }}>
      <label className="field"><span>Current password</span><input type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} /></label>
      <label className="field"><span>New password</span><input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /></label>
      {msg && <div className="field-error" role="alert">{msg}</div>}
      <div><button className="btn primary">Change password</button></div>
    </form>
    <h4>Session</h4>
    <button className="btn" onClick={() => app.signOut()}>Sign out</button>
  </>;
}

function VaultSettingsTab({ vaults, reloadVaults, close }: { vaults: Vault[]; reloadVaults: () => void; close: () => void }) {
  const app = useApp(); const [newName, setNewName] = useState("");
  return <>
    <h3>Vaults</h3>
    <p className="setting-desc">Each vault is a separate set of notes, folders, attachments and settings.</p>
    <ul className="vault-list">
      {vaults.map(v => <li key={v.id}>
        <TextSetting value={v.name} label={`Name of ${v.name}`} onSave={async n => { try { await api(`/api/vaults/${v.id}`, { method: "PATCH", body: { name: n } }); reloadVaults(); } catch (e) { toast((e as Error).message); } }} />
        {v.id === app.store.vault.id ? <span className="badge">Open</span> : <button className="btn small" onClick={() => { close(); app.switchVault(v.id); }}>Open</button>}
        <button className="btn small danger" disabled={vaults.length < 2} onClick={async () => {
          const typed = await import("./ui").then(m => m.prompt(`Delete vault "${v.name}"?`, { label: `This permanently deletes every note and attachment in it. Type "${v.name}" to confirm.`, ok: "Delete vault" }));
          if (typed == null) return;
          try { await api(`/api/vaults/${v.id}`, { method: "DELETE", body: { confirm: typed } }); toast("Vault deleted"); if (v.id === app.store.vault.id) { close(); app.switchVault(vaults.find(x => x.id !== v.id)!.id); } reloadVaults(); } catch (e) { toast((e as Error).message); }
        }}>Delete</button>
      </li>)}
    </ul>
    <form className="setting-row" onSubmit={async e => { e.preventDefault(); try { const v = await api<Vault>("/api/vaults", { body: { name: newName } }); setNewName(""); reloadVaults(); close(); app.switchVault(v.id); } catch (er) { toast((er as Error).message); } }}>
      <div className="setting-info"><label className="setting-name" htmlFor="new-vault">Create a new vault</label></div>
      <div className="setting-control"><input id="new-vault" placeholder="Vault name" value={newName} onChange={e => setNewName(e.target.value)} /><button className="btn primary">Create</button></div>
    </form>
  </>;
}

function EditorSettings() {
  const [s, save] = useSettings();
  return <>
    <h3>Editor</h3>
    <Row name="Default view for new tabs" desc="Live preview hides Markdown syntax except near the cursor.">
      <select aria-label="Default view for new tabs" value={s.defaultMode} onChange={e => save({ defaultMode: e.target.value as any })}><option value="live">Live preview</option><option value="source">Source mode</option><option value="reading">Reading view</option></select>
    </Row>
    <Row name="Properties in document" desc="How the properties block at the top of a note is shown.">
      <select aria-label="Properties in document" value={s.propertiesInDocument} onChange={e => save({ propertiesInDocument: e.target.value as any })}><option value="visible">Visible</option><option value="hidden">Hidden</option><option value="source">Source</option></select>
    </Row>
    <Row name="Readable line length" desc="Limit the width of text so long lines are easier to read."><Switch label="Readable line length" v={s.readableLineLength} on={v => save({ readableLineLength: v })} /></Row>
  </>;
}
function FilesSettings() {
  const [s, save] = useSettings();
  return <>
    <h3>Files & links</h3>
    <Row name="Default location for new notes"><select aria-label="Default location for new notes" value={s.newNoteLocation} onChange={e => save({ newNoteLocation: e.target.value as any })}><option value="root">Vault root</option><option value="current">Same folder as current file</option><option value="folder">In the folder specified below</option></select></Row>
    {s.newNoteLocation === "folder" && <Row name="Folder for new notes"><FolderSetting label="Folder for new notes" value={s.newNoteFolder} onSave={v => save({ newNoteFolder: v })} /></Row>}
    <Row name="New link format" desc="How links are written when you pick a note from autocomplete or drag one in."><select aria-label="New link format" value={s.linkFormat} onChange={e => save({ linkFormat: e.target.value as any })}><option value="shortest">Shortest path when possible</option><option value="relative">Relative path to file</option><option value="absolute">Absolute path in vault</option></select></Row>
    <Row name="Use [[Wikilinks]]" desc="Off: new links use the Markdown [text](path.md) form."><Switch label="Use Wikilinks" v={s.useWikilinks} on={v => save({ useWikilinks: v })} /></Row>
    <Row name="Automatically update internal links" desc="Off: you are asked before links are rewritten when a file is renamed or moved."><Switch label="Automatically update internal links" v={s.autoUpdateLinks} on={v => save({ autoUpdateLinks: v })} /></Row>
    <Row name="Default location for new attachments"><select aria-label="Default location for new attachments" value={s.attachmentLocation} onChange={e => save({ attachmentLocation: e.target.value as any })}><option value="root">Vault root</option><option value="folder">In the folder specified below</option><option value="current">Same folder as current file</option><option value="subfolder">In a subfolder under the current folder</option></select></Row>
    {(s.attachmentLocation === "folder" || s.attachmentLocation === "subfolder") && <Row name={s.attachmentLocation === "folder" ? "Attachment folder path" : "Subfolder name"}><FolderSetting label="Attachment folder path" value={s.attachmentFolder} onSave={v => save({ attachmentFolder: v })} /></Row>}
    <Row name="Deleted files" desc="Where deleted files go."><select aria-label="Deleted files" value={s.deleteBehavior} onChange={e => save({ deleteBehavior: e.target.value as any })}><option value="trash">Move to trash</option><option value="permanent">Permanently delete</option></select></Row>
  </>;
}
function AppearanceSettings() {
  const app = useApp(); const [theme, setTheme] = useState(localStorage.getItem("theme") || "system");
  return <>
    <h3>Appearance</h3>
    <Row name="Base color scheme" desc="Saved on this device."><select aria-label="Base color scheme" value={theme} onChange={e => { setTheme(e.target.value); app.setTheme(e.target.value as any); }}><option value="system">Adapt to system</option><option value="light">Light</option><option value="dark">Dark</option></select></Row>
    <Row name="Font size" desc="Saved on this device."><input type="range" min={12} max={22} aria-label="Font size" defaultValue={Number(localStorage.getItem("font-size") || 16)} onChange={e => { localStorage.setItem("font-size", e.target.value); document.documentElement.style.setProperty("--font-size", e.target.value + "px"); }} /></Row>
  </>;
}
function HotkeySettings() {
  const app = useApp(); const [s, save] = useSettings(); const [q, setQ] = useState(""); const [rec, setRec] = useState<string | null>(null);
  const cmds = app.commands(); const defaults = new Map(new (app.constructor as any)(app.store, app.ws, app.now, app.signOut, app.switchVault).commands().map((c: Command) => [c.id, c.key]));
  useEffect(() => {
    if (!rec) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRec(null); return; }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const combo = comboOf(e); if (!combo) return; const clash = cmds.find(c => c.key === combo && c.id !== rec);
      const next = { ...s.hotkeys, [rec]: combo };
      if (clash) { next[clash.id] = ""; toast(`Removed ${comboLabel(combo)} from "${clash.name}"`); }
      save({ hotkeys: next }); setRec(null);
    };
    window.addEventListener("keydown", h, true); return () => window.removeEventListener("keydown", h, true);
  }, [rec, s.hotkeys]);
  const shown = cmds.filter(c => !q || c.name.toLowerCase().includes(q.toLowerCase()) || (c.key && comboLabel(c.key).toLowerCase().includes(q.toLowerCase())));
  return <>
    <h3>Hotkeys</h3>
    <input className="pane-filter" placeholder="Filter…" aria-label="Filter hotkeys" value={q} onChange={e => setQ(e.target.value)} />
    <div className="hotkey-list">{shown.map(c => <div className="setting-row" key={c.id}>
      <div className="setting-info"><div className="setting-name">{c.name}</div></div>
      <div className="setting-control">
        {rec === c.id ? <kbd className="recording">Press keys…</kbd> : c.key ? <kbd>{comboLabel(c.key)}</kbd> : <span className="muted">Blank</span>}
        <button className="btn small" onClick={() => setRec(c.id)} aria-label={`Set hotkey for ${c.name}`}>Set</button>
        {c.id in s.hotkeys && <button className="btn small" onClick={() => { const n = { ...s.hotkeys }; delete n[c.id]; save({ hotkeys: n }); }} aria-label={`Restore default hotkey for ${c.name}`} title={`Default: ${comboLabel(defaults.get(c.id) as string) || "blank"}`}>Reset</button>}
        <button className={`btn small ${s.pinnedCommands.includes(c.id) ? "is-on" : ""}`} aria-pressed={s.pinnedCommands.includes(c.id)} onClick={() => save({ pinnedCommands: s.pinnedCommands.includes(c.id) ? s.pinnedCommands.filter(x => x !== c.id) : [...s.pinnedCommands, c.id] })} aria-label={`Pin ${c.name} in the command palette`}><Icon name="pin" size={12} /></button>
      </div>
    </div>)}</div>
  </>;
}
function DailySettings() {
  const app = useApp(); const [s, save] = useSettings();
  let sample = ""; try { sample = formatDate({ y: 2026, mo: 11, d: 16, h: 9, mi: 30, s: 0 }, s.dailyFormat); } catch { sample = "Invalid format"; }
  return <>
    <h3>Daily notes</h3>
    <Row name="Date format" desc={<>Example: <strong data-testid="daily-sample">{sample}</strong>. Tokens: YYYY, MM, DD, ddd, dddd, MMM, MMMM, Do; use [brackets] for literal text and / for subfolders.</>}><TextSetting label="Date format" value={s.dailyFormat} onSave={v => save({ dailyFormat: v || "YYYY-MM-DD" })} /></Row>
    <Row name="New file location" desc="Folder where new daily notes are created."><FolderSetting label="Daily note folder" value={s.dailyFolder} onSave={v => save({ dailyFolder: v })} /></Row>
    <Row name="Template file location" desc="A note whose contents are copied into each new daily note."><TextSetting label="Daily note template" value={s.dailyTemplate} placeholder="Templates/Daily.md" onSave={v => save({ dailyTemplate: v })} /></Row>
    <Row name="Open daily note on startup"><Switch label="Open daily note on startup" v={s.openDailyOnStart} on={v => save({ openDailyOnStart: v })} /></Row>
    <button className="btn" onClick={() => { app.setModal(null); app.openDaily(); }}>Open today's daily note</button>
  </>;
}
function TemplateSettings() {
  const [s, save] = useSettings();
  return <>
    <h3>Templates</h3>
    <Row name="Template folder location" desc="Notes in this folder are offered by “Insert template”."><FolderSetting label="Template folder location" value={s.templatesFolder} onSave={v => save({ templatesFolder: v })} /></Row>
    <Row name="Date format" desc="Used by {{date}} and “Insert current date”."><TextSetting label="Template date format" value={s.templateDateFormat} onSave={v => save({ templateDateFormat: v || "YYYY-MM-DD" })} /></Row>
    <Row name="Time format" desc="Used by {{time}} and “Insert current time”."><TextSetting label="Template time format" value={s.templateTimeFormat} onSave={v => save({ templateTimeFormat: v || "HH:mm" })} /></Row>
  </>;
}
function TrashSettings() {
  const app = useApp(); const { store } = app; const [items, setItems] = useState<FileMeta[] | null>(null);
  const load = () => api<FileMeta[]>(`${store.base()}/trash`).then(setItems).catch(e => toast(e.message));
  useEffect(() => { load(); }, []);
  return <>
    <h3>Trash</h3>
    <p className="setting-desc">Deleted files stay here until you remove them.</p>
    {items && items.length > 0 && <button className="btn danger small" onClick={async () => { if (await confirm("Empty trash?", `Permanently delete ${items.length} item(s)? This cannot be undone.`, "Empty trash")) { await api(`${store.base()}/trash`, { method: "DELETE" }); load(); } }}>Empty trash</button>}
    {items === null ? <p>Loading…</p> : items.length === 0 ? <p className="muted">Trash is empty.</p> :
      <ul className="trash-list">{items.map(f => <li key={f.id}><Icon name={f.kind === "folder" ? "folder" : "file"} size={14} /><span className="trash-path">{f.path}</span><span className="muted">{relTime(f.mtime)}</span>
        <button className="btn small" onClick={async () => { try { await api(`${store.base()}/trash/${f.id}/restore`, { method: "POST" }); await store.poll(); toast("Restored"); load(); } catch (e) { toast((e as Error).message); } }}>Restore</button>
        <button className="btn small danger" onClick={async () => { if (await confirm("Delete permanently?", `"${f.path}" will be gone for good.`)) { await api(`${store.base()}/trash/${f.id}`, { method: "DELETE" }); load(); } }}>Delete</button></li>)}</ul>}
  </>;
}

function AboutSettings({ cfg }: { cfg: SiteConfig | null }) {
  const now = cfg ? ({ open: "Anyone can create an account", invite: "Only people with an invite link", closed: "Nobody — sign-up is closed" } as const)[cfg.signup] : "…";
  return <>
    <h3>About {settings.appName}</h3>
    <p className="setting-desc">{settings.appName} keeps Markdown notes, links between them, and attachments on this site.</p>
    <Row name="Who can sign up" desc="Chosen when the site was built."><span className="setting-value" data-testid="access-mode">{cfg ? ACCESS_LABELS[cfg.access] : "…"}</span></Row>
    <Row name="New accounts right now"><span className="setting-value" data-testid="signup-state">{now}</span></Row>
  </>;
}
type Person = { id: number; name: string; email: string; role: string; createdAt: string; removed: boolean };
type Invite = { id: number; email: string; createdAt: string; expiresAt: string };
function PeopleSettings() {
  const [data, setData] = useState<{ members: Person[]; invites: Invite[] } | null>(null);
  const [email, setEmail] = useState(""); const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<{ email: string; link: string } | null>(null);
  const load = () => api<{ members: Person[]; invites: Invite[] }>("/api/people").then(setData).catch(e => toast(e.message));
  useEffect(() => { load(); }, []);
  const invite = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    try { const r = await api<{ email: string; link: string }>("/api/invites", { body: { email } }); setMade(r); setEmail(""); load(); }
    catch (x) { setErr((x as Error).message); }
  };
  const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return <>
    <h3>People</h3>
    <p className="setting-desc">This site is invite-only. Invite someone by email, then send them the link. Each link works once and expires after 7 days. The app does not send email.</p>
    <form className="invite-form" onSubmit={invite}>
      <input type="email" aria-label="Email to invite" placeholder="name@example.com" value={email} onChange={e => setEmail(e.target.value)} required />
      <button className="btn primary small">Invite</button>
    </form>
    {err && <div className="field-error" role="alert">{err}</div>}
    {made && <div className="invite-made" role="status">
      <div>Invite link for {made.email}:</div>
      <code className="invite-link">{made.link}</code>
      <button className="btn small" onClick={() => { navigator.clipboard?.writeText(made.link).then(() => toast("Link copied"), () => toast("Could not copy; select the link instead")); }}>Copy link</button>
    </div>}
    <h4>Pending invites</h4>
    {!data ? <p>Loading…</p> : data.invites.length === 0 ? <p className="muted">No pending invites.</p> :
      <ul className="people-list" aria-label="Pending invites">{data.invites.map(i => <li key={i.id}><span className="person-email">{i.email}</span><span className="muted">expires {day(i.expiresAt)}</span>
        <button className="btn small" onClick={async () => { await api(`/api/invites/${i.id}`, { method: "DELETE" }); toast("Invite revoked"); load(); }}>Revoke</button></li>)}</ul>}
    <h4>People with access</h4>
    {data && <ul className="people-list" aria-label="People">{data.members.map(m => <li key={m.id} className={m.removed ? "is-removed" : ""}>
      <span className="person-name">{m.name}</span><span className="person-email muted">{m.email}</span>
      <span className="badge">{m.role === "owner" ? "Owner" : m.removed ? "No access" : "Member"}</span>
      {m.role !== "owner" && (m.removed
        ? <button className="btn small" onClick={async () => { await api(`/api/people/${m.id}/access`, { body: { access: true } }); load(); }}>Give access back</button>
        : <button className="btn small danger" onClick={async () => { if (await confirm("Remove access?", `${m.name} will be signed out and cannot sign in again. Their notes are kept.`, "Remove access")) { await api(`/api/people/${m.id}/access`, { body: { access: false } }); load(); } }}>Remove access</button>)}
    </li>)}</ul>}
  </>;
}
