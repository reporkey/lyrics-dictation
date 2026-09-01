# Threat model

## Trust boundaries

- The browser UI and every request field are untrusted. The Worker trusts only a validated anonymous HttpOnly credential and D1 state derived from it.
- One credential represents one device. It maps through `device_memberships` to exactly one private or shared data space; clients never submit identity or data-space IDs.
- D1 is authoritative for synchronized lyrics and practice data. IndexedDB is a same-device recovery buffer and is cleared after a confirmed replacement join.
- A pairing code is a temporary bearer capability. Possession authorizes previewing limited replacement counts and joining its target data space, but never reveals another credential or raw database identifier.

## Material threats and controls

| Threat                               | Control                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Credential theft                     | Secure host-only production cookie, HttpOnly, SameSite=Lax, no credential in JavaScript or logs, hash-only storage                                                             |
| Pairing-code guessing or replay      | 60 bits of cryptographic randomness, ten-minute expiry, credential-scoped rate limits, one-time claim, hash-only storage, invalidation on membership changes                   |
| Cross-site mutation                  | Exact same-origin validation before identity creation or mutation; restrictive response headers and no CORS exposure                                                           |
| IDOR or cross-group reads            | Every content query uses the data space resolved from the credential; public device IDs only address members already joined to the actor's space                               |
| Stale write after leave/removal/join | Membership batches increment the data-space version; content writes require the version resolved with the request and fail closed after a membership change                    |
| Old response replay after join       | The joining identity's earlier idempotency responses are replaced atomically with content-free conflict tombstones; delayed retries cannot expose or reinsert replaced records |
| Partial join, leave, or removal      | D1 `batch()` is the atomic boundary; mutation tokens and optimistic workspace versions make concurrent membership changes no-op or conflict rather than partially apply        |
| Data loss on join                    | Read-only preview first; server-enforced second confirmation when cloud records exist; client confirmation also covers IndexedDB recovery; no merge is implied                 |
| Data loss on leave/removal           | Full songs and sessions are cloned in the same atomic batch before membership moves; composite keys preserve record IDs in both divergent spaces                               |
| Group deletion by one member         | UI removes the delete action and the API returns `PAIRING_EXIT_REQUIRED`; a member must first snapshot and leave                                                               |
| Stored script injection              | Shared validation, React text rendering, plain-text editor/import path, CSP, and stored-XSS integration/E2E fixtures                                                           |
| Sensitive logs or caches             | Structured logs exclude credentials, pairing codes, lyrics, and drafts; private API responses use browser and CDN `no-store` headers                                           |
| Browser fingerprinting               | Device management stores only normalized platform, browser family, major version, and coarse device type; raw User-Agent and hardware identifiers are discarded                |

## Known limitations

- There is no account, recovery email, or administrator. Losing all device credentials loses access.
- A person who sees a still-valid pairing code can join the group. The code must be transferred through a trusted channel.
- Device last-active time is approximate because the identity sliding renewal is intentionally rate-limited.
- Cross-device updates revalidate through normal requests and focus/visibility changes; there is no real-time push channel.
- Client storage can fail. A per-membership recovery namespace makes the next bootstrap clear obsolete drafts even if the browser terminated immediately after a confirmed server join; if IndexedDB itself is unavailable, bootstrap surfaces an error instead of exposing joined data with uncertain recovery state.
