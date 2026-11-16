import { describe, it, expect } from "vitest";
import { merge3 } from "../src/shared/merge";
import { formatDate, parseDate, addDays } from "../src/shared/dates";
import { applyVariables, insertTemplate } from "../src/shared/templates";
import { fuzzyScore } from "../src/shared/fuzzy";

describe("merge", () => {
  it("M1 edits on different lines merge cleanly", () => {
    expect(merge3("a\nb\nc\nd", "A\nb\nc\nd", "a\nb\nc\nD")).toEqual({ clean: true, text: "A\nb\nc\nD" });
  });
  it("M2 same line changed differently is a conflict; identical edits are fine", () => {
    expect(merge3("a\nb", "a\nX", "a\nY").clean).toBe(false);
    expect(merge3("a\nb", "a\nX", "a\nX")).toEqual({ clean: true, text: "a\nX" });
  });
  it("M3 insertions at both ends", () => {
    expect(merge3("m", "top\nm", "m\nbottom")).toEqual({ clean: true, text: "top\nm\nbottom" });
  });
});
describe("dates", () => {
  const d = { y: 2026, mo: 11, d: 16, h: 9, mi: 5, s: 0 };
  it("D1 format tokens and literals", () => {
    expect(formatDate(d, "YYYY-MM-DD")).toBe("2026-11-16");
    expect(formatDate(d, "YYYY/MMMM/YYYY-MMM-DD")).toBe("2026/November/2026-Nov-16");
    expect(formatDate(d, "dddd, Do [of] MMMM h:mm A")).toBe("Monday, 16th of November 9:05 AM");
  });
  it("D2 parse back, reject impossible dates, add days across months", () => {
    expect(parseDate("2026/November/2026-Nov-16", "YYYY/MMMM/YYYY-MMM-DD")).toMatchObject({ y: 2026, mo: 11, d: 16 });
    expect(parseDate("2026-02-30", "YYYY-MM-DD")).toBeNull();
    expect(addDays(d, 20)).toMatchObject({ y: 2026, mo: 12, d: 6 });
  });
});
describe("templates", () => {
  it("T1 variables", () => {
    expect(applyVariables("# {{title}} {{date}} {{time}} {{date:dddd}}", { title: "Plan", now: { y: 2026, mo: 11, d: 16, h: 14, mi: 30, s: 0 }, dateFormat: "YYYY-MM-DD", timeFormat: "HH:mm" })).toBe("# Plan 2026-11-16 14:30 Monday");
  });
  it("T2 template properties merge into the note's", () => {
    const r = insertTemplate("---\ntags: [a]\nstatus: done\n---\nHello\n", 25, "---\ntags: [b, a]\nstatus: draft\ntopic: x\n---\n## Body\n");
    expect(r.text).toBe("---\ntags:\n  - a\n  - b\nstatus: done\ntopic: x\n---\n## Body\nHello\n");
  });
});
describe("fuzzy", () => {
  it("F1 letters in order, prefix beats fuzzy", () => {
    expect(fuzzyScore("dn", "Daily notes")).not.toBeNull();
    expect(fuzzyScore("xz", "Daily notes")).toBeNull();
    expect(fuzzyScore("dai", "Daily notes")!).toBeLessThan(fuzzyScore("dn", "Daily notes")!);
  });
});

import { sessionCookie } from "../src/worker/auth";
import { settings as built } from "../src/shared/settings";
describe("Access and cookies", () => {
  it("marks the session cookie Secure except on localhost and 127.0.0.1", () => {
    expect(sessionCookie(new Request("http://localhost:8787/api/auth/login"), "t", 60)).not.toContain("Secure");
    expect(sessionCookie(new Request("http://127.0.0.1:8787/api/auth/login"), "t", 60)).not.toContain("Secure");
    expect(sessionCookie(new Request("https://notes.example.com/api/auth/login"), "t", 60)).toContain("; Secure");
    expect(sessionCookie(new Request("http://192.168.1.5:8787/api/auth/login"), "t", 60)).toContain("; Secure");
  });
  it("defaults the access mode to only_me", () => { expect(built.access).toBe("only_me"); expect(built.cloudflareAccess).toBe(false); });
});
