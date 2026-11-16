import { test, expect, BrowserContext, Page } from "@playwright/test";
import { api, login, signup, DEMO } from "./helpers";

// Runs first, on the fresh database: the first account must become the owner.
// The e2e server runs with ALLOW_SIGNUP=1 for the other tests; here the test_access /
// test_allow_signup cookies (honoured only when TEST_CLOCK=1) pick the mode per request.
const BASE = "http://127.0.0.1:3210";
async function mode(ctx: BrowserContext, access: string, allow = "auto") {
  await ctx.addCookies([{ name: "test_access", value: access, url: BASE }, { name: "test_allow_signup", value: allow, url: BASE }]);
}
async function signupApi(page: Page, body: Record<string, unknown>) {
  return api(page, "/api/auth/signup", { body: { name: "Someone", password: "password-123", ...body } });
}
async function openPeople(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "People" }).click();
}

test("R24 only me: the first account becomes the owner, then sign-up closes", async ({ page, context }) => {
  await mode(context, "only_me");
  await page.goto("/login");
  expect((await api(page, "/api/config")).data).toEqual({ access: "only_me", signup: "open", firstAccount: true }); // the demo account is not an owner
  await page.goto("/signup");
  await expect(page.getByText("This is the first account. It becomes the owner of this site.")).toBeVisible();
  await signup(page, "Olive Owner", "owner@example.com");
  expect((await api(page, "/api/me")).data.role).toBe("owner");
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "About" }).click();
  await expect(page.getByTestId("access-mode")).toHaveText("Only me — sign-up closes after the first account");
  await expect(page.getByTestId("signup-state")).toHaveText("Nobody — sign-up is closed");
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "People" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await api(page, "/api/auth/logout", { method: "POST" });
  // Closed for everyone else: the page says so, the login page has no sign-up link, the API refuses.
  await page.goto("/signup");
  await expect(page.getByRole("status")).toHaveText("Sign-up is closed on this site.");
  await expect(page.getByRole("button", { name: "Create account" })).toHaveCount(0);
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create an account" })).toHaveCount(0);
  const r = await signupApi(page, { email: "second@example.com" });
  expect(r.status).toBe(403); expect(r.data.error).toBe("Sign-up is closed on this site");
  // Existing accounts still sign in.
  await login(page, "owner@example.com", "password-123");
  await api(page, "/api/auth/logout", { method: "POST" });
  await login(page, DEMO.email, DEMO.password);
});

test("R24 invite only: the owner invites by email; links work once, for that email, for 7 days", async ({ page, context, browser }) => {
  await mode(context, "invite_only");
  await login(page, "owner@example.com", "password-123");
  // Without an invite nobody can sign up.
  const noInvite = await signupApi(page, { email: "walkin@example.com" });
  expect(noInvite.status).toBe(403); expect(noInvite.data.error).toBe("You need an invite to create an account here");
  await openPeople(page);
  await expect(page.getByText("This site is invite-only.")).toBeVisible();
  await page.getByLabel("Email to invite").fill("Friend@Example.com");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const link = (await page.locator(".invite-link").textContent())!;
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:3210\/signup\?invite=[a-f0-9]{64}$/);
  await expect(page.getByRole("list", { name: "Pending invites" })).toContainText("friend@example.com");
  await expect(page.getByRole("list", { name: "Pending invites" })).toContainText("expires Nov 22, 2026");
  // A second invite to be revoked.
  await page.getByLabel("Email to invite").fill("later@example.com");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const revoked = (await page.locator(".invite-link").textContent())!;
  await page.getByRole("list", { name: "Pending invites" }).locator("li", { hasText: "later@example.com" }).getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("list", { name: "Pending invites" })).not.toContainText("later@example.com");

  // The invited person, on another device.
  const other = await browser.newContext({ timezoneId: "America/New_York" }); await mode(other, "invite_only");
  const p2 = await other.newPage();
  await p2.goto(link);
  await expect(p2.getByText("You were invited as friend@example.com.")).toBeVisible();
  await expect(p2.getByLabel("Email", { exact: true })).toHaveValue("friend@example.com");
  await expect(p2.getByLabel("Email", { exact: true })).toHaveAttribute("readonly", "");
  // The API also insists on the invited email.
  const wrong = await signupApi(p2, { email: "someone-else@example.com", invite: link.split("=")[1] });
  expect(wrong.status).toBe(400); expect(wrong.data.fields.email).toBe("Use the email address the invite was sent to");
  await p2.getByLabel("Name", { exact: true }).fill("Fran Friend");
  await p2.getByLabel("Password", { exact: true }).fill("password-123");
  await p2.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(p2.locator(".app")).toBeVisible();
  expect((await api(p2, "/api/me")).data.role).toBe("member");
  // Members cannot manage people.
  expect((await api(p2, "/api/people")).status).toBe(403);
  expect((await api(p2, "/api/invites", { body: { email: "x@example.com" } })).status).toBe(403);
  await api(p2, "/api/auth/logout", { method: "POST" });
  // Used and revoked links no longer work.
  for (const l of [link, revoked]) {
    await p2.goto(l);
    await expect(p2.getByRole("status")).toHaveText("This invite link is not valid or has expired. Ask the owner for a new one.");
  }
  // Links expire after 7 days.
  const r = await api(page, "/api/invites", { body: { email: "slow@example.com" } });
  expect(r.status).toBe(201);
  await other.addCookies([{ name: "test_now", value: encodeURIComponent("2026-11-22T12:00:01.000Z"), url: BASE }]);
  await p2.goto(r.data.link);
  await expect(p2.getByRole("status")).toHaveText("This invite link is not valid or has expired. Ask the owner for a new one.");

  // The owner removes access: the member is signed out and cannot sign in again.
  await page.keyboard.press("Escape"); await openPeople(page);
  const row = page.getByRole("list", { name: "People" }).locator("li", { hasText: "friend@example.com" });
  await expect(row).toContainText("Member");
  await row.getByRole("button", { name: "Remove access" }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Remove access" }).click();
  await expect(row).toContainText("No access");
  await other.clearCookies(); await mode(other, "invite_only");
  await p2.goto("/login");
  await p2.getByLabel("Email", { exact: true }).fill("friend@example.com");
  await p2.getByLabel("Password", { exact: true }).fill("password-123");
  await p2.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(p2.getByRole("alert")).toHaveText("This account no longer has access to this site");
  await row.getByRole("button", { name: "Give access back" }).click();
  await expect(row).toContainText("Member");
  await other.close();
});

test("R24 open sign-up, and the ALLOW_SIGNUP override", async ({ page, context }) => {
  await mode(context, "open");
  await page.goto("/login");
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await signup(page, "Opal Open", "opal@example.com");
  expect((await api(page, "/api/me")).data.role).toBe("member");
  await api(page, "/api/auth/logout", { method: "POST" });
  // "0" closes sign-up in every mode, invites included.
  await mode(context, "open", "0");
  expect((await signupApi(page, { email: "nope@example.com" })).status).toBe(403);
  await mode(context, "invite_only", "0");
  expect((await api(page, "/api/config")).data.signup).toBe("closed");
  // "1" opens it in every mode.
  await mode(context, "only_me", "1");
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "Create an account" })).toBeVisible();
  const r = await signupApi(page, { email: "temp@example.com" });
  expect(r.status).toBe(201); expect(r.data.role).toBe("member");
});
