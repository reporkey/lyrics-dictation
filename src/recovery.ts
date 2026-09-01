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

export const blockRecoveryWritesAfterDeletion = () => {
  recoveryWritesBlocked = true;
};

export const readRecovery = async (sessionId: string) =>
  (await database).get("drafts", sessionId);

export const writeRecovery = async (record: RecoveryRecord) => {
  if (recoveryWritesBlocked) return;
  const db = await database;
  if (recoveryWritesBlocked) return;
  await db.put("drafts", record);
};

export const deleteRecovery = async (sessionId: string) =>
  (await database).delete("drafts", sessionId);

export const deleteRecoveryForSong = async (songId: string) => {
  const transaction = (await database).transaction("drafts", "readwrite");
  let cursor = await transaction.store.index("by-song").openKeyCursor(songId);
  while (cursor) {
    await transaction.store.delete(cursor.primaryKey);
    cursor = await cursor.continue();
  }
  await transaction.done;
};

export const deleteRecoveryIfConfirmed = async (
  sessionId: string,
  draftText: string,
) => {
  const transaction = (await database).transaction("drafts", "readwrite");
  const current = await transaction.store.get(sessionId);
  const matches = current?.draftText === draftText;
  if (matches) await transaction.store.delete(sessionId);
  await transaction.done;
  return matches;
};

export const deleteAllRecovery = async () => (await database).clear("drafts");

export const hasAnyRecovery = async () =>
  (await (await database).count("drafts")) > 0;

const RECOVERY_NAMESPACE_KEY = "device-membership";

export const reconcileRecoveryNamespace = async (namespace: string) => {
  const transaction = (await database).transaction(
    ["drafts", "meta"],
    "readwrite",
  );
  const previous = await transaction
    .objectStore("meta")
    .get(RECOVERY_NAMESPACE_KEY);
  if (previous && previous !== namespace) {
    await transaction.objectStore("drafts").clear();
  }
  await transaction.objectStore("meta").put(namespace, RECOVERY_NAMESPACE_KEY);
  await transaction.done;
};

const DELETION_PENDING_KEY = "lyrics-dictation:deletion-pending";
export type DeletionStage = "server" | "local";

export const markDeletionPending = async (stage: DeletionStage) => {
  const failures: unknown[] = [];
  let persisted = false;
  try {
    await (await deletionDatabase).put("markers", stage, DELETION_PENDING_KEY);
    persisted = true;
  } catch (caught) {
    failures.push(caught);
  }
  try {
    localStorage.setItem(DELETION_PENDING_KEY, stage);
    persisted = true;
  } catch (caught) {
    failures.push(caught);
  }
  if (!persisted) throw failures[0] ?? new Error("DELETION_MARKER_UNAVAILABLE");
};

export const readDeletionPendingStage =
  async (): Promise<DeletionStage | null> => {
    const values: Array<string | null | undefined> = [];
    try {
      values.push(localStorage.getItem(DELETION_PENDING_KEY));
    } catch {
      values.push(undefined);
    }
    try {
      values.push(
        await (await deletionDatabase).get("markers", DELETION_PENDING_KEY),
      );
    } catch {
      values.push(undefined);
    }
    // The local stage is only written after cloud deletion succeeds, so it is
    // authoritative if one backing store missed the transition.
    if (values.includes("local")) return "local";
    if (values.includes("server")) return "server";
    // Markers from the earlier local-only format remain recoverable.
    return values.some((value) => value !== null && value !== undefined)
      ? "local"
      : null;
  };

export const hasLocalDeletionPending = async () =>
  (await readDeletionPendingStage()) !== null;

export const finishPendingLocalDeletion = async () => {
  const failures: unknown[] = [];
  try {
    await deleteAllRecovery();
  } catch (caught) {
    failures.push(caught);
  }
  let storageAccessible = true;
  try {
    localStorage.getItem(DELETION_PENDING_KEY);
  } catch {
    storageAccessible = false;
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
        failures.push(caught);
      }
    }
  }
  if (failures.length) throw failures[0];
  if (storageAccessible) {
    localStorage.removeItem(DELETION_PENDING_KEY);
  }
  await (await deletionDatabase).delete("markers", DELETION_PENDING_KEY);
};
