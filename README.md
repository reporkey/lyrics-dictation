# Lyrics Dictation / 歌词默写

A bilingual, privacy-minded web app for memorizing lyrics you supply yourself. Import plain text or LRC, study the complete song, then write it from memory in one free-form editor. Feedback is continuous: matching text is green, incorrect or extra text is amber and underlined, and omissions appear as non-answer-revealing amber markers.

The library can be viewed as cards or a compact list. Language follows the browser and theme follows the operating system until the user changes either; explicit language, theme, and library-layout choices are remembered and synchronized across open tabs.

Spaces, tabs, line breaks, punctuation, symbols, and presentation-only emoji components never affect correctness. Letters, combining marks, and numbers do. `Hello, world`, `Hello world`, and `Hello\nworld` therefore grade identically.

The app has no audio, lyric catalog, scraping, accounts, analytics, or AI features. Data is stored in Cloudflare D1 under an anonymous browser credential.

## Status

**implementation ready; deployment configuration locally verified**

No production Worker, remote D1 database, custom domain, or public release has been created from this repository. The GitHub repository remains private.

No open-source license has been selected. Until the owner adds one, all rights are reserved.

## Architecture

- React 19, Vite, TypeScript, and CodeMirror 6 in the browser.
- A dedicated Web Worker performs whole-document Unicode projection and alignment off the input thread.
- IndexedDB stores immediate crash/offline recovery; debounced writes synchronize to D1.
- A Hono Worker exposes a same-origin JSON API and serves the SPA through the Cloudflare Vite plugin.
- D1 stores anonymous identities, settings, songs, sessions, idempotency records, and rate-limit buckets.
- The raw 256-bit credential exists only in an HttpOnly cookie; D1 stores its SHA-256 hash.

See [architecture](docs/architecture.md) and [threat model](docs/threat-model.md) for boundaries and tradeoffs.

## Local setup

Requirements: Node.js 22 or later and npm. Python is not required.

```sh
npm ci
npx playwright install chromium
npm run db:migrate:local
npm run dev
```

Open the URL printed by Vite. Local development uses `ld_identity_dev`; production uses the Secure host-only `__Host-ld_identity` cookie.

Useful commands:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:a11y
npm run build
npm run audit:runtime
npm run config:validate
npm run check
```

Integration tests execute the real Worker entry point in Cloudflare's workerd-based Vitest pool with a real local D1 binding. Browser tests start an isolated local Worker/Vite server on port `41789` and apply migrations automatically.

## D1 and Cloudflare deployment

Local migrations:

```sh
npm run db:migrate:local
```

Deployment is intentionally not automated. The repository contains a placeholder D1 ID. The owner must perform these steps in their Cloudflare account:

1. Authenticate Wrangler: `npx wrangler login`.
2. Create D1: `npx wrangler d1 create lyrics-dictation`.
3. Replace the placeholder `database_id` in `wrangler.jsonc` with the returned account-specific ID.
4. Apply remote migrations: `npx wrangler d1 migrations apply DB --remote`.
5. Review `npm run build` and `npx wrangler deploy --dry-run`, then explicitly deploy with `npm run deploy`.
6. Configure the intended custom domain and verify HTTPS, the `__Host-ld_identity` flags, HSTS, CSP, private-response cache headers, scheduled cleanup, and D1 backups/restore procedure from the deployed service.

Do not commit account IDs if the eventual public-release policy treats them as private. No application secret is required for identity generation.

## Privacy limitations

There is no login or recovery channel. Clearing the identity cookie permanently loses access to that anonymous library, and data does not transfer automatically to another browser or device. The cookie has a 365-day sliding lifetime, renewed at most daily; scheduled cleanup removes expired identities and cascading data. “Delete all my data” revokes the current credential, deletes the D1 identity and dependent rows, clears local recovery/preferences in every open tab, and expires the cookie. A durable two-stage browser marker resumes interrupted server or local deletion after reload.

Lyrics may be copyrighted. Users are responsible for importing content they are entitled to use. This repository contains no sample commercial lyrics.

## Repository guides

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Production readiness](docs/production-readiness.md)
- [Adversarial review](docs/adversarial-review.md)
