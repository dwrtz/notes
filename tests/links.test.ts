import { describe, it, expect } from "vitest";
import { resolveLink, linktextFor } from "../src/shared/paths";
import { rewriteLinks } from "../src/shared/rewrite";
import { ParsedLink } from "../src/shared/parse";

const files = ["Ideas.md", "Projects/Ideas.md", "Projects/Plan.md", "Archive/2024/Plan.md", "Inbox.md", "img/cat.png", "Projects/sub/Deep.md", "Notes/Deep.md"].map(path => ({ path }));
const r = (lp: string, src: string) => resolveLink(lp, src, files)?.path ?? null;

describe("link resolution", () => {
  it("L1 exact vault path wins, case-insensitive, .md optional", () => {
    expect(r("ideas", "Inbox.md")).toBe("Ideas.md");
    expect(r("Projects/Ideas", "Inbox.md")).toBe("Projects/Ideas.md");
    expect(r("projects/ideas.md", "Inbox.md")).toBe("Projects/Ideas.md");
  });
  it("L2 vault root beats same folder for an exact path; same folder beats other folders", () => {
    expect(r("Ideas", "Projects/Plan.md")).toBe("Ideas.md");
    expect(r("Plan", "Archive/2024/x.md")).toBe("Archive/2024/Plan.md");
  });
  it("L3 bare name with no exact match: fewest folders, then shortest path, then A-Z", () => {
    expect(r("Plan", "Inbox.md")).toBe("Projects/Plan.md");
    expect(r("Deep", "Inbox.md")).toBe("Notes/Deep.md");
    expect(r("sub/Deep", "Inbox.md")).toBe("Projects/sub/Deep.md");
  });
  it("L4 relative paths and attachments need the extension", () => {
    expect(r("../Inbox", "Projects/Plan.md")).toBe("Inbox.md");
    expect(r("./Ideas", "Projects/Plan.md")).toBe("Projects/Ideas.md");
    expect(r("../../../x", "Projects/Plan.md")).toBeNull();
    expect(r("cat.png", "Inbox.md")).toBe("img/cat.png");
    expect(r("cat", "Inbox.md")).toBeNull();
  });
  it("L5 empty link path is the note itself; unknown names are unresolved", () => {
    expect(r("", "Inbox.md")).toBe("Inbox.md");
    expect(r("Nope", "Inbox.md")).toBeNull();
  });
  it("L6 shortest link text uses the bare name only when it is unique", () => {
    const all = files.map(f => f.path);
    expect(linktextFor("Inbox.md", "Projects/Plan.md", all)).toBe("Inbox");
    expect(linktextFor("Projects/Ideas.md", "Inbox.md", all)).toBe("Projects/Ideas");
    expect(linktextFor("img/cat.png", "Inbox.md", all)).toBe("cat.png");
    expect(linktextFor("Projects/sub/Deep.md", "Notes/x.md", all, "relative")).toBe("../Projects/sub/Deep");
    expect(linktextFor("Projects/Plan.md", "Projects/x.md", all, "relative")).toBe("./Plan");
    expect(linktextFor("Projects/Plan.md", "Inbox.md", all, "absolute")).toBe("Projects/Plan");
  });
});

describe("link rewriting", () => {
  const mk = (before: string[], after: string[], moves: Record<string, string>, src: string, srcAfter = src) => {
    const B = before.map(path => ({ path })), A = after.map(path => ({ path }));
    return {
      before: (l: ParsedLink) => resolveLink(l.linkpath, src, B)?.path ?? null,
      after: (l: ParsedLink) => resolveLink(l.linkpath, srcAfter, A)?.path ?? null,
      moved: (p: string) => moves[p] ?? p, sourcePathAfter: srcAfter, allPathsAfter: after, format: "shortest" as const,
    };
  };
  it("W1 rename keeps subpath, display text and embeds; leaves other links", () => {
    const text = "[[Old]] [[Old#H|shown]] ![[Old#^b]] [[Other]] [[Missing]] [o](Old.md)";
    const out = rewriteLinks(text, mk(["Old.md", "Other.md", "n.md"], ["New name.md", "Other.md", "n.md"], { "Old.md": "New name.md" }, "n.md"));
    expect(out).toBe("[[New name]] [[New name#H|shown]] ![[New name#^b]] [[Other]] [[Missing]] [o](New%20name.md)");
  });
  it("W2 moving into a folder where the name clashes writes the path", () => {
    const out = rewriteLinks("[[Plan]]", mk(["Plan.md", "Archive/Plan.md", "n.md"], ["Work/Plan.md", "Archive/Plan.md", "n.md"], { "Plan.md": "Work/Plan.md" }, "n.md"));
    expect(out).toBe("[[Work/Plan]]");
  });
  it("W3 moving the linking note itself fixes relative links and keeps them relative; nothing to do returns null", () => {
    const out = rewriteLinks("[[./Sib]] [[Top]]", mk(["A/n.md", "A/Sib.md", "Top.md"], ["B/n.md", "A/Sib.md", "Top.md"], { "A/n.md": "B/n.md" }, "A/n.md", "B/n.md"));
    expect(out).toBe("[[../A/Sib]] [[Top]]");
    expect(rewriteLinks("[[Top]]", mk(["n.md", "Top.md"], ["n.md", "Top.md"], {}, "n.md"))).toBeNull();
  });
  it("W4 frontmatter links are rewritten in place", () => {
    const out = rewriteLinks('---\nup: "[[Old]]"\n---\nx', mk(["Old.md", "n.md"], ["New.md", "n.md"], { "Old.md": "New.md" }, "n.md"));
    expect(out).toBe('---\nup: "[[New]]"\n---\nx');
  });
});
