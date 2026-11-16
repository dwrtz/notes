import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { api } from "./api";
import { settings } from "../shared/settings";
import { AuthPage } from "./Auth";
import { VaultApp } from "./Shell";
import type { Vault } from "./store";

document.documentElement.style.setProperty("--accent", settings.accentColor);

function Root() {
  const [state, setState] = useState<{ phase: "loading" } | { phase: "out"; page: "login" | "signup" } | { phase: "in"; me: { name: string; email: string }; vaults: Vault[]; vaultId: number; now: { server: number; local: number } }>({ phase: "loading" });
  const load = async () => {
    try {
      const me = await api("/api/me");
      const [vaults, now] = await Promise.all([api<Vault[]>("/api/vaults"), api<{ now: string }>("/api/now")]);
      const want = Number(new URLSearchParams(location.search).get("vault") || localStorage.getItem("lastVault"));
      const v = vaults.find(x => x.id === want) ?? vaults[0];
      setState({ phase: "in", me, vaults, vaultId: v.id, now: { server: Date.parse(now.now), local: Date.now() } });
      history.replaceState(null, "", "/app?vault=" + v.id); localStorage.setItem("lastVault", String(v.id));
    } catch {
      const page = location.pathname === "/signup" ? "signup" : "login";
      if (location.pathname !== "/" + page) history.replaceState(null, "", "/" + page);
      setState({ phase: "out", page });
    }
  };
  useEffect(() => { load(); const out = () => setState({ phase: "out", page: "login" }); window.addEventListener("signed-out", out); return () => window.removeEventListener("signed-out", out); }, []);
  useEffect(() => { document.title = settings.appName; }, [state.phase]);
  if (state.phase === "loading") return <div className="splash" role="status">Loading…</div>;
  if (state.phase === "out") return <AuthPage page={state.page} go={p => { history.pushState(null, "", "/" + p); setState({ phase: "out", page: p }); }} done={load} />;
  const signOut = async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => {}); history.replaceState(null, "", "/login"); setState({ phase: "out", page: "login" }); };
  const v = state.vaults.find(x => x.id === state.vaultId)!;
  // The server's clock is the app's clock (tests freeze it); keep the offset from the browser's.
  const now = () => new Date(Date.now() - state.now.local + state.now.server).toISOString();
  return <VaultApp key={v.id} vault={v} vaults={state.vaults} me={state.me} now={now} signOut={signOut}
    switchVault={async id => { localStorage.setItem("lastVault", String(id)); history.replaceState(null, "", "/app"); await load(); }}
    reloadVaults={load} />;
}
createRoot(document.getElementById("root")!).render(<Root />);
