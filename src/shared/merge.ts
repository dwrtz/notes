// Line-based three-way merge used when two devices edit the same note.
// merge3(base, mine, theirs): changes from both sides are kept when they touch different lines;
// when both sides change the same lines differently the result is { clean: false } and the
// caller keeps the server's text and saves ours as a conflict copy.

function lcsPairs(a: string[], b: string[]): [number, number][] {
  // Trim common prefix/suffix, then classic DP on the middle (bounded).
  let pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const pairs: [number, number][] = [];
  for (let i = 0; i < pre; i++) pairs.push([i, i]);
  if (A.length && B.length) {
    if (A.length * B.length > 4_000_000) throw new Error("too large");
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) { if (A[i] === B[j]) { pairs.push([pre + i, pre + j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  }
  for (let k = 0; k < suf; k++) pairs.push([a.length - suf + k, b.length - suf + k]);
  return pairs;
}

export function merge3(base: string, mine: string, theirs: string): { clean: boolean; text: string } {
  if (mine === theirs) return { clean: true, text: mine };
  if (base === mine) return { clean: true, text: theirs };
  if (base === theirs) return { clean: true, text: mine };
  const O = base.split("\n"), A = mine.split("\n"), B = theirs.split("\n");
  let pa: [number, number][], pb: [number, number][];
  try { pa = lcsPairs(O, A); pb = lcsPairs(O, B); } catch { return { clean: false, text: theirs }; }
  const mapA = new Map(pa), mapB = new Map(pb);
  // Base lines unchanged on both sides act as sync points.
  const syncs: [number, number, number][] = [];
  for (let i = 0; i < O.length; i++) if (mapA.has(i) && mapB.has(i)) syncs.push([i, mapA.get(i)!, mapB.get(i)!]);
  syncs.push([O.length, A.length, B.length]);
  const out: string[] = []; let o = 0, a = 0, b = 0, clean = true;
  for (const [so, sa, sb] of syncs) {
    if (so < o || sa < a || sb < b) continue;
    const co = O.slice(o, so), ca = A.slice(a, sa), cb = B.slice(b, sb);
    const eq = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
    if (eq(ca, co)) out.push(...cb);
    else if (eq(cb, co)) out.push(...ca);
    else if (eq(ca, cb)) out.push(...ca);
    else { clean = false; out.push(...cb); }
    if (so < O.length) out.push(O[so]);
    o = so + 1; a = sa + 1; b = sb + 1;
  }
  return { clean, text: clean ? out.join("\n") : theirs };
}
