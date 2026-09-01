import { openDB, type DBSchema } from "idb";

export interface RecoveryRecord {
  sessionId: string;
  songId: string;
  draftText: string;
  serverVersion: number;
  updatedAt: number;
}

interface RecoveryDatabase extends DBSchema {
  drafts: {
    key: string;
    value: RecoveryRecord;
    indexes: { "by-song": string };
  };
  meta: {
    key: string;
    value: string;
  };
}

interface DeletionDatabase extends DBSchema {
  markers: {
    key: string;
    value: string;
  };
}

const database = openDB<RecoveryDatabase>("lyrics-dictation-recovery", 3, {
  upgrade(db, oldVersion, _newVersion, transaction) {
    const store =
      oldVersion < 1
        ? db.createObjectStore("drafts", { keyPath: "sessionId" })
        : transaction.objectStore("drafts");
    if (oldVersion < 2) store.createIndex("by-song", "songId");
    if (oldVersion < 3) db.createObjectStore("meta");
  },
});

const deletionDatabase = openDB<DeletionDatabase>(
  "lyrics-dictation-deletion",
  1,
  {
    upgrade(db) {
      db.createObjectStore("markers");
    },
  },
);

let recoveryWritesBlocked = false;
let recoveryWriteGeneration = 0;

export const invalidateRecoveryWrites = () => {
  recoveryWriteGeneration += 1;
};

export const blockRecoveryWritesAfterDeletion = () => {
  recoveryWritesBlocked = true;
  invalidateRecoveryWrites();
};

export const resumeRecoveryWritesAfterCancelledDeletion = () => {
  recoveryWritesBlocked = false;
  invalidateRecoveryWrites();
};

export const readRecovery = async (sessionId: string) =>
  (await database).get("drafts", sessionId);

export const writeRecovery = async (record: RecoveryRecord) => {
  const generation = recoveryWriteGeneration;
  if (recoveryWritesBlocked) return;
  const db = await database;
  if (recoveryWritesBlocked || generation !== recoveryWriteGeneration) return;
  await db.put("drafts", record);
};

export const deleteRecovery = async (sessionId: string) =>
  (await database).delete("drafts", sessionId);

export const deleteRecoveryForSong = async (songId: string) => {
  const transaction = (await database).transaction("drafts", "readwrite");
  const work = (async () => {
    let cursor = await transaction.store.index("by-song").openKeyCursor(songId);
    while (cursor) {
      await transaction.store.delete(cursor.primaryKey);
      cursor = await cursor.continue();
    }
  })();
  const [operations, completion] = await Promise.allSettled([
    work,
    transaction.done,
  ]);
  if (operations.status === "rejected") throw operations.reason;
  if (completion.status === "rejected") throw completion.reason;
};

export const deleteRecoveryIfConfirmed = async (
  sessionId: string,
  draftText: string,
) => {
  const transaction = (await database).transaction("drafts", "readwrite");
  let matches = false;
  const work = (async () => {
    const current = await transaction.store.get(sessionId);
    matches = current?.draftText === draftText;
    if (matches) await transaction.store.delete(sessionId);
  })();
  const [operations, completion] = await Promise.allSettled([
    work,
    transaction.done,
  ]);
  if (operations.status === "rejected") throw operations.reason;
  if (completion.status === "rejected") throw completion.reason;
  return matches;
};

export const deleteAllRecovery = async () => {
  const transaction = (await database).transaction(
    ["drafts", "meta"],
    "readwrite",
  );
  const [operations, completion] = await Promise.allSettled([
    Promise.all([
      transaction.objectStore("drafts").clear(),
      transaction.objectStore("meta").clear(),
    ]),
    transaction.done,
  ]);
  if (operations.status === "rejected") throw operations.reason;
  if (completion.status === "rejected") throw completion.reason;
};

export const hasAnyRecovery = async () =>
  (await (await database).count("drafts")) > 0;

const RECOVERY_NAMESPACE_KEY = "device-membership";

export const reconcileRecoveryNamespace = async (namespace: string) => {
  const transaction = (await database).transaction(
    ["drafts", "meta"],
    "readwrite",
  );
  let previous: string | undefined;
  let clearedUnscopedDrafts = false;
  const work = (async () => {
    previous = await transaction
      .objectStore("meta")
      .get(RECOVERY_NAMESPACE_KEY);
    const drafts = transaction.objectStore("drafts");
    if (previous && previous !== namespace) {
      await drafts.clear();
    } else if (!previous && (await drafts.count()) > 0) {
      // Version-2 recovery records predate identity namespaces. They cannot be
      // proven to belong to the current anonymous identity after a cookie
      // reset, so the v3 migration must fail closed instead of adopting them.
      clearedUnscopedDrafts = true;
      await transaction.objectStore("drafts").clear();
    }
    await transaction
      .objectStore("meta")
      .put(namespace, RECOVERY_NAMESPACE_KEY);
  })();
  const [operations, completion] = await Promise.allSettled([
    work,
    transaction.done,
  ]);
  if (operations.status === "rejected") throw operations.reason;
  if (completion.status === "rejected") throw completion.reason;
  return Boolean((previous && previous !== namespace) || clearedUnscopedDrafts);
};

const DELETION_PENDING_KEY = "lyrics-dictation:deletion-pending";
export type DeletionStage = "server" | "local";
type DeletionMarkerStage = DeletionStage | "cancelled";
export interface DeletionMarker {
  stage: DeletionMarkerStage;
  attemptId: string;
  updatedAt: number;
  recoveryNamespace?: string;
}

const parseDeletionMarker = (
  value: string | null | undefined,
): DeletionMarker | null => {
  if (!value) return null;
  if (value === "server" || value === "local") {
    return { stage: value, attemptId: "legacy", updatedAt: 0 };
  }
  try {
    const parsed = JSON.parse(value) as Partial<DeletionMarker>;
    if (
      (parsed.stage === "server" ||
        parsed.stage === "local" ||
        parsed.stage === "cancelled") &&
      typeof parsed.attemptId === "string" &&
      typeof parsed.updatedAt === "number" &&
      (parsed.recoveryNamespace === undefined ||
        typeof parsed.recoveryNamespace === "string")
    )
      return parsed as DeletionMarker;
  } catch {
    // Unknown markers from an older client are treated as local cleanup work.
  }
  return { stage: "local", attemptId: "legacy", updatedAt: 0 };
};

const newestDeletionMarker = (markers: DeletionMarker[]) =>
  markers.sort(
    (left, right) =>
      right.updatedAt - left.updatedAt ||
      (right.stage === "cancelled" ? 1 : 0) -
        (left.stage === "cancelled" ? 1 : 0),
  )[0] ?? null;

export const markDeletionPending = async (
  stage: DeletionStage,
  attemptId: string,
  recoveryNamespace: string,
) => {
  const failures: unknown[] = [];
  let persisted = false;
  let indexedPersisted = false;
  let localPersisted = false;
  const marker = JSON.stringify({
    stage,
    attemptId,
    updatedAt: Date.now(),
    recoveryNamespace,
  });
  try {
    await (await deletionDatabase).put("markers", marker, DELETION_PENDING_KEY);
    persisted = true;
    indexedPersisted = true;
  } catch (caught) {
    failures.push(caught);
  }
  try {
    localStorage.setItem(DELETION_PENDING_KEY, marker);
    persisted = true;
    localPersisted = true;
  } catch (caught) {
    failures.push(caught);
  }
  if (!persisted) throw failures[0] ?? new Error("DELETION_MARKER_UNAVAILABLE");
  return { indexedPersisted, localPersisted };
};

export const readDeletionPendingMarker =
  async (): Promise<DeletionMarker | null> => {
    const markers: DeletionMarker[] = [];
    try {
      const marker = parseDeletionMarker(
        localStorage.getItem(DELETION_PENDING_KEY),
      );
      if (marker) markers.push(marker);
    } catch {
      // IndexedDB remains available as the second durable copy.
    }
    try {
      const marker = parseDeletionMarker(
        await (await deletionDatabase).get("markers", DELETION_PENDING_KEY),
      );
      if (marker) markers.push(marker);
    } catch {
      // localStorage remains available as the second durable copy.
    }
    const newest = newestDeletionMarker(markers);
    return newest?.stage === "cancelled" ? null : newest;
  };

export const readDeletionPendingStage =
  async (): Promise<DeletionStage | null> =>
    ((await readDeletionPendingMarker())?.stage as DeletionStage | undefined) ??
    null;

export const hasLocalDeletionPending = async () =>
  (await readDeletionPendingStage()) !== null;

export const cancelPendingDeletion = async (attemptId: string) => {
  const failures: unknown[] = [];
  let persisted = false;
  const marker = JSON.stringify({
    stage: "cancelled",
    attemptId,
    updatedAt: Date.now(),
  });
  try {
    localStorage.setItem(DELETION_PENDING_KEY, marker);
    persisted = true;
  } catch (caught) {
    failures.push(caught);
  }
  try {
    await (await deletionDatabase).put("markers", marker, DELETION_PENDING_KEY);
    persisted = true;
  } catch (caught) {
    failures.push(caught);
  }
  if (!persisted) throw failures[0] ?? new Error("DELETION_MARKER_UNAVAILABLE");
};

export const clearCancelledDeletionMarker = async (attemptId: string) => {
  let localMarker: string | null;
  let indexedMarker: string | undefined;
  try {
    localMarker = localStorage.getItem(DELETION_PENDING_KEY);
    indexedMarker = await (
      await deletionDatabase
    ).get("markers", DELETION_PENDING_KEY);
  } catch {
    // Keep the cancellation tombstone when either durable copy cannot be
    // inspected. It must continue to override a stale pending marker in the
    // other store.
    return false;
  }

  const markers = [
    parseDeletionMarker(localMarker),
    parseDeletionMarker(indexedMarker),
  ].filter((marker): marker is DeletionMarker => marker !== null);
  const newest = newestDeletionMarker(markers);
  if (newest?.stage !== "cancelled" || newest.attemptId !== attemptId)
    return false;

  const indexedDb = await deletionDatabase;
  const indexedTransaction = indexedDb.transaction("markers", "readwrite");
  const currentIndexed =
    await indexedTransaction.store.get(DELETION_PENDING_KEY);
  if (currentIndexed === indexedMarker) {
    await indexedTransaction.store.delete(DELETION_PENDING_KEY);
  }
  await indexedTransaction.done;

  // Delete the local copy last. If cleanup is interrupted, a remaining
  // cancellation tombstone is harmless; a remaining active marker is not.
  if (localStorage.getItem(DELETION_PENDING_KEY) === localMarker) {
    localStorage.removeItem(DELETION_PENDING_KEY);
  }
  return true;
};

export const finishPendingLocalDeletion = async ({
  localMarkerMayExist = true,
}: { localMarkerMayExist?: boolean } = {}) => {
  const cleanupFailures: unknown[] = [];
  try {
    await deleteAllRecovery();
  } catch (caught) {
    cleanupFailures.push(caught);
  }
  let storageAccessible = true;
  try {
    localStorage.getItem(DELETION_PENDING_KEY);
  } catch {
    storageAccessible = false;
    if (localMarkerMayExist)
      cleanupFailures.push(new Error("LOCAL_STORAGE_UNAVAILABLE"));
  }
  if (storageAccessible) {
    for (const key of [
      "lyrics-dictation:locale",
      "lyrics-dictation:theme",
      "lyrics-dictation:library-view",
      "lyrics-dictation:live-check",
    ]) {
      try {
        localStorage.removeItem(key);
      } catch (caught) {
        cleanupFailures.push(caught);
      }
    }
  }
  if (cleanupFailures.length) throw cleanupFailures[0];

  const markerFailures: unknown[] = [];
  if (storageAccessible) {
    try {
      localStorage.removeItem(DELETION_PENDING_KEY);
    } catch (caught) {
      markerFailures.push(caught);
    }
  }
  try {
    await (await deletionDatabase).delete("markers", DELETION_PENDING_KEY);
  } catch (caught) {
    markerFailures.push(caught);
  }
  if (markerFailures.length) throw markerFailures[0];
};
