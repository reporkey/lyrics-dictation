# Production-readiness checklist

## Verified locally before release

- [x] `npm ci` succeeds from a clean checkout.
- [x] Fresh local D1 accepts every ordered migration.
- [x] Format, lint, types, unit, Worker/D1 integration, E2E, accessibility, build, and runtime audit pass.
- [x] `npx wrangler deploy --dry-run` accepts the configuration and generated bindings are current.
- [x] English and Chinese desktop/360 px flows, light/dark themes, keyboard editing, selection/copy, undo/redo, and mixed CJK/Latin IME are manually inspected.
- [x] Independent adversarial review has zero unresolved critical/high findings.
- [x] Final diff contains no credentials, account data, uploaded lyrics, local D1, traces, or build output.

## Owner steps not performed by local development

- [ ] Create/select the Cloudflare account and remote D1 database.
- [ ] Replace the placeholder D1 ID and apply migrations remotely.
- [ ] Review D1 backup/restore and provider retention policy.
- [ ] Explicitly authorize and run deployment.
- [ ] Configure DNS/custom domain and any platform abuse controls.
- [ ] Verify remote SPA/API routing, scheduled cleanup, logs, and observability redaction.
- [ ] Verify HTTPS plus production cookie `__Host-`/Secure/HttpOnly/SameSite/Path flags.
- [ ] Verify HSTS, CSP, frame, referrer, nosniff, browser/CDN no-store behavior at the edge.
- [ ] Select an open-source license and review branding/contribution policy before publishing.
- [ ] Enable a private security-reporting channel.

No checkbox should be marked based only on intended configuration.
