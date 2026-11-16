import { describe, it, expect } from "vitest";
import { parseNote, resolveSubpath, splitWikiInner } from "../src/shared/parse";

describe("parse", () => {
  it("P1 wikilinks with heading, block and display text", () => {
    const p = parseNote("See [[Note A]] and [[Folder/B#Intro|the intro]] and [[C#^abc]] and [[#Local]].");
    expect(p.links.map(l => [l.linkpath, l.subpath, l.display])).toEqual([["Note A", "", null], ["Folder/B", "#Intro", "the intro"], ["C", "#^abc", null], ["", "#Local", null]]);
    expect(p.links[1].raw).toBe("[[Folder/B#Intro|the intro]]");
  });
  it("P2 embeds and markdown links; URLs are not vault links", () => {
    const p = parseNote("![[pic.png|200]] [x](My%20Note.md#Part) [web](https://a.b/c) ![img](assets/a.png)");
    expect(p.links.map(l => [l.kind, l.format, l.linkpath, l.subpath, l.display])).toEqual([
      ["embed", "wiki", "pic.png", "", "200"], ["link", "md", "My Note.md", "#Part", "x"], ["embed", "md", "assets/a.png", "", "img"]]);
  });
  it("P3 links and tags inside code and comments are ignored", () => {
    const p = parseNote("```\n[[In code]] #nottag\n```\n`[[inline]]` %%[[hidden]]%% [[Real]] #real\n%%\n[[multi]]\n%%");
    expect(p.links.map(l => l.linkpath)).toEqual(["Real"]);
    expect(p.tags.map(t => t.tag)).toEqual(["real"]);
  });
  it("P4 tags: nested, unicode, need a non-digit, not in URLs or headings", () => {
    const p = parseNote("# Heading\n#work/meeting #1984 #y1984 #café #a-b_c http://x.com/#frag (#paren)");
    expect(p.tags.map(t => t.tag)).toEqual(["work/meeting", "y1984", "café", "a-b_c", "paren"]);
  });
  it("P5 frontmatter: tags, aliases and links in properties", () => {
    const p = parseNote('---\ntags: [project, "#idea"]\naliases:\n  - AI\n  - Machine minds\nrelated: "[[Other note]]"\n---\nBody #inline');
    expect(p.aliases).toEqual(["AI", "Machine minds"]);
    expect(p.tags.map(t => t.tag)).toEqual(["project", "idea", "inline"]);
    expect(p.links.map(l => [l.linkpath, l.frontmatterKey])).toEqual([["Other note", "related"]]);
    expect(p.frontmatter.bodyStart).toBe(p.lineStarts[7]);
  });
  it("P6 invalid frontmatter is flagged and ignored", () => {
    const p = parseNote("---\ntags: [unclosed\n---\ntext");
    expect(p.frontmatter.present).toBe(true); expect(p.frontmatter.valid).toBe(false); expect(p.tags).toEqual([]);
  });
  it("P7 headings and block ids (end of line and on their own line)", () => {
    const p = parseNote("# One\npara one ^p1\n\n## Two ##\n- item a\n- item b ^li\n\n> quote\n> more\n\n^q1\nafter");
    expect(p.headings.map(h => [h.level, h.text])).toEqual([[1, "One"], [2, "Two"]]);
    expect(p.blocks.map(b => [b.id, b.startLine, b.endLine])).toEqual([["p1", 1, 1], ["li", 5, 5], ["q1", 7, 8]]);
  });
  it("P8 resolveSubpath for nested headings and blocks", () => {
    const p = parseNote("# A\nx\n## B\ny\n# C\n## B\nz ^blk");
    expect(resolveSubpath(p, "#C#B")).toEqual({ startLine: 5, endLine: 6, kind: "heading" });
    expect(resolveSubpath(p, "#b")).toEqual({ startLine: 2, endLine: 3, kind: "heading" });
    expect(resolveSubpath(p, "#^BLK")).toEqual({ startLine: 6, endLine: 6, kind: "block" });
    expect(resolveSubpath(p, "#Missing")).toBeNull();
  });
  it("P9 escaped pipe in tables splits display text", () => {
    expect(splitWikiInner("Note\\|Shown")).toEqual({ linkpath: "Note", subpath: "", display: "Shown" });
  });
  it("P10 tasks", () => {
    const p = parseNote("- [ ] call mum\n- [x] email bob\n* [ ] other");
    expect(p.tasks.map(t => [t.done, t.text])).toEqual([[false, "call mum"], [true, "email bob"], [false, "other"]]);
  });
});
