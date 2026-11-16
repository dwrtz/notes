import { defineConfig } from "@playwright/test";
const PORT = 3210;
// Runs the real Worker under `wrangler dev` with a fresh local D1/R2 in .e2e/ and a frozen clock.
// ALLOW_SIGNUP=1 lets the tests create accounts; e2e/0-access.spec.ts switches access modes with test cookies.
const serve = [
  "rm -rf .e2e",
  "npm run build",
  "npx wrangler d1 migrations apply DB --local --persist-to .e2e",
  `npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to .e2e --var NOW:2026-11-15T12:00:00.000Z --var TEST_CLOCK:1 --var ALLOW_SIGNUP:1 --show-interactive-dev-session=false`,
].join(" && ");
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1360, height: 860 }, timezoneId: "America/New_York" },
  webServer: { command: serve, url: `http://127.0.0.1:${PORT}/api/now`, reuseExistingServer: false, timeout: 180_000 },
});
