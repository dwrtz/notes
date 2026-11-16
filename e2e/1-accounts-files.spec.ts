import { test, expect } from "@playwright/test";
import { login, signup, tree, api, open, editor, saved } from "./helpers";

test.describe.configure({ mode: "serial" });

test("R2 sign up, starter vault, sign out, guarded pages, bad login, duplicate email", async ({ page }) => {
  await signup(page, "Kim Park", "kim@example.com");
  await expect(tree(page, "Welcome.md")).toBeVisible();
  await expect(page.locator(".vault-switch")).toContainText("My notes");
  await page.keyboard.press("Control+p");
  await page.getByPlaceholder("Type a command…").fill("sign out");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email", { exact: true }).fill("kim@example.com");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Email or password is wrong");
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Kim Again");
  await page.getByLabel("Email", { exact: true }).fill("KIM@example.com");
  await page.getByLabel("Password", { exact: true }).fill("password-123");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByText("That email already has an account")).toBeVisible();
});

test("R2 vaults: create, switch, rename, delete needs the name", async ({ page }) => {
  await login(page, "kim@example.com", "password-123");
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "Vaults", exact: true }).click();
  await page.getByLabel("Create a new vault").fill("Work");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".vault-switch")).toContainText("Work");
  await expect(page).toHaveURL(/vault=\d+/);
  await expect(page.locator(".tree-row")).toHaveCount(0);
  await page.locator(".vault-switch").click();
  await page.getByRole("menuitem", { name: "My notes" }).click();
  await expect(tree(page, "Welcome.md")).toBeVisible();
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "Vaults", exact: true }).click();
  page.once("dialog", d => d.dismiss());
  await page.locator(".vault-list li").filter({ has: page.locator('input[aria-label="Name of Work"]') }).getByRole("button", { name: "Delete" }).click();
  await page.getByLabel(/Type "Work" to confirm/).fill("work");
  await page.getByRole("button", { name: "Delete vault" }).click();
  await expect(page.getByText("Type the vault's name to delete it")).toBeVisible();
  await page.locator(".vault-list li").filter({ has: page.locator('input[aria-label="Name of Work"]') }).getByRole("button", { name: "Delete" }).click();
  await page.getByLabel(/Type "Work" to confirm/).fill("Work");
  await page.getByRole("button", { name: "Delete vault" }).click();
  await expect(page.locator('input[aria-label="Name of Work"]')).toHaveCount(0);
});

test("R3 explorer: new note, new folder, rename, drag to move, delete to trash and restore", async ({ page }) => {
  await login(page, "kim@example.com", "password-123");
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(tree(page, "Untitled.md")).toBeVisible();
  const title = page.locator(".view-title-input");
  await expect(title).toBeFocused();
  await title.fill("Groceries");
  await title.press("Enter");
  await expect(tree(page, "Groceries.md")).toBeVisible();
  await editor(page).click();
  await page.keyboard.type("Milk and bread");
  await saved(page);
  // second "Untitled" gets a free name
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(tree(page, "Untitled.md")).toBeVisible();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(tree(page, "Untitled 1.md")).toBeVisible();
  // invalid names are refused
  await page.locator(".view-title-input").fill("a/b");
  await page.locator(".view-title-input").press("Enter");
  await expect(page.locator(".toast").last()).toContainText("cannot contain");
  // folder
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Home");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(tree(page, "Home")).toBeVisible();
  // drag Groceries into Home
  await tree(page, "Groceries.md").dragTo(tree(page, "Home"));
  await expect(tree(page, "Home/Groceries.md")).toBeVisible();
  // context-menu rename via F2
  await tree(page, "Home/Groceries.md").click();
  await page.keyboard.press("F2");
  await page.getByRole("dialog").getByLabel("Name").fill("Shopping");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(tree(page, "Home/Shopping.md")).toBeVisible();
  await open(page, "Shopping");
  await expect(editor(page)).toContainText("Milk and bread");
  // duplicate name is refused
  await tree(page, "Untitled.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Rename/ }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Welcome");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".toast").last()).toContainText("already exists");
  // delete -> trash -> restore
  await tree(page, "Untitled 1.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(tree(page, "Untitled 1.md")).toHaveCount(0);
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await page.locator(".trash-list li").filter({ hasText: "Untitled 1.md" }).getByRole("button", { name: "Restore" }).click();
  await page.keyboard.press("Escape");
  await expect(tree(page, "Untitled 1.md")).toBeVisible();
  // deleting a folder takes its files
  await tree(page, "Home").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(tree(page, "Home")).toHaveCount(0);
  const t = await api(page, "/api/vaults");
  const v = t.data[0].id;
  const tr = await api(page, `/api/vaults/${v}/trash`);
  expect(tr.data.map((f: any) => f.path)).toEqual(expect.arrayContaining(["Home"]));
});

test("R23 API refuses other users' vaults, cross-site writes and bad input", async ({ page, request }) => {
  await login(page, "kim@example.com", "password-123");
  const mine = (await api(page, "/api/vaults")).data[0].id;
  const other = mine === 1 ? 2 : 1;
  expect((await api(page, `/api/vaults/1/tree`)).status).toBe(mine === 1 ? 200 : 404);
  expect((await api(page, `/api/vaults/${mine}/notes`, { body: { path: "../x.md" } })).status).toBe(400);
  expect((await api(page, `/api/vaults/${mine}/notes`, { body: { path: "Welcome.md" } })).status).toBe(409);
  const cross = await request.post(`/api/vaults/${mine}/notes`, { data: { path: "x.md" }, headers: { Origin: "https://evil.example" } });
  expect([401, 403]).toContain(cross.status());
  const anon = await request.get(`/api/vaults/${other}/tree`);
  expect(anon.status()).toBe(401);
});
