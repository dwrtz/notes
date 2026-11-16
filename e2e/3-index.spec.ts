import { test, expect } from "@playwright/test";
import { login, open, editor, typeAtEnd, saved, cmd, noteText } from "./helpers";

test.describe.configure({ mode: "serial" });

async function search(page: import("@playwright/test").Page, q: string) {
  await page.getByRole("tab", { name: "Search" }).click();
  await page.getByRole("textbox", { name: "Search", exact: true }).fill(q);
}
const results = (page: import("@playwright/test").Page) => page.locator('[aria-label="Search results"] .result-title');

test("R11 search: words, phrases, OR, negation, path:, file:, tag:, line:, section:, task:, properties, regex", async ({ page }) => {
  await login(page);
  await search(page, "launch");
  await expect(results(page).filter({ hasText: "Launch plan" })).toBeVisible();
  await expect(results(page).filter({ hasText: "2026-11-13" })).toBeVisible();
  await search(page, '"public launch"');
  await expect(results(page)).toHaveCount(1);
  await search(page, "path:People");
  await expect(results(page)).toHaveCount(2);
  await search(page, "file:ana OR file:ben");
  await expect(results(page)).toHaveCount(2);
  await search(page, "tag:#idea");
  await expect(results(page).filter({ hasText: "Ideas" })).toBeVisible();
  await expect(results(page).filter({ hasText: "2026-11-14" })).toBeVisible();
  await search(page, "tag:#idea -path:Daily");
  await expect(results(page)).toHaveCount(1);
  await search(page, "line:(Ana launch)");
  await expect(results(page).filter({ hasText: "2026-11-13" })).toBeVisible();
  await search(page, "section:(Risks testing)");
  await expect(results(page)).toHaveCount(1);
  await search(page, "task-todo:announcement");
  await expect(results(page)).toHaveCount(1);
  await search(page, "[status:Active]");
  await expect(results(page)).toHaveCount(1);
  await search(page, "[role]");
  await expect(results(page)).toHaveCount(2);
  await search(page, "/Ok[a-z]+r/");
  await expect(results(page).filter({ hasText: "Ben Okafor" })).toBeVisible();
  await search(page, "tag:(");
  await expect(page.locator(".search-pane [role=alert]")).toBeVisible();
  // clicking a match opens the note at that line
  await search(page, '"offline mode"');
  await page.locator(".result-match").first().click();
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText("2026-11-14");
  // a search for a tag from the editor
  await search(page, "");
  await expect(page.locator(".recent")).toContainText('"offline mode"');
});

test("R10 tags pane shows nested tags with counts and opens a tag search", async ({ page }) => {
  await login(page);
  await page.getByRole("tab", { name: "Tags" }).click();
  const tags = page.locator(".tags-pane");
  await expect(tags.locator(".tag-row", { hasText: "#guide" }).locator(".tag-count")).toHaveText("2");
  await expect(tags.locator(".tag-row", { hasText: "#idea" }).first()).toBeVisible();
  await expect(tags.locator(".tag-row", { hasText: "#later" })).toBeVisible();
  await tags.getByRole("button", { name: "#guide" }).click();
  await expect(page.getByRole("textbox", { name: "Search", exact: true })).toHaveValue("tag:#guide");
  await expect(results(page)).toHaveCount(2);
  // typing a tag in a note adds it
  await open(page, "Reading list");
  await typeAtEnd(page, "\n#books/fiction ");
  await saved(page);
  await page.getByRole("tab", { name: "Tags" }).click();
  await expect(tags.locator(".tag-row", { hasText: "#books" })).toBeVisible();
});

test("R9 properties: edit values, add a property, change a type, list chips, all-properties pane", async ({ page }) => {
  await login(page);
  await open(page, "Ben Okafor");
  const props = page.locator(".tab-group.is-current .props");
  // The YAML block is hidden from the editor text from the moment the note opens, and typing starts in the body.
  await expect(props).toBeVisible();
  await expect(editor(page)).not.toContainText("role:");
  await expect(editor(page)).not.toContainText("---");
  await editor(page).focus();
  await page.keyboard.type("Hello ");
  await saved(page);
  expect(await noteText(page, "People/Ben Okafor.md")).toMatch(/\n---\nHello /);
  await expect(editor(page)).not.toContainText("role:");
  await page.keyboard.press("Control+z");
  await saved(page);
  await props.getByLabel("role").fill("Lead engineer");
  await props.getByLabel("role").press("Enter");
  await saved(page);
  await props.getByLabel("Add to aliases").fill("Benny");
  await props.getByLabel("Add to aliases").press("Enter");
  await saved(page);
  await page.keyboard.press("Control+;");
  await page.getByLabel("Property name").fill("rating");
  await page.getByLabel("Property name").press("Enter");
  await props.locator(".prop-key", { hasText: "rating" }).click();
  await page.getByRole("menuitem", { name: "Number" }).click();
  await expect(props.getByLabel("rating")).toHaveAttribute("type", "number");
  await props.getByLabel("rating").fill("4");
  await props.getByLabel("rating").press("Enter");
  await saved(page);
  await cmd(page, "Toggle live preview/source mode");
  await expect(editor(page)).toContainText("role: Lead engineer");
  await expect(editor(page)).toContainText("- Benny");
  await expect(editor(page)).toContainText("rating: 4");
  await cmd(page, "Toggle live preview/source mode");
  // switcher finds the new alias
  await page.keyboard.press("Control+o");
  await page.getByPlaceholder("Find or create a note…").fill("Benny");
  await expect(page.locator(".picker-item").first()).toContainText("Benny");
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "All properties" }).click();
  await expect(page.locator(".all-props")).toContainText("rating");
  await expect(page.locator(".all-props").locator("li", { hasText: "rating" })).toContainText("Number");
  // invalid YAML is reported, not overwritten
  await open(page, "Reading list");
  await cmd(page, "Toggle live preview/source mode");
  await editor(page).click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("bad: [unclosed\n");
  await cmd(page, "Toggle live preview/source mode");
  await expect(page.locator(".props.invalid")).toBeVisible();
  await cmd(page, "Toggle live preview/source mode");
  await page.keyboard.press("Control+z");
  await saved(page);
});

test("R12 quick switcher: fuzzy, aliases, recent files, create with Shift+Enter, open in new tab", async ({ page }) => {
  await login(page);
  await open(page, "Welcome");
  await open(page, "Ideas");
  await page.keyboard.press("Control+o");
  await expect(page.locator(".picker-item").first()).toContainText("Projects/Ideas");
  await expect(page.locator(".picker-item").nth(1)).toContainText("Welcome");
  await page.getByPlaceholder("Find or create a note…").fill("lnch pln");
  await expect(page.locator(".picker-item").first()).toContainText("Launch plan");
  await page.getByPlaceholder("Find or create a note…").fill("Ana");
  await expect(page.locator(".picker-item").first()).toContainText("Ana");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".tab")).toHaveCount(2);
  await page.keyboard.press("Control+o");
  await page.getByPlaceholder("Find or create a note…").fill("Weekly review");
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText("Weekly review");
});

test("R13 command palette runs commands, shows hotkeys; hotkeys can be changed and pinned", async ({ page }) => {
  await login(page);
  await page.keyboard.press("Control+p");
  await page.getByPlaceholder("Type a command…").fill("graph view open");
  await expect(page.locator(".picker-item").first()).toContainText("Ctrl+G");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText("Graph view");
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "Hotkeys", exact: true }).click();
  await page.getByLabel("Filter hotkeys").fill("random");
  await page.getByRole("button", { name: "Set hotkey for Open random note" }).click();
  await page.keyboard.press("Alt+r");
  await expect(page.locator(".hotkey-list kbd").first()).toContainText("Alt");
  await page.getByRole("button", { name: "Pin Open random note in the command palette" }).click();
  await expect(page.getByRole("button", { name: "Pin Open random note in the command palette" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+p");
  await expect(page.locator(".picker-item").first()).toContainText("Open random note");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+r");
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).not.toHaveText("Graph view");
});
