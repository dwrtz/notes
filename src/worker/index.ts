import { settings, ACCESS_MODES, AccessMode } from "../shared/settings";
import { cleanSettings } from "../shared/vaultSettings";
import { parseNote } from "../shared/parse";
import { parseQuery, evaluate, requiredTerms, explain, QueryError } from "../shared/search";
import { displayName, lc } from "../shared/paths";
import { HttpError, Router, json, body } from "./http";
import { checkPassword, hashPassword, randomHex, readCookie, sessionCookie, sha256, emailOk } from "./auth";
import { Vault, META, FileRow, ATTACH_TYPES } from "./vault";
import { seedDemo, starterNotes } from "./seed";

const DAY = 86_400_000;
const INVITE_DAYS = 7;

/** Who may create an account right now (R24). */
type Signup = { mode: AccessMode; state: "open" | "invite" | "closed"; firstAccount: boolean; override: "" | "0" | "1" };
async function signupPolicy(env: Env, req: Request): Promise<Signup> {
  let mode: AccessMode = settings.access;
  let override = String(env.ALLOW_SIGNUP ?? "").trim();
  if (env.TEST_CLOCK === "1") { // tests switch modes per request, like test_now
    const m = readCookie(req, "test_access"); if (m && (ACCESS_MODES as readonly string[]).includes(m)) mode = m as AccessMode;
    const a = readCookie(req, "test_allow_signup"); if (a !== undefined) override = a === "auto" ? "" : a;
  }
  const ov: Signup["override"] = override === "0" || override === "1" ? override : "";
  const firstAccount = !(await env.DB.prepare("SELECT 1 FROM users WHERE role='owner'").first());
  const state: Signup["state"] = ov === "0" ? "closed" : ov === "1" || firstAccount || mode === "open" ? "open" : mode === "invite_only" ? "invite" : "closed";
  return { mode, state, firstAccount, override: ov };
}
const MAX_BODY = 25 * 1024 * 1024;

/** Deployment allowlist: ALLOWED_EMAILS="a@x.com,b@y.com" limits sign-up, sign-in and existing sessions to these
 *  emails (case-insensitive). Empty or unset means no extra restriction. */
function allowedEmails(env: Env): Set<string> | null {
  const raw = String(env.ALLOWED_EMAILS ?? "").trim();
  if (!raw) return null;
  return new Set(raw.split(",").map(e => e.trim().toLowerCase()).filter(Boolean));
}
const NOT_ALLOWED = "This email can't be used on this site";
function emailAllowed(env: Env, email: unknown): boolean {
  const list = allowedEmails(env);
  return !list || (typeof email === "string" && list.has(email.trim().toLowerCase()));
}

function clock(env: Env, req: Request) {
  if (env.TEST_CLOCK === "1") { const c = readCookie(req, "test_now"); if (c && !Number.isNaN(Date.parse(decodeURIComponent(c)))) return new Date(decodeURIComponent(c)).toISOString(); }
  if (env.NOW) return new Date(env.NOW).toISOString();
  return new Date().toISOString();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        const origin = req.headers.get("origin");
        if (origin && origin !== url.origin) throw new HttpError(403, "Cross-site request refused");
        const len = Number(req.headers.get("content-length") || 0);
        if (len > MAX_BODY) throw new HttpError(413, "That upload is too big");
      }
      const now = () => clock(env, req);
      if (settings.seedDemo) await seedDemo(env, now());
      return await routes(env, req, now).handle(req);
    } catch (e: any) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
      console.error("unexpected error", e?.stack || e);
      return json({ error: "Something went wrong on our side. Try again." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

function routes(env: Env, req: Request, now: () => string) {
  const db = env.DB;
  const r = new Router();

  async function user(): Promise<{ id: number; email: string; name: string; role: string } | null> {
    const t = readCookie(req, "session"); if (!t) return null;
    const u = await db.prepare("SELECT u.id,u.email,u.name,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled_at IS NULL").bind(await sha256(t), now()).first<{ id: number; email: string; name: string; role: string }>();
    return u && emailAllowed(env, u.email) ? u : null; // sessions of emails outside ALLOWED_EMAILS stop working
  }
  async function needOwner() { const u = await needUser(); if (u.role !== "owner") throw new HttpError(403, "Only the owner can do that"); return u; }
  async function needUser() { const u = await user(); if (!u) throw new HttpError(401, "Sign in first"); return u; }
  async function vaultFor(p: Record<string, string>) {
    const u = await needUser();
    const v = await db.prepare("SELECT id FROM vaults WHERE id=? AND user_id=?").bind(Number(p.v), u.id).first<{ id: number }>();
    if (!v) throw new HttpError(404, "Vault not found");
    return new Vault(env, v.id, now);
  }
  async function startSession(uid: number) {
    const token = randomHex(32);
    await db.prepare("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)").bind(await sha256(token), uid, new Date(Date.parse(now()) + 30 * DAY).toISOString()).run();
    return sessionCookie(req, token, 30 * 86400);
  }
  const vaultRow = (v: any) => ({ id: v.id, name: v.name, seq: v.seq, settings: cleanSettings(JSON.parse(v.settings || "{}")), createdAt: v.created_at });
  const meta = (f: FileRow, aliases?: string[]) => ({ id: f.id, path: f.path, kind: f.kind, size: f.size, mime: f.mime, version: f.version, seq: f.seq, ctime: f.ctime, mtime: f.mtime, deleted: !!f.deleted_at, ...(aliases ? { aliases } : {}) });

  r.on("GET", "/api/now", async () => json({ now: now() }));

  // ---------- Accounts ----------
  r.on("GET", "/api/config", async () => {
    const p = await signupPolicy(env, req);
    return json({ access: p.mode, signup: p.state, firstAccount: p.firstAccount });
  });
  async function inviteFor(token: unknown) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
    return await db.prepare("SELECT * FROM invites WHERE token_hash=? AND used_at IS NULL AND expires_at>?").bind(await sha256(token), now()).first<any>();
  }
  const BAD_INVITE = "This invite link is not valid or has expired";
  r.on("GET", "/api/invites/check", async () => {
    const inv = await inviteFor(new URL(req.url).searchParams.get("token"));
    if (!inv) throw new HttpError(404, BAD_INVITE);
    return json({ email: inv.email });
  });
  r.on("POST", "/api/auth/signup", async () => {
    const b = await body(req); const fields: Record<string, string> = {};
    if (emailOk(b.email) && !emailAllowed(env, b.email)) throw new HttpError(403, NOT_ALLOWED, { fields: { email: NOT_ALLOWED } });
    const policy = await signupPolicy(env, req);
    if (policy.state === "closed") throw new HttpError(403, "Sign-up is closed on this site");
    let invite: any = null;
    if (policy.state === "invite") {
      invite = await inviteFor(b.invite);
      if (!invite) throw new HttpError(403, b.invite ? BAD_INVITE : "You need an invite to create an account here");
    }
    if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 80) fields.name = "Enter your name (up to 80 characters)";
    if (!emailOk(b.email)) fields.email = "Enter a valid email";
    else if (invite && b.email.toLowerCase() !== invite.email) fields.email = "Use the email address the invite was sent to";
    if (typeof b.password !== "string" || b.password.length < 8 || b.password.length > 200) fields.password = "Use 8 to 200 characters";
    if (emailOk(b.email) && await db.prepare("SELECT 1 FROM users WHERE email=?").bind(b.email.toLowerCase()).first()) fields.email = "That email already has an account";
    if (Object.keys(fields).length) throw new HttpError(400, "Check the fields below", { fields });
    const t = now();
    if (invite) {
      const used = await db.prepare("UPDATE invites SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?").bind(t, invite.id, t).run();
      if (!used.meta.changes) throw new HttpError(403, BAD_INVITE);
    }
    // The first account becomes the owner. When only the owner may sign up, the insert itself refuses a second one
    // (two people racing to be first cannot both win).
    const ownerOnly = policy.override !== "1" && policy.mode !== "open" && !invite;
    const ins = await db.prepare(
      `INSERT INTO users (email,name,password_hash,created_at,role)
       SELECT ?,?,?,?, CASE WHEN EXISTS (SELECT 1 FROM users WHERE role='owner') THEN 'member' ELSE 'owner' END
       WHERE ? = 0 OR NOT EXISTS (SELECT 1 FROM users WHERE role='owner')`
    ).bind(b.email.toLowerCase(), b.name.trim(), await hashPassword(b.password), t, ownerOnly ? 1 : 0).run().catch(e => {
      if (String(e).includes("UNIQUE")) throw new HttpError(409, "Try again: another account was created at the same moment");
      throw e;
    });
    if (!ins.meta.changes) throw new HttpError(403, "Sign-up is closed on this site");
    const u = (await db.prepare("SELECT id, role FROM users WHERE email=?").bind(b.email.toLowerCase()).first<{ id: number; role: string }>())!;
    await db.prepare("INSERT INTO vaults (user_id,name,created_at) VALUES (?,?,?)").bind(u.id, "My notes", t).run();
    const v = (await db.prepare("SELECT id FROM vaults WHERE user_id=?").bind(u.id).first<{ id: number }>())!;
    await starterNotes(new Vault(env, v.id, now));
    return json({ id: u.id, name: b.name.trim(), email: b.email.toLowerCase(), role: u.role }, 201, { "set-cookie": await startSession(u.id) });
  });
  r.on("POST", "/api/auth/login", async () => {
    const b = await body(req);
    if (emailOk(b.email) && !emailAllowed(env, b.email)) throw new HttpError(403, NOT_ALLOWED);
    const u = emailOk(b.email) ? await db.prepare("SELECT * FROM users WHERE email=?").bind(b.email.toLowerCase()).first<any>() : null;
    if (!u || typeof b.password !== "string" || !(await checkPassword(b.password, u.password_hash))) throw new HttpError(401, "Email or password is wrong");
    if (u.disabled_at) throw new HttpError(403, "This account no longer has access to this site");
    return json({ id: u.id, name: u.name, email: u.email, role: u.role }, 200, { "set-cookie": await startSession(u.id) });
  });
  r.on("POST", "/api/auth/logout", async () => {
    const t = readCookie(req, "session");
    if (t) await db.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(t)).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(req, "", 0) });
  });
  r.on("GET", "/api/me", async () => json(await needUser()));
  r.on("PATCH", "/api/me", async () => {
    const u = await needUser(); const b = await body(req);
    if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 80) throw new HttpError(400, "Enter your name (up to 80 characters)");
    await db.prepare("UPDATE users SET name=? WHERE id=?").bind(b.name.trim(), u.id).run();
    return json({ ...u, name: b.name.trim() });
  });
  r.on("POST", "/api/me/password", async () => {
    const u = await needUser(); const b = await body(req);
    const row = (await db.prepare("SELECT password_hash FROM users WHERE id=?").bind(u.id).first<any>())!;
    if (typeof b.current !== "string" || !(await checkPassword(b.current, row.password_hash))) throw new HttpError(400, "Your current password is wrong");
    if (typeof b.next !== "string" || b.next.length < 8 || b.next.length > 200) throw new HttpError(400, "Use 8 to 200 characters");
    await db.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(await hashPassword(b.next), u.id).run();
    return json({ ok: true });
  });

  // ---------- People (owner; invite-only sites) ----------
  r.on("GET", "/api/people", async () => {
    await needOwner(); const t = now();
    const members = (await db.prepare("SELECT id,name,email,role,created_at,disabled_at FROM users WHERE role<>'demo' ORDER BY role='owner' DESC, created_at").all<any>()).results
      .map(m => ({ id: m.id, name: m.name, email: m.email, role: m.role, createdAt: m.created_at, removed: !!m.disabled_at }));
    const invites = (await db.prepare("SELECT id,email,created_at,expires_at FROM invites WHERE used_at IS NULL AND expires_at>? ORDER BY created_at DESC").bind(t).all<any>()).results
      .map(i => ({ id: i.id, email: i.email, createdAt: i.created_at, expiresAt: i.expires_at }));
    return json({ members, invites });
  });
  r.on("POST", "/api/invites", async () => {
    const u = await needOwner(); const b = await body(req);
    const policy = await signupPolicy(env, req);
    if (policy.mode !== "invite_only") throw new HttpError(400, "Invites are only used when the site is invite-only");
    if (!emailOk(b.email)) throw new HttpError(400, "Enter a valid email", { fields: { email: "Enter a valid email" } });
    if (!emailAllowed(env, b.email)) throw new HttpError(403, NOT_ALLOWED, { fields: { email: NOT_ALLOWED } });
    const email = b.email.toLowerCase();
    if (await db.prepare("SELECT 1 FROM users WHERE email=?").bind(email).first()) throw new HttpError(400, "That email already has an account", { fields: { email: "That email already has an account" } });
    const token = randomHex(32); const t = now();
    const expiresAt = new Date(Date.parse(t) + INVITE_DAYS * DAY).toISOString();
    await db.batch([
      db.prepare("DELETE FROM invites WHERE email=? AND used_at IS NULL").bind(email), // a new invite replaces an older one
      db.prepare("INSERT INTO invites (email,token_hash,created_by,created_at,expires_at) VALUES (?,?,?,?,?)").bind(email, await sha256(token), u.id, t, expiresAt),
    ]);
    const inv = (await db.prepare("SELECT id FROM invites WHERE token_hash=?").bind(await sha256(token)).first<{ id: number }>())!;
    return json({ id: inv.id, email, expiresAt, link: `${new URL(req.url).origin}/signup?invite=${token}` }, 201);
  });
  r.on("DELETE", "/api/invites/:id", async (_q, p) => {
    await needOwner();
    await db.prepare("DELETE FROM invites WHERE id=? AND used_at IS NULL").bind(Number(p.id)).run();
    return json({ ok: true });
  });
  r.on("POST", "/api/people/:id/access", async (_q, p) => {
    const u = await needOwner(); const b = await body(req);
    const target = await db.prepare("SELECT id, role FROM users WHERE id=?").bind(Number(p.id)).first<any>();
    if (!target || target.role === "demo") throw new HttpError(404, "Person not found");
    if (target.id === u.id) throw new HttpError(400, "You cannot remove your own access");
    if (b.access === false) await db.batch([
      db.prepare("UPDATE users SET disabled_at=? WHERE id=?").bind(now(), target.id),
      db.prepare("DELETE FROM sessions WHERE user_id=?").bind(target.id),
    ]);
    else await db.prepare("UPDATE users SET disabled_at=NULL WHERE id=?").bind(target.id).run();
    return json({ ok: true });
  });

  // ---------- Vaults ----------
  r.on("GET", "/api/vaults", async () => {
    const u = await needUser();
    return json((await db.prepare("SELECT * FROM vaults WHERE user_id=? ORDER BY name").bind(u.id).all<any>()).results.map(vaultRow));
  });
  r.on("POST", "/api/vaults", async () => {
    const u = await needUser(); const b = await body(req);
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 60) throw new HttpError(400, "Enter a vault name (up to 60 characters)");
    if (await db.prepare("SELECT 1 FROM vaults WHERE user_id=? AND name=?").bind(u.id, name).first()) throw new HttpError(409, "You already have a vault with that name");
    await db.prepare("INSERT INTO vaults (user_id,name,created_at) VALUES (?,?,?)").bind(u.id, name, now()).run();
    return json(vaultRow(await db.prepare("SELECT * FROM vaults WHERE user_id=? AND name=?").bind(u.id, name).first()), 201);
  });
  r.on("PATCH", "/api/vaults/:v", async (_q, p) => {
    const v = await vaultFor(p); const b = await body(req);
    const cur = (await db.prepare("SELECT * FROM vaults WHERE id=?").bind(v.id).first<any>())!;
    let name = cur.name;
    if (b.name !== undefined) {
      name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name || name.length > 60) throw new HttpError(400, "Enter a vault name (up to 60 characters)");
      if (await db.prepare("SELECT 1 FROM vaults WHERE user_id=? AND name=? AND id<>?").bind(cur.user_id, name, v.id).first()) throw new HttpError(409, "You already have a vault with that name");
    }
    const s = cleanSettings({ ...JSON.parse(cur.settings || "{}"), ...(b.settings && typeof b.settings === "object" ? b.settings : {}) });
    await db.prepare("UPDATE vaults SET name=?, settings=? WHERE id=?").bind(name, JSON.stringify(s), v.id).run();
    return json(vaultRow(await db.prepare("SELECT * FROM vaults WHERE id=?").bind(v.id).first()));
  });
  r.on("DELETE", "/api/vaults/:v", async (_q, p) => {
    const v = await vaultFor(p); const b = await body(req);
    const cur = (await db.prepare("SELECT * FROM vaults WHERE id=?").bind(v.id).first<any>())!;
    if (b.confirm !== cur.name) throw new HttpError(400, "Type the vault's name to delete it");
    if ((await db.prepare("SELECT COUNT(*) n FROM vaults WHERE user_id=?").bind(cur.user_id).first<any>()).n <= 1) throw new HttpError(400, "You need at least one vault");
    let cursor: string | undefined;
    do { const l = await env.FILES.list({ prefix: `v${v.id}/`, cursor }); if (l.objects.length) await env.FILES.delete(l.objects.map(o => o.key)); cursor = l.truncated ? l.cursor : undefined; } while (cursor);
    await db.batch([db.prepare("DELETE FROM notes_fts WHERE vault_id=?").bind(v.id), db.prepare("DELETE FROM vaults WHERE id=?").bind(v.id)]);
    return json({ ok: true });
  });

  // ---------- Files ----------
  async function aliasMap(v: Vault) {
    const m = new Map<number, string[]>();
    for (const a of (await db.prepare("SELECT file_id, alias FROM aliases WHERE vault_id=?").bind(v.id).all<any>()).results) { if (!m.has(a.file_id)) m.set(a.file_id, []); m.get(a.file_id)!.push(a.alias); }
    return m;
  }
  r.on("GET", "/api/vaults/:v/tree", async (_q, p) => {
    const v = await vaultFor(p);
    const seq = (await db.prepare("SELECT seq FROM vaults WHERE id=?").bind(v.id).first<any>()).seq;
    const am = await aliasMap(v);
    return json({ seq, files: (await v.live()).map(f => meta(f, am.get(f.id) ?? [])) });
  });
  r.on("GET", "/api/vaults/:v/changes", async (q, p) => {
    const v = await vaultFor(p);
    const since = Number(new URL(q.url).searchParams.get("since") || 0);
    const seq = (await db.prepare("SELECT seq FROM vaults WHERE id=?").bind(v.id).first<any>()).seq;
    if (since >= seq) return json({ seq, changed: [] });
    const rows = (await db.prepare(`SELECT ${META} FROM files WHERE vault_id=? AND seq>?`).bind(v.id, since).all<FileRow>()).results;
    const am = await aliasMap(v);
    return json({ seq, changed: rows.map(f => meta(f, am.get(f.id) ?? [])) });
  });
  r.on("GET", "/api/vaults/:v/files/:id", async (_q, p) => {
    const v = await vaultFor(p); const f = await v.get(Number(p.id), true);
    return json({ ...meta(f), content: f.kind === "note" ? f.content ?? "" : null });
  });
  r.on("POST", "/api/vaults/:v/notes", async (_q, p) => {
    const v = await vaultFor(p); const b = await body(req);
    const f = await v.createNote(b.path, typeof b.content === "string" ? b.content : "");
    return json({ ...meta(f), content: typeof b.content === "string" ? b.content : "" }, 201);
  });
  r.on("POST", "/api/vaults/:v/folders", async (_q, p) => { const v = await vaultFor(p); const b = await body(req); return json(meta(await v.createFolder(b.path)), 201); });
  r.on("PUT", "/api/vaults/:v/files/:id/content", async (_q, p) => {
    const v = await vaultFor(p); const b = await body(req);
    if (!Number.isInteger(b.baseVersion)) throw new HttpError(400, "Send baseVersion");
    return json(meta(await v.save(Number(p.id), b.content, b.baseVersion)));
  });
  r.on("POST", "/api/vaults/:v/files/:id/move", async (_q, p) => {
    const v = await vaultFor(p); const b = await body(req);
    const res = await v.move(Number(p.id), b.path, { updateLinks: typeof b.updateLinks === "boolean" ? b.updateLinks : undefined, dryRun: !!b.dryRun });
    return json({ ...res, file: b.dryRun ? null : meta(await v.get(Number(p.id))) });
  });
  r.on("DELETE", "/api/vaults/:v/files/:id", async (_q, p) => {
    const v = await vaultFor(p); const s = await v.settings();
    return json(await v.remove(Number(p.id), s.deleteBehavior === "permanent"));
  });
  r.on("GET", "/api/vaults/:v/trash", async (_q, p) => { const v = await vaultFor(p); return json((await v.trash()).map(f => meta(f))); });
  r.on("POST", "/api/vaults/:v/trash/:id/restore", async (_q, p) => { const v = await vaultFor(p); return json(meta(await v.restore(Number(p.id)))); });
  r.on("DELETE", "/api/vaults/:v/trash/:id", async (_q, p) => { const v = await vaultFor(p); await v.purge(Number(p.id)); return json({ ok: true }); });
  r.on("DELETE", "/api/vaults/:v/trash", async (_q, p) => { const v = await vaultFor(p); for (const f of await v.trash()) await v.purge(f.id); return json({ ok: true }); });

  r.on("POST", "/api/vaults/:v/attachments", async (q, p) => {
    const v = await vaultFor(p);
    const path = new URL(q.url).searchParams.get("path") || "";
    const data = await q.arrayBuffer();
    return json(meta(await v.uploadAttachment(path, data)), 201);
  });
  r.on("GET", "/api/vaults/:v/raw/:id", async (_q, p) => {
    const v = await vaultFor(p); const f = await v.get(Number(p.id));
    if (f.kind !== "attachment" || !f.r2_key) throw new HttpError(404, "No such attachment");
    const obj = await env.FILES.get(f.r2_key); if (!obj) throw new HttpError(404, "The file's data is missing");
    const h: Record<string, string> = { "content-type": f.mime || ATTACH_TYPES[f.path.split(".").pop()!.toLowerCase()] || "application/octet-stream", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" };
    if (f.mime === "image/svg+xml") h["content-security-policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
    return new Response(obj.body, { headers: h });
  });

  // ---------- Index queries ----------
  r.on("GET", "/api/vaults/:v/search", async (q, p) => {
    const v = await vaultFor(p);
    const sp = new URL(q.url).searchParams;
    const text = sp.get("q") || ""; const matchCase = sp.get("case") === "1"; const sort = sp.get("sort") || "name-asc";
    let node; try { node = parseQuery(text); } catch (e) { if (e instanceof QueryError) throw new HttpError(400, e.message); throw e; }
    if (!node) return json({ results: [], total: 0, explain: "" });
    const terms = requiredTerms(node).filter(t => t.length >= 3);
    let cands: any[];
    if (terms.length) {
      const expr = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(" AND ");
      cands = (await db.prepare(`SELECT ${META.split(", ").map(c => "f." + c).join(",")}, f.content FROM notes_fts JOIN files f ON f.id=notes_fts.rowid WHERE notes_fts MATCH ? AND notes_fts.vault_id=? AND f.deleted_at IS NULL LIMIT 3000`).bind(expr, v.id).all<any>()).results;
      cands.push(...(await db.prepare(`SELECT ${META}, NULL AS content FROM files WHERE vault_id=? AND kind='attachment' AND deleted_at IS NULL`).bind(v.id).all<any>()).results);
    } else {
      cands = (await db.prepare(`SELECT ${META}, content FROM files WHERE vault_id=? AND kind<>'folder' AND deleted_at IS NULL`).bind(v.id).all<any>()).results;
    }
    const results: any[] = [];
    for (const f of cands) {
      const content = f.content ?? "";
      const parsed = parseNote(content);
      const { hit, matches } = evaluate(node, { path: f.path, content, parsed, isNote: f.kind === "note" }, matchCase);
      if (!hit) continue;
      const byLine = new Map<number, [number, number][]>();
      for (const m of matches) { if (!byLine.has(m.line)) byLine.set(m.line, []); byLine.get(m.line)!.push([m.start, m.end]); }
      results.push({ ...meta(f), matches: [...byLine].slice(0, 20).map(([line, ranges]) => ({ line, text: (parsed.lines[line] ?? "").slice(0, 400), ranges })), matchCount: matches.length });
    }
    const cmp: Record<string, (a: any, b: any) => number> = {
      "name-asc": (a, b) => displayName(a.path).localeCompare(displayName(b.path), undefined, { sensitivity: "base", numeric: true }) || a.path.localeCompare(b.path),
      "name-desc": (a, b) => -cmp["name-asc"](a, b),
      "mtime-desc": (a, b) => b.mtime.localeCompare(a.mtime), "mtime-asc": (a, b) => a.mtime.localeCompare(b.mtime),
      "ctime-desc": (a, b) => b.ctime.localeCompare(a.ctime), "ctime-asc": (a, b) => a.ctime.localeCompare(b.ctime),
    };
    results.sort(cmp[sort] ?? cmp["name-asc"]);
    return json({ results: results.slice(0, 500), total: results.length, explain: explain(node) });
  });

  r.on("GET", "/api/vaults/:v/files/:id/backlinks", async (_q, p) => {
    const v = await vaultFor(p); const f = await v.get(Number(p.id));
    const rows = (await db.prepare(`SELECT l.source_id, l.line, f.path, f.content, f.mtime, f.ctime FROM links l JOIN files f ON f.id=l.source_id WHERE l.vault_id=? AND l.target_id=? AND l.source_id<>? AND f.deleted_at IS NULL ORDER BY f.path_lc, l.line`).bind(v.id, f.id, f.id).all<any>()).results;
    const linked = new Map<number, any>();
    for (const r0 of rows) {
      if (!linked.has(r0.source_id)) linked.set(r0.source_id, { id: r0.source_id, path: r0.path, mtime: r0.mtime, ctime: r0.ctime, mentions: [], lines: (r0.content ?? "").split("\n") });
      const e = linked.get(r0.source_id); if (!e.mentions.some((m: any) => m.line === r0.line)) e.mentions.push({ line: r0.line, text: (e.lines[r0.line] ?? "").slice(0, 400) });
    }
    // Unlinked mentions: the note's name or an alias as a whole word, outside links, code and tags.
    const names = [displayName(f.path), ...(await db.prepare("SELECT alias FROM aliases WHERE file_id=?").bind(f.id).all<any>()).results.map(a => a.alias)].filter(n => n.trim().length >= 2);
    const unlinked: any[] = [];
    if (f.kind === "note" || f.kind === "attachment") {
      const cand = new Map<number, any>();
      for (const n of names) {
        const rs = n.length >= 3
          ? (await db.prepare(`SELECT f.id,f.path,f.content,f.mtime,f.ctime FROM notes_fts JOIN files f ON f.id=notes_fts.rowid WHERE notes_fts MATCH ? AND notes_fts.vault_id=? AND f.deleted_at IS NULL LIMIT 500`).bind(`body:"${n.replace(/"/g, '""')}"`, v.id).all<any>()).results
          : (await db.prepare(`SELECT id,path,content,mtime,ctime FROM files WHERE vault_id=? AND kind='note' AND deleted_at IS NULL AND content LIKE ? LIMIT 500`).bind(v.id, `%${n}%`).all<any>()).results;
        for (const x of rs) cand.set(x.id, x);
      }
      cand.delete(f.id);
      for (const c of cand.values()) {
        const ms = findMentions(c.content ?? "", names);
        if (ms.length) unlinked.push({ id: c.id, path: c.path, mtime: c.mtime, ctime: c.ctime, version: undefined, mentions: ms.slice(0, 20) });
      }
      unlinked.sort((a, b) => a.path.localeCompare(b.path));
    }
    return json({ linked: [...linked.values()].map(({ lines, ...x }) => x), unlinked: unlinked.slice(0, 200) });
  });

  r.on("GET", "/api/vaults/:v/tags", async (_q, p) => {
    const v = await vaultFor(p);
    const rows = (await db.prepare(`SELECT t.tag_lc, (SELECT t2.tag FROM tags t2 WHERE t2.vault_id=t.vault_id AND t2.tag_lc=t.tag_lc ORDER BY t2.rowid LIMIT 1) AS tag, COUNT(DISTINCT t.file_id) AS count FROM tags t JOIN files f ON f.id=t.file_id WHERE t.vault_id=? AND f.deleted_at IS NULL GROUP BY t.tag_lc`).bind(v.id).all<any>()).results;
    return json(rows.map(x => ({ tag: x.tag, count: x.count })));
  });
  r.on("GET", "/api/vaults/:v/graph", async (_q, p) => {
    const v = await vaultFor(p);
    const files = (await v.live()).filter(f => f.kind !== "folder");
    const links = (await db.prepare("SELECT source_id, target_id, linkpath, COUNT(*) n FROM links WHERE vault_id=? AND linkpath<>'' GROUP BY source_id, target_id, CASE WHEN target_id IS NULL THEN lower(linkpath) END").bind(v.id).all<any>()).results;
    const tags = (await db.prepare("SELECT DISTINCT file_id, tag_lc FROM tags WHERE vault_id=?").bind(v.id).all<any>()).results;
    return json({
      nodes: files.map(f => ({ id: f.id, path: f.path, kind: f.kind, ctime: f.ctime })),
      links: links.map(l => ({ source: l.source_id, target: l.target_id, unresolved: l.target_id == null ? l.linkpath : null, count: l.n })),
      tags: tags.map(t => ({ file: t.file_id, tag: t.tag_lc })),
    });
  });
  r.on("GET", "/api/vaults/:v/headings", async (q, p) => {
    const v = await vaultFor(p); const term = (new URL(q.url).searchParams.get("q") || "").toLowerCase();
    const rows = (await db.prepare(`SELECT h.text, h.level, h.line, f.id, f.path FROM headings h JOIN files f ON f.id=h.file_id WHERE h.vault_id=? AND f.deleted_at IS NULL AND lower(h.text) LIKE ? ORDER BY length(h.text) LIMIT 50`).bind(v.id, `%${term}%`).all<any>()).results;
    return json(rows);
  });
  r.on("GET", "/api/vaults/:v/properties", async (_q, p) => {
    const v = await vaultFor(p);
    const rows = (await db.prepare(`SELECT p.key_lc, MIN(p.key) AS key, COUNT(DISTINCT p.file_id) AS count, t.type FROM props p JOIN files f ON f.id=p.file_id LEFT JOIN prop_types t ON t.vault_id=p.vault_id AND t.key_lc=p.key_lc WHERE p.vault_id=? AND f.deleted_at IS NULL GROUP BY p.key_lc ORDER BY p.key_lc`).bind(v.id).all<any>()).results;
    // Types chosen for keys that no note uses right now (e.g. a property added with no value yet) are listed too.
    const seen = new Set(rows.map(x => x.key_lc));
    const extra = (await db.prepare("SELECT key_lc, type FROM prop_types WHERE vault_id=?").bind(v.id).all<any>()).results.filter(t => !seen.has(t.key_lc));
    return json([...rows.map(x => ({ key: x.key, count: x.count, type: x.type || "text" })), ...extra.map(t => ({ key: t.key_lc, count: 0, type: t.type }))]);
  });
  r.on("GET", "/api/vaults/:v/properties/:key/values", async (_q, p) => {
    const v = await vaultFor(p);
    const rows = (await db.prepare(`SELECT p.value FROM props p JOIN files f ON f.id=p.file_id WHERE p.vault_id=? AND p.key_lc=? AND f.deleted_at IS NULL LIMIT 1000`).bind(v.id, p.key.toLowerCase()).all<any>()).results;
    const vals = new Set<string>();
    for (const x of rows) { const val = JSON.parse(x.value); for (const s of Array.isArray(val) ? val : [val]) if (s != null && s !== "") vals.add(String(s)); }
    return json([...vals].sort().slice(0, 100));
  });
  r.on("PUT", "/api/vaults/:v/properties/:key/type", async (_q, p) => {
    const v = await vaultFor(p); const b = await body(req);
    const types = ["text", "list", "number", "checkbox", "date", "datetime"];
    const k = p.key.toLowerCase();
    if (k === "tags") throw new HttpError(400, "The tags property always has the Tags type");
    if (!types.includes(b.type)) throw new HttpError(400, "Choose a property type");
    await db.prepare("INSERT INTO prop_types (vault_id,key_lc,type) VALUES (?,?,?) ON CONFLICT(vault_id,key_lc) DO UPDATE SET type=excluded.type").bind(v.id, k, b.type).run();
    return json({ key: p.key, type: b.type });
  });

  // ---------- Bookmarks ----------
  const bmRow = (b: any) => ({ id: b.id, parentId: b.parent_id, position: b.position, type: b.type, title: b.title, path: b.path, subpath: b.subpath, query: b.query });
  r.on("GET", "/api/vaults/:v/bookmarks", async (_q, p) => { const v = await vaultFor(p); return json((await db.prepare("SELECT * FROM bookmarks WHERE vault_id=? ORDER BY position").bind(v.id).all()).results.map(bmRow)); });
  r.on("POST", "/api/vaults/:v/bookmarks", async (_q, p) => {
    const v = await vaultFor(p); const b = await body(req);
    if (!["group", "file", "folder", "search", "heading", "block", "graph"].includes(b.type)) throw new HttpError(400, "Unknown bookmark type");
    if (b.type === "group" && !(typeof b.title === "string" && b.title.trim())) throw new HttpError(400, "Name the group");
    if (["file", "folder", "heading", "block"].includes(b.type) && typeof b.path !== "string") throw new HttpError(400, "Choose what to bookmark");
    if (b.type === "search" && !(typeof b.query === "string" && b.query.trim())) throw new HttpError(400, "Enter a search first");
    const parent = b.parentId ? await db.prepare("SELECT id FROM bookmarks WHERE id=? AND vault_id=? AND type='group'").bind(b.parentId, v.id).first<any>() : null;
    const pos = ((await db.prepare("SELECT MAX(position) m FROM bookmarks WHERE vault_id=?").bind(v.id).first<any>())?.m ?? 0) + 1;
    const res = await db.prepare("INSERT INTO bookmarks (vault_id,parent_id,position,type,title,path,subpath,query) VALUES (?,?,?,?,?,?,?,?) RETURNING *")
      .bind(v.id, parent?.id ?? null, pos, b.type, typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 200) : null, b.path ?? null, b.subpath ?? null, b.query ?? null).first();
    return json(bmRow(res), 201);
  });
  r.on("PATCH", "/api/vaults/:v/bookmarks/:id", async (_q, p) => {
    const v = await vaultFor(p); const b = await body(req);
    const cur = await db.prepare("SELECT * FROM bookmarks WHERE id=? AND vault_id=?").bind(Number(p.id), v.id).first<any>();
    if (!cur) throw new HttpError(404, "Bookmark not found");
    const title = b.title === undefined ? cur.title : (typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 200) : null);
    let parent = cur.parent_id;
    if (b.parentId !== undefined) {
      parent = b.parentId ? (await db.prepare("SELECT id FROM bookmarks WHERE id=? AND vault_id=? AND type='group'").bind(b.parentId, v.id).first<any>())?.id ?? null : null;
      if (cur.type === "group") parent = null;
    }
    const pos = typeof b.position === "number" ? b.position : cur.position;
    await db.prepare("UPDATE bookmarks SET title=?, parent_id=?, position=? WHERE id=?").bind(title, parent, pos, cur.id).run();
    return json(bmRow(await db.prepare("SELECT * FROM bookmarks WHERE id=?").bind(cur.id).first()));
  });
  r.on("DELETE", "/api/vaults/:v/bookmarks/:id", async (_q, p) => {
    const v = await vaultFor(p);
    await db.batch([db.prepare("DELETE FROM bookmarks WHERE parent_id=? AND vault_id=?").bind(Number(p.id), v.id), db.prepare("DELETE FROM bookmarks WHERE id=? AND vault_id=?").bind(Number(p.id), v.id)]);
    return json({ ok: true });
  });

  r.on("GET", "/api/:rest*", async () => { throw new HttpError(404, "Not found"); });
  return r;
}

/** Whole-word, case-insensitive mentions of any of `names` outside links, embeds, tags, code and frontmatter. */
export function findMentions(content: string, names: string[]) {
  const p = parseNote(content);
  const out: { line: number; text: string; start: number; end: number; name: string }[] = [];
  const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);
  const sorted = [...names].sort((a, b) => b.length - a.length);
  p.lines.forEach((line, i) => {
    if (p.masked[i]) return;
    const base = p.lineStarts[i];
    const blocked: [number, number][] = [...p.links.filter(l => l.line === i && l.start >= 0).map(l => [l.start - base, l.end - base] as [number, number]), ...p.tags.filter(t => t.line === i && t.start >= 0).map(t => [t.start - base, t.end - base] as [number, number])];
    const code = /`[^`]*`/g; let m: RegExpExecArray | null; while ((m = code.exec(line))) blocked.push([m.index, m.index + m[0].length]);
    const low = line.toLowerCase();
    for (const n of sorted) {
      const nl = n.toLowerCase(); let k = low.indexOf(nl);
      while (k >= 0) {
        const e = k + nl.length;
        if (!isWord(line[k - 1]) && !isWord(line[e]) && !blocked.some(([a, b]) => k < b && e > a)) { out.push({ line: i, text: line.slice(0, 400), start: k, end: e, name: n }); blocked.push([k, e]); }
        k = low.indexOf(nl, k + 1);
      }
    }
  });
  return out;
}
void lc;
