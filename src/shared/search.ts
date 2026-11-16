// Search query language: words, "phrases", /regex/, OR, -negation, ( ) groups,
// operators file: path: content: tag: line: block: section: task: task-todo: task-done:
// match-case: ignore-case:, and properties [key], [key:value], [key:>5], [key:null].
import { ParsedNote, normTag } from "./parse";

export type Field = "any" | "file" | "path" | "content" | "tag" | "line" | "block" | "section" | "task" | "task-todo" | "task-done";
export type Node =
  | { t: "and"; items: Node[] } | { t: "or"; items: Node[] } | { t: "not"; item: Node }
  | { t: "term"; kind: "word" | "phrase" | "regex"; value: string; case?: boolean }
  | { t: "op"; field: Field; item: Node }
  | { t: "case"; on: boolean; item: Node }
  | { t: "prop"; key: Node | null; keyText: string; value: Node | null; cmp?: { op: "<" | ">" | "<=" | ">=" | "="; num: number }; isNull?: boolean };

export class QueryError extends Error {}
const FIELDS = new Set(["file", "path", "content", "tag", "line", "block", "section", "task", "task-todo", "task-done"]);

type Tok = { k: "word" | "phrase" | "regex" | "(" | ")" | "OR" | "-" | "op" | "prop"; v: string };

function tokenize(q: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")") { out.push({ k: c, v: c }); i++; continue; }
    if (c === "-" && i + 1 < q.length && !/\s/.test(q[i + 1]) && (i === 0 || /[\s(]/.test(q[i - 1]))) { out.push({ k: "-", v: "-" }); i++; continue; }
    if (c === '"') {
      let j = i + 1, s = "";
      while (j < q.length && q[j] !== '"') { if (q[j] === "\\" && j + 1 < q.length) { s += q[j + 1]; j += 2; continue; } s += q[j++]; }
      out.push({ k: "phrase", v: s }); i = j + 1; continue;
    }
    if (c === "/" ) {
      const j = findRegexEnd(q, i);
      if (j > i + 1) { out.push({ k: "regex", v: q.slice(i + 1, j) }); i = j + 1; continue; }
    }
    if (c === "[") {
      let depth = 0, j = i;
      for (; j < q.length; j++) { if (q[j] === "[") depth++; else if (q[j] === "]") { depth--; if (!depth) break; } else if (q[j] === '"') { const e = q.indexOf('"', j + 1); if (e > 0) j = e; } }
      if (j >= q.length) throw new QueryError("A property filter is missing its closing ]");
      out.push({ k: "prop", v: q.slice(i + 1, j) }); i = j + 1; continue;
    }
    let j = i; while (j < q.length && !/[\s()]/.test(q[j])) { if (q[j] === ":") break; j++; }
    const word = q.slice(i, j);
    if (q[j] === ":" && (FIELDS.has(word.toLowerCase()) || word === "match-case" || word === "ignore-case")) { out.push({ k: "op", v: word.toLowerCase() }); i = j + 1; continue; }
    // plain word (may contain ":")
    j = i; while (j < q.length && !/[\s()]/.test(q[j])) j++;
    const w = q.slice(i, j);
    out.push(w === "OR" ? { k: "OR", v: w } : { k: "word", v: w }); i = j;
  }
  return out;
}
function findRegexEnd(q: string, i: number) { for (let j = i + 1; j < q.length; j++) { if (q[j] === "\\") { j++; continue; } if (q[j] === "/") return j; } return -1; }

export function parseQuery(q: string): Node | null {
  const toks = tokenize(q); let p = 0;
  const peek = () => toks[p];
  function parseOr(): Node {
    const items = [parseAnd()];
    while (peek()?.k === "OR") { p++; items.push(parseAnd()); }
    return items.length === 1 ? items[0] : { t: "or", items };
  }
  function parseAnd(): Node {
    const items: Node[] = [];
    while (p < toks.length && peek().k !== ")" && peek().k !== "OR") items.push(parseUnary());
    if (!items.length) throw new QueryError("Something is missing around OR or a bracket");
    return items.length === 1 ? items[0] : { t: "and", items };
  }
  function parseUnary(): Node {
    const tk = toks[p++];
    if (tk.k === "-") return { t: "not", item: parseUnary() };
    if (tk.k === "(") { const n = parseOr(); if (peek()?.k !== ")") throw new QueryError("A bracket is not closed"); p++; return n; }
    if (tk.k === "op") {
      if (p >= toks.length || peek().k === ")" ) throw new QueryError(`${tk.v}: needs something to look for`);
      const item = parseUnary();
      if (tk.v === "match-case" || tk.v === "ignore-case") return { t: "case", on: tk.v === "match-case", item };
      return { t: "op", field: tk.v as Field, item };
    }
    if (tk.k === "prop") return parseProp(tk.v);
    if (tk.k === "word" || tk.k === "phrase" || tk.k === "regex") {
      if (tk.k === "regex") { try { new RegExp(tk.v); } catch { throw new QueryError("That regular expression is not valid"); } }
      return { t: "term", kind: tk.k, value: tk.v };
    }
    throw new QueryError("Unexpected " + tk.v);
  }
  if (!toks.length) return null;
  const n = parseOr();
  if (p < toks.length) throw new QueryError("A bracket is closed but was never opened");
  return n;
}

function parseProp(inner: string): Node {
  const colon = inner.indexOf(":");
  const keyText = (colon < 0 ? inner : inner.slice(0, colon)).trim();
  if (!keyText) throw new QueryError("A property filter needs a property name");
  const key = /^[\w\- ]+$/.test(keyText) ? null : parseQuery(keyText);
  if (colon < 0) return { t: "prop", key, keyText, value: null };
  const v = inner.slice(colon + 1).trim();
  if (v === "null") return { t: "prop", key, keyText, value: null, isNull: true };
  const cmp = /^(<=|>=|<|>|=)\s*(-?\d+(?:\.\d+)?)$/.exec(v);
  if (cmp) return { t: "prop", key, keyText, value: null, cmp: { op: cmp[1] as any, num: Number(cmp[2]) } };
  if (!v) throw new QueryError("A property filter is missing its value");
  return { t: "prop", key, keyText, value: parseQuery(v) };
}

export interface SearchDoc { path: string; content: string; parsed: ParsedNote; isNote: boolean }
export interface Match { line: number; start: number; end: number } // offsets within the line

/** Words and phrases that every result must contain — used to narrow candidates with the full-text index. */
export function requiredTerms(n: Node | null): string[] {
  if (!n) return [];
  if (n.t === "term" && n.kind !== "regex") return [n.value];
  if (n.t === "and") return n.items.flatMap(requiredTerms);
  if (n.t === "op" && (n.field === "content" || n.field === "line" || n.field === "block" || n.field === "section" || n.field.startsWith("task"))) return requiredTerms(n.item);
  if (n.t === "case") return requiredTerms(n.item);
  return [];
}

function makeTest(n: Extract<Node, { t: "term" }>, matchCase: boolean) {
  if (n.kind === "regex") { const re = new RegExp(n.value, matchCase ? "g" : "gi"); return (s: string) => { re.lastIndex = 0; return re.test(s); }; }
  const needle = matchCase ? n.value : n.value.toLowerCase();
  return (s: string) => (matchCase ? s : s.toLowerCase()).includes(needle);
}
export function termMatches(n: Extract<Node, { t: "term" }>, s: string, matchCase: boolean): Match[] {
  const out: Match[] = [];
  if (n.kind === "regex") { const re = new RegExp(n.value, matchCase ? "g" : "gi"); let m; while ((m = re.exec(s)) && out.length < 50) { out.push({ line: 0, start: m.index, end: m.index + m[0].length }); if (!m[0].length) re.lastIndex++; } return out; }
  const hay = matchCase ? s : s.toLowerCase(), needle = matchCase ? n.value : n.value.toLowerCase();
  if (!needle) return out;
  let i = hay.indexOf(needle); while (i >= 0 && out.length < 50) { out.push({ line: 0, start: i, end: i + needle.length }); i = hay.indexOf(needle, i + needle.length); }
  return out;
}

type Ctx = { doc: SearchDoc; matchCase: boolean; scope: string | null; field: Field; matches: Match[] | null };

function units(doc: SearchDoc, field: Field): { text: string; line: number }[] {
  const p = doc.parsed, lines = p.lines;
  const body = lines.map((t, i) => ({ text: t, line: i })).filter((_, i) => !(p.frontmatter.present && i <= p.frontmatter.endLine));
  if (field === "line") return body;
  if (field === "task" || field === "task-todo" || field === "task-done")
    return p.tasks.filter(t => field === "task" || (field === "task-done") === t.done).map(t => ({ text: lines[t.line], line: t.line }));
  if (field === "block") {
    const out: { text: string; line: number }[] = []; let cur: { text: string; line: number } | null = null;
    for (const b of body) { if (!b.text.trim()) { if (cur) out.push(cur); cur = null; continue; } if (!cur) cur = { text: b.text, line: b.line }; else cur.text += "\n" + b.text; }
    if (cur) out.push(cur); return out;
  }
  if (field === "section") {
    const out: { text: string; line: number }[] = []; let cur = { text: "", line: body[0]?.line ?? 0 };
    for (const b of body) { if (/^#{1,6}\s/.test(b.text)) { out.push(cur); cur = { text: b.text, line: b.line }; } else cur.text += "\n" + b.text; }
    out.push(cur); return out;
  }
  return [];
}

function evalNode(n: Node, c: Ctx): boolean {
  switch (n.t) {
    case "and": return n.items.every(i => evalNode(i, c));
    case "or": { let any = false; for (const i of n.items) if (evalNode(i, c)) any = true; return any; }
    case "not": return !evalNode(n.item, { ...c, matches: null });
    case "case": return evalNode(n.item, { ...c, matchCase: n.on });
    case "op": {
      if (n.field === "line" || n.field === "block" || n.field === "section" || n.field.startsWith("task")) {
        let ok = false;
        for (const u of units(c.doc, n.field)) {
          if (evalNode(n.item, { ...c, field: "content", scope: u.text, matches: null })) {
            ok = true;
            if (c.matches) collect(n.item, u.text, u.line, c);
          }
        }
        return ok;
      }
      return evalNode(n.item, { ...c, field: n.field });
    }
    case "prop": return evalProp(n, c);
    case "term": {
      const test = makeTest(n, c.matchCase);
      const d = c.doc;
      switch (c.field) {
        case "file": return test(d.path.slice(d.path.lastIndexOf("/") + 1));
        case "path": return test(d.path);
        case "tag": {
          const want = normTag(n.value).toLowerCase();
          return d.parsed.tags.some(t => { const tg = t.tag.toLowerCase(); return n.kind === "regex" ? test(tg) : tg === want || tg.startsWith(want + "/"); });
        }
        case "content": {
          if (c.scope != null) return test(c.scope);
          const ok = d.isNote && test(d.content);
          if (ok && c.matches) collect(n, d.content, 0, c);
          return ok;
        }
        default: {
          const inName = test(d.path.slice(d.path.lastIndexOf("/") + 1).replace(/\.md$/i, ""));
          const inBody = d.isNote && test(d.content);
          if (inBody && c.matches) collect(n, d.content, 0, c);
          return inName || inBody;
        }
      }
    }
  }
}

function collect(n: Node, text: string, firstLine: number, c: Ctx) {
  if (!c.matches) return;
  if (n.t === "and" || n.t === "or") { n.items.forEach(i => collect(i, text, firstLine, c)); return; }
  if (n.t === "case") { collect(n.item, text, firstLine, { ...c, matchCase: n.on }); return; }
  if (n.t !== "term") return;
  const lines = text.split("\n");
  lines.forEach((l, k) => { for (const m of termMatches(n, l, c.matchCase)) if (c.matches!.length < 200) c.matches!.push({ line: firstLine + k, start: m.start, end: m.end }); });
}

function propValues(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(propValues);
  if (v instanceof Date) return [v.toISOString().slice(0, 10)];
  return [String(v)];
}
function evalProp(n: Extract<Node, { t: "prop" }>, c: Ctx): boolean {
  const data = c.doc.parsed.frontmatter.valid ? c.doc.parsed.frontmatter.data : {};
  const keys = Object.keys(data).filter(k => n.key ? evalNode(n.key, { ...c, field: "content", scope: k, matches: null }) : k.toLowerCase() === n.keyText.toLowerCase());
  if (!keys.length) return false;
  return keys.some(k => {
    const v = data[k];
    if (n.isNull) return v == null || v === "";
    if (n.cmp) {
      const num = typeof v === "number" ? v : Number(v);
      if (v == null || v === "" || Number.isNaN(num)) return false;
      const { op, num: x } = n.cmp;
      return op === "<" ? num < x : op === ">" ? num > x : op === "<=" ? num <= x : op === ">=" ? num >= x : num === x;
    }
    if (!n.value) return true;
    return propValues(v).some(s => evalNode(n.value!, { ...c, field: "content", scope: s, matches: null }));
  });
}

export function evaluate(n: Node, doc: SearchDoc, matchCase = false): { hit: boolean; matches: Match[] } {
  const matches: Match[] = [];
  const hit = evalNode(n, { doc, matchCase, scope: null, field: "any", matches });
  return { hit, matches: hit ? dedupe(matches) : [] };
}
function dedupe(ms: Match[]) {
  const seen = new Set<string>(); return ms.filter(m => { const k = `${m.line}:${m.start}:${m.end}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.line - b.line || a.start - b.start);
}

/** A plain-English explanation of a query, for the "Explain search term" switch. */
export function explain(n: Node | null, depth = 0): string {
  if (!n) return "";
  const pad = "  ".repeat(depth);
  switch (n.t) {
    case "and": return `${pad}Match all of:\n` + n.items.map(i => explain(i, depth + 1)).join("\n");
    case "or": return `${pad}Match any of:\n` + n.items.map(i => explain(i, depth + 1)).join("\n");
    case "not": return `${pad}Do not match:\n` + explain(n.item, depth + 1);
    case "case": return `${pad}${n.on ? "Case-sensitive" : "Ignoring case"}:\n` + explain(n.item, depth + 1);
    case "op": return `${pad}${({ file: "In the file name", path: "In the file path", content: "In the text", tag: "With the tag", line: "On one line", block: "In one block", section: "In one section", task: "In one task", "task-todo": "In one unfinished task", "task-done": "In one finished task", any: "Anywhere" } as Record<string, string>)[n.field]}:\n` + explain(n.item, depth + 1);
    case "prop": return `${pad}Property "${n.keyText}"` + (n.isNull ? " is empty" : n.cmp ? ` is ${n.cmp.op} ${n.cmp.num}` : n.value ? ` matches:\n${explain(n.value, depth + 1)}` : " exists");
    case "term": return `${pad}${n.kind === "regex" ? `Pattern /${n.value}/` : n.kind === "phrase" ? `The exact text "${n.value}"` : `"${n.value}"`}`;
  }
}
