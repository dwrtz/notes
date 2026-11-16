import React, { useEffect, useMemo, useRef, useState } from "react";
import { forceSimulation, forceManyBody, forceLink, forceX, forceY, forceCollide, Simulation, SimulationNodeDatum, SimulationLinkDatum } from "d3-force";
import { useApp } from "./app";
import { useEmitter } from "./store";
import { api } from "./api";
import { Icon, IconButton, showMenu } from "./ui";
import { displayName, basename } from "../shared/paths";

interface GNode extends SimulationNodeDatum { id: string; label: string; kind: "note" | "attachment" | "unresolved" | "tag"; fileId?: number; ctime?: string; deg: number; inDeg: number; color?: string }
interface GLink extends SimulationLinkDatum<GNode> { source: string | GNode; target: string | GNode }
interface GraphSettings {
  query: string; tags: boolean; attachments: boolean; existingOnly: boolean; orphans: boolean;
  groups: { query: string; color: string }[];
  arrows: boolean; textFade: number; nodeSize: number; linkWidth: number;
  center: number; repel: number; linkForce: number; linkDistance: number;
  depth: number; incoming: boolean; outgoing: boolean;
}
const DEFAULTS: GraphSettings = { query: "", tags: false, attachments: false, existingOnly: false, orphans: true, groups: [], arrows: false, textFade: 0, nodeSize: 1, linkWidth: 1, center: 0.5, repel: 10, linkForce: 1, linkDistance: 250, depth: 1, incoming: true, outgoing: true };
const PALETTE = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#8e4ec6", "#d6409f"];

export function GraphView({ local }: { local?: number }) {
  const app = useApp(); const { store } = app; useEmitter(store);
  const key = `graph:${store.vault.id}:${local != null ? "local" : "global"}`;
  const [s, setS] = useState<GraphSettings>(() => ({ ...DEFAULTS, ...(local != null ? { linkDistance: 120 } : {}), ...JSON.parse(localStorage.getItem(key) || "{}") }));
  const set = (p: Partial<GraphSettings>) => { const n = { ...s, ...p }; setS(n); localStorage.setItem(key, JSON.stringify(n)); };
  const [raw, setRaw] = useState<any>(null);
  const [filterIds, setFilterIds] = useState<Set<number> | null>(null);
  const [groupIds, setGroupIds] = useState<Set<number>[]>([]);
  const [panel, setPanel] = useState(false);
  const [animate, setAnimate] = useState(0);
  useEffect(() => { api(`${store.base()}/graph`).then(setRaw).catch(() => {}); }, [store.seq]);
  useEffect(() => {
    if (!s.query.trim()) { setFilterIds(null); return; }
    const t = setTimeout(() => api(`${store.base()}/search?q=${encodeURIComponent(s.query)}`).then(r => setFilterIds(new Set(r.results.map((x: any) => x.id)))).catch(() => setFilterIds(new Set())), 300);
    return () => clearTimeout(t);
  }, [s.query, store.seq]);
  useEffect(() => {
    let live = true;
    Promise.all(s.groups.map(g => g.query.trim() ? api(`${store.base()}/search?q=${encodeURIComponent(g.query)}`).then(r => new Set<number>(r.results.map((x: any) => x.id))).catch(() => new Set<number>()) : Promise.resolve(new Set<number>()))).then(x => live && setGroupIds(x));
    return () => { live = false; };
  }, [JSON.stringify(s.groups), store.seq]);

  const graph = useMemo(() => {
    if (!raw) return null;
    const nodes = new Map<string, GNode>(); const links: GLink[] = [];
    for (const n of raw.nodes) {
      if (n.kind === "attachment" && !s.attachments) continue;
      if (filterIds && !filterIds.has(n.id)) continue;
      nodes.set("f" + n.id, { id: "f" + n.id, label: n.kind === "note" ? displayName(n.path) : basename(n.path), kind: n.kind, fileId: n.id, ctime: n.ctime, deg: 0, inDeg: 0 });
    }
    for (const l of raw.links) {
      const src = "f" + l.source; if (!nodes.has(src)) continue;
      let tgt: string;
      if (l.target != null) { tgt = "f" + l.target; if (!nodes.has(tgt)) continue; }
      else { if (s.existingOnly) continue; tgt = "u" + l.unresolved.toLowerCase(); if (!nodes.has(tgt)) nodes.set(tgt, { id: tgt, label: l.unresolved, kind: "unresolved", deg: 0, inDeg: 0 }); }
      if (src === tgt) continue;
      links.push({ source: src, target: tgt });
    }
    if (s.tags) for (const t of raw.tags) { const src = "f" + t.file; if (!nodes.has(src)) continue; const id = "t" + t.tag; if (!nodes.has(id)) nodes.set(id, { id, label: "#" + t.tag, kind: "tag", deg: 0, inDeg: 0 }); links.push({ source: src, target: id }); }
    let keep: Set<string> | null = null;
    if (local != null) {
      keep = new Set(["f" + local]); let frontier = ["f" + local];
      for (let d = 0; d < s.depth; d++) {
        const next: string[] = [];
        for (const l of links) {
          const a = l.source as string, b = l.target as string;
          if (s.outgoing && frontier.includes(a) && !keep.has(b)) { keep.add(b); next.push(b); }
          if (s.incoming && frontier.includes(b) && !keep.has(a)) { keep.add(a); next.push(a); }
        }
        frontier = next;
      }
    }
    let ls = keep ? links.filter(l => keep!.has(l.source as string) && keep!.has(l.target as string)) : links;
    for (const l of ls) { nodes.get(l.source as string)!.deg++; const t = nodes.get(l.target as string)!; t.deg++; t.inDeg++; }
    let ns = [...nodes.values()].filter(n => !keep || keep.has(n.id));
    if (!s.orphans) ns = ns.filter(n => n.deg > 0 || (local != null && n.fileId === local));
    const ids = new Set(ns.map(n => n.id)); ls = ls.filter(l => ids.has(l.source as string) && ids.has(l.target as string));
    for (const n of ns) { const gi = n.fileId != null ? groupIds.findIndex(g => g.has(n.fileId!)) : -1; n.color = gi >= 0 ? s.groups[gi].color : undefined; }
    return { nodes: ns, links: ls };
  }, [raw, s.tags, s.attachments, s.existingOnly, s.orphans, filterIds, groupIds, local, s.depth, s.incoming, s.outgoing]);

  return (
    <div className={`graph-view ${local != null ? "is-local" : ""}`}>
      {graph && <GraphCanvas graph={graph} s={s} local={local} animate={animate} onOpen={(n, how) => {
        if (n.kind === "tag") app.ws.search(`tag:${n.label}`);
        else if (n.kind === "unresolved") app.openLink(n.label, app.activeFile()?.path || "", how !== "same");
        else if (n.fileId != null) app.openFile(n.fileId, how);
      }} />}
      <div className="graph-controls">
        <IconButton icon="gear" label="Graph settings" active={panel} onClick={() => setPanel(!panel)} />
        {local == null && <IconButton icon="play" label="Animate" onClick={() => setAnimate(a => a + 1)} />}
      </div>
      {panel && <div className="graph-panel" role="region" aria-label="Graph settings">
        <div className="graph-panel-head"><strong>Filters</strong><button className="link-btn" onClick={() => { localStorage.removeItem(key); setS({ ...DEFAULTS, ...(local != null ? { linkDistance: 120 } : {}) }); }}>Restore defaults</button></div>
        <input className="pane-filter" placeholder="Search files…" aria-label="Search files" value={s.query} onChange={e => set({ query: e.target.value })} />
        {local != null && <label className="slider">Depth <input type="range" min={1} max={3} value={s.depth} onChange={e => set({ depth: +e.target.value })} aria-label="Depth" /> {s.depth}</label>}
        {local != null && <><Toggle label="Incoming links" v={s.incoming} on={v => set({ incoming: v })} /><Toggle label="Outgoing links" v={s.outgoing} on={v => set({ outgoing: v })} /></>}
        <Toggle label="Tags" v={s.tags} on={v => set({ tags: v })} />
        <Toggle label="Attachments" v={s.attachments} on={v => set({ attachments: v })} />
        <Toggle label="Existing files only" v={s.existingOnly} on={v => set({ existingOnly: v })} />
        <Toggle label="Orphans" v={s.orphans} on={v => set({ orphans: v })} />
        <div className="graph-panel-head"><strong>Groups</strong></div>
        {s.groups.map((g, i) => <div key={i} className="group-row">
          <input type="color" aria-label="Group colour" value={g.color} onChange={e => set({ groups: s.groups.map((x, j) => j === i ? { ...x, color: e.target.value } : x) })} />
          <input className="pane-filter" aria-label="Group search" placeholder="Search…" value={g.query} onChange={e => set({ groups: s.groups.map((x, j) => j === i ? { ...x, query: e.target.value } : x) })} />
          <IconButton icon="x" label="Remove group" onClick={() => set({ groups: s.groups.filter((_, j) => j !== i) })} />
        </div>)}
        <button className="btn small" onClick={() => set({ groups: [...s.groups, { query: "", color: PALETTE[s.groups.length % PALETTE.length] }] })}>New group</button>
        <div className="graph-panel-head"><strong>Display</strong></div>
        <Toggle label="Arrows" v={s.arrows} on={v => set({ arrows: v })} />
        <Slider label="Text fade threshold" min={-3} max={3} step={0.1} v={s.textFade} on={v => set({ textFade: v })} />
        <Slider label="Node size" min={0.2} max={3} step={0.1} v={s.nodeSize} on={v => set({ nodeSize: v })} />
        <Slider label="Link thickness" min={0.2} max={4} step={0.1} v={s.linkWidth} on={v => set({ linkWidth: v })} />
        <div className="graph-panel-head"><strong>Forces</strong></div>
        <Slider label="Center force" min={0} max={1} step={0.01} v={s.center} on={v => set({ center: v })} />
        <Slider label="Repel force" min={0} max={20} step={0.5} v={s.repel} on={v => set({ repel: v })} />
        <Slider label="Link force" min={0} max={1} step={0.01} v={s.linkForce} on={v => set({ linkForce: v })} />
        <Slider label="Link distance" min={30} max={500} step={10} v={s.linkDistance} on={v => set({ linkDistance: v })} />
      </div>}
      {graph && <ul className="sr-only" aria-label="Notes in the graph">{graph.nodes.map(n => <li key={n.id}><button data-node={n.id} onClick={() => n.fileId != null ? app.openFile(n.fileId) : n.kind === "tag" ? app.ws.search(`tag:${n.label}`) : app.openLink(n.label, "", false)}>{n.label}</button></li>)}</ul>}
    </div>
  );
}
function Toggle({ label, v, on }: { label: string; v: boolean; on: (v: boolean) => void }) { return <label className="toggle"><span>{label}</span><input type="checkbox" role="switch" checked={v} onChange={e => on(e.target.checked)} /></label>; }
function Slider({ label, min, max, step, v, on }: { label: string; min: number; max: number; step: number; v: number; on: (v: number) => void }) { return <label className="slider"><span>{label}</span><input type="range" min={min} max={max} step={step} value={v} onChange={e => on(+e.target.value)} aria-label={label} /></label>; }

function GraphCanvas({ graph, s, local, animate, onOpen }: { graph: { nodes: GNode[]; links: GLink[] }; s: GraphSettings; local?: number; animate: number; onOpen: (n: GNode, how: "same" | "tab" | "split") => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const st = useRef({ k: 1, x: 0, y: 0, hover: null as GNode | null, drag: null as GNode | null, visible: Infinity, sim: null as Simulation<GNode, GLink> | null, positions: new Map<string, { x: number; y: number }>() });
  const draw = useRef<() => void>(() => {});
  useEffect(() => {
    const c = ref.current!; const S = st.current;
    const nodes = graph.nodes.map(n => ({ ...n, ...(S.positions.get(n.id) || {}) }));
    const links = graph.links.map(l => ({ ...l }));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const radius = (n: GNode) => (n.kind === "tag" ? 3.5 : 4) * s.nodeSize * (1 + Math.sqrt(n.inDeg) * 0.45);
    const sim = forceSimulation<GNode>(nodes)
      .force("charge", forceManyBody<GNode>().strength(-s.repel * 12))
      .force("link", forceLink<GNode, GLink>(links).id(d => d.id).distance(s.linkDistance * 0.4).strength(s.linkForce * 0.6))
      .force("x", forceX<GNode>(0).strength(s.center * 0.08)).force("y", forceY<GNode>(0).strength(s.center * 0.08))
      .force("collide", forceCollide<GNode>(n => radius(n) + 2));
    S.sim = sim;
    const css = () => { const cs = getComputedStyle(c); return { node: cs.getPropertyValue("--graph-node").trim() || "#888", line: cs.getPropertyValue("--graph-line").trim() || "#ccc", text: cs.getPropertyValue("--text").trim() || "#222", accent: cs.getPropertyValue("--accent").trim() || "#7c5cff", unres: cs.getPropertyValue("--text-faint").trim() || "#aaa", tag: cs.getPropertyValue("--graph-tag").trim() || "#46a758", attach: cs.getPropertyValue("--graph-attach").trim() || "#f0b429" }; };
    let colors = css();
    const neighbors = (n: GNode | null) => { if (!n) return null; const set = new Set([n.id]); for (const l of links) { const a = (l.source as GNode).id, b = (l.target as GNode).id; if (a === n.id) set.add(b); if (b === n.id) set.add(a); } return set; };
    const paint = () => {
      const dpr = window.devicePixelRatio || 1; const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
      const ctx = c.getContext("2d")!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      ctx.translate(w / 2 + S.x, h / 2 + S.y); ctx.scale(S.k, S.k);
      const hi = neighbors(S.hover);
      const shown = (n: GNode) => !n.ctime || S.visible === Infinity || Date.parse(n.ctime) <= S.visible;
      ctx.lineWidth = s.linkWidth / S.k * Math.max(S.k, 0.6);
      for (const l of links) {
        const a = l.source as GNode, b = l.target as GNode; if (!shown(a) || !shown(b)) continue;
        const lit = hi && hi.has(a.id) && hi.has(b.id) && (a === S.hover || b === S.hover);
        ctx.strokeStyle = lit ? colors.accent : colors.line; ctx.globalAlpha = hi && !lit ? 0.2 : 1;
        ctx.beginPath(); ctx.moveTo(a.x!, a.y!); ctx.lineTo(b.x!, b.y!); ctx.stroke();
        if (s.arrows) { const ang = Math.atan2(b.y! - a.y!, b.x! - a.x!); const r = radius(b) + 2; const tx = b.x! - Math.cos(ang) * r, ty = b.y! - Math.sin(ang) * r; ctx.fillStyle = ctx.strokeStyle as string; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx - 6 * Math.cos(ang - 0.4), ty - 6 * Math.sin(ang - 0.4)); ctx.lineTo(tx - 6 * Math.cos(ang + 0.4), ty - 6 * Math.sin(ang + 0.4)); ctx.fill(); }
      }
      const labelAlpha = Math.max(0, Math.min(1, (S.k - 0.6 + s.textFade * 0.3) * 2));
      for (const n of nodes) {
        if (!shown(n)) continue;
        const dim = hi && !hi.has(n.id);
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.fillStyle = n === S.hover || (local != null && n.fileId === local) ? colors.accent : n.color || (n.kind === "unresolved" ? colors.unres : n.kind === "tag" ? colors.tag : n.kind === "attachment" ? colors.attach : colors.node);
        ctx.beginPath(); ctx.arc(n.x!, n.y!, radius(n), 0, Math.PI * 2); ctx.fill();
        const a = n === S.hover || (hi && hi.has(n.id)) ? 1 : labelAlpha;
        if (a > 0.02) { ctx.globalAlpha = dim ? 0.25 : a; ctx.fillStyle = colors.text; ctx.font = `${12 / Math.max(S.k, 0.75)}px system-ui, sans-serif`; ctx.textAlign = "center"; ctx.fillText(n.label, n.x!, n.y! + radius(n) + 12 / Math.max(S.k, 0.75)); }
      }
      ctx.globalAlpha = 1;
      for (const n of nodes) S.positions.set(n.id, { x: n.x!, y: n.y! });
    };
    draw.current = paint;
    sim.on("tick", paint);
    const toWorld = (ex: number, ey: number) => { const r = c.getBoundingClientRect(); return { x: (ex - r.left - r.width / 2 - S.x) / S.k, y: (ey - r.top - r.height / 2 - S.y) / S.k }; };
    const hit = (ex: number, ey: number) => { const p = toWorld(ex, ey); let best: GNode | null = null, bd = Infinity; for (const n of nodes) { const d = Math.hypot(n.x! - p.x, n.y! - p.y); if (d < radius(n) + 4 && d < bd) { best = n; bd = d; } } return best; };
    let panning: { x: number; y: number; sx: number; sy: number } | null = null; let moved = false;
    const down = (e: PointerEvent) => { c.setPointerCapture(e.pointerId); moved = false; const n = hit(e.clientX, e.clientY); if (n && e.button === 0) { S.drag = n; n.fx = n.x; n.fy = n.y; sim.alphaTarget(0.2).restart(); } else panning = { x: e.clientX, y: e.clientY, sx: S.x, sy: S.y }; };
    const move = (e: PointerEvent) => {
      if (S.drag) { const p = toWorld(e.clientX, e.clientY); S.drag.fx = p.x; S.drag.fy = p.y; moved = true; return; }
      if (panning) { S.x = panning.sx + e.clientX - panning.x; S.y = panning.sy + e.clientY - panning.y; moved = moved || Math.abs(e.clientX - panning.x) + Math.abs(e.clientY - panning.y) > 3; paint(); return; }
      const n = hit(e.clientX, e.clientY); if (n !== S.hover) { S.hover = n; c.style.cursor = n ? "pointer" : "grab"; c.title = n ? n.label : ""; paint(); }
    };
    const up = (e: PointerEvent) => {
      const n = S.drag; S.drag = null; panning = null; sim.alphaTarget(0);
      if (n) { n.fx = null; n.fy = null; if (!moved) onOpen(n, e.ctrlKey || e.metaKey ? "tab" : "same"); }
    };
    const wheel = (e: WheelEvent) => { e.preventDefault(); const r = c.getBoundingClientRect(); const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2; const f = Math.exp(-e.deltaY * 0.0015); const k = Math.max(0.1, Math.min(6, S.k * f)); S.x = mx - (mx - S.x) * (k / S.k); S.y = my - (my - S.y) * (k / S.k); S.k = k; paint(); };
    const key = (e: KeyboardEvent) => { const step = e.shiftKey ? 120 : 40; if (e.key === "+" || e.key === "=") S.k = Math.min(6, S.k * 1.2); else if (e.key === "-") S.k = Math.max(0.1, S.k / 1.2); else if (e.key === "ArrowLeft") S.x += step; else if (e.key === "ArrowRight") S.x -= step; else if (e.key === "ArrowUp") S.y += step; else if (e.key === "ArrowDown") S.y -= step; else return; e.preventDefault(); paint(); };
    const ctxmenu = (e: MouseEvent) => { const n = hit(e.clientX, e.clientY); if (!n || n.fileId == null) return; showMenu(e, [{ label: "Open in new tab", onClick: () => onOpen(n, "tab") }, { label: "Open to the right", icon: "split", onClick: () => onOpen(n, "split") }]); };
    c.addEventListener("pointerdown", down); c.addEventListener("pointermove", move); c.addEventListener("pointerup", up); c.addEventListener("wheel", wheel, { passive: false }); c.addEventListener("keydown", key); c.addEventListener("contextmenu", ctxmenu);
    const ro = new ResizeObserver(() => paint()); ro.observe(c);
    const themed = () => { colors = css(); paint(); }; window.addEventListener("theme-changed", themed);
    return () => { sim.stop(); ro.disconnect(); window.removeEventListener("theme-changed", themed); c.removeEventListener("pointerdown", down); c.removeEventListener("pointermove", move); c.removeEventListener("pointerup", up); c.removeEventListener("wheel", wheel); c.removeEventListener("keydown", key); c.removeEventListener("contextmenu", ctxmenu); };
  }, [graph, s.repel, s.linkDistance, s.linkForce, s.center, s.nodeSize, s.arrows, s.linkWidth, s.textFade]);
  // Time-lapse: reveal nodes in order of creation.
  useEffect(() => {
    if (!animate) return; const S = st.current;
    const times = graph.nodes.map(n => n.ctime ? Date.parse(n.ctime) : 0).filter(Boolean).sort((a, b) => a - b);
    if (!times.length) return;
    let i = 0; S.visible = times[0] - 1;
    const timer = setInterval(() => { S.visible = times[i++]; draw.current(); if (i >= times.length) { clearInterval(timer); S.visible = Infinity; draw.current(); } }, Math.max(60, 3000 / times.length));
    return () => { clearInterval(timer); S.visible = Infinity; };
  }, [animate]);
  return <canvas ref={ref} className="graph-canvas" tabIndex={0} role="img" aria-label={`Graph with ${graph.nodes.length} nodes and ${graph.links.length} links`} data-nodes={graph.nodes.length} data-links={graph.links.length} />;
}
export { Icon };
