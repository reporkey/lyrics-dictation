# Codex autonomous build prompt

You are the principal product engineer responsible for turning this starter repository into a production-quality, open-source-ready lyrics dictation web application. Work autonomously to completion. Do not stop for routine implementation choices, do not ask for progress approvals, and do not merely produce a plan or prototype.

## Outcome

Build a polished responsive web app named **Lyrics Dictation** for people to memorize and write lyrics from memory. It must support Chinese and English, accept only user-supplied lyric text or lyric files, synchronize data in the cloud without accounts, and be deployable on Cloudflare.

The repository is implementation-complete only when the application, database migrations, automated tests, security/privacy protections, documentation, and Cloudflare deployment configuration all work together and the independent adversarial review described below has passed. Locally verified deployment configuration is not the same as a remotely deployed production service.

## Authority and working method

- You are authorized to inspect and edit every file in this repository; install project-local dependencies; run builds, tests, linters, local databases, browsers, and non-destructive security checks; and revise your own work until the acceptance criteria pass.
- Minimize user-facing progress messages while complying with mandatory host communication and safety rules. Pause only when the environment requires owner action that cannot be completed safely without them, such as authenticating an external service or supplying a secret. Do not ask about ordinary product or engineering choices: make a defensible choice, document it, and continue.
- Do not deploy, create paid resources, change external account settings, or publish the repository. Prepare and verify the deployment configuration locally. If Cloudflare credentials are already available, you may run read-only checks but must not deploy without explicit authorization.
- Preserve unrelated existing work. Never commit credentials, generated secrets, personal data, or uploaded lyrics.
- Use the current stable, officially supported Cloudflare approach at implementation time. Before choosing framework and platform APIs, consult current official Cloudflare documentation. Prefer a small TypeScript stack that runs naturally on Cloudflare Workers, stores relational data in D1, serves frontend assets from the same project where practical, and has strong local test support. Avoid unnecessary services and vendor abstractions.
- Keep the implementation maintainable for a future public repository: clear module boundaries, strict types, reproducible commands, committed lockfile, environment examples, migrations, contribution guidance, and no dependence on private infrastructure.
- Follow `AGENTS.md`. If Python is needed for tooling, use `uv` per project and never a system or Homebrew Python.

## Product scope

### 1. Languages and interface

- Ship complete Simplified Chinese (`zh-CN`) and English (`en`) UI translations.
- On first visit map `zh`, `zh-CN`, `zh-SG`, and `zh-Hans` browser preferences to `zh-CN`; map any `en-*` preference to `en`; otherwise fall back to `en`. Let the user switch language at any time. A manual choice wins over browser detection, is persisted immediately in local storage for startup, and is synchronized to the anonymous D1 settings record once an identity exists. On later loads a valid server setting is authoritative and refreshes local storage.
- All user-visible application strings, validation messages, empty/error/loading states, document title/description, not-found pages, server-error presentation, and accessibility labels must go through the localization system. Set `<html lang>` correctly. Tests must fail if either locale is missing required keys.
- User-entered song titles, artists, and lyrics are content and must never be translated automatically.
- Provide a coherent, restrained visual system with excellent typography for both Latin and CJK text. Support phone, tablet, and desktop layouts down to 360 px width. Avoid generic template styling and ornamental UI that does not aid study.

### 2. Lyric import and library

- The only lyric inputs are:
  1. pasting plain text or LRC into a text area; and
  2. uploading a local `.txt` or `.lrc` file.
- Do not integrate music, audio playback, microphones, streaming services, lyric providers, scraping, URLs, or third-party content catalogs.
- Decode UTF-8 strictly, remove one leading BOM, and normalize CRLF/CR to LF for the editable stored source. Recognize LRC timestamps in common `[mm:ss]`, `[mm:ss.xx]`, and `[mm:ss.xxx]` forms. Recognize only metadata tags `ar`, `ti`, `al`, `by`, `offset`, `re`, `ve`, and `length` case-insensitively; use `ar` and `ti` only to prefill editable artist/title, and omit recognized metadata-only lines from study content. Preserve unknown or malformed bracketed text as lyrics rather than silently discarding it.
- LRC ordering is normative: if every non-metadata, non-blank lyric line has at least one valid timestamp, expand every timestamp into a distinct lyric occurrence, sort occurrences by numeric timestamp, preserve source order for ties, and do not deduplicate repeats. If any studyable line is untimed, ignore all timestamps for ordering, preserve source-line order, and include each source line once after stripping its valid leading timestamp sequence. Preserve blank lines in the editable source but exclude them from sessions. Let the user review and edit parsed title, artist, and source before saving, and regenerate study lines from the edited source.
- Enforce shared client/server limits from one documented configuration: uploaded UTF-8 bytes at most 1 MiB; decoded source at most 500,000 Unicode scalar values; at most 10,000 source lines; each source line at most 2,000 Unicode scalar values; title and artist each at most 200 Unicode scalar values. Reject unsupported extensions, invalid UTF-8, and songs with zero non-blank studyable lines. The server is authoritative. Test every boundary and one-over-boundary case and show localized actionable errors. Treat filenames and contents as untrusted input.
- Provide a personal library with create/import, view, edit, search, sort, and delete. A destructive delete requires confirmation and must remove dependent study data transactionally.
- Store normalized lyric lines while preserving the user’s original text for future editing. Never include sample copyrighted lyrics; tests and demos must use short original or public-domain fixture text.

### 3. Study and dictation flow

- A song detail view has a **Study** view that shows the complete lyrics and a **Start dictation** action.
- A dictation session presents one lyric line at a time without exposing the answer. It supports keyboard-first entry, previous/next navigation, progress, and an explicit submit/check action. Allow at most one in-progress session per song. **Start dictation** resumes it; **Start over** requires confirmation and marks the old session abandoned. Refreshing or reopening the app resumes the unfinished session.
- After checking a line, show an accessible character/word-level diff and the correct line. The user can continue, retry incorrect lines, or finish the session.
- Grading is normative: normalize both values to Unicode NFC; normalize all Unicode whitespace runs to one ASCII space and trim them; when case sensitivity is off apply locale-independent Unicode default case folding; when punctuation sensitivity is off remove code points in Unicode General Category `P*`. Both sensitivity options default off and are fixed for a session. Do not apply compatibility normalization or remove letters, marks, numbers, symbols, emoji, or CJK characters. Segment and diff with Unicode extended grapheme clusters, never UTF-16 code units. Use grapheme-level equality as the correctness primitive; optional word grouping must not change the result. Display the untouched expected answer alongside the diff, and give screen readers a concise result summary instead of every diff token.
- Record attempts per line, first-attempt correctness, eventual correctness, `started_at`, `completed_at`, and abandoned state. Define the headline score as `first-attempt-correct lines / total studyable lines × 100`, while also showing eventual completion separately. Completion duration is documented wall-clock time from start to completion and may include time away. Show useful progress on the song detail view and a recent-activity overview. Do not add gamification, social features, leaderboards, sharing, or AI-generated content.
- Empty songs, blank lyric lines, very long lines, emoji, combining characters, apostrophes, CJK punctuation, and mixed Chinese/English text must behave predictably and be covered by tests.

### 4. Anonymous identity and cloud sync

- There is no registration, login, email, password, OAuth, or user-visible account system.
- On first server interaction, create a cryptographically random opaque anonymous credential with at least 256 bits of entropy. In production use a host-only cookie named `__Host-ld_identity` with `Path=/`, no `Domain`, `HttpOnly`, `Secure`, `SameSite=Lax`, and a documented 365-day sliding lifetime renewed at most once per day. Use a clearly separate localhost-only cookie/configuration when `Secure` is unavailable.
- Never use a sequential/raw database identifier as authentication. Store only a one-way cryptographic hash of the credential in D1. Use constant-time comparison where relevant. Do not make identity or private records accessible from JavaScript.
- A missing, malformed, expired, or unknown credential must never recover or reveal an earlier identity: create a new identity and return an empty library. Update `last_seen_at` only after successful validation. Purge identities inactive for more than 365 days and all dependent data through a documented, testable scheduled maintenance path. Disclose the retention and identity-loss behavior in both locales.
- Every lyrics, settings, session, and progress query/mutation must derive ownership from the validated cookie on the server. Enforce ownership in the query itself where practical. Never accept a client-supplied owner ID.
- Provide CSRF protection appropriate to the chosen architecture for every state-changing request, validate `Origin`/`Host`, use restrictive CORS and correct content types, and implement a tested CSP, `X-Content-Type-Options: nosniff`, restrictive `Referrer-Policy`, frame protection, and production HSTS. Every private API response and every response that sets identity must use `Cache-Control: no-store` and must not be cached by the CDN. Imported filenames, titles, artists, lyrics, and diffs must render as text, never trusted HTML.
- Choose and document numeric per-route rate limits in one shared configuration; enforce them server-side, return `429` plus `Retry-After`, test boundaries and local/production-equivalent behavior, and do not persist raw IP addresses in logs. Upload and field-size limits are defined in the import section.
- Every mutable record carries a server-generated integer version. Update and delete requests supply the last observed version; a stale request returns stable `409 VERSION_CONFLICT` without mutation, and the UI preserves unsaved input while offering reload/retry. Define an explicit retry contract for creation, answer submission, session completion, song deletion, and delete-all. Operations that create records or increment counts use a credential-scoped idempotency key stored with the result. Delete-all is safe to repeat and must not accidentally create a replacement identity. Test response-loss retries, duplicate concurrent requests, and stale update/delete races.
- Synchronize across tabs and visits that share the cookie. After a successful mutation update the current tab immediately, notify same-origin tabs with `BroadcastChannel` or an equivalent primitive, and revalidate on focus/visibility change; no WebSocket is required. Never show “synced” until the server confirms success.
- Local UI state may be cached for resilience, but D1 is the source of truth for saved content and progress. Clearly distinguish offline/network failure from an empty library and allow safe retry.
- Explain in the UI and privacy documentation that clearing cookies loses access to the anonymous library and that anonymous data does not automatically transfer between browsers/devices.
- Provide a localized privacy/data screen with **Delete all my cloud data**. Require confirmation, delete all owned records transactionally, expire the identity cookie, and test the full flow. Collect no analytics or telemetry by default.

## Data and API quality

- Design normalized D1 tables with foreign keys, cascading behavior where appropriate, indexes for ownership and common queries, explicit migration files, and timestamp/version conventions. Migrations must work from an empty database and be safe to apply in order. Use D1-supported atomic batch/transaction facilities confirmed in current official documentation; do not assume generic SQLite transaction APIs are available in Workers.
- Define a small versioned JSON API or an equally clear server-action boundary. Validate all untrusted data with shared schemas. Return stable error codes plus localized client messages; do not leak stack traces, SQL, secrets, credential hashes, or cross-user record existence.
- Use parameterized queries only. Escape rendered content by default and do not render imported markup as HTML.
- Add structured server logging that is useful for diagnosis but excludes cookies, credentials, lyric contents, and other private data.
- Document data retention assumptions and the operational process for migrations and deletion. Do not invent legal claims or claim formal compliance certifications.

## UX states and accessibility

- Every asynchronous screen must have intentional loading, empty, error, success, and retry states without layout breakage.
- Meet WCAG 2.2 AA in the implemented flows: semantic landmarks and headings, associated labels, visible focus, full keyboard operation, logical focus after dialogs/navigation, adequate contrast and target sizes, screen-reader announcements for validation and grading, reduced-motion support, and no color-only correctness signal.
- Use native controls where they are the clearest choice. Dialogs must trap/restore focus and close predictably. Touch and keyboard interactions must both work.
- Include a not-found state and resilient handling for deleted/stale records and expired/invalid cookies.

## Explicit non-goals

- No audio or video playback, recording, speech recognition, timed lyric synchronization, karaoke display, lyric fetching, URL import, scraping, AI features, social/sharing features, ads, analytics, admin dashboard, account system, payment, or native mobile app.
- No placeholder controls, dead navigation, fake sync, mock production APIs, hard-coded demo success, or TODOs standing in for acceptance criteria.

## Tests and verification

Use a balanced pyramid and make all commands suitable for CI:

- Unit tests for LRC/plain-text parsing, Unicode grading/normalization, diff behavior, validation schemas, locale parity, and pure domain logic.
- API/integration tests must exercise the real Worker entry point through the officially supported local Workers test runtime with a real local D1 binding; a generic SQLite repository test or mocked binding alone is insufficient. Cover cookie issuance, hashing and renewal, invalid/expired identities, ownership isolation, CRUD, version conflicts, retry/idempotency contracts, cascaded deletion, delete-all, retention purge, malformed input, rate limits, CSRF/origin protection, private-response cache policy, security headers, stored-XSS payload rendering, and safe errors. CI must create a fresh local D1 database, apply the real migrations through Wrangler, run Worker tests, validate deployment configuration, and generate/check binding types when supported.
- End-to-end browser tests for both locales covering first visit, import by paste, `.txt` upload, `.lrc` upload, edit/search/delete, a complete dictation and retry flow, resume after reload, cloud persistence with the same cookie, isolation with a different browser context, network/error recovery where feasible, and deletion of all data.
- Automated accessibility checks plus manual keyboard and responsive inspection of critical pages. Treat automated checks as a floor, not proof of accessibility.
- Type checking, linting, formatting verification, production build, migration validation, and dependency/security review. Completion requires no known critical/high runtime dependency vulnerability; record impact and mitigation for any advisory that cannot be resolved.
- Tests must be deterministic, parallel-safe where possible, and must not require a deployed service, paid account, or real user data. Do not weaken assertions or exclude meaningful paths merely to make CI green.

Expose consistent package scripts named `format:check`, `lint`, `typecheck`, `test:unit`, `test:integration`, `test:e2e`, `test:a11y`, `build`, and an aggregate `check`. README and CI must call these same entry points. Create a CI workflow for pull requests and the default branch. Pin actions to trusted major versions or immutable revisions according to current ecosystem best practice, grant least-privilege workflow permissions, use dependency caching, and run the relevant checks. Do not add automatic deployment.

## Independent adversarial review

After the implementation and normal test suite pass, conduct a genuinely independent review using a fresh subagent or isolated review context that did not implement the feature. Give the reviewer the requirements and repository, but not the implementer’s conclusions. The reviewer must try to falsify completion, with special focus on:

- cross-user data access and IDOR;
- cookie theft/exposure, weak identity generation/storage, CSRF, XSS through imported lyrics or filenames, SQL injection, unsafe CORS, cache leaks, and sensitive logs;
- deletion completeness, cookie reset, concurrent/stale writes, retries, partial failures, and migration integrity;
- LRC/parser fuzz cases and Unicode grading errors in Chinese, English, and mixed text;
- accessibility, keyboard traps, mobile overflow, misleading sync state, missing translations, and destructive-action mistakes;
- test gaps, tests that cannot fail, production-only failures, and discrepancies between documentation and behavior.

The reviewer must produce a severity-ranked report with concrete reproduction evidence. Do not accept it at face value: reproduce each plausible issue, fix every confirmed critical/high issue, and fix or explicitly document every confirmed medium/low issue with evidence, mitigation, and the reason it remains residual risk. Add regression tests, rerun the complete quality suite, then run a fresh final adversarial pass whose reviewer verifies remediations and states pass/fail explicitly. Completion requires zero confirmed unresolved critical/high findings. Keep a concise `docs/adversarial-review.md` recording scope, checks performed, confirmed findings, remediations, residual risks, and final evidence. Do not include secrets, exploit payloads that target external systems, or private user data.

If neither a fresh subagent nor a genuinely isolated context is available, perform an internal adversarial pass, label it non-independent, record the limitation, and report **implementation complete; independent review pending**. Do not claim the independent-review acceptance criterion passed and never skip the review silently.

## Documentation and repository readiness

Provide at minimum:

- `README.md` with product overview, screenshots or verified UI images if practical, architecture, local setup, all quality commands, D1 migrations, Cloudflare preview/deployment instructions, privacy limitations of cookie identity, and project status. Clearly list creation of the remote D1 database, account-specific IDs, remote migrations, secrets, deployment, custom-domain setup, and production Cookie/HSTS verification as unperformed owner steps unless they were actually authorized and completed;
- `CONTRIBUTING.md`, a code of conduct, security reporting policy, and an explicit note that no open-source license has been selected yet unless the repository already contains one;
- `.env.example` or equivalent with placeholders only, Cloudflare configuration, migration files, and a production-readiness checklist;
- concise architecture/data-model and threat-model documentation explaining trust boundaries and material tradeoffs;
- no generated build output, local databases, browser traces, credentials, or machine-specific files committed.

Do not choose an open-source license on the owner’s behalf. Keep copyright headers and branding minimal so a license can be selected later.

## Required completion evidence

Before finishing:

1. Inspect the final diff and repository status for accidental files and secrets.
2. Start from a clean local database, apply all migrations, build, and exercise the app through its real local server.
3. Run the formatter check, linter, type checker, unit tests, integration tests, end-to-end tests, accessibility checks, production build, and any platform configuration validation.
4. Complete the independent adversarial-review loop and rerun every affected test plus the full suite.
5. Confirm both locale bundles are complete and manually inspect representative desktop and 360 px mobile screens in both languages.
6. Verify documentation commands from a clean checkout or an equivalent clean environment.

Your final response must lead with one precise status: **implementation ready; deployment configuration locally verified**, **implementation complete; independent review pending**, or **deployed and remotely verified**. Use the last status only if deployment was explicitly authorized and tested remotely. Summarize implemented behavior and architecture, list exact verification commands and results, link to material files, disclose residual risk and every unverified external step, and give only the minimal owner actions needed next. Do not claim success for checks you did not run.
