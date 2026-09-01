import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  ApiClientError,
  blockApiAfterDeletion,
  bootstrapApi,
  broadcastDataChanged,
  broadcastDataDeleted,
  clientTabId,
  DATA_SPACE_REPLACED_STORAGE_KEY,
  deleteCloudData,
} from "./api";
import { detectBrowserLocale, readLocalePreference, useI18n } from "./i18n";
import type { Locale } from "./lib/constants";
import type { BootstrapPayload } from "./lib/types";
import { notifyPreferencesCleared } from "./preferences";
import {
  blockRecoveryWritesAfterDeletion,
  finishPendingLocalDeletion,
  hasLocalDeletionPending,
  markDeletionPending,
  readDeletionPendingStage,
  reconcileRecoveryNamespace,
} from "./recovery";

const loadBootstrap = async () => {
  const payload = await bootstrapApi<BootstrapPayload>();
  await reconcileRecoveryNamespace(payload.recoveryNamespace);
  return payload;
};

interface AppDataValue {
  data: BootstrapPayload | null;
  loading: boolean;
  error: Error | null;
  deleting: boolean;
  deleted: boolean;
  reload: () => Promise<void>;
  changeLocale: (locale: Locale) => Promise<void>;
  beginDeletion: (hideContent?: boolean) => void;
  reportDeletionFailure: () => void;
  clearAfterDeletion: () => void;
}

const AppDataContext = createContext<AppDataValue | null>(null);

export const AppDataProvider = ({ children }: { children: ReactNode }) => {
  const { locale, setLocale, applyLocale } = useI18n();
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const didStartInitialLoad = useRef(false);
  const bootstrapSyncingRef = useRef(false);
  const pendingLocaleRef = useRef<Locale | null>(null);
  const dataRef = useRef<BootstrapPayload | null>(null);
  const localeMutationChainRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const deletedRef = useRef(false);

  const beginDeletion = useCallback(
    (hideContent = false) => {
      if (!deletedRef.current) generationRef.current += 1;
      deletedRef.current = true;
      bootstrapSyncingRef.current = false;
      pendingLocaleRef.current = null;
      blockApiAfterDeletion();
      blockRecoveryWritesAfterDeletion();
      const clearedData: BootstrapPayload = {
        locale,
        localeExplicit: false,
        settingsVersion: 1,
        songs: [],
        recentSessions: [],
        devices: [],
        paired: false,
        recoveryNamespace: dataRef.current?.recoveryNamespace ?? "",
      };
      dataRef.current = clearedData;
      setData(clearedData);
      setError(null);
      setLoading(false);
      setDeleting(hideContent);
    },
    [locale],
  );

  const reportDeletionFailure = useCallback(() => setDeleting(false), []);

  const clearAfterDeletion = useCallback(() => {
    beginDeletion();
    notifyPreferencesCleared();
    setDeleting(false);
    setDeleted(true);
  }, [beginDeletion]);

  const resumePendingDeletion = useCallback(async () => {
    beginDeletion(true);
    try {
      if ((await readDeletionPendingStage()) === "server") {
        await deleteCloudData();
        await markDeletionPending("local");
      }
      await finishPendingLocalDeletion();
      broadcastDataDeleted();
      clearAfterDeletion();
    } catch (caught) {
      setData(null);
      setDeleting(false);
      setError(caught instanceof Error ? caught : new Error("UNKNOWN"));
    }
  }, [beginDeletion, clearAfterDeletion]);

  const reload = useCallback(async () => {
    if (await hasLocalDeletionPending()) {
      await resumePendingDeletion();
      return;
    }
    if (deletedRef.current) return;
    const generation = ++generationRef.current;
    bootstrapSyncingRef.current = true;
    try {
      setLoading(true);
      setError(null);
      const payload = await loadBootstrap();
      if (generation !== generationRef.current || deletedRef.current) return;
      dataRef.current = payload;
      setData(payload);
      deletedRef.current = false;
      setDeleted(false);
      if (!pendingLocaleRef.current) {
        const preference = readLocalePreference();
        if (
          preference &&
          (preference !== payload.locale || !payload.localeExplicit)
        ) {
          pendingLocaleRef.current = preference;
        } else if (preference) {
          applyLocale(preference);
        } else if (payload.localeExplicit) {
          setLocale(payload.locale);
        } else {
          applyLocale(detectBrowserLocale());
        }
      }
      if (pendingLocaleRef.current) {
        let synchronized = payload;
        while (pendingLocaleRef.current) {
          const requested: Locale = pendingLocaleRef.current;
          const result = await api<{
            locale: Locale;
            localeExplicit: boolean;
            version: number;
          }>("/api/settings", {
            method: "PATCH",
            body: JSON.stringify({
              locale: requested,
              version: synchronized.settingsVersion,
            }),
          });
          if (generation !== generationRef.current || deletedRef.current)
            return;
          synchronized = {
            ...synchronized,
            locale: result.locale,
            localeExplicit: result.localeExplicit,
            settingsVersion: result.version,
          };
          if (pendingLocaleRef.current === requested) {
            pendingLocaleRef.current = null;
          }
        }
        dataRef.current = synchronized;
        setData(synchronized);
        applyLocale(synchronized.locale);
        broadcastDataChanged();
      }
    } catch (caught) {
      if (generation === generationRef.current && !deletedRef.current) {
        setError(caught instanceof Error ? caught : new Error("UNKNOWN"));
      }
    } finally {
      if (generation === generationRef.current && !deletedRef.current) {
        bootstrapSyncingRef.current = false;
        setLoading(false);
      }
    }
  }, [applyLocale, resumePendingDeletion, setLocale]);

  useEffect(() => {
    if (didStartInitialLoad.current) return;
    didStartInitialLoad.current = true;
    void reload();
  }, [reload]);

  useEffect(() => {
    const channel =
      typeof BroadcastChannel === "function"
        ? new BroadcastChannel("lyrics-dictation:data")
        : null;
    if (channel) {
      channel.onmessage = (event) => {
        if (
          event.data?.type === "deletion-started" &&
          event.data?.sourceTabId !== clientTabId
        )
          beginDeletion(true);
        else if (event.data?.type === "data-deleted") clearAfterDeletion();
        else if (!deletedRef.current) void reload();
      };
    }
    const onVisibility = () => {
      if (!deletedRef.current && document.visibilityState === "visible")
        void reload();
    };
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === "lyrics-dictation:deletion-pending" &&
        event.newValue !== null
      ) {
        beginDeletion(true);
      } else if (event.key === "lyrics-dictation:data-deletion-started") {
        beginDeletion(true);
      } else if (event.key === "lyrics-dictation:data-deleted") {
        clearAfterDeletion();
      } else if (
        event.key === DATA_SPACE_REPLACED_STORAGE_KEY &&
        event.newValue !== null &&
        !deletedRef.current
      ) {
        void reload();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("storage", onStorage);
    return () => {
      channel?.close();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("storage", onStorage);
    };
  }, [beginDeletion, clearAfterDeletion, reload]);

  const synchronizePendingLocale = useCallback(async (generation: number) => {
    let changed = false;
    while (pendingLocaleRef.current) {
      if (
        generation !== generationRef.current ||
        deletedRef.current ||
        bootstrapSyncingRef.current
      )
        return;
      const requested = pendingLocaleRef.current;
      const current = dataRef.current;
      if (!current) return;
      if (current.locale === requested && current.localeExplicit) {
        if (pendingLocaleRef.current === requested)
          pendingLocaleRef.current = null;
        continue;
      }
      let result: {
        locale: Locale;
        localeExplicit: boolean;
        version: number;
      };
      try {
        result = await api<typeof result>("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({
            locale: requested,
            version: current.settingsVersion,
          }),
        });
      } catch (caught) {
        if (
          caught instanceof ApiClientError &&
          caught.code === "VERSION_CONFLICT" &&
          generation === generationRef.current &&
          !deletedRef.current
        ) {
          const refreshed = await loadBootstrap();
          if (generation !== generationRef.current || deletedRef.current)
            return;
          dataRef.current = refreshed;
          setData(refreshed);
          continue;
        }
        throw caught;
      }
      if (generation !== generationRef.current || deletedRef.current) return;
      const synchronized: BootstrapPayload = {
        ...current,
        locale: result.locale,
        localeExplicit: result.localeExplicit,
        settingsVersion: result.version,
      };
      dataRef.current = synchronized;
      setData(synchronized);
      if (pendingLocaleRef.current === requested)
        pendingLocaleRef.current = null;
      changed = true;
    }
    if (changed) broadcastDataChanged();
  }, []);

  const changeLocale = useCallback(
    (next: Locale) => {
      pendingLocaleRef.current = next;
      setLocale(next);
      if (deletedRef.current) {
        pendingLocaleRef.current = null;
        return Promise.resolve();
      }
      const generation = generationRef.current;
      if (!dataRef.current || bootstrapSyncingRef.current)
        return Promise.resolve();
      const task = localeMutationChainRef.current
        .catch(() => undefined)
        .then(() => synchronizePendingLocale(generation));
      localeMutationChainRef.current = task;
      return task;
    },
    [setLocale, synchronizePendingLocale],
  );

  const value = useMemo(
    () => ({
      data,
      loading,
      error,
      deleting,
      deleted,
      reload,
      changeLocale,
      beginDeletion,
      reportDeletionFailure,
      clearAfterDeletion,
    }),
    [
      data,
      loading,
      error,
      deleting,
      deleted,
      reload,
      changeLocale,
      beginDeletion,
      reportDeletionFailure,
      clearAfterDeletion,
    ],
  );
  return (
    <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>
  );
};

export const useAppData = () => {
  const value = useContext(AppDataContext);
  if (!value) throw new Error("useAppData must be used inside AppDataProvider");
  return value;
};
