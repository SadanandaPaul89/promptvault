# PromptVault

A searchable vault of master prompts, ranked by a hybrid algorithm.

- **Viral Creator Prompts**: 24 prompts that went viral on Reels and Shorts (AI photo, AI video, scripts, business, study, coding, resume, festival).
- **Product Management**: 500 Claude prompts from `server/seed/pm-library-seed.json`, in 12 categories and 91 sections (vision, PRDs, roadmaps, metrics, research, GTM, and more).

Users search in plain words and fill in the `[variables]`; the prompt updates as they type. They can then copy it, save it to their vault, vote on whether it worked, and submit links to new prompts.

## Run locally

Requires **Node 22.18+** (Node 24 recommended). The server runs TypeScript directly. Its one runtime dependency is `@libsql/client`: locally it uses a SQLite file in `data/`, and in production it can point at [Turso](https://turso.tech) (hosted SQLite) instead, with the same SQL.

```bash
npm install
npm run dev        # http://localhost:5173  (Vite + API on :3000 with hot reload)
```

Production mode:

```bash
npm run build      # builds the client into dist/
npm start          # serves the site + API on http://localhost:3000
```

Other scripts: `npm test` (API and ranking tests) and `npm run typecheck`.

## Deploy

### Free: Vercel (website + API) + Turso (database)

Both have free plans and neither needs a card.

- **Vercel** serves the website and runs the API as one serverless function on the same domain, so login cookies are first-party and there's no cross-site setup. `npm run build:vercel` ([scripts/build-vercel.mjs](scripts/build-vercel.mjs)) builds the client and bundles [server/src/vercel.ts](server/src/vercel.ts) into Vercel's [Build Output](https://vercel.com/docs/build-output-api/v3) format.
- **Turso** holds the database, because serverless functions have no lasting disk. The free tier is 5 GB, far more than this app needs.

1. **Turso:** create a database and copy its URL and a token:
   ```bash
   turso db create promptvault
   turso db show promptvault --url       # → TURSO_DATABASE_URL
   turso db tokens create promptvault    # → TURSO_AUTH_TOKEN
   ```
   The tables and the 524 prompts are created on the first request.
2. **Vercel:** **Add New → Project** → import this repo. Keep the defaults ([vercel.json](vercel.json) sets the build). Under **Environment Variables** add:
   - `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` from step 1.
   - `JWT_SECRET`: 32+ random characters. Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`.
   - `ADMIN_EMAILS`: your email (comma-separate several).

   Then **Deploy**.
3. **Region:** in the Vercel project, open **Settings → Functions → Function Region** and pick the region closest to your Turso database (for example Mumbai `bom1` for Turso's `aws-ap-south-1`), then redeploy. Every API request talks to the database, so this matters more than anything else for speed.
4. Open the site, create an account with your `ADMIN_EMAILS` address, and the Admin tab appears.

Every push to `main` redeploys. If the site shows "Server is misconfigured", an environment variable is missing; the function log in Vercel says which.

**Notes:**
- **Cold starts:** a function that hasn't run for a while takes a second or two to start. The prompt catalog is then cached in memory, so browsing costs one small query per request.
- **Rate limits** are kept in each function instance's memory, so they're looser than on a single server.
- **Reels:** whisper.cpp can't run on Vercel, so the extension's analyses use the caption and on-screen text only.
- **Extension:** set `API_BASE` in [extension/config.js](extension/config.js) and the matching `host_permissions` entry in `manifest.json` to your Vercel URL.

### Other hosts

SQLite needs a **persistent disk**, so pick a host that provides one:

- **Docker** (any VPS, Fly.io, Railway, Render): `docker build -t promptvault .` then
  `docker run -p 3000:3000 -v promptvault-data:/data promptvault`
- **Any Node host with a disk**: build command `npm ci --include=dev && npm run build`, start command `npm start`, and set `DATABASE_PATH` to a path on the persistent disk. Set `TRUST_PROXY=1`. Without a disk, use Turso as above.

Environment variables are listed in `.env.example`. The health check is `GET /api/health`.

## Adding prompts

Drop a JSON file into `server/seed/` in the same shape as `pm-library-seed.json` and import it and add it to `SEED_COLLECTIONS` in [server/src/db.ts](server/src/db.ts). Seeding runs on every boot and is idempotent: new prompts are added, and existing ones (with their real votes and copies) are never overwritten.

## Ranking

| Signal | Weight (search) | Notes |
|---|---|---|
| Semantic | 45% | Synonyms (PRD → requirements, OKR → metrics…), field weighting (title > tags > category > body), IDF so common words like "product" count less, intent boosts per category |
| Keyword | 20% | Exact (stemmed) word matches |
| Success | 20% | "It worked" votes; one vote per visitor, and it can be changed |
| Viral | 10% | Starting signal from the original post |
| Freshness | 5% | Decays over about 3 weeks |

When browsing without a query: 55% viral, 30% success, 15% freshness. The code is in [server/src/ranking.ts](server/src/ranking.ts).

## Accounts and the Admin panel

Browsing and search are public. Saving, voting and submitting links require an account, and each account sees only its own saves, votes and submissions.

**Seeing submitted links:**
1. Set `ADMIN_EMAILS=you@example.com` (comma-separated for more than one) and restart the server.
2. Sign in with that email, or create an account with it.
3. An **Admin** tab appears in the header. It has two sections:
   - **Submitted links:** every submission with the submitter's email. You can mark each one pending, added or rejected, and the submitter sees the new status.
   - **Extension analyses:** prompts found by the browser extension. Approve the ones you want or reject them.

Roles are read from the database on every request, so removing someone's admin access takes effect immediately.

**How sessions work** ([server/src/auth.ts](server/src/auth.ts)):

| Piece | Detail |
|---|---|
| Passwords | scrypt (N=16384) with a per-user salt |
| Access token | HS256 JWT, valid for 15 minutes. The header, signature, `iss`, `aud` and `exp` are all checked strictly, and `alg` can't be switched |
| Refresh token | Random, valid for 30 days, stored in the database only as a SHA-256 hash. It rotates on every use. If an already-used token is presented again, every session in that sign-in chain is revoked |
| Cookies | Both tokens are sent only in `HttpOnly; SameSite=Strict` cookies, so page JavaScript can never read them. `Secure` is set over HTTPS. The refresh cookie is scoped to `/api/auth` |
| CSRF | SameSite cookies, plus a same-origin check on every request that changes data |
| Caching | API responses are sent with `Cache-Control: no-store, private` and `Vary: Cookie`. The client's query cache is keyed by user and cleared whenever someone signs in or out |
| Sign out | Revokes the session on the server. "Sign out on all devices" revokes every session for the account |

Set `JWT_SECRET` in production (`openssl rand -base64 48`). The server won't start without it when `NODE_ENV=production`. When someone signs in for the first time, saves and votes they made anonymously in that browser before accounts existed are moved into their account.

## Post analyzer (browser extension)

The Chrome extension in [extension/](extension/) finds the prompt in an Instagram reel/post or a LinkedIn post. It runs only when the user clicks **Analyze this post**, and it reads the post in the user's own browser session. The server never fetches anything from Instagram or LinkedIn. Mobile is "coming soon".

How it works:

1. **Cache first.** Every post is reduced to one canonical key (`ig:{shortcode}`, `li:activity:{id}`; see [canonical.ts](server/src/canonical.ts)). If anyone has analysed the post before, the result comes back instantly with no approval step.
2. **First time a post is seen:**
   - The extension reads the caption or post text and runs OCR on images in the browser with Tesseract.js.
   - For reels, it plays the reel once, records the tab audio and samples frames for on-screen-text OCR.
   - The server transcribes the audio with self-hosted whisper.cpp ([stt.ts](server/src/stt.ts)) and runs rule-based extraction ([extract.ts](server/src/extract.ts)). There's no LLM yet.
3. **Status:**
   - **pending:** new prompts were found and wait for moderation.
   - **approved:** every prompt found was already in the vault. It's approved automatically, and each repost bumps that prompt's viral score.
   - **no_prompt** or **dm_gated** ("comment X for the prompt"): cached right away.
4. **Moderation:** use the Admin tab (see above). Scripts can also call the API with an `ADMIN_TOKEN`:
   ```bash
   curl -H "Authorization: Bearer $ADMIN_TOKEN" localhost:3000/api/admin/analyses?status=pending
   curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
        -d '{"keep":[0]}' localhost:3000/api/admin/analyses/ID/approve     # or /reject
   ```
   Approved prompts go into the **From Reels & Posts** collection.

Media is never stored. Only the extracted text, the post link and the creator handle are kept. The extension's setup steps are in [extension/README.md](extension/README.md).

## Project layout

```
client/            React 19 + Tailwind 4 UI (Vite)
server/src/        index.ts (entry) · app.ts (HTTP, static, security, rate limits) · api.ts · ranking.ts · db.ts
server/seed/       seed prompt collections (JSON)
server/test/       node:test API tests
legacy/            the original Hatch/Muse-runtime version, kept for reference
```

## Privacy and limits

- Saves, votes and submissions belong to accounts (see above). The browser extension stays anonymous, identified by a random id stored in the extension.
- Viral and copy numbers in the creator collection are curated starting signals, not measured data. The PM library starts at zero.
- Submitted links go into a `pending` queue in the `submissions` table. Extraction is manual for now (see `CLAUDE-AUTOMATION-PROMPTS.md`, Prompt 8).
