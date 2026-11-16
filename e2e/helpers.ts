import { expect, Page } from "@playwright/test";
export const DEMO = { email: "sam@example.com", password: "demo-pass-123" };
export async function login(page: Page, email = DEMO.email, password = DEMO.password) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".app")).toBeVisible();
}
export async function signup(page: Page, name: string, email: string, password = "password-123") {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.locator(".app")).toBeVisible();
}
/** Open a note with the quick switcher. */
export async function open(page: Page, name: string) {
  await page.keyboard.press("Control+o");
  await page.getByPlaceholder("Find or create a note…").fill(name);
  await page.keyboard.press("Enter");
  await expect(page.locator(".tab-group.is-current .tab.is-active .tab-title")).toHaveText(name.split("/").pop()!);
}
export const editor = (page: Page) => page.locator(".tab-group.is-current .cm-content").first();
export async function typeAtEnd(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}
/** Wait until the status bar says everything is saved. */
export async function saved(page: Page) { await expect(page.locator(".statusbar .sync")).toHaveText("Saved"); }
export async function cmd(page: Page, name: string) {
  await page.keyboard.press("Control+p");
  await page.getByPlaceholder("Type a command…").fill(name);
  await page.keyboard.press("Enter");
}
export async function api(page: Page, path: string, init: { method?: string; body?: unknown } = {}) {
  return page.evaluate(async ([path, init]) => {
    const r = await fetch(path, { method: (init as any).method || ((init as any).body ? "POST" : "GET"), headers: { "content-type": "application/json" }, body: (init as any).body ? JSON.stringify((init as any).body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, [path, init] as const);
}
export const tree = (page: Page, path: string) => page.locator(`.tree-row[data-path="${path}"]`);
/** A note's saved Markdown, read from the API. */
export async function noteText(page: Page, path: string): Promise<string> {
  const vid = (await api(page, "/api/vaults")).data[0].id;
  const f = (await api(page, `/api/vaults/${vid}/tree`)).data.files.find((x: any) => x.path === path);
  return (await api(page, `/api/vaults/${vid}/files/${f.id}`)).data.content;
}
