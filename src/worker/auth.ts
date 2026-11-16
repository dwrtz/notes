import { HttpError } from "./http";
const enc = new TextEncoder();
export const randomHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, "0")).join("");
const hex = (u: Uint8Array) => Array.from(u, b => b.toString(16).padStart(2, "0")).join("");
export async function sha256(s: string) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))); }
async function derive(pw: string, salt: string, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations }, key, 256));
}
export async function hashPassword(pw: string) {
  const salt = randomHex(16), n = 100_000;
  return `pbkdf2-sha256$${n}$${salt}$${hex(await derive(pw, salt, n))}`;
}
export async function checkPassword(pw: string, stored: string) {
  const [alg, n, salt, h] = stored.split("$");
  if (alg !== "pbkdf2-sha256" || Number(n) !== 100_000 || !/^[a-f0-9]{64}$/.test(h)) return false;
  const got = await derive(pw, salt, 100_000);
  const want = Uint8Array.from(h.match(/../g)!, x => parseInt(x, 16));
  return crypto.subtle.timingSafeEqual(got, want);
}
export function readCookie(req: Request, name: string) {
  for (const part of (req.headers.get("cookie") || "").split(";")) { const [k, ...v] = part.trim().split("="); if (k === name) return v.join("="); }
  return undefined;
}
export function sessionCookie(req: Request, token: string, maxAgeSec: number) {
  // Secure everywhere except plain-http local development on localhost / 127.0.0.1.
  const host = new URL(req.url).hostname;
  const secure = host === "localhost" || host === "127.0.0.1" ? "" : "; Secure";
  return `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}
export function emailOk(s: unknown): s is string { return typeof s === "string" && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
export function need(cond: unknown, msg: string, status = 400): asserts cond { if (!cond) throw new HttpError(status, msg); }
