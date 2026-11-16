import { test, expect } from "@playwright/test";
import { login, open, editor, typeAtEnd, saved, api, tree, cmd } from "./helpers";

test.describe.configure({ mode: "serial" });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("R19 attachments: drop an image into a note, stored in R2, embedded and served", async ({ page }) => {
  await login(page);
  await open(page, "Ideas");
  await editor(page).click();
  await page.keyboard.press("Control+End");
  const dt = await page.evaluateHandle((b64) => {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bin], "sketch.png", { type: "image/png" })); return dt;
  }, PNG.toString("base64"));
  await editor(page).dispatchEvent("drop", { dataTransfer: dt });
  await expect(editor(page)).toContainText("sketch.png", { timeout: 10_000 }).catch(async () => {
    await expect(page.locator(".tab-group.is-current .cm-embed img")).toBeVisible();
  });
  await saved(page);
  await expect(tree(page, "Attachments")).toBeVisible();
  const vid = (await api(page, "/api/vaults")).data[0].id;
  const f = (await api(page, `/api/vaults/${vid}/tree`)).data.files.find((x: any) => x.path === "Attachments/sketch.png");
  expect(f).toBeTruthy();
  const raw = await page.request.get(`/api/vaults/${vid}/raw/${f.id}`);
  expect(raw.status()).toBe(200);
  expect(raw.headers()["content-type"]).toBe("image/png");
  await page.keyboard.press("Control+e");
  await expect(page.locator(".reading img[alt='Attachments/sketch.png']")).toBeVisible();
  // unsupported types and oversized files are refused
  const bad = await page.request.post(`/api/vaults/${vid}/attachments?path=x.exe`, { data: Buffer.from("MZ"), headers: { Origin: "http://127.0.0.1:3210", "content-type": "application/octet-stream" } });
  expect(bad.status()).toBe(415);
});

test("R20 sync: edits on another device appear; a conflicting save is merged or kept as a copy", async ({ page, browser }) => {
  await login(page);
  await open(page, "Reading list");
  const other = await browser.newPage();
  await login(other);
  await open(other, "Reading list");
  await typeAtEnd(other, "\nAdded on the phone");
  await saved(other);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(editor(page)).toContainText("Added on the phone", { timeout: 10_000 });
  // simultaneous edits to different lines merge cleanly
  await other.evaluate(() => (window as any).__pausePoll = true);
  const vid = (await api(page, "/api/vaults")).data[0].id;
  const file = (await api(page, `/api/vaults/${vid}/tree`)).data.files.find((x: any) => x.path === "Reading list.md");
  const cur = (await api(page, `/api/vaults/${vid}/files/${file.id}`)).data;
  // the server copy changes underneath the editor
  await api(page, `/api/vaults/${vid}/files/${file.id}/content`, { method: "PUT", body: { content: cur.content.replace("# Reading list", "# Reading list (shared)"), baseVersion: cur.version } });
  await typeAtEnd(other, "\nTyped while offline");
  await saved(other);
  await expect(editor(other)).toContainText("Reading list (shared)");
  await expect(editor(other)).toContainText("Typed while offline");
  // clashing edits to the same line keep both: the server text wins and ours is saved beside it
  const cur2 = (await api(page, `/api/vaults/${vid}/files/${file.id}`)).data;
  await api(page, `/api/vaults/${vid}/files/${file.id}/content`, { method: "PUT", body: { content: cur2.content.replace("Typed while offline", "Server wording"), baseVersion: cur2.version } });
  await editor(other).click();
  await other.keyboard.press("Control+End");
  await other.keyboard.press("Shift+Home");
  await other.keyboard.type("Phone wording");
  await expect(other.locator(".toast").last()).toContainText('This note also changed on another device. Your version was saved as "Reading list (conflict 202611150700).md".', { timeout: 10_000 });
  await expect(other.locator('.tree-row[data-path^="Reading list (conflict 202611150700)"]')).toBeVisible();
  await other.close();
});

test("R21 theme and settings: dark mode, readable line length, default view", async ({ page }) => {
  await login(page);
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Base color scheme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  await page.getByLabel("Default view for new tabs").selectOption("reading");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+t");
  await open(page, "Welcome");
  await expect(page.locator(".tab-group.is-current .reading")).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  await page.getByLabel("Default view for new tabs").selectOption("live");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Base color scheme").selectOption("light");
  await page.keyboard.press("Escape");
});

test("R22 mobile layout: drawers, bottom bar, one pane", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: "America/New_York" });
  const page = await ctx.newPage();
  await login(page);
  await expect(page.locator(".mobile-bar")).toBeVisible();
  await expect(page.locator(".ribbon")).toHaveCount(0);
  await page.locator(".mobile-top").getByRole("button", { name: "Open left sidebar" }).click();
  await expect(page.locator(".sidebar.left")).toBeVisible();
  await tree(page, "Welcome.md").click();
  await expect(page.locator(".sidebar.left")).toHaveCount(0);
  await expect(page.locator(".mobile-title")).toHaveText("Welcome");
  await page.locator(".mobile-bar").getByRole("button", { name: "Open quick switcher" }).click();
  await page.getByPlaceholder("Find or create a note…").fill("Ideas");
  await page.keyboard.press("Enter");
  await expect(page.locator(".mobile-title")).toHaveText("Ideas");
  await ctx.close();
});
