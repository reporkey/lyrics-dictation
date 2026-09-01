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
  acceptLifecycleToken,
  ApiClientError,
  blockApiAfterDeletion,
  bootstrapApi,
  broadcastDataChanged,
  broadcastDataDeleted,
  broadcastDeletionCancelled,
  clientTabId,
  DATA_CHANGED_STORAGE_KEY,
  DATA_SPACE_REPLACED_STORAGE_KEY,
  DELETION_CANCELLED_STORAGE_KEY,
  deleteCloudData,
  resumeApiAfterCancelledDeletion,
  setApiRecoveryNamespace,
} from "./api";
import { detectBrowserLocale, readLocalePreference, useI18n } from "./i18n";
import type { Locale } from "./lib/constants";
import type { BootstrapPayload } from "./lib/types";
import { notifyPreferencesCleared } from "./preferences";
import {
  blockRecoveryWritesAfterDeletion,
  cancelPendingDeletion,
  clearCancelledDeletionMarker,
  deleteAllRecovery,
  finishPendingLocalDeletion,
  hasLocalDeletionPending,
  invalidateRecoveryWrites,
  markDeletionPending,
  readDeletionPendingMarker,
  reconcileRecoveryNamespace,
  resumeRecoveryWritesAfterCancelledDeletion,
} from "./recovery";

class RecoveryReconciliationError extends Error {
  constructor(public readonly cause: unknown) {
    super("RECOVERY_RECONCILIATION_FAILED");
  }
}

const loadBootstrap = async () => {
  return bootstrapApi<BootstrapPayload>();
};

const reconcileAcceptedBootstrap = async (payload: BootstrapPayload) => {
  try {
    const recoveryNamespaceChanged = await reconcileRecoveryNamespace(
      payload.recoveryNamespace,
    );
    const serverNamespaceChanged = setApiRecoveryNamespace(
      payload.recoveryNamespace,
    );
    return serverNamespaceChanged || recoveryNamespaceChanged;
  } catch (caught) {
    // The server identity is authoritative. Move the mutation fence forward
    // even when local recovery cannot be reconciled, then hide the old UI.
    setApiRecoveryNamespace(payload.recoveryNamespace);
    throw new RecoveryReconciliationError(caught);
  }
};

interface AppDataValue {
  data: BootstrapPayload | null;
  loading: boolean;
  error: Error | null;
  deleting: boolean;
  deleted: boolean;
  dataRevision: number;
  dataSpaceReplacementVersion: number;
  dataSpaceNavigationVersion: number;
  reload: () => Promise<void>;
  refreshBeforeDeletion: (
    suppressReplacementNavigation?: boolean,
  ) => Promise<BootstrapPayload>;
  changeLocale: (locale: Locale) => Promise<void>;
  replaceDataSpace: (token: string, navigateAway?: boolean) => Promise<void>;
  beginDeletion: (hideContent?: boolean, attemptId?: string) => string;
  cancelDeletion: (attemptId: string) => boolean;
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
  const [dataRevision, setDataRevision] = useState(0);
  const [dataSpaceReplacementVersion, setDataSpaceReplacementVersion] =
    useState(0);
  const [dataSpaceNavigationVersion, setDataSpaceNavigationVersion] =
    useState(0);
  const didStartInitialLoad = useRef(false);
  const bootstrapSyncingRef = useRef(false);
  const pendingLocaleRef = useRef<Locale | null>(null);
  const dataRef = useRef<BootstrapPayload | null>(null);
  const localeMutationChainRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const deletedRef = useRef(false);
  const recentDataChangedTokensRef = useRef(new Set<string>());
  const lastDataSpaceReplacementRef = useRef<string | null>(null);
  const activeDeletionAttemptRef = useRef<string | null>(null);
  const finalizedDeletionAttemptsRef = useRef(
    new Map<string, "cancelled" | "completed">(),
  );
  const suppressNamespaceNavigationRef = useRef(false);

  const rememberFinalizedDeletion = useCallback(
    (attemptId: string, status: "cancelled" | "completed") => {
      const finalized = finalizedDeletionAttemptsRef.current;
      finalized.set(attemptId, status);
      while (finalized.size > 32) {
        const oldest = finalized.keys().next().value as string | undefined;
        if (!oldest) break;
        finalized.delete(oldest);
      }
    },
    [],
  );

  const beginDeletion = useCallback(
    (hideContent = false, requestedAttemptId?: string) => {
      const attemptId = requestedAttemptId ?? crypto.randomUUID();
      if (
        finalizedDeletionAttemptsRef.current.has(attemptId) ||
        (deletedRef.current && !activeDeletionAttemptRef.current)
      )
        return attemptId;
      if (
        activeDeletionAttemptRef.current &&
        activeDeletionAttemptRef.current !== attemptId
      )
        return activeDeletionAttemptRef.current;
      activeDeletionAttemptRef.current = attemptId;
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
      return attemptId;
    },
    [locale],
  );

  const reportDeletionFailure = useCallback(() => setDeleting(false), []);

  const cancelDeletion = useCallback(
    (attemptId: string) => {
      if (
        finalizedDeletionAttemptsRef.current.has(attemptId) ||
        (deletedRef.current && !activeDeletionAttemptRef.current) ||
        (activeDeletionAttemptRef.current &&
          activeDeletionAttemptRef.current !== attemptId)
      )
        return false;
      rememberFinalizedDeletion(attemptId, "cancelled");
      activeDeletionAttemptRef.current = null;
      generationRef.current += 1;
      deletedRef.current = false;
      resumeApiAfterCancelledDeletion();
      resumeRecoveryWritesAfterCancelledDeletion();
      setDeleting(false);
      setDeleted(false);
      setError(null);
      return true;
    },
    [rememberFinalizedDeletion],
  );

  const clearAfterDeletion = useCallback(() => {
    const attemptId = beginDeletion();
    rememberFinalizedDeletion(attemptId, "completed");
    activeDeletionAttemptRef.current = null;
    notifyPreferencesCleared();
    setDeleting(false);
    setDeleted(true);
  }, [beginDeletion, rememberFinalizedDeletion]);

  const resumePendingDeletion = useCallback(async () => {
    const marker = await readDeletionPendingMarker();
    if (!marker) return;
    const stage = marker.stage;
    let deletionNamespace = marker.recoveryNamespace;
    // Markers written by the pre-device-sync client had no namespace. Resolve
    // that one legacy case before blocking requests; current markers always
    // carry the exact namespace that the atomic DELETE must fence.
    if (stage === "server" && !deletionNamespace) {
      try {
        deletionNamespace = (await api<BootstrapPayload>("/api/bootstrap"))
          .recoveryNamespace;
      } catch (caught) {
        if (
          !(caught instanceof ApiClientError) ||
          caught.code !== "IDENTITY_NOT_FOUND"
        ) {
          setError(caught instanceof Error ? caught : new Error("UNKNOWN"));
          setLoading(false);
          return;
        }
      }
    }
    const attemptId = beginDeletion(true, marker.attemptId);
    let localMarkerMayExist = true;
    try {
      if (stage === "server") {
        await deleteCloudData(deletionNamespace);
        const localMarker = await markDeletionPending(
          "local",
          attemptId,
          deletionNamespace ?? "",
        );
        localMarkerMayExist = localMarker.localPersisted;
      }
      await finishPendingLocalDeletion({ localMarkerMayExist });
      broadcastDataDeleted();
      clearAfterDeletion();
    } catch (caught) {
      if (
        stage === "server" &&
        caught instanceof ApiClientError &&
        ["PAIRING_EXIT_REQUIRED", "RECOVERY_NAMESPACE_MISMATCH"].includes(
          caught.code,
        )
      ) {
        try {
          await cancelPendingDeletion(attemptId);
          cancelDeletion(attemptId);
          broadcastDeletionCancelled(attemptId);
          await clearCancelledDeletionMarker(attemptId);
          const cancellationGeneration = generationRef.current;
          const payload = await loadBootstrap();
          if (cancellationGeneration !== generationRef.current) return;
          await reconcileAcceptedBootstrap(payload);
          if (cancellationGeneration !== generationRef.current) return;
          dataRef.current = payload;
          setData(payload);
          setLoading(false);
          setError(
            caught.code === "RECOVERY_NAMESPACE_MISMATCH"
              ? new ApiClientError("PAIRING_EXIT_REQUIRED", 409)
              : caught,
          );
          return;
        } catch (cancellationFailure) {
          setError(
            cancellationFailure instanceof Error
              ? cancellationFailure
              : new Error("UNKNOWN"),
          );
        }
      } else {
        setError(caught instanceof Error ? caught : new Error("UNKNOWN"));
      }
      setData(null);
      setDeleting(false);
    }
  }, [beginDeletion, cancelDeletion, clearAfterDeletion]);

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
      const recoveryNamespaceChanged =
        await reconcileAcceptedBootstrap(payload);
      if (generation !== generationRef.current || deletedRef.current) return;
      if (recoveryNamespaceChanged) {
        invalidateRecoveryWrites();
        setData(null);
        setDataSpaceReplacementVersion((version) => version + 1);
        if (!suppressNamespaceNavigationRef.current)
          setDataSpaceNavigationVersion((version) => version + 1);
      }
      dataRef.current = payload;
      setData(payload);
      setDataRevision((revision) => revision + 1);
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
        if (caught instanceof RecoveryReconciliationError) {
          invalidateRecoveryWrites();
          dataRef.current = null;
          setData(null);
          setDataSpaceReplacementVersion((version) => version + 1);
          setDataSpaceNavigationVersion((version) => version + 1);
        }
        setError(caught instanceof Error ? caught : new Error("UNKNOWN"));
      }
    } finally {
      if (generation === generationRef.current && !deletedRef.current) {
        bootstrapSyncingRef.current = false;
        setLoading(false);
      }
    }
  }, [applyLocale, resumePendingDeletion, setLocale]);

  const refreshBeforeDeletion = useCallback(
    async (suppressReplacementNavigation = false) => {
      const generation = ++generationRef.current;
      let payload: BootstrapPayload;
      let recoveryNamespaceChanged: boolean;
      try {
        payload = await api<BootstrapPayload>("/api/bootstrap");
        if (generation !== generationRef.current || deletedRef.current)
          throw new ApiClientError("NETWORK", 0);
        recoveryNamespaceChanged = await reconcileAcceptedBootstrap(payload);
      } catch (caught) {
        invalidateRecoveryWrites();
        dataRef.current = null;
        setData(null);
        setDataSpaceReplacementVersion((version) => version + 1);
        if (!suppressReplacementNavigation)
          setDataSpaceNavigationVersion((version) => version + 1);
        setError(caught instanceof Error ? caught : new Error("UNKNOWN"));
        setLoading(false);
        throw caught;
      }
      if (generation !== generationRef.current || deletedRef.current)
        throw new ApiClientError("NETWORK", 0);
      dataRef.current = payload;
      setData(payload);
      setDataRevision((revision) => revision + 1);
      if (recoveryNamespaceChanged) {
        invalidateRecoveryWrites();
        setDataSpaceReplacementVersion((version) => version + 1);
        if (!suppressReplacementNavigation)
          setDataSpaceNavigationVersion((version) => version + 1);
      }
      setError(null);
      return payload;
    },
    [],
  );

  const replaceDataSpace = useCallback(
    async (token: string, navigateAway = true) => {
      const replacementToken = token || crypto.randomUUID();
      if (lastDataSpaceReplacementRef.current === replacementToken) return;
      lastDataSpaceReplacementRef.current = replacementToken;
      generationRef.current += 1;
      invalidateRecoveryWrites();
      dataRef.current = null;
      setData(null);
      setError(null);
      setLoading(true);
      setDataSpaceReplacementVersion((version) => version + 1);
      if (navigateAway) setDataSpaceNavigationVersion((version) => version + 1);
      try {
        await deleteAllRecovery();
        suppressNamespaceNavigationRef.current = !navigateAway;
        await reload();
      } catch (caught) {
        setError(caught instanceof Error ? caught : new Error("UNKNOWN"));
        setLoading(false);
        throw caught;
      } finally {
        suppressNamespaceNavigationRef.current = false;
      }
    },
    [reload],
  );

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
    const reloadAfterDataChange = (token: unknown) => {
      if (!acceptLifecycleToken(recentDataChangedTokensRef.current, token))
        return;
      if (!deletedRef.current) void reload();
    };
    if (channel) {
      channel.onmessage = (event) => {
        if (
          event.data?.type === "deletion-started" &&
          event.data?.sourceTabId !== clientTabId
        )
          beginDeletion(true, event.data?.token);
        else if (
          event.data?.type === "deletion-cancelled" &&
          event.data?.sourceTabId !== clientTabId
        ) {
          if (cancelDeletion(event.data?.token)) void reload();
        } else if (event.data?.type === "data-space-replaced") {
          if (event.data?.sourceTabId !== clientTabId)
            void replaceDataSpace(event.data?.token, true).catch(
              () => undefined,
            );
        } else if (event.data?.type === "data-deleted") clearAfterDeletion();
        else reloadAfterDataChange(event.data?.token);
      };
    }
    const onVisibility = () => {
      if (!deletedRef.current && document.visibilityState === "visible")
        void reload();
    };
    const onStorage = async (event: StorageEvent) => {
      if (
        event.key === "lyrics-dictation:deletion-pending" &&
        event.newValue !== null
      ) {
        const marker = await readDeletionPendingMarker();
        if (marker) beginDeletion(true, marker.attemptId);
      } else if (event.key === "lyrics-dictation:data-deletion-started") {
        if (event.newValue) beginDeletion(true, event.newValue);
      } else if (event.key === "lyrics-dictation:data-deleted") {
        clearAfterDeletion();
      } else if (
        event.key === DELETION_CANCELLED_STORAGE_KEY &&
        event.newValue !== null
      ) {
        if (cancelDeletion(event.newValue)) void reload();
      } else if (
        event.key === DATA_SPACE_REPLACED_STORAGE_KEY &&
        event.newValue !== null &&
        !deletedRef.current
      ) {
        void replaceDataSpace(event.newValue, true).catch(() => undefined);
      } else if (
        event.key === DATA_CHANGED_STORAGE_KEY &&
        event.newValue !== null &&
        !deletedRef.current
      ) {
        reloadAfterDataChange(event.newValue);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("storage", onStorage);
    return () => {
      channel?.close();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("storage", onStorage);
    };
  }, [
    beginDeletion,
    cancelDeletion,
    clearAfterDeletion,
    replaceDataSpace,
    reload,
  ]);

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
          const recoveryNamespaceChanged =
            await reconcileAcceptedBootstrap(refreshed);
          if (generation !== generationRef.current || deletedRef.current)
            return;
          if (recoveryNamespaceChanged) {
            invalidateRecoveryWrites();
            setData(null);
            setDataSpaceReplacementVersion((version) => version + 1);
            setDataSpaceNavigationVersion((version) => version + 1);
          }
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
      dataRevision,
      dataSpaceReplacementVersion,
      dataSpaceNavigationVersion,
      reload,
      refreshBeforeDeletion,
      replaceDataSpace,
      changeLocale,
      beginDeletion,
      cancelDeletion,
      reportDeletionFailure,
      clearAfterDeletion,
    }),
    [
      data,
      loading,
      error,
      deleting,
      deleted,
      dataRevision,
      dataSpaceReplacementVersion,
      dataSpaceNavigationVersion,
      reload,
      refreshBeforeDeletion,
      replaceDataSpace,
      changeLocale,
      beginDeletion,
      cancelDeletion,
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
