// Template variables and property merging.
import { stringify } from "yaml";
import { formatDate, Parts } from "./dates";
import { parseFrontmatter } from "./parse";

export function applyVariables(text: string, v: { title: string; now: Parts; dateFormat: string; timeFormat: string }) {
  return text.replace(/\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}/gi, (_m, name: string, fmt?: string) => {
    const n = name.toLowerCase();
    if (n === "title") return v.title;
    return formatDate(v.now, fmt?.trim() || (n === "date" ? v.dateFormat : v.timeFormat));
  });
}

/**
 * Insert a template into a note at `offset`. The template's properties are merged into the note's
 * frontmatter (the note's own values win; list values are combined without duplicates) and the rest
 * of the template's text goes at the cursor. Returns the new text and where the cursor should go.
 */
export function insertTemplate(note: string, offset: number, template: string): { text: string; cursor: number } {
  const tf = parseFrontmatter(template);
  const tBody = tf.present ? template.slice(tf.bodyStart) : template;
  if (!tf.present || !tf.valid || !Object.keys(tf.data).length) {
    return { text: note.slice(0, offset) + tBody + note.slice(offset), cursor: offset + tBody.length };
  }
  const nf = parseFrontmatter(note);
  const merged: Record<string, unknown> = { ...(nf.valid ? nf.data : {}) };
  for (const [k, v] of Object.entries(tf.data)) {
    const key = Object.keys(merged).find(x => x.toLowerCase() === k.toLowerCase());
    if (!key) { merged[k] = v; continue; }
    const cur = merged[key];
    if (Array.isArray(cur) || Array.isArray(v)) {
      const a = Array.isArray(cur) ? cur : cur == null || cur === "" ? [] : [cur];
      const b = Array.isArray(v) ? v : v == null || v === "" ? [] : [v];
      merged[key] = [...a, ...b.filter(x => !a.some(y => String(y) === String(x)))];
    } else if (cur == null || cur === "") merged[key] = v;
  }
  const body = nf.present ? note.slice(nf.bodyStart) : note;
  const bodyOffset = Math.max(0, offset - (nf.present ? nf.bodyStart : 0));
  const fm = "---\n" + stringify(merged, { lineWidth: 0 }).trimEnd() + "\n---\n";
  const newBody = body.slice(0, bodyOffset) + tBody + body.slice(bodyOffset);
  return { text: fm + newBody, cursor: fm.length + bodyOffset + tBody.length };
}

/** Write a note's frontmatter from a property object, keeping the body. Empty object removes it. */
export function setFrontmatter(note: string, data: Record<string, unknown>): string {
  const nf = parseFrontmatter(note);
  const body = nf.present ? note.slice(nf.bodyStart) : note;
  if (!Object.keys(data).length) return body;
  return "---\n" + stringify(data, { lineWidth: 0 }).trimEnd() + "\n---\n" + body;
}
