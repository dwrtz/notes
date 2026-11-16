import { useEffect, useState } from "react";
import { api } from "./api";
import type { VaultStore } from "./store";
export function inferTypeClient(key: string, v: unknown): string {
  const k = key.toLowerCase();
  if (k === "tags") return "tags";
  if (k === "aliases" || k === "cssclasses" || Array.isArray(v)) return "list";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "checkbox";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return "date";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return "datetime";
  return "text";
}
const cache = new Map<number, Record<string, string>>();
export function usePropTypes(store: VaultStore) {
  const [t, setT] = useState<Record<string, string>>(cache.get(store.vault.id) || {});
  useEffect(() => {
    const load = () => api<{ key: string; type: string }[]>(`${store.base()}/properties`).then(rows => { const m = Object.fromEntries(rows.map(r => [r.key.toLowerCase(), r.type])); cache.set(store.vault.id, m); setT(m); }).catch(() => {});
    load(); window.addEventListener("prop-types-changed", load); return () => window.removeEventListener("prop-types-changed", load);
  }, [store.vault.id]);
  return t;
}
