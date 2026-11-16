// Date formatting with the familiar YYYY-MM-DD style tokens, used by daily notes and templates.
// Tokens: YYYY YY MMMM MMM MM M DD D Do dddd ddd dd d HH H hh h mm m ss s A a, [literal].
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number } // mo 1-12
const TOKEN = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|A|a/g;
const p2 = (n: number) => String(n).padStart(2, "0");
function weekday(p: Parts) { return new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay(); }
function ord(n: number) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
export function formatDate(p: Parts, fmt: string): string {
  return fmt.replace(TOKEN, (t, lit) => {
    if (lit !== undefined) return lit;
    const h12 = p.h % 12 || 12;
    switch (t) {
      case "YYYY": return String(p.y).padStart(4, "0"); case "YY": return p2(p.y % 100);
      case "MMMM": return MONTHS[p.mo - 1]; case "MMM": return MONTHS[p.mo - 1].slice(0, 3);
      case "MM": return p2(p.mo); case "M": return String(p.mo);
      case "Do": return ord(p.d); case "DD": return p2(p.d); case "D": return String(p.d);
      case "dddd": return DAYS[weekday(p)]; case "ddd": return DAYS[weekday(p)].slice(0, 3); case "dd": return DAYS[weekday(p)].slice(0, 2); case "d": return String(weekday(p));
      case "HH": return p2(p.h); case "H": return String(p.h); case "hh": return p2(h12); case "h": return String(h12);
      case "mm": return p2(p.mi); case "m": return String(p.mi); case "ss": return p2(p.s); case "s": return String(p.s);
      case "A": return p.h < 12 ? "AM" : "PM"; case "a": return p.h < 12 ? "am" : "pm";
    }
    return t;
  });
}
/** Parse a string written with `fmt` back into a date (date tokens only). Null when it does not fit. */
export function parseDate(s: string, fmt: string): Parts | null {
  const groups: string[] = [];
  let re = "^";
  let last = 0; TOKEN.lastIndex = 0; let m: RegExpExecArray | null;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  while ((m = TOKEN.exec(fmt))) {
    re += esc(fmt.slice(last, m.index)); last = m.index + m[0].length;
    if (m[1] !== undefined) { re += esc(m[1]); continue; }
    const t = m[0];
    const pat: Record<string, string> = { YYYY: "(\\d{4})", YY: "(\\d{2})", MMMM: `(${MONTHS.join("|")})`, MMM: `(${MONTHS.map(x => x.slice(0, 3)).join("|")})`, MM: "(\\d{2})", M: "(\\d{1,2})", DD: "(\\d{2})", D: "(\\d{1,2})", Do: "(\\d{1,2})(?:st|nd|rd|th)", dddd: `(?:${DAYS.join("|")})`, ddd: `(?:${DAYS.map(x => x.slice(0, 3)).join("|")})`, dd: "(?:Su|Mo|Tu|We|Th|Fr|Sa)", d: "(?:\\d)", HH: "(?:\\d{2})", H: "(?:\\d{1,2})", hh: "(?:\\d{2})", h: "(?:\\d{1,2})", mm: "(?:\\d{2})", m: "(?:\\d{1,2})", ss: "(?:\\d{2})", s: "(?:\\d{1,2})", A: "(?:AM|PM)", a: "(?:am|pm)" };
    re += pat[t]; if (pat[t].startsWith("(") && !pat[t].startsWith("(?:")) groups.push(t);
  }
  re += esc(fmt.slice(last)) + "$";
  const mm = new RegExp(re, "i").exec(s); if (!mm) return null;
  const out: Parts = { y: 1970, mo: 1, d: 1, h: 0, mi: 0, s: 0 };
  groups.forEach((t, i) => {
    const v = mm[i + 1];
    if (t === "YYYY") out.y = +v; else if (t === "YY") out.y = 2000 + +v;
    else if (t === "MMMM") out.mo = MONTHS.findIndex(x => x.toLowerCase() === v.toLowerCase()) + 1;
    else if (t === "MMM") out.mo = MONTHS.findIndex(x => x.slice(0, 3).toLowerCase() === v.toLowerCase()) + 1;
    else if (t === "MM" || t === "M") out.mo = +v; else out.d = +v;
  });
  const chk = new Date(Date.UTC(out.y, out.mo - 1, out.d));
  if (chk.getUTCMonth() !== out.mo - 1 || chk.getUTCDate() !== out.d) return null;
  return out;
}
/** Wall-clock parts of an instant in a time zone. */
export function partsInZone(iso: string, zone: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const o: Record<string, string> = {}; for (const x of f.formatToParts(new Date(iso))) o[x.type] = x.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
export function addDays(p: Parts, n: number): Parts { const d = new Date(Date.UTC(p.y, p.mo - 1, p.d + n)); return { ...p, y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() }; }
export function dayKey(p: Parts) { return `${String(p.y).padStart(4, "0")}-${p2(p.mo)}-${p2(p.d)}`; }
