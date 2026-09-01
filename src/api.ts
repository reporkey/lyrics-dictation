import type { ApiErrorPayload } from "./lib/types";

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export const idempotencyKey = () => crypto.randomUUID();

const activeRequests = new Set<AbortController>();
let blockedAfterDeletion = false;
export const clientTabId = crypto.randomUUID();

export const blockApiAfterDeletion = () => {
  blockedAfterDeletion = true;
  for (const controller of activeRequests) controller.abort();
  activeRequests.clear();
};

export const api = async <T>(
  path: string,
  init: RequestInit = {},
  allowWhileBlocked = false,
): Promise<T> => {
  if (blockedAfterDeletion && !allowWhileBlocked) {
    throw new ApiClientError("IDENTITY_NOT_FOUND", 404);
  }
  const controller = new AbortController();
  activeRequests.add(controller);
  let response: Response;
  const headers = new Headers({
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...Object.fromEntries(new Headers(init.headers).entries()),
  });
  const retryable = headers.has("Idempotency-Key");
  try {
    let attempt = 0;
    while (true) {
      try {
        response = await fetch(path, {
          credentials: "same-origin",
          ...init,
          headers,
          signal: controller.signal,
        });
        break;
      } catch {
        if (
          (!blockedAfterDeletion || allowWhileBlocked) &&
          retryable &&
          attempt === 0
        ) {
          attempt += 1;
          continue;
        }
        throw new ApiClientError(
          blockedAfterDeletion && !allowWhileBlocked
            ? "IDENTITY_NOT_FOUND"
            : "NETWORK",
          blockedAfterDeletion && !allowWhileBlocked ? 404 : 0,
        );
      }
    }
    const payload = (await response.json().catch(() => null)) as
      T | ApiErrorPayload | null;
    if (!response.ok) {
      const error =
        payload && typeof payload === "object" && "error" in payload
          ? (payload as ApiErrorPayload).error
          : undefined;
      throw new ApiClientError(
        error?.code ?? "UNKNOWN",
        response.status,
        error?.details,
      );
    }
    return payload as T;
  } finally {
    activeRequests.delete(controller);
  }
};

export const deleteCloudData = () =>
  api("/api/data", { method: "DELETE" }, true);

const bootstrapWithoutWebLocks = async <T>(): Promise<T> => {
  const lockKey = "lyrics-dictation:bootstrap-lock";
  const probeKey = `${lockKey}:probe`;
  try {
    localStorage.setItem(probeKey, "1");
    localStorage.removeItem(probeKey);
  } catch {
    // With storage disabled there is no safe cross-tab lease. A direct
    // bootstrap still keeps the app usable and avoids an uncaught exception.
    return api<T>("/api/bootstrap");
  }
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const now = Date.now();
    let lease: { token: string; expiresAt: number } | null = null;
    try {
      lease = JSON.parse(localStorage.getItem(lockKey) ?? "null") as {
        token: string;
        expiresAt: number;
      } | null;
    } catch {
      lease = null;
    }
    if (!lease || lease.expiresAt <= now) {
      localStorage.setItem(
        lockKey,
        JSON.stringify({ token, expiresAt: now + 10_000 }),
      );
      await Promise.resolve();
      const confirmed = localStorage.getItem(lockKey)?.includes(token);
      if (confirmed) {
        try {
          return await api<T>("/api/bootstrap");
        } finally {
          if (localStorage.getItem(lockKey)?.includes(token)) {
            localStorage.removeItem(lockKey);
          }
        }
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new ApiClientError("NETWORK", 0);
};

// Cookie-less bootstrap must be serialized across tabs. Otherwise two first
// requests can create different HttpOnly identities and the last Set-Cookie
// response can orphan data created under the other credential.
export const bootstrapApi = async <T>(): Promise<T> => {
  if (navigator.locks) {
    return navigator.locks.request("lyrics-dictation:bootstrap", () =>
      api<T>("/api/bootstrap"),
    );
  }
  return bootstrapWithoutWebLocks<T>();
};

const postDataMessage = (message: Record<string, unknown>) => {
  if (typeof BroadcastChannel !== "function") return;
  const channel = new BroadcastChannel("lyrics-dictation:data");
  channel.postMessage(message);
  channel.close();
};

export const broadcastDataChanged = () => {
  postDataMessage({
    type: "changed",
    sourceTabId: clientTabId,
    at: Date.now(),
  });
};

export const DATA_SPACE_REPLACED_STORAGE_KEY =
  "lyrics-dictation:data-space-replaced";

const broadcastLifecycle = (type: string, storageKey: string) => {
  try {
    postDataMessage({ type, sourceTabId: clientTabId, at: Date.now() });
  } catch {
    // The storage event below is the compatibility path.
  }
  try {
    localStorage.setItem(storageKey, crypto.randomUUID());
    localStorage.removeItem(storageKey);
  } catch {
    // BroadcastChannel remains the primary same-origin notification path when
    // storage is unavailable.
  }
};

export const broadcastDataSpaceReplaced = () =>
  broadcastLifecycle("data-space-replaced", DATA_SPACE_REPLACED_STORAGE_KEY);

export const broadcastDeletionStarted = () =>
  broadcastLifecycle(
    "deletion-started",
    "lyrics-dictation:data-deletion-started",
  );

export const broadcastSongDeleted = (songId: string) => {
  postDataMessage({ type: "song-deleted", songId, at: Date.now() });
};

export const broadcastSessionReplaced = (
  songId: string,
  sessionId: string | null,
) => {
  postDataMessage({
    type: "session-replaced",
    songId,
    sessionId,
    at: Date.now(),
  });
};

export const broadcastDataDeleted = () => {
  broadcastLifecycle("data-deleted", "lyrics-dictation:data-deleted");
};
