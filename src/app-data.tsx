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
  blockApiAfterDeletion,
  bootstrapApi,
  broadcastDataChanged,
  broadcastDataDeleted,
  clientTabId,
  deleteCloudData,
} from "./api";
import { useI18n } from "./i18n";
import type { Locale } from "./lib/constants";
import type { BootstrapPayload } from "./lib/types";
import {
  blockRecoveryWritesAfterDeletion,
  finishPendingLocalDeletion,
  hasLocalDeletionPending,
  markDeletionPending,
  readDeletionPendingStage,
} from "./recovery";

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
  const { locale, setLocale } = useI18n();
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const didStartInitialLoad = useRef(false);
  const bootstrapSyncingRef = useRef(false);
  const pendingLocaleRef = useRef<Locale | null>(null);
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
      setData({
        locale,
        settingsVersion: 1,
        songs: [],
        recentSessions: [],
      });
      setError(null);
      setLoading(false);
      setDeleting(hideContent);
    },
    [locale],
  );

  const reportDeletionFailure = useCallback(() => setDeleting(false), []);

  const clearAfterDeletion = useCallback(() => {
    beginDeletion();
    setDeleting(false);
    setDeleted(true);
  }, [beginDeletion]);

  const resumePendingDeletion = useCallback(async () => {
    beginDeletion(true);
    try {
      if (readDeletionPendingStage() === "server") {
        await deleteCloudData();
        markDeletionPending("local");
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
    if (hasLocalDeletionPending()) {
      await resumePendingDeletion();
      return;
    }
    if (deletedRef.current) return;
    const generation = ++generationRef.current;
    bootstrapSyncingRef.current = true;
    try {
      setLoading(true);
      setError(null);
      const payload = await bootstrapApi<BootstrapPayload>();
      if (generation !== generationRef.current || deletedRef.current) return;
      setData(payload);
      deletedRef.current = false;
      setDeleted(false);
      if (!pendingLocaleRef.current) {
        setLocale(payload.locale);
      } else {
        let synchronized = payload;
        while (pendingLocaleRef.current) {
          const requested: Locale = pendingLocaleRef.current;
          const result = await api<{ locale: Locale; version: number }>(
            "/api/settings",
            {
              method: "PATCH",
              body: JSON.stringify({
                locale: requested,
                version: synchronized.settingsVersion,
              }),
            },
          );
          if (generation !== generationRef.current || deletedRef.current)
            return;
          synchronized = {
            ...synchronized,
            locale: result.locale,
            settingsVersion: result.version,
          };
          if (pendingLocaleRef.current === requested) {
            pendingLocaleRef.current = null;
          }
        }
        setData(synchronized);
        setLocale(synchronized.locale);
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
  }, [resumePendingDeletion, setLocale]);

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

  const changeLocale = useCallback(
    async (next: Locale) => {
      const previous = locale;
      pendingLocaleRef.current = next;
      setLocale(next);
      if (deletedRef.current) {
        pendingLocaleRef.current = null;
        return;
      }
      const generation = generationRef.current;
      if (!data || bootstrapSyncingRef.current) return;
      try {
        const result = await api<{ locale: Locale; version: number }>(
          "/api/settings",
          {
            method: "PATCH",
            body: JSON.stringify({
              locale: next,
              version: data.settingsVersion,
            }),
          },
        );
        if (generation !== generationRef.current || deletedRef.current) return;
        setData((current) =>
          current
            ? {
                ...current,
                locale: result.locale,
                settingsVersion: result.version,
              }
            : current,
        );
        if (pendingLocaleRef.current === next) pendingLocaleRef.current = null;
        broadcastDataChanged();
      } catch (caught) {
        if (generation !== generationRef.current || deletedRef.current) return;
        if (pendingLocaleRef.current === next) pendingLocaleRef.current = null;
        setLocale(previous);
        throw caught;
      }
    },
    [data, locale, setLocale],
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
