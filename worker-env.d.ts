/** Bindings for this Worker. Run `npm run types` if you want a generated `worker-configuration.d.ts`. */
interface Env {
  FILES: R2Bucket;
  DB: D1Database;
  ASSETS: Fetcher;
  NOW: string;
  TEST_CLOCK: string;
  ALLOW_SIGNUP: string;
  /** Comma-separated allowlist for sign-up, sign-in and sessions. Empty or unset means no extra restriction. */
  ALLOWED_EMAILS: string;
}
