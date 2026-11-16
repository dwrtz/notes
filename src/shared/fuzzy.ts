// Fuzzy matching for the quick switcher, command palette and link suggestions.
// Letters of the query must appear in order. Score: lower is better.
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, " ").trim(), t = text.toLowerCase();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return idx === 0 ? 0 : (t[idx - 1] === " " || t[idx - 1] === "/" ? 1 : 2) + idx / 1000;
  let ti = 0, gaps = 0, start = -1, last = -1;
  for (const ch of q) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    if (start < 0) start = at;
    if (last >= 0 && at > last + 1) gaps += 1;
    last = at; ti = at + 1;
  }
  return 10 + gaps * 2 + (last - start) / 100 + start / 1000;
}
/** Return matched character indexes for highlighting. */
export function fuzzyIndexes(query: string, text: string): number[] {
  const q = query.toLowerCase().trim(), t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (q && idx >= 0) return Array.from({ length: q.length }, (_, i) => idx + i);
  const out: number[] = []; let ti = 0;
  for (const ch of q) { if (ch === " ") continue; const at = t.indexOf(ch, ti); if (at < 0) return []; out.push(at); ti = at + 1; }
  return out;
}
