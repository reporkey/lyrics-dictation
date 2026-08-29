export const PREFERENCES_CLEARED_EVENT = "lyrics-dictation:preferences-cleared";
const PREFERENCES_CHANNEL = "lyrics-dictation:preferences";

export interface PreferenceChange {
  key: string;
  value: string | null;
}

const listeners = new Set<(change: PreferenceChange) => void>();
let channel: BroadcastChannel | null | undefined;

const getChannel = () => {
  if (channel !== undefined) return channel;
  channel =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel(PREFERENCES_CHANNEL)
      : null;
  if (channel) {
    channel.onmessage = (event) => {
      if (
        event.data?.type === "changed" &&
        typeof event.data.key === "string"
      ) {
        const value =
          typeof event.data.value === "string" ? event.data.value : null;
        for (const listener of listeners) {
          listener({ key: event.data.key, value });
        }
      } else if (event.data?.type === "cleared") {
        window.dispatchEvent(new Event(PREFERENCES_CLEARED_EVENT));
      }
    };
  }
  return channel;
};

export const readPreference = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const writePreference = (key: string, value: string): boolean => {
  let persisted = false;
  try {
    localStorage.setItem(key, value);
    persisted = true;
  } catch {
    // Keep the current page and other open tabs usable even when storage is
    // denied. The choice simply cannot survive a full browser restart.
  }
  const change = { key, value };
  for (const listener of listeners) listener(change);
  try {
    getChannel()?.postMessage({ type: "changed", ...change });
  } catch {
    // The native storage event remains the compatibility path.
  }
  return persisted;
};

export const subscribePreferenceChanges = (
  listener: (change: PreferenceChange) => void,
) => {
  listeners.add(listener);
  getChannel();
  const onStorage = (event: StorageEvent) => {
    if (event.key) listener({ key: event.key, value: event.newValue });
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
};

export const notifyPreferencesCleared = () => {
  window.dispatchEvent(new Event(PREFERENCES_CLEARED_EVENT));
  try {
    getChannel()?.postMessage({ type: "cleared" });
  } catch {
    // Open tabs also receive the localStorage removals where available.
  }
};
