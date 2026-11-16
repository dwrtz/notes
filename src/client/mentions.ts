// Unlinked mentions inside one note: names and aliases of other notes as whole words, outside links, tags and code.
import { parseNote } from "../shared/parse";
import { displayName } from "../shared/paths";
import type { FileMeta } from "./store";
export function findMentionsClient(text: string, files: FileMeta[]) {
  const p = parseNote(text);
  const names: { n: string; f: FileMeta }[] = [];
  for (const f of files) { const n = displayName(f.path); if (n.length >= 3) names.push({ n, f }); for (const a of f.aliases || []) if (a.length >= 2) names.push({ n: a, f }); }
  names.sort((a, b) => b.n.length - a.n.length);
  const out: { line: number; start: number; end: number; target: FileMeta; text: string; lineText: string }[] = [];
  const isWord = (c?: string) => !!c && /[\p{L}\p{N}_]/u.test(c);
  p.lines.forEach((line, i) => {
    if (p.masked[i] || out.length > 200) return;
    const base = p.lineStarts[i];
    const blocked: [number, number][] = [...p.links.filter(l => l.line === i && l.start >= 0).map(l => [l.start - base, l.end - base] as [number, number]), ...p.tags.filter(t => t.line === i && t.start >= 0).map(t => [t.start - base, t.end - base] as [number, number])];
    const code = /`[^`]*`/g; let m: RegExpExecArray | null; while ((m = code.exec(line))) blocked.push([m.index, m.index + m[0].length]);
    const low = line.toLowerCase();
    for (const { n, f } of names) {
      const nl = n.toLowerCase(); let k = low.indexOf(nl);
      while (k >= 0) { const e = k + nl.length; if (!isWord(line[k - 1]) && !isWord(line[e]) && !blocked.some(([a, b]) => k < b && e > a)) { out.push({ line: i, start: k, end: e, target: f, text: line.slice(k, e), lineText: line }); blocked.push([k, e]); } k = low.indexOf(nl, k + 1); }
    }
  });
  return out;
}
