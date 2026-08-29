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
}

const database = openDB<RecoveryDatabase>("lyrics-dictation-recovery", 2, {
  upgrade(db, oldVersion, _newVersion, transaction) {
    const store =
      oldVersion < 1
        ? db.createObjectStore("drafts", { keyPath: "sessionId" })
        : transaction.objectStore("drafts");
    if (oldVersion < 2) store.createIndex("by-song", "songId");
  },
});

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

const DELETION_PENDING_KEY = "lyrics-dictation:deletion-pending";
export type DeletionStage = "server" | "local";

export const markDeletionPending = (stage: DeletionStage) => {
  localStorage.setItem(DELETION_PENDING_KEY, stage);
};

export const readDeletionPendingStage = (): DeletionStage | null => {
  const value = localStorage.getItem(DELETION_PENDING_KEY);
  if (value === "server" || value === "local") return value;
  // Markers from the earlier local-only format remain recoverable.
  return value === null ? null : "local";
};

export const hasLocalDeletionPending = () =>
  readDeletionPendingStage() !== null;

export const finishPendingLocalDeletion = async () => {
  const failures: unknown[] = [];
  try {
    await deleteAllRecovery();
  } catch (caught) {
    failures.push(caught);
  }
  for (const key of [
    "lyrics-dictation:locale",
    "lyrics-dictation:theme",
    "lyrics-dictation:library-view",
  ]) {
    try {
      localStorage.removeItem(key);
    } catch (caught) {
      failures.push(caught);
    }
  }
  if (failures.length) throw failures[0];
  localStorage.removeItem(DELETION_PENDING_KEY);
};
