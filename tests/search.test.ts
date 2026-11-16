import { describe, it, expect } from "vitest";
import { parseQuery, evaluate, requiredTerms, QueryError } from "../src/shared/search";
import { parseNote } from "../src/shared/parse";

const doc = (path: string, content: string) => ({ path, content, parsed: parseNote(content), isNote: path.endsWith(".md") });
const docs = [
  doc("Meetings/Work sync.md", "---\nstatus: Draft\nduration: 3\ntags: [work]\n---\n# Agenda\nmeeting with Bob about work\n- [ ] call Alice\n- [x] email Carol\n\n## Notes\ndog and cat"),
  doc("Personal/Meetup.md", "meetup with friends #personal\nThe dog\nthe cat"),
  doc("Daily/2026-11-16.md", "Today: meeting #work/daily\nStar Wars night"),
  doc("img/photo.jpg", ""),
];
const find = (q: string, mc = false) => docs.filter(d => evaluate(parseQuery(q)!, d, mc).hit).map(d => d.path);

describe("search", () => {
  it("S1 words are ANDed, OR and parentheses, negation", () => {
    expect(find("meeting work")).toEqual(["Meetings/Work sync.md", "Daily/2026-11-16.md"]);
    expect(find("meetup OR bob")).toEqual(["Meetings/Work sync.md", "Personal/Meetup.md"]);
    expect(find("meeting -bob")).toEqual(["Daily/2026-11-16.md"]);
    expect(find("(dog OR star) -(meeting bob)")).toEqual(["Personal/Meetup.md", "Daily/2026-11-16.md"]);
  });
  it("S2 phrases, case and regex", () => {
    expect(find('"star wars"')).toEqual(["Daily/2026-11-16.md"]);
    expect(find("match-case:Star")).toEqual(["Daily/2026-11-16.md"]);
    expect(find("match-case:star")).toEqual([]);
    expect(find("/\\d{4}-\\d{2}-\\d{2}/")).toEqual(["Daily/2026-11-16.md"]);
  });
  it("S3 file: and path: match any file, including attachments", () => {
    expect(find("file:.jpg")).toEqual(["img/photo.jpg"]);
    expect(find('path:"Meetings/"')).toEqual(["Meetings/Work sync.md"]);
    expect(find("file:meetup")).toEqual(["Personal/Meetup.md"]);
  });
  it("S4 tag: matches nested tags and frontmatter tags but not text", () => {
    expect(find("tag:#work")).toEqual(["Meetings/Work sync.md", "Daily/2026-11-16.md"]);
    expect(find("tag:work/daily")).toEqual(["Daily/2026-11-16.md"]);
    expect(find("tag:#personal")).toEqual(["Personal/Meetup.md"]);
  });
  it("S5 line:, section:, block: and task operators", () => {
    expect(find("line:(dog cat)")).toEqual(["Meetings/Work sync.md"]);
    expect(find("block:(dog cat)")).toEqual(["Meetings/Work sync.md", "Personal/Meetup.md"]);
    expect(find("section:(bob alice)")).toEqual(["Meetings/Work sync.md"]);
    expect(find("section:(bob dog)")).toEqual([]);
    expect(find("task-todo:call")).toEqual(["Meetings/Work sync.md"]);
    expect(find("task-todo:email")).toEqual([]);
    expect(find("task-done:email")).toEqual(["Meetings/Work sync.md"]);
  });
  it("S6 properties", () => {
    expect(find("[status]")).toEqual(["Meetings/Work sync.md"]);
    expect(find("[status:draft]")).toEqual(["Meetings/Work sync.md"]);
    expect(find("[status:Draft OR Published]")).toEqual(["Meetings/Work sync.md"]);
    expect(find("[duration:<5]")).toEqual(["Meetings/Work sync.md"]);
    expect(find("[duration:>5]")).toEqual([]);
  });
  it("S7 matches report lines for highlighting", () => {
    const r = evaluate(parseQuery("bob")!, docs[0]);
    expect(r.matches).toEqual([{ line: 6, start: 13, end: 16 }]);
  });
  it("S8 required terms for the index; errors for bad queries", () => {
    expect(requiredTerms(parseQuery('meeting "star wars" -bob (a OR b) tag:x')!)).toEqual(["meeting", "star wars"]);
    expect(() => parseQuery("(a OR b")).toThrow(QueryError);
    expect(() => parseQuery("/[/")).toThrow(QueryError);
    expect(parseQuery("   ")).toBeNull();
  });
});
