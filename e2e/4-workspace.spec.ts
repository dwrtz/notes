import { test, expect } from "@playwright/test";
import { login, open, editor, saved, cmd, tree, api, noteText } from "./helpers";

test.describe.configure({ mode: "serial" });

test("R14 graph: global graph with filters, local graph with depth", async ({ page }) => {
  await login(page);
  await page.keyboard.press("Control+g");
  const canvas = page.locator(".tab-group.is-current .graph-canvas");
  await expect(canvas).toBeVisible();
  const n0 = Number(await canvas.getAttribute("data-nodes"));
  expect(n0).toBeGreaterThan(8);
  await page.getByRole("button", { name: "Graph settings" }).click();
  await page.getByRole("switch", { name: "Tags" }).check();
  await expect.poll(async () => Number(await canvas.getAttribute("data-nodes"))).toBeGreaterThan(n0);
  await page.getByRole("switch", { name: "Tags" }).uncheck();
  await page.getByRole("switch", { name: "Existing files only" }).check();
  await expect.poll(async () => Number(await canvas.getAttribute("data-nodes"))).toBeLessThan(n0);
  await page.getByRole("switch", { name: "Orphans" }).uncheck();
  await page.getByLabel("Search files").fill("path:People");
  await expect.poll(async () => Number(await canvas.getAttribute("data-nodes"))).toBe(2);
  await page.getByRole("button", { name: "Restore defaults" }).click();
  await expect.poll(async () => Number(await canvas.getAttribute("data-nodes"))).toBe(n0);
  // the accessible node list opens notes
  await page.locator(".tab-group.is-current [aria-label='Notes in the graph'] button", { hasText: "Linking basics" }).dispatchEvent("click");
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText("Linking basics");
  await page.getByRole("tab", { name: "Local graph" }).click();
  const local = page.locator(".sidebar.right .graph-canvas");
  await expect(local).toBeVisible();
  const d1 = Number(await local.getAttribute("data-nodes"));
  await page.locator(".sidebar.right").getByRole("button", { name: "Graph settings" }).click();
  await page.locator(".sidebar.right").getByLabel("Depth").fill("2");
  await expect.poll(async () => Number(await local.getAttribute("data-nodes"))).toBeGreaterThan(d1);
});

test("R15 daily notes: today from the template, previous/next, settings", async ({ page }) => {
  await login(page);
  await cmd(page, "Open today's daily note");
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText("2026-11-15");
  await expect(page.locator(".tab-group.is-current .crumb-folder")).toContainText("Daily");
  await expect(editor(page)).toContainText("Sunday 15 November");
  await expect(editor(page)).toContainText("Plan");
  await cmd(page, "Open previous daily note");
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText("2026-11-14");
  await cmd(page, "Open next daily note");
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText("2026-11-15");
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "Daily notes", exact: true }).click();
  await page.getByLabel("Date format").fill("YYYY/MMMM/Do");
  await page.getByLabel("Date format").press("Enter");
  await expect(page.getByTestId("daily-sample")).toHaveText("2026/November/16th");
  await page.getByLabel("Date format").fill("YYYY-MM-DD");
  await page.getByLabel("Date format").press("Enter");
  await page.keyboard.press("Escape");
});

test("R16 templates: insert with variables and merged properties; insert date", async ({ page }) => {
  await login(page);
  await page.keyboard.press("Control+o");
  await page.getByPlaceholder("Find or create a note…").fill("Kickoff");
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText("Kickoff");
  await editor(page).click();
  await cmd(page, "Templates: Insert template");
  await page.getByPlaceholder("Choose a template…").fill("Meeting");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toContainText("Date: 2026-11-15 07:00");
  await saved(page);
  const t = await noteText(page, "Kickoff.md");
  expect(t).toContain("# Kickoff");
  expect(t).toContain("Date: 2026-11-15 07:00");
  expect(t).toMatch(/tags:\n\s+- meeting/);
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await cmd(page, "Templates: Insert current date");
  await expect.poll(() => noteText(page, "Kickoff.md")).toMatch(/2026-11-15\s*$/);
});

test("R17 tabs, splits, history, pinning and tab shortcuts", async ({ page }) => {
  await login(page);
  await open(page, "Welcome");
  await page.keyboard.press("Control+t");
  await expect(page.locator(".tab")).toHaveCount(2);
  await open(page, "Ideas");
  await page.keyboard.press("Control+1");
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText("Welcome");
  await cmd(page, "Go to next tab");
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText("Ideas");
  // history
  await open(page, "Linking basics");
  await page.getByRole("button", { name: "Navigate back" }).first().click();
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText("Ideas");
  // split right and open in the other pane
  await cmd(page, "Split right");
  await expect(page.locator(".tab-group")).toHaveCount(2);
  await open(page, "Ana Ruiz");
  await expect(page.locator(".tab-group").nth(1).locator(".tab.is-active .tab-title")).toHaveText("Ana Ruiz");
  // pin
  const cur = page.locator(".tab-group.is-current .tab.is-active");
  await cur.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await expect(page.locator(".tab-group").nth(1).locator(".tab.is-active .tab-close")).toHaveCount(0);
  await open(page, "Welcome");
  await expect(page.locator(".tab-group").nth(1).locator(".tab")).toHaveCount(2);
  // close the group's tabs
  await page.keyboard.press("Control+w");
  await page.locator(".tab-group").nth(1).locator(".tab").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin" }).click();
  await page.keyboard.press("Control+w");
  await expect(page.locator(".tab-group")).toHaveCount(1);
  // layout persists
  await page.reload();
  await expect(page.locator(".tab")).toHaveCount(2);
});

test("R18 bookmarks: files, searches, groups; bookmark the current note", async ({ page }) => {
  await login(page);
  await page.getByRole("tab", { name: "Bookmarks" }).click();
  const bm = page.locator(".bookmarks");
  await expect(bm).toContainText("Welcome");
  await expect(bm).toContainText("Open projects");
  await expect(bm).toContainText("People");
  await bm.getByText("Open projects").click();
  await expect(page.getByRole("textbox", { name: "Search", exact: true })).toHaveValue("tag:#project");
  await page.getByRole("tab", { name: "Bookmarks" }).click();
  await open(page, "Reading list");
  await page.keyboard.press("Control+d");
  await expect(bm).toContainText("Reading list");
  await bm.getByText("Ana Ruiz").click();
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText("Ana Ruiz");
  await bm.locator("[data-bookmark]", { hasText: "Reading list" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Remove/ }).click();
  await expect(bm).not.toContainText("Reading list");
  // bookmarks follow renames
  const vid = (await api(page, "/api/vaults")).data[0].id;
  const ana = (await api(page, `/api/vaults/${vid}/tree`)).data.files.find((f: any) => f.path === "People/Ana Ruiz.md");
  await api(page, `/api/vaults/${vid}/files/${ana.id}/move`, { body: { path: "People/Ana R.md" } });
  const list = (await api(page, `/api/vaults/${vid}/bookmarks`)).data;
  expect(list.map((b: any) => b.path)).toContain("People/Ana R.md");
});
