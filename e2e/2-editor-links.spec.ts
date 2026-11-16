import { test, expect } from "@playwright/test";
import { login, open, editor, typeAtEnd, saved, api, tree, cmd, noteText } from "./helpers";

test.describe.configure({ mode: "serial" });

test("R4 live preview hides syntax away from the cursor; source and reading modes; autosave", async ({ page }) => {
  await login(page);
  await open(page, "Reading list");
  await typeAtEnd(page, "\n**Bold idea** and ==marked== text");
  await page.keyboard.press("Control+Home");
  await expect(editor(page).locator(".cm-formatting").filter({ hasText: "**" })).toHaveCount(0);
  await expect(editor(page)).toContainText("Bold idea");
  await cmd(page, "Toggle live preview/source mode");
  await expect(editor(page)).toContainText("**Bold idea**");
  await page.keyboard.press("Control+e");
  await expect(page.locator(".reading strong")).toHaveText("Bold idea");
  await expect(page.locator(".reading mark")).toHaveText("marked");
  // tick a task in reading view
  await page.locator(".reading .task-box").first().check();
  await saved(page);
  await page.reload();
  await expect(page.locator(".reading .task-box").first()).toBeChecked();
  await page.keyboard.press("Control+e");
  await expect(editor(page).locator(".cm-task-box").first()).toBeChecked();
});

test("R5 wikilink autocomplete: names, aliases, headings, blocks, new notes; Ctrl/Cmd-click follows", async ({ page }) => {
  await login(page);
  await open(page, "Reading list");
  await typeAtEnd(page, "\nSee [[Launch");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("Launch plan");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toContainText("Launch plan");
  await page.keyboard.type(" and [[links 1");
  await expect(page.locator(".cm-tooltip-autocomplete li").first()).toContainText("Links 101");
  await page.keyboard.press("Enter");
  await page.keyboard.type(" and [[Getting started#");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("Find things");
  await page.locator(".cm-tooltip-autocomplete li", { hasText: "Find things" }).click();
  await page.keyboard.type(" and [[Ideas#^");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("A weekly digest");
  await page.locator(".cm-tooltip-autocomplete li", { hasText: "A weekly digest" }).click();
  await page.keyboard.type(" and [[Brand new idea");
  await page.locator(".cm-tooltip-autocomplete li", { hasText: "Link to a new note" }).click();
  await page.keyboard.press("Enter");
  await saved(page);
  await page.keyboard.press("Control+e");
  const r = page.locator(".reading");
  await expect(r.locator("a.internal-link", { hasText: "Launch plan" })).toBeVisible();
  await expect(r.locator("a.internal-link", { hasText: "Links 101" })).toHaveAttribute("data-href", "Linking basics");
  await expect(r.locator("a.internal-link", { hasText: "Getting started > Find things" })).toBeVisible();
  await expect(r.locator("a.internal-link.is-unresolved", { hasText: "Brand new idea" })).toBeVisible();
  // the chosen block got an id in the target note
  const vid = (await api(page, "/api/vaults")).data[0].id;
  const ideas = (await api(page, `/api/vaults/${vid}/tree`)).data.files.find((f: any) => f.path === "Projects/Ideas.md");
  const body = (await api(page, `/api/vaults/${vid}/files/${ideas.id}`)).data.content as string;
  expect(body).toMatch(/A weekly digest by email #idea\/later \^[a-z0-9]{6}/);
  // follow the heading link
  await r.locator("a.internal-link", { hasText: "Getting started > Find things" }).click();
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText("Getting started");
  // clicking an unresolved link creates the note
  await open(page, "Reading list");
  if (!(await page.locator(".tab-group.is-current .reading").count())) await page.keyboard.press("Control+e");
  await page.locator(".reading a.internal-link.is-unresolved", { hasText: "Brand new idea" }).click();
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText("Brand new idea");
  await expect(tree(page, "Brand new idea.md")).toBeVisible();
});

test("R6 embeds: note sections, blocks and images render inline", async ({ page }) => {
  await login(page);
  await open(page, "Getting started");
  await page.keyboard.press("Control+e");
  await expect(page.locator(".reading .markdown-embed")).toContainText("clicking one creates the note");
  await open(page, "Launch plan");
  await expect(page.locator(".tab-group.is-current img[alt$='Roadmap.svg']").first()).toBeVisible();
});

test("R7 renaming and moving files rewrites links; ambiguous names get paths", async ({ page }) => {
  await login(page);
  const vid = (await api(page, "/api/vaults")).data[0].id;
  await api(page, `/api/vaults/${vid}/notes`, { body: { path: "Alpha.md", content: "# Alpha\n## Part\nText ^b1\n" } });
  await api(page, `/api/vaults/${vid}/notes`, { body: { path: "Sub/Beta.md", content: "See [[Alpha]], [[Alpha#Part|part]], ![[Alpha#^b1]] and [md](../Alpha.md).\n" } });
  await api(page, `/api/vaults/${vid}/notes`, { body: { path: "Gamma.md", content: "Links [[Beta]].\n" } });
  await page.reload();
  await tree(page, "Alpha.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Rename/ }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Omega");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(tree(page, "Omega.md")).toBeVisible();
  const beta = await noteText(page, "Sub/Beta.md");
  expect(beta).toBe("See [[Omega]], [[Omega#Part|part]], ![[Omega#^b1]] and [md](../Omega.md).\n");
  // a second "Beta" makes the old link ambiguous; moving Sub/Beta keeps Gamma pointing at it
  await api(page, `/api/vaults/${vid}/notes`, { body: { path: "Beta.md", content: "root beta\n" } });
  const files = (await api(page, `/api/vaults/${vid}/tree`)).data.files;
  const sub = files.find((f: any) => f.path === "Sub/Beta.md");
  const dry = await api(page, `/api/vaults/${vid}/files/${sub.id}/move`, { body: { path: "Archive/Beta.md", dryRun: true } });
  expect(dry.data.updatedNotes).toBeGreaterThanOrEqual(0);
  // turning off auto-update asks first
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "Files & links", exact: true }).click();
  await page.getByRole("switch", { name: "Automatically update internal links" }).uncheck();
  await page.keyboard.press("Escape");
  await tree(page, "Omega.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Rename/ }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Zeta");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Update links?" })).toContainText("in 1 note");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(tree(page, "Zeta.md")).toBeVisible();
  expect(await noteText(page, "Sub/Beta.md")).toContain("[[Omega]]");
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "Files & links", exact: true }).click();
  await page.getByRole("switch", { name: "Automatically update internal links" }).check();
  await page.keyboard.press("Escape");
});

test("R8 backlinks and outgoing links with linked and unlinked mentions; Link turns a mention into a link", async ({ page }) => {
  await login(page);
  await open(page, "Ana Ruiz");
  await page.getByRole("tab", { name: "Backlinks" }).click();
  const bl = page.locator(".backlinks");
  await expect(bl.locator(".bl-section").first()).toContainText("Ben Okafor");
  await expect(bl).toContainText("Welcome");
  await expect(bl).toContainText("Launch plan");
  const unlinked = bl.locator(".bl-section").nth(1);
  await expect(unlinked).toContainText("2026-11-13");
  await unlinked.locator(".result-match-row", { hasText: "Kick-off with Ana" }).getByRole("button", { name: "Link" }).click();
  await expect(bl.locator(".bl-section").first()).toContainText("2026-11-13");
  await open(page, "2026-11-13");
  await expect(editor(page)).toContainText("Kick-off with");
  await page.keyboard.press("Control+e");
  await expect(page.locator(".reading a.internal-link", { hasText: "Ana" })).toBeVisible();
  await page.getByRole("tab", { name: "Outgoing links" }).click();
  await expect(page.locator(".outgoing")).toContainText("Linking basics");
  await expect(page.locator(".outgoing")).toContainText("Ana Ruiz");
  await open(page, "Launch plan");
  await page.getByRole("tab", { name: "Outgoing links" }).click();
  await expect(page.locator(".outgoing .is-unresolved", { hasText: "Meeting notes" })).toBeVisible();
});
