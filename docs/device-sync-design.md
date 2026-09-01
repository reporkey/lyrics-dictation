# Device sync product and architecture decision

Status: confirmed implementation contract for the device-sync worktree.

## User-visible contract

1. Each anonymous HttpOnly identity cookie represents one device. A device can create a 12-character, human-readable pairing code valid for 10 minutes. The code is single-use; creating a replacement code invalidates any older active code for the same data space.
2. Entering a valid code first shows a preview. The preview states whether this device has cloud songs, active drafts, or completed history that would be replaced. Nothing changes during preview.
3. Joining with local records requires a separate explicit confirmation. The server rejects a join without that confirmation, and the client clears the joining device's IndexedDB recovery/cache only after the server confirms the atomic switch. There is no merge mode.
4. Paired devices share the cloud lyrics library, in-progress drafts, and complete dictation history. Locale, theme, and other presentation preferences remain per-device so one device cannot unexpectedly change another device's interface.
5. Every member can open device management, identify “this device,” see non-secret labels, normalized platform/browser descriptions, and last-active times, create a new code, leave, or remove another device. There is no group owner or privileged first device. Raw User-Agent strings and hardware identifiers are not stored.
6. Leaving or removal atomically clones the current shared songs, drafts, and history into a private data space for the departing device. The remaining group keeps its own copy. Both sides preserve record IDs and immediately stop observing later changes from the other side.
7. A device that is already in a multi-device group must leave before joining another group. This prevents entering a code from silently replacing data for unrelated group members.
8. “Delete all my data” is unavailable while paired and the API returns `PAIRING_EXIT_REQUIRED`. The device must leave first, then can delete its private copy.
9. A data space is considered a group only while it has at least two members. When a membership operation leaves one member, it automatically becomes a normal private space without an extra dissolve action.

## Security and failure contract

- Pairing codes use cryptographically secure randomness, are normalized for entry, stored in D1 only as SHA-256 hashes, never returned again after creation, and never written to logs.
- Code preview and join are origin-checked and separately rate-limited. Preview does not reserve a code; expiry, use, or membership changes may make the final join fail safely.
- Join, leave, removal, and auto-dissolve run as atomic D1 batches with optimistic data-space versions. A stale or concurrent membership mutation returns a stable conflict and cannot partially delete, clone, or reassign data.
- Every content query derives the data-space ID from the validated cookie membership. Client input never supplies an owner or data-space ID. Device-management operations use opaque public device IDs distinct from identity primary keys and credentials.
- Membership changes invalidate every outstanding code for the affected data space. A removed device keeps its credential; its next request resolves to its private cloned space without exposing whether another member initiated the removal.
- A replacement join turns the joining identity's earlier idempotency responses into content-free conflict tombstones. Delayed retries therefore cannot reveal or recreate records from the replaced private space.
- Retention cleanup removes an expired member without deleting an active group's shared data. An expired last member causes its private space and dependent data to be deleted.

## Storage model

- `identities`: one credential hash per browser/device plus last activity and expiry.
- `data_spaces`: versioned synchronization and membership-mutation boundary.
- `device_memberships`: one current data space per identity, a non-secret public device ID/label, normalized platform/browser metadata, and a recovery namespace that changes only when a join replaces local data.
- `songs` and `sessions`: owned by `data_space_id`; primary keys are composite so a leave snapshot can preserve IDs in two divergent spaces.
- `pairing_codes`: hashed, expiring, single-use capability targeting one data space.
- `settings`, `rate_limits`, and idempotency records remain identity-scoped. Replacement joins scrub prior idempotency response bodies while retaining safe tombstones that reject stale retries.

Cloudflare D1 `batch()` is the transaction boundary. The implementation does not issue generic `BEGIN`/`COMMIT` from Worker code. This follows the current Cloudflare Worker binding contract that a batch executes sequentially and rolls back the whole sequence if a statement fails.

The client persists the last recovery namespace in the same IndexedDB database as drafts. Bootstrap clears obsolete drafts before exposing joined data whenever the namespace changes, covering a browser termination after the server commits a join but before the click handler finishes local cleanup. Leaving or removal preserves the namespace and therefore preserves same-device recovery.

## Acceptance mapping

| Requested behavior                   | Authoritative evidence                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| A creates a code                     | Worker integration plus browser device-management test             |
| B enters and binds                   | Preview/join integration and two-browser-context E2E               |
| Library/history sync                 | Cross-cookie CRUD/session integration and E2E revalidation         |
| Manage, leave, remove, add           | API authorization tests and localized management E2E               |
| Departed device retains but diverges | Snapshot equality followed by bidirectional isolation test         |
| B replacement confirmation           | Server rejection, UI confirmation, and local recovery cleanup test |
| Grouped delete blocked               | API and disabled/redirecting UI test                               |
| One-member auto-dissolve             | Membership-count and delete-eligibility integration test           |
