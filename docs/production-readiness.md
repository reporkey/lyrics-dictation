# Production-readiness checklist

## Verified locally before release

- [x] `npm ci` succeeds from a clean checkout.
- [x] Fresh local D1 accepts every ordered migration.
- [x] Format, lint, types, unit, Worker/D1 integration, E2E, accessibility, build, and runtime audit pass.
- [x] `npx wrangler deploy --dry-run` accepts the configuration and generated bindings are current.
- [x] English and Chinese desktop/360 px flows, light/dark themes, keyboard editing, selection/copy, undo/redo, and mixed CJK/Latin IME are manually inspected.
- [x] Independent adversarial review has zero unresolved critical/high findings.
- [x] Final diff contains no credentials, account data, uploaded lyrics, local D1, traces, or build output.

## Production deployment — verified 2026-08-29

- [x] Create/select the Cloudflare account and a dedicated APAC D1 database.
- [x] Configure the production D1 binding and apply all four remote migrations.
- [x] Explicitly authorize and deploy the Worker.
- [x] Configure the `dictation.reporkey.com` Custom Domain; Cloudflare manages DNS and TLS.
- [x] Verify remote SPA and API routing plus the scheduled cleanup trigger.
- [x] Verify the production cookie `__Host-`/Secure/HttpOnly/SameSite/Path flags.
- [x] Verify HSTS, CSP, frame, referrer, nosniff, browser caching, and API `no-store` behavior at the edge.
- [x] Verify the deployed page in Chrome with no console errors.

## Owner steps still open

- [ ] Review D1 backup/restore and provider retention policy.
- [ ] Decide whether to add Cloudflare platform-level abuse controls beyond credential-scoped application rate limits.
- [ ] Review production log retention and observability redaction in the Cloudflare dashboard.
- [ ] Select an open-source license and review branding/contribution policy before publishing.
- [ ] Enable a private security-reporting channel.

No checkbox should be marked based only on intended configuration.
