// Demo data (when seed_demo is on and the database is empty) and the starter note for new vaults.
import { hashPassword } from "./auth";
import { Vault } from "./vault";

let checked = false;

export const DEMO = { email: "sam@example.com", password: "demo-pass-123", name: "Sam Lee", vault: "Demo vault" };

const ROADMAP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="260" viewBox="0 0 640 260">
<rect width="640" height="260" rx="16" fill="#f4f1ff"/>
<text x="32" y="48" font-family="sans-serif" font-size="22" font-weight="700" fill="#2e2a47">Roadmap</text>
<g font-family="sans-serif" font-size="14" fill="#2e2a47">
<rect x="32" y="80" width="170" height="56" rx="10" fill="#c9bcff"/><text x="48" y="114">Research</text>
<rect x="232" y="80" width="170" height="56" rx="10" fill="#a8e6cf"/><text x="248" y="114">Build</text>
<rect x="432" y="80" width="176" height="56" rx="10" fill="#ffd3a5"/><text x="448" y="114">Launch</text>
<path d="M202 108h30M402 108h30" stroke="#2e2a47" stroke-width="3"/>
<text x="32" y="196">December: private beta</text><text x="32" y="222">January: public launch</text></g></svg>`;

const NOTES: [string, string][] = [
  ["Welcome.md", `# Welcome

This is a demo vault. Every note is a plain Markdown file, and notes link to each other with double brackets.

- Start with [[Getting started]].
- See how a project is planned in [[Projects/Launch plan|the launch plan]].
- People live in their own folder, like [[People/Ana Ruiz|Ana]].

Open the graph to see how everything connects. #demo
`],
  ["Getting started.md", `---
tags:
  - guide
---
# Getting started

## Make a note
Press the new note button, or open the quick switcher and type a name that does not exist yet.

## Link notes
Type two opening brackets to link to another note. Read [[Linking basics#Headings]] for links to a heading.

## The one tip to remember
![[Linking basics#^tip]]

## Find things
Search the whole vault, or filter by tag with tag:#guide.
`],
  ["Linking basics.md", `---
aliases:
  - Links 101
tags:
  - guide
---
# Linking basics

A link points at a note by its name. If two notes share a name, the link includes the folder.

Links that point at notes that do not exist yet still work: clicking one creates the note. ^tip

## Headings
Add a hash after the name to point at a heading, like [[Getting started#Find things]].

## Blocks
Add a caret and an id to point at a single paragraph.
`],
  ["Projects/Launch plan.md", `---
status: Active
due: 2026-12-01
owner: "[[People/Ana Ruiz]]"
tags:
  - project
---
# Launch plan

The plan for the public launch. Ana owns it and [[People/Ben Okafor|Ben]] helps with the site.

![[Attachments/Roadmap.svg]]

## Tasks
- [x] Pick a launch date
- [ ] Write the announcement
- [ ] Book the [[Meeting notes|review meeting]]

## Risks
Not enough time for testing. See [[Ideas]] for things we cut. #risk
`],
  ["Projects/Ideas.md", `# Ideas

Things we may do after the Launch plan is done. #idea

- A weekly digest by email #idea/later
- Shared vaults for teams
- Better mobile layout
`],
  ["People/Ana Ruiz.md", `---
aliases:
  - Ana
role: Product lead
tags:
  - person
---
# Ana Ruiz

Leads the product. Talk to Ana about scope and dates.
`],
  ["People/Ben Okafor.md", `---
aliases:
  - Ben
role: Engineer
tags:
  - person
---
# Ben Okafor

Builds the website. Works with [[Ana Ruiz]] on the [[Launch plan]].
`],
  ["Daily/2026-11-13.md", `# Friday 13 November

- Kick-off with Ana about the launch.
- Read [[Linking basics]].
`],
  ["Daily/2026-11-14.md", `# Saturday 14 November

- Drafted the [[Launch plan]].
- New idea for the [[Ideas|ideas list]]: offline mode. #idea
`],
  ["Reading list.md", `---
tags:
  - reading
---
# Reading list

- [ ] How to take smart notes
- [x] A book about writing well
- [ ] Anything Ben recommends
`],
  ["Templates/Daily template.md", `# {{date:dddd D MMMM}}

## Plan
- [ ] 

## Log
`],
  ["Templates/Meeting.md", `---
tags:
  - meeting
attendees: []
---
# {{title}}

Date: {{date}} {{time}}

## Notes

## Actions
- [ ] 
`],
];

export async function seedDemo(env: Env, now: string) {
  if (checked) return;
  const any = await env.DB.prepare("SELECT 1 FROM users LIMIT 1").first();
  if (any) { checked = true; return; }
  const res = await env.DB.prepare("INSERT OR IGNORE INTO users (email,name,password_hash,created_at,role) VALUES (?,?,?,?,'demo')").bind(DEMO.email, DEMO.name, await hashPassword(DEMO.password), now).run();
  checked = true;
  if (!res.meta.changes) return; // another request is seeding
  const u = (await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(DEMO.email).first<{ id: number }>())!;
  const settings = { dailyFolder: "Daily", dailyTemplate: "Templates/Daily template.md", templatesFolder: "Templates" };
  await env.DB.prepare("INSERT INTO vaults (user_id,name,settings,created_at) VALUES (?,?,?,?)").bind(u.id, DEMO.vault, JSON.stringify(settings), now).run();
  const vid = (await env.DB.prepare("SELECT id FROM vaults WHERE user_id=?").bind(u.id).first<{ id: number }>())!.id;
  // Spread creation times over the past days so the graph's time-lapse has an order.
  let t = Date.parse(now) - NOTES.length * 3600_000;
  const v = new Vault(env, vid, () => new Date(t).toISOString());
  await v.createFolder("Attachments");
  await v.uploadAttachment("Attachments/Roadmap.svg", new TextEncoder().encode(ROADMAP_SVG).buffer as ArrayBuffer);
  for (const [path, content] of NOTES) { t += 3600_000; await v.createNote(path, content); }
  const db = env.DB;
  await db.batch([
    db.prepare("INSERT INTO bookmarks (vault_id,parent_id,position,type,path) VALUES (?,NULL,1,'file','Welcome.md')").bind(vid),
    db.prepare("INSERT INTO bookmarks (vault_id,parent_id,position,type,title,query) VALUES (?,NULL,2,'search','Open projects','tag:#project')").bind(vid),
    db.prepare("INSERT INTO bookmarks (vault_id,parent_id,position,type,title) VALUES (?,NULL,3,'group','People')").bind(vid),
  ]);
  const g = (await db.prepare("SELECT id FROM bookmarks WHERE vault_id=? AND type='group'").bind(vid).first<{ id: number }>())!.id;
  await db.prepare("INSERT INTO bookmarks (vault_id,parent_id,position,type,path) VALUES (?,?,4,'file','People/Ana Ruiz.md')").bind(vid, g).run();
}

export async function starterNotes(v: Vault) {
  await v.createNote("Welcome.md", `# Welcome

This vault is yours. Write in Markdown, link notes with [[double brackets]], and add #tags.

Press Ctrl+O (Cmd+O on a Mac) to jump to a note, or Ctrl+P (Cmd+P) to see every command.
`);
}
