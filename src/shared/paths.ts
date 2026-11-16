// Vault paths and link resolution. Paths are vault-relative, "/"-separated, no leading slash.
export const NOTE_EXT = "md";
export function basename(path: string) { return path.slice(path.lastIndexOf("/") + 1); }
export function dirname(path: string) { const i = path.lastIndexOf("/"); return i < 0 ? "" : path.slice(0, i); }
export function extname(path: string) { const b = basename(path); const i = b.lastIndexOf("."); return i <= 0 ? "" : b.slice(i + 1).toLowerCase(); }
/** File name without the ".md" extension (other extensions are kept). */
export function displayName(path: string) { const b = basename(path); return b.toLowerCase().endsWith(".md") ? b.slice(0, -3) : b; }
export function stem(path: string) { const b = basename(path); const i = b.lastIndexOf("."); return i <= 0 ? b : b.slice(0, i); }
export function joinPath(dir: string, name: string) { return dir ? `${dir}/${name}` : name; }
export const lc = (s: string) => s.toLowerCase();

/** Characters a file or folder name may not contain, and the reason shown to the user. */
export const BAD_NAME_CHARS = /[\\/:*?"<>|#^[\]]/;
export function checkName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name";
  if (n.length > 200) return "Use 200 characters or fewer";
  if (BAD_NAME_CHARS.test(n)) return 'Names cannot contain any of \\ / : * ? " < > | # ^ [ ]';
  if (n.startsWith(".")) return "Names cannot start with a dot";
  return null;
}

/** Collapse "./", "../" and empty segments. Returns null when it climbs above the vault root. */
export function normalizePath(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.join("/");
}

/** The key a link target is filed under for fast re-resolution: lower-case last segment without ".md". */
export function targetKey(linkpath: string) { const b = basename(linkpath).toLowerCase(); return b.endsWith(".md") ? b.slice(0, -3) : b; }
export function fileKey(path: string) { return targetKey(path); }

export interface VaultFileRef { path: string }

/**
 * Resolve a link path written in `sourcePath` against the vault's files.
 * Order: (1) explicit "./" or "../" paths relative to the source's folder;
 * (2) the exact path from the vault root; (3) the same path inside the source's folder;
 * (4) any file whose path ends with "/<linkpath>" — the one with the fewest folders, then the
 * shortest path, then alphabetical. Matching ignores case. A link path without an extension
 * means "<linkpath>.md"; a link path with an extension matches that file exactly.
 * An empty link path is the source note itself.
 */
export function resolveLink<T extends VaultFileRef>(linkpath: string, sourcePath: string, files: T[] | Map<string, T>): T | null {
  const byPath = files instanceof Map ? files : new Map(files.map(f => [lc(f.path), f]));
  const lp = linkpath.trim().replace(/^\/+/, "");
  if (!lp) return byPath.get(lc(sourcePath)) ?? null;
  const names = lp.toLowerCase().endsWith(".md") ? [lp] : [lp + ".md", lp];
  const srcDir = dirname(sourcePath);
  if (lp.startsWith("./") || lp.startsWith("../")) {
    const joined = normalizePath(joinPath(srcDir, lp));
    if (joined == null) return null;
    const cands = joined.toLowerCase().endsWith(".md") ? [joined] : [joined + ".md", joined];
    for (const c of cands) { const f = byPath.get(lc(c)); if (f) return f; }
    return null;
  }
  for (const n of names) { const f = byPath.get(lc(n)); if (f) return f; }
  if (srcDir) for (const n of names) { const f = byPath.get(lc(joinPath(srcDir, n))); if (f) return f; }
  let best: T | null = null; let bestScore: [number, number, string] | null = null;
  for (const n of names) {
    const suffix = "/" + lc(n);
    for (const [k, f] of byPath) {
      if (!k.endsWith(suffix)) continue;
      const score: [number, number, string] = [k.split("/").length, k.length, k];
      if (!bestScore || score[0] < bestScore[0] || (score[0] === bestScore[0] && (score[1] < bestScore[1] || (score[1] === bestScore[1] && score[2] < bestScore[2])))) { best = f; bestScore = score; }
    }
    if (best) return best;
  }
  return null;
}

export type LinkFormat = "shortest" | "relative" | "absolute";

/** The text to write in a new link from `sourcePath` to `targetPath` (without "[[", subpath or display). */
export function linktextFor(targetPath: string, sourcePath: string, allPaths: string[], format: LinkFormat = "shortest"): string {
  const isNote = targetPath.toLowerCase().endsWith(".md");
  const strip = (p: string) => (isNote ? p.slice(0, -3) : p);
  if (format === "absolute") return strip(targetPath);
  if (format === "relative") {
    const from = dirname(sourcePath).split("/").filter(Boolean), to = targetPath.split("/");
    let i = 0; while (i < from.length && i < to.length - 1 && lc(from[i]) === lc(to[i])) i++;
    const ups = from.length - i;
    return strip((ups ? "../".repeat(ups) : "./") + to.slice(i).join("/"));
  }
  const name = lc(basename(targetPath));
  const clash = allPaths.some(p => lc(p) !== lc(targetPath) && lc(basename(p)) === name);
  return strip(clash ? targetPath : basename(targetPath));
}

/** Text for a wikilink: "[[target#sub|display]]" (embed adds "!"). */
export function wikilink(target: string, subpath = "", display: string | null = null, embed = false) {
  return `${embed ? "!" : ""}[[${target}${subpath}${display != null && display !== "" ? "|" + display : ""}]]`;
}
/** Text for a Markdown link; the destination keeps ".md" and is percent-encoded. */
export function mdlink(targetPath: string, linktext: string, subpath = "", display = "", embed = false) {
  const dest = (linktext.toLowerCase().endsWith(".md") || !targetPath.toLowerCase().endsWith(".md") ? linktext : linktext + ".md");
  const enc = dest.split("/").map(s => encodeURIComponent(s)).join("/") + (subpath ? "#" + encodeURIComponent(subpath.slice(1)) : "");
  return `${embed ? "!" : ""}[${display}](${enc})`;
}
