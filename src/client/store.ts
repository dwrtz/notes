// Client state for one open vault: file tree, note texts with autosave and sync, settings.
import { useEffect, useReducer } from "react";
import { api, ApiError } from "./api";
import { merge3 } from "../shared/merge";
import { resolveLink, linktextFor, lc, dirname, joinPath, basename, displayName } from "../shared/paths";
import { VaultSettings } from "../shared/vaultSettings";
import { toast } from "./ui";
import { formatDate, partsInZone } from "../shared/dates";

export interface FileMeta { id: number; path: string; kind: "note" | "folder" | "attachment"; size: number; mime: string | null; version: number; seq: number; ctime: string; mtime: string; deleted: boolean; aliases: string[] }
export interface Vault { id: number; name: string; seq: number; settings: VaultSettings }
interface NoteState { content: string; version: number; base: string; dirty: boolean; saving: boolean; timer?: number; loaded: boolean }

type Listener = () => void;
export class Emitter { private ls = new Set<Listener>(); on(l: Listener) { this.ls.add(l); return () => { this.ls.delete(l); }; } emit() { for (const l of [...this.ls]) l(); } }
export function useEmitter(e: Emitter) { const [, force] = useReducer((x: number) => x + 1, 0); useEffect(() => e.on(force), [e]); }

export const SAVE_DELAY = 800;

export class VaultStore extends Emitter {
  files = new Map<number, FileMeta>();
  byPath = new Map<string, FileMeta>();
  notes = new Map<number, NoteState>();
  seq = 0;
  syncState: "saved" | "saving" | "offline" | "error" = "saved";
  remote = new Emitter(); // fired when an open note changed on another device
  remoteChanged = new Set<number>();
  private pollTimer?: number;
  /** The app clock (server time, test clock aware). Set by the app. */
  now: () => string = () => new Date().toISOString();
  constructor(public vault: Vault) { super(); }
  get settings() { return this.vault.settings; }
  base() { return `/api/vaults/${this.vault.id}`; }

  async load() {
    const t = await api<{ seq: number; files: FileMeta[] }>(`${this.base()}/tree`);
    this.files.clear(); for (const f of t.files) this.files.set(f.id, f);
    this.seq = t.seq; this.reindex(); this.emit();
  }
  private reindex() { this.byPath = new Map([...this.files.values()].map(f => [lc(f.path), f])); }
  startPolling() {
    const tick = () => { this.poll().catch(() => {}); };
    this.pollTimer = window.setInterval(tick, 5000);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(this.pollTimer); window.removeEventListener("focus", tick); };
  }
  /** Pull changes from other devices. */
  async poll() {
    let r: { seq: number; changed: FileMeta[] };
    try { r = await api(`${this.base()}/changes?since=${this.seq}`); }
    catch (e) { if (e instanceof ApiError && e.status === 0) { this.syncState = "offline"; this.emit(); } return; }
    if (this.syncState === "offline") this.syncState = "saved";
    if (!r.changed.length) { this.seq = r.seq; this.emit(); return; }
    for (const f of r.changed) {
      if (f.deleted) { this.files.delete(f.id); continue; }
      const old = this.files.get(f.id);
      this.files.set(f.id, f);
      const n = this.notes.get(f.id);
      if (n && n.loaded && f.version > n.version && old) {
        if (!n.dirty && !n.saving) { await this.refetch(f.id); this.remoteChanged.add(f.id); }
      }
    }
    this.seq = r.seq; this.reindex(); this.emit();
    if (this.remoteChanged.size) this.remote.emit();
  }
  private async refetch(id: number) {
    const d = await api<FileMeta & { content: string }>(`${this.base()}/files/${id}`);
    const n = this.notes.get(id); if (!n) return;
    n.content = d.content; n.base = d.content; n.version = d.version;
  }

  file(id: number | undefined | null) { return id == null ? undefined : this.files.get(id); }
  byPathGet(path: string) { return this.byPath.get(lc(path)); }
  list() { return [...this.files.values()]; }
  resolve(linkpath: string, sourcePath: string) { return resolveLink(linkpath, sourcePath, this.byPath as Map<string, FileMeta>); }
  linktext(target: FileMeta, sourcePath: string) { return linktextFor(target.path, sourcePath, this.list().filter(f => f.kind !== "folder").map(f => f.path), this.settings.linkFormat); }

  /** Get a note's text (cached). */
  async note(id: number): Promise<string> {
    const n = this.notes.get(id);
    if (n?.loaded) return n.content;
    const d = await api<FileMeta & { content: string }>(`${this.base()}/files/${id}`);
    const cur = this.notes.get(id);
    if (cur?.loaded) return cur.content;
    this.notes.set(id, { content: d.content, version: d.version, base: d.content, dirty: false, saving: false, loaded: true });
    return d.content;
  }
  cached(id: number) { const n = this.notes.get(id); return n?.loaded ? n.content : undefined; }
  setText(id: number, text: string) {
    const n = this.notes.get(id); if (!n) return;
    if (n.content === text) return;
    n.content = text; n.dirty = true;
    this.syncState = "saving"; this.emit();
    window.clearTimeout(n.timer);
    n.timer = window.setTimeout(() => this.flush(id), SAVE_DELAY);
  }
  async flushAll() { await Promise.all([...this.notes.keys()].map(id => this.flush(id))); }
  /** Save now. On a conflict, merge with the other device's text; if lines clash, keep theirs and save ours as a copy. */
  async flush(id: number): Promise<void> {
    const n = this.notes.get(id); if (!n || !n.dirty) return;
    if (n.saving) { window.clearTimeout(n.timer); n.timer = window.setTimeout(() => this.flush(id), SAVE_DELAY); return; }
    window.clearTimeout(n.timer);
    n.saving = true; const sending = n.content;
    try {
      const m = await api<FileMeta>(`${this.base()}/files/${id}/content`, { method: "PUT", body: { content: sending, baseVersion: n.version } });
      n.version = m.version; n.base = sending; n.dirty = n.content !== sending;
      const f = this.files.get(id); if (f) this.files.set(id, { ...m, aliases: f.aliases });
      this.syncState = n.dirty ? "saving" : "saved";
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.current) {
        const cur = e.data.current as FileMeta & { content: string };
        const merged = merge3(n.base, n.content, cur.content ?? "");
        const mine = n.content;
        n.version = cur.version; n.base = cur.content ?? "";
        n.content = merged.text; n.dirty = merged.text !== n.base;
        this.remoteChanged.add(id); this.remote.emit();
        if (!merged.clean) {
          const f = this.files.get(id);
          if (f) {
            const stamp = formatDate(partsInZone(this.now(), Intl.DateTimeFormat().resolvedOptions().timeZone), "YYYYMMDDHHmm");
            const copy = joinPath(dirname(f.path), `${displayName(f.path)} (conflict ${stamp}).md`);
            await this.createNote(copy, mine).catch(() => {});
            toast(`This note also changed on another device. Your version was saved as "${basename(copy)}".`);
          }
        }
        n.saving = false;
        if (n.dirty) return this.flush(id);
      } else if (e instanceof ApiError && e.status === 404) {
        // Deleted on another device: keep the text as a new note next to where it was.
        const f = this.files.get(id); n.dirty = false; this.notes.delete(id);
        if (f) {
          const copy = this.freePath(dirname(f.path), displayName(f.path));
          await this.createNote(copy, n.content).catch(() => {});
          toast(`This note was deleted on another device. Your text was saved as "${basename(copy)}".`);
        }
        this.syncState = "saved";
      } else {
        this.syncState = e instanceof ApiError && e.status === 0 ? "offline" : "error";
        if (!(e instanceof ApiError && e.status === 0)) toast(e instanceof Error ? e.message : "Could not save");
        n.timer = window.setTimeout(() => this.flush(id), 5000);
      }
    } finally { n.saving = false; this.emit(); }
  }

  upsert(f: FileMeta) { this.files.set(f.id, { ...this.files.get(f.id), ...f, aliases: f.aliases ?? this.files.get(f.id)?.aliases ?? [] }); this.reindex(); this.emit(); }
  async createNote(path: string, content = ""): Promise<FileMeta> {
    const f = await api<FileMeta & { content: string }>(`${this.base()}/notes`, { body: { path, content } });
    this.notes.set(f.id, { content, version: f.version, base: content, dirty: false, saving: false, loaded: true });
    await this.load(); return this.files.get(f.id)!;
  }
  async createFolder(path: string) { const f = await api<FileMeta>(`${this.base()}/folders`, { body: { path } }); await this.load(); return f; }
  /** Rename/move; returns null if the user declined the link update prompt. */
  async move(id: number, path: string, confirmLinks?: (n: { updatedNotes: number; updatedLinks: number }) => Promise<boolean>) {
    await this.flushAll();
    let updateLinks: boolean | undefined;
    if (!this.settings.autoUpdateLinks && confirmLinks) {
      const dry = await api(`${this.base()}/files/${id}/move`, { body: { path, dryRun: true, updateLinks: true } });
      updateLinks = dry.updatedNotes ? await confirmLinks(dry) : false;
    }
    const r = await api<{ moved: number; updatedNotes: number; updatedLinks: number; file: FileMeta }>(`${this.base()}/files/${id}/move`, { body: { path, updateLinks } });
    // Notes whose text changed are refetched.
    for (const [nid, n] of this.notes) if (n.loaded && !n.dirty) { n.loaded = false; void nid; }
    await this.load();
    for (const [nid] of this.notes) { await this.note(nid).catch(() => {}); this.remoteChanged.add(nid); }
    this.remote.emit();
    return r;
  }
  async remove(id: number) { await api(`${this.base()}/files/${id}`, { method: "DELETE" }); await this.load(); }
  async upload(path: string, file: Blob): Promise<FileMeta> {
    const f = await api<FileMeta>(`${this.base()}/attachments?path=${encodeURIComponent(path)}`, { raw: file, headers: { "content-type": file.type || "application/octet-stream" } });
    await this.load(); return this.files.get(f.id)!;
  }
  rawUrl(f: FileMeta) { return `${this.base()}/raw/${f.id}?v=${f.version}`; }
  /** Applies at once, then saves; the server's copy wins when it answers (or the old value on error). */
  async saveSettings(patch: Partial<VaultSettings>) {
    const before = this.vault;
    this.vault = { ...this.vault, settings: { ...this.vault.settings, ...patch } }; this.emit();
    try { const v = await api<Vault>(`${this.base()}`, { method: "PATCH", body: { settings: patch } }); this.vault = { ...this.vault, ...v }; }
    catch (e) { this.vault = before; throw e; }
    finally { this.emit(); }
  }

  /** A free path like "Folder/Untitled 2.md". */
  freePath(folder: string, name: string, ext = ".md") {
    for (let i = 0; ; i++) { const p = joinPath(folder, `${name}${i ? " " + i : ""}${ext}`); if (!this.byPath.has(lc(p))) return p; }
  }
  /** Folder for a new note created while `fromPath` is open. */
  newNoteFolder(fromPath?: string) {
    const s = this.settings;
    if (s.newNoteLocation === "current" && fromPath) return dirname(fromPath);
    if (s.newNoteLocation === "folder") return s.newNoteFolder.replace(/^\/+|\/+$/g, "");
    return "";
  }
  attachmentFolder(fromPath?: string) {
    const s = this.settings, here = fromPath ? dirname(fromPath) : "";
    if (s.attachmentLocation === "current") return here;
    if (s.attachmentLocation === "folder") return s.attachmentFolder.replace(/^\/+|\/+$/g, "");
    if (s.attachmentLocation === "subfolder") return joinPath(here, s.attachmentFolder.replace(/^\/+|\/+$/g, "") || "attachments");
    return "";
  }
}
