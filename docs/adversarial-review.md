# Adversarial review

## Independent falsification pass 1 — 2026-08-29

A fresh subagent that did not implement the application reviewed the complete requirements, source, migrations, tests, and deployment configuration. It specifically probed ownership/IDOR, identity cookies, CSRF, XSS, SQL injection, caching, deletion, concurrency, LRC parsing, Unicode projection, editor persistence, accessibility, mobile layout, test gaps, and documentation discrepancies. Result: **FAIL**, with zero critical, two high, several medium/low, and no demonstrated cross-user access or injection issue.

### Confirmed high findings and remediation

1. **A delayed autosave response could erase newer recovery text.** Reproduction: pause save A, enter B, then release A. The old response unconditionally removed IndexedDB recovery and could report synced. Completion had the same snapshot race. Remediation: recovery deletion is now a read/write transaction conditional on exact acknowledged text; a surviving unmatched record always wins on reload; completion captures and locks one exact draft snapshot. Playwright reproduces the delayed-response sequence, aborts the newer save, reloads, and verifies B is restored.
2. **Unicode canonical ordering occurred inside former editor graphemes rather than over the whole filtered stream.** Reproduction: expected `U+0323 U+0345`, draft `U+0345 SPACE U+0323`; removing the space should allow canonical reordering but did not. Remediation: whole-stream NFD canonical ordering now runs after filtering and again after case folding, with per-code-point provenance retained. Unit fixtures cover the exact sequence and a starter-plus-separated-mark variant.

### Confirmed medium/low findings and disposition

- Oversized divergent alignment used positional fallback without anchor chunks. Deterministic unique-token, longest-noncrossing anchors now split oversized regions for progressive refinement. Heuristic output remains non-exact and cannot complete a session. Repetitive regions without safe anchors remain a documented residual below.
- Plain input incorrectly stripped metadata/timestamps, and a colon was accepted as an LRC fractional separator. Plain and LRC paths are now distinct; pasted LRC is inferred unless the user explicitly chooses a format; only period fractions are accepted. Unit regressions cover both cases.
- Delete-all could emit an expiry and a renewal cookie together when renewal was due. API middleware now skips renewal for that route; a real Worker/D1 test ages the identity and asserts only `Max-Age=0` is emitted.
- Song deletion, restart, and lyric editing could orphan IndexedDB recovery. Each successful operation now clears the affected active-session record.
- Session save/complete/abandon lacked idempotency keys. Client calls and credential-scoped server response replay now cover all three actions; integration tests replay a session save without a second version increment.
- Grading summaries could be announced on every key. Visible feedback is no longer live; a separate polite, atomic summary is debounced by 700 ms. Completion remains a one-time assertive status.
- Several stable API codes fell through to a generic client error. Both locale catalogs now cover validation, media, JSON, origin, idempotency, missing record/session, inactive/incomplete session, HTTP, and internal errors. Unsafe-control errors include a one-based position without echoing the character.
- Mobile automated coverage was thin. A 360×800 Playwright check now asserts no horizontal overflow and that the fixed navigation remains entirely within the viewport. Manual desktop/mobile, light/dark, English/Chinese inspection is recorded in final evidence.

### Residual risks accepted for this release candidate

- Unicode 15.1 behavior is guarded by conformance fixtures, but `Intl.Segmenter` and Unicode property escapes use browser/workerd data rather than a fully vendored segmentation table. Runtime upgrades could change an edge case. Mitigation: pinned fixture profile, projection/property regression tests, and no approximate completion.
- Highly repetitive, highly divergent drafts can exceed both exact matrix budgets and offer no unique anchors. They remain visibly “Checking…” and cannot complete until equality or an exact region is reached. This favors bounded input latency and memory over an unbounded matrix.
- Automated browsers cannot faithfully prove every native IME implementation. CodeMirror composition handling is preserved, grading is decoration-only, intermediate worker results are keyed to the exact draft, and mixed Chinese/English composition was manually inspected. Third-party writing extensions also cannot be fully disabled by a site.
- Edge behavior for Host/Origin and production security headers still requires remote verification behind the final Cloudflare route and custom domain. No production deployment was authorized.

## Final independent verification

### Independent falsification pass 2 — 2026-08-29

A second fresh reviewer independently reran the quality suite and security probes, verified both pass-1 high remediations, and returned **FAIL** on the reviewed snapshot with five new high findings: lost-response UI retries used new keys; mutation/result idempotency had an ambiguous failure window; concurrent cookieless bootstrap could orphan one identity; autosave rescheduled itself forever while idle; and maximum-size divergent grading consumed about 4.4 seconds and 301 MB RSS. It also confirmed medium issues around stale-tab recovery deletion, immediate post-delete identity recreation, concurrent session-start 500s, case-fold provenance, cross-tab refresh/lifecycle flush, edge normalization/i18n, and test coverage.

Remediation after pass 2:

- Fetch retries one network failure with the same key; create/start/delete UI intents retain their key until success. Creates use deterministic IDs and status-0 reservations reconcile against committed records; session mutations reconcile exact version/text/status; ambiguous unknown failures retain rather than delete the reservation. Integration coverage simulates a committed session mutation whose result record remains status 0.
- First bootstrap uses a cross-tab Web Lock with a lease fallback. A two-page first-visit browser test imports in one tab and verifies the other sees the same library.
- Autosave tracks the last queued draft rather than payload/sync-state transitions. Browser coverage proves zero idle writes and exactly one write for one edit.
- Server autosave/abandon paths no longer align. Completion and import validation use a linear whole-stream projection. Browser documents above 20,000 scalars use linear exact equality and bounded “Checking…” output when divergent. The maximum legal 100,000-scalar integration fixture saves successfully; the 100k-versus-100k benchmark now averages about 22.40 ms locally.
- Recovery records gained a song index; delete/edit/restart clear by song even with a stale tab. A two-tab browser regression inspects IndexedDB after stale deletion.
- Delete-all clears current and sibling-tab state without navigation/bootstrap, leaves no identity cookie, and shows a localized success state.
- Concurrent start requests return the same active session with stable 200/201 responses. Case-fold expansion now retains per-code-point origins, with the reviewer’s `ß` plus separated acute fixture covered.
- Successful saves broadcast and clean dictation tabs revalidate; unsaved tabs retain their local recovery. `pagehide` adds a best-effort keepalive flush.
- API source/draft line endings normalize before limits/storage; LRC inference covers every recognized metadata tag; form UTF-16 `maxLength`/native required messages were removed in favor of shared server validation; UTF-8 BOM decoding and IPv6 localhost handling were corrected; abandoned history uses its actual update time.

Remaining pass-2 residuals are explicitly accepted: Unicode segmentation/property data is runtime-provided rather than fully vendored; identity-scoped rate limits are not Sybil-resistant and require optional Cloudflare platform controls; native IME/screen-reader/browser-extension behavior cannot be exhaustively automated; and production edge Host/header behavior remains unverified before deployment.

### Independent falsification pass 3 — 2026-08-29

A third fresh reviewer returned **FAIL** on its snapshot with five high findings: a stale IndexedDB recovery could overwrite a newer cloud version without warning; legal repeated LRC timestamps could expand into an illegal study document; one Greek case-fold/canonical-order sequence disagreed between interactive and authoritative completion projections; a stale dictation tab could recreate recovery after another tab deleted the song; and very large divergent documents showed only zero feedback indefinitely. Medium findings covered forced-restart concurrency, abandoned-session mutability/counts, request binding for idempotency, runtime Unicode data, malformed emoji policy, and a manual language change during initial bootstrap.

Remediation after pass 3:

- Recovery now compares its captured server version with the current D1 version. A mismatch enters explicit conflict UI, retains both drafts, and performs no autosave until the user chooses. A browser regression inserts a stale recovery, advances D1 directly, reloads, and proves the cloud text remains untouched.
- LRC parsing calculates expanded occurrence scalars and UTF-8 bytes before materializing or sorting occurrences, and rejects expansion above the shared draft capacity. The exact repeated-timestamp exploit fixture is covered by unit tests.
- Interactive provenance now maps per-code-point origins onto the authoritative whole-stream NFC → default case-fold → NFD sequence. The reported Greek `U+1F88 U+0323` case and separated-mark cases must agree with `gradeCompletion`.
- Successful song deletion emits a song-scoped cross-tab terminal event. A dictation tab clears IndexedDB and navigates away even with unsaved local text; a two-tab Playwright test asserts both the absent editor and zero recovery records.
- Documents through 50,000 scalars use the normal progressive aligner. Larger divergent documents expose bounded first-window counts and inline states while the remainder stays “Checking…”; exact normalized equality remains authoritative. A 60,000-character browser regression proves nonzero counts, an inline first-character error, and no false completion.
- Start/restart work gained short per-song leases plus the existing partial unique index; concurrent forced restarts return only successful 200/201 responses and leave exactly one active row. Terminal abandoned sessions reopen read-only. Idempotency operation namespaces now include request fingerprints. A manual locale choice made while bootstrap is pending is queued, synchronized after identity creation, and verified across reload.

The full post-remediation suite passed from a clean dependency install and fresh two-migration D1 database: 41 unit tests, 15 real Worker/D1 integration tests, 18 Chromium E2E tests, the separate accessibility run, production build, zero runtime audit findings, and Wrangler dry-run.

### Independent falsification pass 4 — 2026-08-29

A fourth fresh reviewer found one new **high** in a real D1 ambiguity probe: a status-0 `restart: true` reservation whose mutation had not committed could replay the preexisting active session as if it were the new restart result. That was a false success and violated the safe-retry contract. Recovery now accepts a forced restart only when the exact deterministic session ID for that operation exists; otherwise it returns `409 IDEMPOTENCY_IN_PROGRESS` and never misrepresents the old session. A committed restart remains recoverable by its deterministic ID. A real-D1 regression inserts the pre-mutation status-0 state and proves the old active row is not replayed.

The reviewer also confirmed three medium reliability gaps, all hardened before the final gate:

- Truly overlapping forced restarts could return `[A, B, B]`, leaving the first successful caller holding already-abandoned A. The per-song lease now remains for a 30 ms coalescing window after result creation. A three-request D1 regression requires every response to identify the same final active session.
- Abandonment retained zero counters. It now records linear, bounded final aggregates; the D1 test verifies `Hello` against `Hello world你好` records five correct and seven missing.
- Restart or lyric edit in a sibling tab could leave an unsaved old-session editor able to recreate zombie IndexedDB recovery. Session-replacement/termination broadcasts now synchronously invalidate the old session, clear recovery, and navigate to the replacement session or song. CodeMirror external document changes are annotated so they do not trigger user-change callbacks, recovery writes, or undo entries. Playwright verifies the old recovery remains absent.

On the current source, the fourth reviewer independently ran `npm run check`: **41 unit, 17 Worker/D1 integration, and 19 Chromium E2E tests passed**, followed by production build, zero runtime audit findings, and Wrangler dry-run. The separate accessibility command and benchmark had already passed on the same remediation line.

### Independent falsification pass 5 — 2026-08-29

The first fresh post-pass-4 reviewer returned **FAIL** with one high: JSON endpoints called `request.json()` before field validation, so an anonymous caller could make a Worker buffer a body up to the platform request limit, beyond the isolate memory budget; rejected oversized imports also bypassed rate accounting. Remediation replaces unbounded parsing with a 1 MiB transport boundary. Declared oversized bodies fail with `413 REQUEST_BODY_TOO_LARGE` before reading; absent/chunked lengths are read incrementally and the stream is canceled immediately after crossing the cap. Parse failures on idempotent create/session routes charge mutation and, for song imports, import buckets. Unit tests prove pre-read rejection and bounded stream cancellation; real Worker/D1 integration proves the localized 413 contract and both counters.

Two medium and two low findings were also resolved:

- Forced restart and lyric edit now compute the same bounded abandonment aggregates used by the explicit abandon action. Integration covers all three terminal paths.
- Browser and `Accept-Language` detection now choose the first supported preference in quality/order rather than allowing any lower-priority Chinese entry to override English.
- Direct editor control-character rejection reports the localized one-based offending position without echoing the character.
- Session save/complete/abandon logical intents retain one idempotency key across both automatic network retry and later manual retry; Playwright forces two failed network attempts, clicks Retry, and proves every request used one key.

Post-remediation quality evidence: **43 unit tests, 20 real Worker/D1 integration tests, and 20 Chromium E2E tests passed**, followed by the separate accessibility run, production build, zero runtime audit findings, and Wrangler dry-run. Maximum-size divergent completion averaged 9.89 ms and bounded abandonment aggregates 19.24 ms locally.

### Independent falsification pass 6 — 2026-08-29

The next fresh reviewer returned **FAIL** with one high identity-loss bug: middleware resolved or created identity before checking the write `Origin`. A cross-site top-level POST withheld the SameSite cookie, caused the Worker to mint and set a replacement credential, and only then returned `403`, orphaning the original library. API middleware is now ordered as security-header wrapper → exact-origin validation → identity resolution. Real Chromium establishes an existing library cookie, submits a top-level form from an opaque cross-site origin, and proves `ORIGIN_MISMATCH` with the original cookie unchanged. Real Worker/D1 integration separately proves no `Set-Cookie`, no new identity row, and private error headers.

One medium input-policy issue was also fixed: unpaired UTF-16 surrogates are now rejected as unsupported `C*` input instead of being silently converted to replacement characters by workerd/D1. Unit and escaped-JSON Worker/D1 regressions require rejection while valid astral emoji remains accepted.

The sixth reviewer independently probed the transport gate with declared oversize, unknown-length streaming, exact 1 MiB, missing/invalid lengths, and legal ~600 KiB escaped source/draft bodies. The current full suite passed with **43 unit, 21 Worker/D1 integration, and 21 Chromium E2E tests**, plus accessibility, production build, zero runtime audit findings, and Wrangler dry-run. It reported zero currently unresolved critical/high findings but correctly required another fresh reviewer because it discovered the CSRF high during its own pass.

### Final independent release gate

Passes 7–15 continued to falsify transport boundaries, LRC fallback, Unicode whitespace and format-control handling, stale-cookie deletion, exact RGI emoji acceptance, cookie renewal, local cleanup failure, sibling-tab teardown, reload resumption, `BroadcastChannel` absence, and storage-event races. Every confirmed issue was remediated and promoted to unit, real Worker/D1 integration, or browser regression coverage. In particular, deletion now uses a credential revocation table plus a durable, two-stage, cross-tab browser state machine.

Passes 16 and 17 identified two final race surfaces: a crash window between cloud deletion and durable local cleanup state, and page-lifecycle/recovery writes that bypassed the shared deletion block. Their reporting processes were interrupted, so neither was treated as a release approval. The marker is now written in the `server` stage before the delete request, advances to `local` only after cloud success, and is removed only after local cleanup. Pagehide uses the shared abortable client and recovery writes check deletion state both before and after asynchronous IndexedDB work.

### Independent falsification pass 18 — final release gate — 2026-08-29

A fresh independent reviewer returned **PASS** with **zero critical, zero high, and no new medium/low blockers**. It reran the complete quality suite: 48 unit tests, 24 tests against the real Worker and local D1, 27 Chromium E2E tests, the separate accessibility test, production build, zero runtime audit findings, and Wrangler dry-run. Targeted deletion tests passed 4/4.

The reviewer also held a deletion request open while a dirty peer tab navigated and exercised page lifecycle handling. It observed zero post-block PATCH requests, zero cookies, zero recovery records, and no late write. Maximum-size divergent completion completed in 10.59 ms and bounded abandonment aggregates in 20.22 ms on the review machine. The release gate is therefore **PASS** with no unresolved critical/high findings.

Accepted residual risks remain runtime-provided Unicode segmentation/property data, native IME and third-party extension behavior, credential-scoped rather than network-wide abuse controls, and provider backup/restore behavior requiring an owner policy decision.

### Independent preference and UI falsification pass 19 — 2026-08-29

Two independent reviewers separately attacked the new language, theme, and card/list preference work. Their first pass found no critical/high issues, but did expose five medium and several low defects: an explicit cloud locale could be lost after browser storage was cleared; rapid language changes reused stale settings versions; delete-all left in-memory preferences active; theme/layout did not reliably synchronize across tabs; denied local storage could break startup and deletion; Chinese source badges and mobile completion counts were inconsistent; Traditional Chinese browser tags defaulted to English; English singular copy was wrong; dark mode could flash light chrome; and the new populated/mobile states lacked complete accessibility coverage.

Remediation added a versioned `locale_explicit` setting, serialized/coalesced locale writes with conflict recovery, safe preference access plus cross-tab synchronization, browser/system defaults that yield to explicit choices, pre-paint theme initialization and matching `theme-color`, localized source/count labels, responsive card/list counts, and expanded browser/axe coverage. Deletion markers now have an IndexedDB fallback, so cloud deletion, cookie expiry, and recovery cleanup still succeed when all local-storage methods throw. Keyboard review additionally found and fixed a missing search focus ring and a mobile focus-order jump; the visible desktop/mobile navigation variants now preserve visual Tab order without duplicate accessible navigation.

Final independent probes returned **PASS** with zero new critical, high, medium, or low findings. The state reviewer verified explicit-locale recovery, adversarial rapid toggles, immediate preference reset after deletion, live two-tab synchronization, and a full delete with `localStorage.getItem`, `setItem`, and `removeItem` all throwing: exactly one cloud DELETE, zero identity cookies, zero cloud songs/sessions, zero IndexedDB drafts/markers, and no page errors. The UI reviewer verified Chinese/English copy, `zh-TW`/`zh-HK`/`zh-Hant`, light/dark first paint, mobile card/list layouts at 360 and 320 px, search focus visibility, a Header → Main → mobile-navigation Tab order, one accessible navigation per viewport, no horizontal overflow, and the expanded WCAG A/AA axe run.

### Production deployment verification — 2026-08-29

The reviewed snapshot was deployed to a dedicated APAC D1 database and the Cloudflare Worker Custom Domain `dictation.reporkey.com`. All four remote migrations applied successfully and Wrangler reported no pending migrations. Live HTTPS checks returned 200 for the SPA and bootstrap API; the API returned an empty new library with `Cache-Control: no-store` and a host-only anonymous cookie carrying the `__Host-` prefix, Secure, HttpOnly, SameSite=Lax, and root Path attributes. HSTS and CSP were present, the scheduled cleanup trigger was deployed, and a real Chrome load showed the library/import UI with no console warnings or errors. D1 backup/restore policy, production log retention/redaction, and optional platform-level abuse controls remain owner follow-ups.
