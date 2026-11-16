import React, { useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { settings } from "../shared/settings";

/** Public sign-up rules from GET /api/config (R24). */
export type SiteConfig = { access: "only_me" | "invite_only" | "open"; signup: "open" | "invite" | "closed"; firstAccount: boolean };

export function AuthPage({ page, go, done }: { page: "login" | "signup"; go: (p: "login" | "signup") => void; done: () => void }) {
  const [f, setF] = useState({ name: "", email: "", password: "" });
  const [err, setErr] = useState<string | null>(null); const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState<SiteConfig | null>(null);
  const token = page === "signup" ? new URLSearchParams(location.search).get("invite") : null;
  const [invite, setInvite] = useState<{ email: string } | "bad" | null>(null);
  useEffect(() => { api<SiteConfig>("/api/config").then(setCfg).catch(() => setCfg({ access: "open", signup: "open", firstAccount: false })); }, []);
  useEffect(() => {
    if (!token) { setInvite(null); return; }
    api<{ email: string }>(`/api/invites/check?token=${encodeURIComponent(token)}`)
      .then(i => { setInvite(i); setF(x => ({ ...x, email: i.email })); }).catch(() => setInvite("bad"));
  }, [token]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null); setFields({});
    try { await api(page === "login" ? "/api/auth/login" : "/api/auth/signup", { body: page === "login" ? { email: f.email, password: f.password } : { ...f, ...(token ? { invite: token } : {}) } }); done(); }
    catch (x) { if (x instanceof ApiError) { setErr(x.message); setFields(x.data?.fields || {}); } else setErr("Something went wrong"); }
    finally { setBusy(false); }
  };
  const field = (k: "name" | "email" | "password", label: string, type = "text", auto?: string, readOnly = false) => (
    <label className="field"><span>{label}</span>
      <input type={type} value={f[k]} autoComplete={auto} readOnly={readOnly} onChange={e => setF({ ...f, [k]: e.target.value })} aria-invalid={!!fields[k]} required />
      {fields[k] && <small className="field-error">{fields[k]}</small>}
    </label>
  );
  const brand = <div className="auth-brand"><span className="brand-mark" aria-hidden="true" />{settings.appName}</div>;
  const toLogin = <p className="auth-switch">Have an account? <a href="/login" onClick={e => { e.preventDefault(); go("login"); }}>Sign in</a></p>;
  if (page === "signup" && cfg) {
    // Sign-up is not possible here: say why instead of showing a form that cannot work.
    let stop: string | null = null;
    if (cfg.signup === "closed") stop = "Sign-up is closed on this site.";
    else if (cfg.signup === "invite" && invite === "bad") stop = "This invite link is not valid or has expired. Ask the owner for a new one.";
    else if (cfg.signup === "invite" && !token) stop = "You need an invite to create an account here. Ask the owner to invite you.";
    if (stop) return <main className="auth"><div className="auth-card form">{brand}<h1>Create your account</h1><p className="auth-note" role="status">{stop}</p>{toLogin}</div></main>;
  }
  const inviteLocked = page === "signup" && cfg?.signup === "invite" && !!invite && invite !== "bad";
  return (
    <main className="auth">
      <form className="auth-card form" onSubmit={submit}>
        {brand}
        <h1>{page === "login" ? "Sign in" : "Create your account"}</h1>
        {page === "signup" && cfg?.firstAccount && cfg.signup === "open" && cfg.access !== "open" && <p className="auth-note">This is the first account. It becomes the owner of this site.</p>}
        {inviteLocked && <p className="auth-note">You were invited as {(invite as { email: string }).email}.</p>}
        {page === "signup" && field("name", "Name", "text", "name")}
        {field("email", "Email", "email", "email", inviteLocked)}
        {field("password", "Password", "password", page === "login" ? "current-password" : "new-password")}
        {err && !Object.keys(fields).length && <div className="field-error" role="alert">{err}</div>}
        <button className="btn primary wide" disabled={busy}>{page === "login" ? "Sign in" : "Create account"}</button>
        {page === "login"
          ? cfg && cfg.signup === "open" && <p className="auth-switch">New here? <a href="/signup" onClick={e => { e.preventDefault(); go("signup"); }}>Create an account</a></p>
          : toLogin}
      </form>
    </main>
  );
}
