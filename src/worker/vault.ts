// Vault storage: files in D1 (notes) and R2 (attachments), plus the link/tag/search index.
import { parseNote, ParsedLink, asList } from "../shared/parse";
import { basename, checkName, dirname, fileKey, joinPath, lc, resolveLink, targetKey, displayName, extname } from "../shared/paths";
import { rewriteLinks } from "../shared/rewrite";
import { cleanSettings, VaultSettings } from "../shared/vaultSettings";
import { HttpError } from "./http";
import { randomHex } from "./auth";

export interface FileRow { id: number; vault_id: number; path: string; kind: "note" | "folder" | "attachment"; size: number; mime: string | null; r2_key: string | null; version: number; seq: number; ctime: string; mtime: string; deleted_at: string | null; content?: string | null }
export const META = "id, vault_id, path, kind, size, mime, r2_key, version, seq, ctime, mtime, deleted_at";
export const MAX_NOTE_BYTES = 1_000_000;
export const ATTACH_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", pdf: "application/pdf",
};
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const chunk = <T,>(a: T[], n: number) => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
export function inferType(key: string, v: unknown): string {
  const k = key.toLowerCase();
  if (k === "tags") return "tags";
  if (k === "aliases" || k === "cssclasses" || Array.isArray(v)) return "list";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "checkbox";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return "date";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v)) return "datetime";
  return "text";
}

export class Vault {
  constructor(public env: Env, public id: number, public now: () => string) {}
  get db() { return this.env.DB; }

  async settings(): Promise<VaultSettings> {
    const r = await this.db.prepare("SELECT settings FROM vaults WHERE id=?").bind(this.id).first<{ settings: string }>();
    return cleanSettings(JSON.parse(r?.settings || "{}"));
  }
  async live(): Promise<FileRow[]> {
    return (await this.db.prepare(`SELECT ${META} FROM files WHERE vault_id=? AND deleted_at IS NULL ORDER BY path_lc`).bind(this.id).all<FileRow>()).results;
  }
  async get(id: number, withContent = false): Promise<FileRow> {
    const f = await this.db.prepare(`SELECT ${META}${withContent ? ", content" : ""} FROM files WHERE id=? AND vault_id=? AND deleted_at IS NULL`).bind(id, this.id).first<FileRow>();
    if (!f) throw new HttpError(404, "That file is not in this vault");
    return f;
  }
  async byPath(path: string): Promise<FileRow | null> {
    return await this.db.prepare(`SELECT ${META} FROM files WHERE vault_id=? AND path_lc=? AND deleted_at IS NULL`).bind(this.id, lc(path)).first<FileRow>();
  }
  bumpSeq() { return this.db.prepare("UPDATE vaults SET seq=seq+1 WHERE id=?").bind(this.id); }
  seqExpr() { return `(SELECT seq FROM vaults WHERE id=${this.id})`; }

  /** Check a full path: every segment a valid name. Returns the cleaned path. */
  checkPath(path: unknown, kind: "note" | "folder" | "attachment"): string {
    if (typeof path !== "string") throw new HttpError(400, "Enter a name");
    let p = path.split("/").map(s => s.trim()).filter(Boolean).join("/");
    if (kind === "note" && !p.toLowerCase().endsWith(".md")) p += ".md";
    const segs = p.split("/");
    for (const [i, s] of segs.entries()) {
      const name = i === segs.length - 1 && kind === "note" ? s.slice(0, -3) : s;
      const err = checkName(name); if (err) throw new HttpError(400, err, { field: "name" });
    }
    if (p.length > 500) throw new HttpError(400, "That path is too long");
    return p;
  }

  /** Statements that create any missing parent folders of `path`. */
  folderStatements(path: string, existing: Set<string>): D1PreparedStatement[] {
    const out: D1PreparedStatement[] = [];
    const segs = path.split("/"); segs.pop();
    let cur = "";
    for (const s of segs) {
      cur = joinPath(cur, s);
      if (existing.has(lc(cur))) continue;
      existing.add(lc(cur));
      out.push(this.insertStmt(cur, "folder", null, null, null, 0));
    }
    return out;
  }
  insertStmt(path: string, kind: string, content: string | null, mime: string | null, r2: string | null, size: number, rev = randomHex(8)) {
    const now = this.now();
    return this.db.prepare(`INSERT INTO files (vault_id,path,path_lc,key,kind,content,size,mime,r2_key,version,rev,seq,ctime,mtime) VALUES (?,?,?,?,?,?,?,?,?,1,?,${this.seqExpr()},?,?)`)
      .bind(this.id, path, lc(path), fileKey(path), kind, content, size, mime, r2, rev, now, now);
  }

  /** Index statements for one note, applied only if the note's rev is still `rev`. */
  indexStatements(fileId: number, path: string, content: string, rev: string, files: Map<string, FileRow>): D1PreparedStatement[] {
    const p = parseNote(content);
    const guard = "WHERE (SELECT rev FROM files WHERE id=?)=?";
    const st: D1PreparedStatement[] = [];
    for (const t of ["links WHERE source_id", "tags WHERE file_id", "headings WHERE file_id", "blocks WHERE file_id", "aliases WHERE file_id", "props WHERE file_id"])
      st.push(this.db.prepare(`DELETE FROM ${t}=? AND (SELECT rev FROM files WHERE id=?)=?`).bind(fileId, fileId, rev));
    st.push(this.db.prepare(`DELETE FROM notes_fts WHERE rowid=? AND (SELECT rev FROM files WHERE id=?)=?`).bind(fileId, fileId, rev));
    st.push(this.db.prepare(`INSERT INTO notes_fts (rowid,name,body,vault_id) SELECT ?,?,?,? ${guard}`).bind(fileId, displayName(path), content, this.id, fileId, rev));
    for (const l of p.links) {
      const t = resolveLink(l.linkpath, path, files);
      st.push(this.db.prepare(`INSERT INTO links (vault_id,source_id,kind,format,linkpath,subpath,display,line,prop,target_key,target_id) SELECT ?,?,?,?,?,?,?,?,?,?,? ${guard}`)
        .bind(this.id, fileId, l.kind, l.format, l.linkpath, l.subpath, l.display, l.line, l.frontmatterKey ?? null, l.linkpath ? targetKey(l.linkpath) : "", t?.id ?? null, fileId, rev));
    }
    const seenTags = new Set<string>();
    for (const t of p.tags) {
      const k = `${t.tag.toLowerCase()}@${t.line}`; if (seenTags.has(k)) continue; seenTags.add(k);
      st.push(this.db.prepare(`INSERT INTO tags (vault_id,file_id,tag,tag_lc,line) SELECT ?,?,?,?,? ${guard}`).bind(this.id, fileId, t.tag, t.tag.toLowerCase(), t.line, fileId, rev));
    }
    for (const h of p.headings) st.push(this.db.prepare(`INSERT INTO headings (file_id,vault_id,level,text,line) SELECT ?,?,?,?,? ${guard}`).bind(fileId, this.id, h.level, h.text, h.line, fileId, rev));
    for (const b of p.blocks) st.push(this.db.prepare(`INSERT INTO blocks (file_id,block_id,line,text) SELECT ?,?,?,? ${guard}`).bind(fileId, b.id, b.line, b.text.slice(0, 500), fileId, rev));
    for (const a of p.aliases) st.push(this.db.prepare(`INSERT INTO aliases (vault_id,file_id,alias,alias_lc) SELECT ?,?,?,? ${guard}`).bind(this.id, fileId, a, a.toLowerCase(), fileId, rev));
    if (p.frontmatter.valid) for (const [k, v] of Object.entries(p.frontmatter.data)) {
      st.push(this.db.prepare(`INSERT INTO props (vault_id,file_id,key,key_lc,value) SELECT ?,?,?,?,? ${guard}`).bind(this.id, fileId, k, k.toLowerCase(), JSON.stringify(v ?? null), fileId, rev));
      st.push(this.db.prepare(`INSERT OR IGNORE INTO prop_types (vault_id,key_lc,type) VALUES (?,?,?)`).bind(this.id, k.toLowerCase(), inferType(k, v)));
    }
    return st;
  }

  /** Re-resolve links whose target name is one of `keys` (after files appear, move or go away). */
  async reresolve(keys: string[], extraSources: number[] = []) {
    const files = await this.live();
    const map = new Map(files.map(f => [lc(f.path), f]));
    const byId = new Map(files.map(f => [f.id, f]));
    const rows: { id: number; source_id: number; linkpath: string; target_id: number | null }[] = [];
    for (const ks of chunk([...new Set(keys)], 90)) {
      if (!ks.length) continue;
      rows.push(...(await this.db.prepare(`SELECT id,source_id,linkpath,target_id FROM links WHERE vault_id=? AND target_key IN (${ks.map(() => "?").join(",")})`).bind(this.id, ...ks).all<any>()).results);
    }
    for (const ids of chunk([...new Set(extraSources)], 90)) {
      if (!ids.length) continue;
      rows.push(...(await this.db.prepare(`SELECT id,source_id,linkpath,target_id FROM links WHERE source_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<any>()).results);
    }
    const updates: D1PreparedStatement[] = [];
    const seen = new Set<number>();
    for (const r of rows) {
      if (seen.has(r.id)) continue; seen.add(r.id);
      const src = byId.get(r.source_id); if (!src) continue;
      const t = resolveLink(r.linkpath, src.path, map)?.id ?? null;
      if (t !== r.target_id) updates.push(this.db.prepare("UPDATE links SET target_id=? WHERE id=?").bind(t, r.id));
    }
    for (const c of chunk(updates, 200)) await this.db.batch(c);
  }

  async createNote(pathIn: unknown, content: string): Promise<FileRow> {
    const path = this.checkPath(pathIn, "note");
    if (new TextEncoder().encode(content).length > MAX_NOTE_BYTES) throw new HttpError(413, "Notes can be up to 1 MB");
    const files = await this.live();
    if (files.some(f => lc(f.path) === lc(path))) throw new HttpError(409, `"${basename(path)}" already exists there`, { field: "name" });
    const rev = randomHex(8);
    const existing = new Set(files.filter(f => f.kind === "folder").map(f => lc(f.path)));
    await this.db.batch([this.bumpSeq(), ...this.folderStatements(path, existing), this.insertStmt(path, "note", content, null, null, content.length, rev)]);
    const row = (await this.byPath(path))!;
    const map = new Map([...files, row].map(f => [lc(f.path), f]));
    await this.db.batch(this.indexStatements(row.id, path, content, rev, map));
    await this.reresolve([fileKey(path)]);
    return row;
  }
  async createFolder(pathIn: unknown): Promise<FileRow> {
    const path = this.checkPath(pathIn, "folder");
    const files = await this.live();
    if (files.some(f => lc(f.path) === lc(path))) throw new HttpError(409, `"${basename(path)}" already exists there`, { field: "name" });
    const existing = new Set(files.filter(f => f.kind === "folder").map(f => lc(f.path)));
    await this.db.batch([this.bumpSeq(), ...this.folderStatements(path + "/x", existing)]);
    return (await this.byPath(path))!;
  }

  /** Save a note's text if `baseVersion` is still current; otherwise 409 with the current text. */
  async save(id: number, content: string, baseVersion: number): Promise<FileRow> {
    if (typeof content !== "string") throw new HttpError(400, "Send the note text");
    if (new TextEncoder().encode(content).length > MAX_NOTE_BYTES) throw new HttpError(413, "Notes can be up to 1 MB");
    const f = await this.get(id);
    if (f.kind !== "note") throw new HttpError(400, "Only notes have text");
    const rev = randomHex(8);
    const files = await this.live();
    const map = new Map(files.map(x => [lc(x.path), x]));
    const res = await this.db.batch([
      this.bumpSeq(),
      this.db.prepare(`UPDATE files SET content=?, size=?, version=version+1, rev=?, seq=${this.seqExpr()}, mtime=? WHERE id=? AND version=? AND deleted_at IS NULL`)
        .bind(content, content.length, rev, this.now(), id, baseVersion),
      ...this.indexStatements(id, f.path, content, rev, map),
    ]);
    if (!res[1].meta.changes) {
      const cur = await this.get(id, true);
      throw new HttpError(409, "This note changed on another device", { current: cur });
    }
    return await this.get(id);
  }

  /** Rename or move a file or folder. Rewrites links to keep them pointing at the same files. */
  async move(id: number, newPathIn: unknown, opts: { updateLinks?: boolean; dryRun?: boolean }) {
    const f = await this.get(id);
    const newPath = this.checkPath(newPathIn, f.kind === "note" ? "note" : f.kind === "folder" ? "folder" : "attachment");
    if (f.kind === "attachment" && extname(newPath) !== extname(f.path)) throw new HttpError(400, "Keep the file's extension");
    if (newPath === f.path) return { moved: 0, updatedNotes: 0, updatedLinks: 0 };
    if (f.kind === "folder" && lc(newPath + "/").startsWith(lc(f.path + "/"))) throw new HttpError(400, "A folder cannot go inside itself");
    const files = await this.live();
    const moving = files.filter(x => x.id === id || (f.kind === "folder" && lc(x.path).startsWith(lc(f.path) + "/")));
    const movingIds = new Set(moving.map(x => x.id));
    const moves = new Map<string, string>(); // old path -> new path
    for (const x of moving) moves.set(x.path, newPath + x.path.slice(f.path.length));
    for (const [, np] of moves) {
      const clash = files.find(y => !movingIds.has(y.id) && lc(y.path) === lc(np));
      if (clash) throw new HttpError(409, `"${basename(np)}" already exists there`, { field: "name" });
    }
    const after = files.map(x => ({ ...x, path: moves.get(x.path) ?? x.path }));
    const mapBefore = new Map(files.map(x => [lc(x.path), x]));
    const mapAfter = new Map(after.map(x => [lc(x.path), x]));
    const settings = await this.settings();
    const updateLinks = opts.updateLinks ?? settings.autoUpdateLinks;

    // Notes whose links may change: links to moved files, links by name to the new names, and moved notes themselves.
    const newKeys = [...moves.values()].map(fileKey), oldKeys = [...moves.keys()].map(fileKey);
    const ids = new Set<number>();
    for (const c of chunk([...movingIds], 90)) for (const r of (await this.db.prepare(`SELECT DISTINCT source_id FROM links WHERE target_id IN (${c.map(() => "?").join(",")})`).bind(...c).all<any>()).results) ids.add(r.source_id);
    for (const c of chunk([...new Set(newKeys)], 90)) for (const r of (await this.db.prepare(`SELECT DISTINCT source_id FROM links WHERE vault_id=? AND target_key IN (${c.map(() => "?").join(",")})`).bind(this.id, ...c).all<any>()).results) ids.add(r.source_id);
    for (const x of moving) if (x.kind === "note") ids.add(x.id);
    const rewrites: { id: number; path: string; content: string; version: number }[] = [];
    let updatedLinks = 0;
    if (updateLinks) {
      for (const c of chunk([...ids], 50)) {
        const rows = (await this.db.prepare(`SELECT id,path,content,version FROM files WHERE id IN (${c.map(() => "?").join(",")}) AND kind='note' AND deleted_at IS NULL`).bind(...c).all<any>()).results;
        for (const r of rows) {
          const srcAfter = moves.get(r.path) ?? r.path;
          const allAfter = after.map(x => x.path);
          let count = 0;
          const out = rewriteLinks(r.content ?? "", {
            before: (l: ParsedLink) => resolveLink(l.linkpath, r.path, mapBefore)?.path ?? null,
            after: (l: ParsedLink) => { const t = resolveLink(l.linkpath, srcAfter, mapAfter)?.path ?? null; return t; },
            moved: (p: string) => { const n = moves.get(p) ?? p; if (n !== p) count++; return n; },
            sourcePathAfter: srcAfter, allPathsAfter: allAfter, format: settings.linkFormat,
          });
          if (out != null) { rewrites.push({ id: r.id, path: srcAfter, content: out, version: r.version }); updatedLinks += Math.max(count, 1); }
        }
      }
    }
    if (opts.dryRun) return { moved: moving.length, updatedNotes: rewrites.length, updatedLinks };

    const now = this.now();
    const existing = new Set(files.filter(x => x.kind === "folder" && !movingIds.has(x.id)).map(x => lc(x.path)));
    const st: D1PreparedStatement[] = [this.bumpSeq(), ...this.folderStatements(newPath, existing)];
    // Two steps avoid unique-index clashes when paths swap case: first to a temporary path, then to the final one.
    for (const x of moving) st.push(this.db.prepare(`UPDATE files SET path=?, path_lc=? WHERE id=?`).bind(`\u0000${x.id}`, `\u0000${x.id}`, x.id));
    for (const x of moving) { const np = moves.get(x.path)!; st.push(this.db.prepare(`UPDATE files SET path=?, path_lc=?, key=?, seq=${this.seqExpr()}, mtime=? WHERE id=?`).bind(np, lc(np), fileKey(np), now, x.id)); }
    // Bookmarks point at paths; keep them on the moved files.
    for (const x of moving) { const np = moves.get(x.path)!; st.push(this.db.prepare(`UPDATE bookmarks SET path=? WHERE vault_id=? AND lower(path)=?`).bind(np, this.id, lc(x.path))); }
    const revs = new Map<number, string>();
    for (const r of rewrites) {
      const rev = randomHex(8); revs.set(r.id, rev);
      st.push(this.db.prepare(`UPDATE files SET content=?, size=?, version=version+1, rev=?, seq=${this.seqExpr()}, mtime=? WHERE id=?`).bind(r.content, r.content.length, rev, now, r.id));
    }
    for (const c of chunk(st, 400)) await this.db.batch(c);
    // Reindex changed notes and moved notes (names changed in the search index).
    const filesNow = await this.live();
    const mapNow = new Map(filesNow.map(x => [lc(x.path), x]));
    const toIndex = new Map<number, { path: string; content: string; rev: string }>();
    for (const r of rewrites) toIndex.set(r.id, { path: r.path, content: r.content, rev: revs.get(r.id)! });
    const movedNotes = moving.filter(x => x.kind === "note" && !toIndex.has(x.id)).map(x => x.id);
    for (const c of chunk(movedNotes, 50)) for (const r of (await this.db.prepare(`SELECT id,path,content,rev FROM files WHERE id IN (${c.map(() => "?").join(",")})`).bind(...c).all<any>()).results) toIndex.set(r.id, { path: r.path, content: r.content ?? "", rev: r.rev });
    for (const [fid, x] of toIndex) await this.db.batch(this.indexStatements(fid, x.path, x.content, x.rev, mapNow));
    await this.reresolve([...oldKeys, ...newKeys], [...ids]);
    return { moved: moving.length, updatedNotes: rewrites.length, updatedLinks };
  }

  /** Move to the trash (or delete for good). Folders take their contents with them. */
  async remove(id: number, permanent: boolean) {
    const f = await this.get(id);
    const files = await this.live();
    const victims = files.filter(x => x.id === id || (f.kind === "folder" && lc(x.path).startsWith(lc(f.path) + "/")));
    const now = this.now();
    const st: D1PreparedStatement[] = [this.bumpSeq()];
    for (const v of victims) {
      st.push(this.db.prepare(`UPDATE files SET deleted_at=?, seq=${this.seqExpr()}, rev=? WHERE id=?`).bind(now, randomHex(8), v.id));
      for (const t of ["links WHERE source_id", "tags WHERE file_id", "headings WHERE file_id", "blocks WHERE file_id", "aliases WHERE file_id", "props WHERE file_id"]) st.push(this.db.prepare(`DELETE FROM ${t}=?`).bind(v.id));
      st.push(this.db.prepare("DELETE FROM notes_fts WHERE rowid=?").bind(v.id));
    }
    for (const c of chunk(st, 400)) await this.db.batch(c);
    if (permanent) for (const v of victims) await this.purge(v.id);
    await this.reresolve(victims.map(v => fileKey(v.path)));
    return { removed: victims.length };
  }
  async trash() {
    return (await this.db.prepare(`SELECT ${META} FROM files WHERE vault_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, path_lc`).bind(this.id).all<FileRow>()).results;
  }
  async restore(id: number) {
    const f = await this.db.prepare(`SELECT ${META}, content, rev FROM files WHERE id=? AND vault_id=? AND deleted_at IS NOT NULL`).bind(id, this.id).first<any>();
    if (!f) throw new HttpError(404, "That file is not in the trash");
    const files = await this.live();
    let path = f.path as string;
    // Pick a free name if something now uses the old one: "Name 1", "Name 2", ...
    if (files.some(x => lc(x.path) === lc(path))) path = freeName(path, new Set(files.map(x => lc(x.path))), f.kind === "folder");
    const existing = new Set(files.filter(x => x.kind === "folder").map(x => lc(x.path)));
    const rev = randomHex(8);
    await this.db.batch([this.bumpSeq(), ...this.folderStatements(path, existing),
      this.db.prepare(`UPDATE files SET deleted_at=NULL, path=?, path_lc=?, key=?, rev=?, seq=${this.seqExpr()} WHERE id=?`).bind(path, lc(path), fileKey(path), rev, id)]);
    if (f.kind === "note") { const map = new Map([...files, { ...f, path }].map((x: any) => [lc(x.path), x])); await this.db.batch(this.indexStatements(id, path, f.content ?? "", rev, map)); }
    await this.reresolve([fileKey(path)]);
    return await this.get(id);
  }
  async purge(id: number) {
    const f = await this.db.prepare(`SELECT r2_key FROM files WHERE id=? AND vault_id=? AND deleted_at IS NOT NULL`).bind(id, this.id).first<any>();
    if (!f) throw new HttpError(404, "That file is not in the trash");
    if (f.r2_key) await this.env.FILES.delete(f.r2_key);
    await this.db.batch([this.db.prepare("DELETE FROM links WHERE source_id=?").bind(id), this.db.prepare("UPDATE links SET target_id=NULL WHERE target_id=?").bind(id), this.db.prepare("DELETE FROM files WHERE id=?").bind(id)]);
  }

  async uploadAttachment(pathIn: unknown, data: ArrayBuffer): Promise<FileRow> {
    const path0 = this.checkPath(pathIn, "attachment");
    const ext = extname(path0);
    const mime = ATTACH_TYPES[ext];
    if (!mime) throw new HttpError(415, "That kind of file cannot be added. Use an image, audio, video or PDF file.");
    if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "Attachments can be up to 20 MB");
    const files = await this.live();
    const path = files.some(f => lc(f.path) === lc(path0)) ? freeName(path0, new Set(files.map(f => lc(f.path))), false) : path0;
    const key = `v${this.id}/${randomHex(16)}`;
    await this.env.FILES.put(key, data, { httpMetadata: { contentType: mime } });
    const existing = new Set(files.filter(f => f.kind === "folder").map(f => lc(f.path)));
    await this.db.batch([this.bumpSeq(), ...this.folderStatements(path, existing), this.insertStmt(path, "attachment", null, mime, key, data.byteLength)]);
    await this.reresolve([fileKey(path)]);
    return (await this.byPath(path))!;
  }
}

/** "Folder/Name.md" -> "Folder/Name 1.md", "Folder/Name 2.md", ... first one not in `taken`. */
export function freeName(path: string, taken: Set<string>, isFolder: boolean) {
  const dir = dirname(path), b = basename(path);
  const dot = isFolder ? -1 : b.lastIndexOf(".");
  const stem = dot > 0 ? b.slice(0, dot) : b, ext = dot > 0 ? b.slice(dot) : "";
  for (let i = 1; ; i++) { const p = joinPath(dir, `${stem} ${i}${ext}`); if (!taken.has(lc(p))) return p; }
}
export { asList };
