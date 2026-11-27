# Notes

[![Built from a Spekkr spec](https://img.shields.io/badge/built%20from-Spekkr%20spec-f0442b)](https://spekkr.com/dwrtz/linked-notes/)

Built from the Spekkr spec dwrtz/linked-notes: https://spekkr.com/dwrtz/linked-notes/

Build line: `Build the spec at https://spekkr.com/dwrtz/linked-notes/start.md`

Live demo: [https://notes.beef-able.com](https://notes.beef-able.com)

A personal linked-notes app (Obsidian-style) that runs on one Cloudflare Worker. Notes and metadata live in D1; attachments live in R2. Access defaults to a single owner (`only_me`). You can also run it invite-only or open, and optionally restrict sign-up and sign-in to a list of emails.

## Run it on your computer

```bash
npm install
npm run dev          # builds, migrates the local D1 database, then wrangler dev
```

Open http://localhost:8787. No Cloudflare account is needed locally.

## Tests

```bash
npm test                                         # unit tests
npx playwright install chromium && npm run e2e  # end-to-end, against wrangler dev
```

## Deploy to Cloudflare

1. Copy [`wrangler.example.jsonc`](./wrangler.example.jsonc) over `wrangler.jsonc` (or edit `wrangler.jsonc` in place) and replace `<YOUR_D1_DATABASE_ID>` with your database id. You can also set `account_id` and a custom domain there.
2. Log in and create the bindings once:

```bash
npx wrangler login
npx wrangler d1 create linked-notes
npx wrangler r2 bucket create linked-notes-attachments
```

Paste the printed D1 id into `wrangler.jsonc`, then apply migrations and deploy:

```bash
npx wrangler d1 migrations apply DB --remote
npm run deploy
```

### Vars

Set these in `wrangler.jsonc` (or as Worker vars in the dashboard):

| Var | Default | Meaning |
|---|---|---|
| `ALLOW_SIGNUP` | `"1"` | `"1"` allows new accounts, `"0"` refuses them. |
| `ALLOWED_EMAILS` | `""` | Comma-separated allowlist for sign-up, sign-in and existing sessions. Empty or unset means no extra restriction. Example: `"you@example.com"`. |

The first account created becomes the owner. After that, you can set `ALLOW_SIGNUP` to `"0"` and keep `ALLOWED_EMAILS` set so only those addresses can use the site.

### If static asset upload is unavailable

The UI can be bundled into the Worker instead of being uploaded as Workers static assets. Temporarily set `"main": "src/worker/deploy-entry.ts"` in your wrangler config (and drop the `assets` block), then:

```bash
npm run build
node gen-inline-assets.mjs
npx wrangler deploy
```

`src/worker/inline-assets.gen.js` is generated and is not committed.

## Settings (`spekkr.inputs.json`)

- **`app_name`:** the product name (default `"Notes"`).
- **`accent_color`:** the accent colour, as `#rrggbb`.
- **`access`:** `only_me` (default), `invite_only`, or `open`.
- **`seed_demo`:** if `true` (the default in this repo, so local dev and tests have a demo account), seed a demo vault on first run. Set this to `false` before a personal production deploy.
- **`cloudflare_access`:** optional hint that the deploy sits behind Cloudflare Access.

## License

MIT. See [LICENSE](./LICENSE).
