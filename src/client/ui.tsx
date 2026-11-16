// Shared UI: icons (drawn here), toasts, modals, prompts, menus.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

const P: Record<string, string> = {
  file: "M6 3h8l4 4v14H6z M14 3v4h4",
  folder: "M3 6h6l2 2h10v11H3z",
  search: "M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13z M15.5 15.5L21 21",
  bookmark: "M6 3h12v18l-6-5-6 5z",
  tag: "M3 12V3h9l9 9-9 9z M7.5 7.5h.01",
  graph: "M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M18 8m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M10 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M7.5 7.2L16 8 M7 7.8L9.4 16 M16.6 9.6L11.4 16.6",
  calendar: "M4 5h16v15H4z M4 9h16 M8 3v4 M16 3v4",
  template: "M4 4h16v5H4z M4 13h7v7H4z M15 13h5 M15 17h5",
  plus: "M12 5v14 M5 12h14",
  x: "M6 6l12 12 M18 6L6 18",
  chevronRight: "M9 6l6 6-6 6", chevronDown: "M6 9l6 6 6-6",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  edit: "M4 20h4L19 9l-4-4L4 16z",
  book: "M4 5c3-1 6-1 8 1c2-2 5-2 8-1v14c-3-1-6-1-8 1c-2-2-5-2-8-1z M12 6v14",
  code: "M9 7l-5 5 5 5 M15 7l5 5-5 5",
  link: "M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1 M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1",
  back: "M15 6l-6 6 6 6", forward: "M9 6l6 6-6 6",
  gear: "M12 9a3 3 0 1 1 0 6a3 3 0 0 1 0-6z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1",
  sun: "M12 8a4 4 0 1 1 0 8a4 4 0 0 1 0-8z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M5 19l1.5-1.5 M17.5 6.5L19 5",
  moon: "M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z",
  sidebarLeft: "M3 4h18v16H3z M9 4v16", sidebarRight: "M3 4h18v16H3z M15 4v16",
  list: "M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01",
  sort: "M7 4v16 M3 8l4-4 4 4 M14 8h7 M14 12h5 M14 16h3",
  collapse: "M7 14l5-5 5 5", expand: "M7 10l5 5 5-5",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13",
  check: "M5 12l5 5 9-10",
  menu: "M4 7h16 M4 12h16 M4 17h16",
  command: "M8 4a2 2 0 1 0 0 4h8a2 2 0 1 0 0-4 M8 4v16 M16 4v16 M8 20a2 2 0 1 1 0-4h8a2 2 0 1 1 0 4",
  newFolder: "M3 6h6l2 2h10v11H3z M12 11v5 M9.5 13.5h5",
  newNote: "M6 3h8l4 4v14H6z M12 11v6 M9 14h6",
  arrowIn: "M14 5h5v14h-5 M4 12h11 M11 8l4 4-4 4",
  arrowOut: "M10 5H5v14h5 M9 12h11 M16 8l4 4-4 4",
  image: "M4 5h16v14H4z M4 16l5-5 4 4 2-2 5 5 M15 9h.01",
  split: "M3 4h18v16H3z M12 4v16",
  pin: "M9 4h6l-1 6 3 3H7l3-3z M12 13v7",
  lock: "M6 11h12v9H6z M8 11V7a4 4 0 0 1 8 0v4",
  alias: "M8 8l-4 4 4 4 M4 12h11a5 5 0 0 0 5-5",
  property: "M5 6h14 M5 12h14 M5 18h9",
  play: "M7 5l12 7-12 7z",
  dice: "M5 5h14v14H5z M9 9h.01 M15 15h.01 M15 9h.01 M9 15h.01",
};
export function Icon({ name, size = 16, title }: { name: string; size?: number; title?: string }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}<path d={P[name] || P.file} />
    </svg>
  );
}
export function IconButton({ icon, label, onClick, active, className = "", ...rest }: { icon: string; label: string; onClick?: (e: React.MouseEvent) => void; active?: boolean; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`icon-btn ${active ? "is-active" : ""} ${className}`} aria-label={label} title={label} aria-pressed={active === undefined ? undefined : active} onClick={onClick} {...rest}><Icon name={icon} /></button>;
}

// ---------- Toasts ----------
let toastHost: HTMLElement | null = null;
export function toast(message: string, ms = 4000) {
  if (!toastHost) { toastHost = document.createElement("div"); toastHost.className = "toasts"; toastHost.setAttribute("role", "status"); toastHost.setAttribute("aria-live", "polite"); document.body.appendChild(toastHost); }
  const el = document.createElement("div"); el.className = "toast"; el.textContent = message;
  toastHost.appendChild(el); setTimeout(() => el.remove(), ms);
}

// ---------- Modal ----------
export function Modal({ title, onClose, children, wide, className = "" }: { title?: string; onClose: () => void; children: React.ReactNode; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input,textarea,select,button:not(.modal-close)");
    first?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("keydown", key, true); prev?.focus?.(); };
  }, []);
  return (
    <div className="modal-bg" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`modal ${wide ? "is-wide" : ""} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        {title && <div className="modal-title">{title}</div>}
        <button className="modal-close icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        {children}
      </div>
    </div>
  );
}

/** Mount a modal imperatively and resolve with its result. */
export function openModal<T>(render: (done: (v: T) => void) => React.ReactNode): Promise<T> {
  return new Promise(resolve => {
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: T) => { root.unmount(); host.remove(); resolve(v); };
    root.render(<>{render(done)}</>);
  });
}
export function prompt(title: string, opts: { value?: string; label?: string; placeholder?: string; ok?: string; validate?: (v: string) => string | null; selectStem?: boolean } = {}): Promise<string | null> {
  return openModal<string | null>(done => <PromptDialog title={title} {...opts} done={done} />);
}
function PromptDialog({ title, value = "", label, placeholder, ok = "Save", validate, done, selectStem }: { title: string; value?: string; label?: string; placeholder?: string; ok?: string; validate?: (v: string) => string | null; done: (v: string | null) => void; selectStem?: boolean }) {
  const [v, setV] = useState(value); const [err, setErr] = useState<string | null>(null);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => { const el = inp.current; if (el) { el.focus(); if (selectStem) { const i = value.lastIndexOf("."); el.setSelectionRange(0, i > 0 ? i : value.length); } else el.select(); } }, []);
  const submit = (e: React.FormEvent) => { e.preventDefault(); const m = validate?.(v) ?? null; if (m) { setErr(m); return; } done(v); };
  return (
    <Modal title={title} onClose={() => done(null)}>
      <form onSubmit={submit} className="form">
        <label className="field"><span>{label || "Name"}</span><input ref={inp} value={v} placeholder={placeholder} onChange={e => { setV(e.target.value); setErr(null); }} aria-invalid={!!err} /></label>
        {err && <div className="field-error" role="alert">{err}</div>}
        <div className="modal-actions"><button type="button" className="btn" onClick={() => done(null)}>Cancel</button><button className="btn primary" type="submit">{ok}</button></div>
      </form>
    </Modal>
  );
}
export function confirm(title: string, text: string, ok = "Delete", danger = true): Promise<boolean> {
  return openModal<boolean>(done => (
    <Modal title={title} onClose={() => done(false)}>
      <p className="modal-text">{text}</p>
      <div className="modal-actions"><button className="btn" onClick={() => done(false)}>Cancel</button><button className={`btn ${danger ? "danger" : "primary"}`} onClick={() => done(true)}>{ok}</button></div>
    </Modal>
  ));
}

// ---------- Context menu ----------
export interface MenuItem { label: string; icon?: string; onClick?: () => void; danger?: boolean; separator?: boolean; disabled?: boolean }
let menuClose: (() => void) | null = null;
export function showMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  menuClose?.();
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => { root.unmount(); host.remove(); menuClose = null; };
  menuClose = close;
  root.render(<Menu x={e.clientX} y={e.clientY} items={items} close={close} />);
}
function Menu({ x, y, items, close }: { x: number; y: number; items: MenuItem[]; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current!; const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
    el.querySelector<HTMLElement>("button")?.focus();
    const down = (ev: MouseEvent) => { if (!el.contains(ev.target as Node)) close(); };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") { ev.stopPropagation(); close(); }
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        const bs = [...el.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]; const i = bs.indexOf(document.activeElement as HTMLButtonElement);
        bs[(i + (ev.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length]?.focus();
      }
    };
    setTimeout(() => window.addEventListener("mousedown", down), 0); window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", down); window.removeEventListener("keydown", key, true); };
  }, []);
  return (
    <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) => it.separator ? <div key={i} className="menu-sep" /> :
        <button key={i} role="menuitem" disabled={it.disabled} className={`menu-item ${it.danger ? "is-danger" : ""}`} onClick={() => { close(); it.onClick?.(); }}>
          {it.icon && <Icon name={it.icon} />}<span>{it.label}</span>
        </button>)}
    </div>
  );
}
export function relTime(iso: string) { const d = new Date(iso); return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
