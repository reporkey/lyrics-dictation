# Threat model

## Assets and boundaries

Assets are private imported lyrics, song metadata, drafts/progress, locale settings, and the anonymous bearer credential. The browser, Worker, and D1 are trusted application components; uploaded files, editor input, filenames, headers, URLs, cookies, and record IDs are untrusted. Cloudflare account security and the user's device/browser profile are outside the app's control.

## Material threats and controls

- **Cross-user access / IDOR:** the API never accepts an owner ID. Queries bind both record ID and identity derived from the cookie, returning the same not-found shape across owners.
- **Credential disclosure:** 256-bit random credentials are host-only, HttpOnly, Secure in production, SameSite=Lax, and absent from logs/JavaScript/D1. Only SHA-256 hashes are stored. The credential is a bearer token; malware, browser-profile theft, or a compromised origin can still steal/use it.
- **CSRF and cross-origin reads:** writes require an exact same-origin `Origin`; CORS is not opened. Origin validation runs before identity lookup or creation, so a cross-site request without its SameSite cookie cannot rotate the anonymous credential before being rejected. SameSite cookies add defense. Custom-domain/proxy configuration must preserve the public host/protocol.
- **XSS/content injection:** React/CodeMirror render imported values as text, no user HTML is injected, API errors are stable codes, and static responses set a restrictive CSP through `_headers`. API responses also set CSP, nosniff, frame denial, and no-referrer.
- **Cache leakage:** every API response and identity-setting response carries browser and CDN `no-store` directives. Production verification remains an owner step.
- **SQL injection:** all values use D1 parameter binding; source kind and actions are schema enums.
- **Unicode concealment:** dangerous controls, bidi formatting, and unpaired UTF-16 surrogates are rejected without echoing the raw character. Normalized grading excludes all whitespace, punctuation, and symbols. Format controls are accepted only inside a complete Emoji 15.1 RGI grapheme matched by a pinned data package; arbitrary tags, selectors, joiners, and modifiers are rejected. Runtime Unicode-data drift in browser/workerd segmentation and property data is covered by fixtures but remains a documented residual compatibility risk.
- **Lost/concurrent writes:** IndexedDB precedes debounced network persistence. Integer versions reject stale writes and conflict UI preserves local text. Logical mutations retain idempotency keys across response-loss retries; deterministic create IDs and reconciliation close ambiguous result-storage windows. First bootstrap is serialized across tabs. A device crash before the IndexedDB transaction commits, browser storage eviction, and a browser without both Web Locks and functional shared local storage remain possible.
- **Resource exhaustion:** request JSON is bounded to 1 MiB while streaming and oversized invalid attempts consume rate buckets. Autosave stores text without alignment. Interactive matrices have fixed cell budgets, very large documents use linear exact-equality checks, import and terminal-count checks are linear, and credential-scoped rate limits bound mutations. Platform-level DDoS protection remains an owner deployment concern.
- **Abuse:** credential-scoped fixed-window limits bound mutations/imports/destructive actions. This is not IP-based DDoS protection; Cloudflare platform controls should be configured if production abuse warrants it.
- **Deletion:** D1 atomically tombstones the credential hash and deletes the identity, cascading settings, songs, sessions, idempotency keys, and rate buckets. The tombstone outlives the cookie so stale requests cannot recreate the identity. Before the request, a durable browser marker and cross-tab signal block normal API/recovery writes; after success, a second marker stage independently clears IndexedDB and preferences and resumes after reload if interrupted. The cookie is expired with an absolute date and identity renewal rechecks the live row and tombstone. Backups, provider retention, and deletion guarantees beyond live D1 are not claimed.

## Privacy tradeoff

No account means no recovery and no cross-browser sync. Clearing the cookie loses access; copying it transfers full library access. The UI discloses both. No analytics are included.
