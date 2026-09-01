import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiClientError,
  api,
  broadcastDataChanged,
  DATA_SPACE_REPLACED_STORAGE_KEY,
  idempotencyKey,
} from "../api";
import { DictationEditor } from "../components/DictationEditor";
import { ErrorNotice, LoadingState } from "../components/Feedback";
import { useGrading } from "../hooks/useGrading";
import { useI18n } from "../i18n";
import { formatElapsedTime, sessionAccuracy } from "../lib/session-metrics";
import type { DictationSession } from "../lib/types";
import { draftTextSchema } from "../lib/validation";
import { findUnsafeControl } from "../lib/text-policy";
import {
  PREFERENCES_CLEARED_EVENT,
  readPreference,
  subscribePreferenceChanges,
  writePreference,
} from "../preferences";
import {
  deleteRecovery,
  deleteRecoveryIfConfirmed,
  invalidateRecoveryWrites,
  readRecovery,
  writeRecovery,
} from "../recovery";

type SyncState = "synced" | "local" | "saving" | "error" | "conflict";

interface SessionPayload {
  session: DictationSession;
  studyText: string;
  songTitle: string;
}

const LIVE_CHECK_PREFERENCE_KEY = "lyrics-dictation:live-check";

const readLiveCheckPreference = () =>
  readPreference(LIVE_CHECK_PREFERENCE_KEY) !== "off";

export const DictationPage = () => {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [payload, setPayload] = useState<SessionPayload | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [syncState, setSyncState] = useState<SyncState>("synced");
  const [recoveryUnavailable, setRecoveryUnavailable] = useState(false);
  const recoveryUnavailableRef = useRef(false);
  recoveryUnavailableRef.current = recoveryUnavailable;
  const syncStateRef = useRef<SyncState>("synced");
  syncStateRef.current = syncState;
  const [validationMessage, setValidationMessage] = useState<
    { kind: "limit" } | { kind: "unsafe"; position: number } | null
  >(null);
  const [cloudConflict, setCloudConflict] = useState<DictationSession | null>(
    null,
  );
  const [realtimeFeedback, setRealtimeFeedback] = useState(
    readLiveCheckPreference,
  );
  const [announcedSummary, setAnnouncedSummary] = useState("");
  const [clockNow, setClockNow] = useState(() => Date.now());
  const sessionRef = useRef<DictationSession | null>(null);
  const draftRef = useRef("");
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const lastQueuedDraft = useRef<string | null>(null);
  const mutationIntentRef = useRef<{
    fingerprint: string;
    key: string;
  } | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const recoveryWriteSequenceRef = useRef(0);
  const loadGenerationRef = useRef(0);

  const { grade, checking, approximate } = useGrading(
    payload?.studyText ?? "",
    draft,
    payload?.session.caseSensitive ?? false,
    payload?.session.status !== "in_progress",
    payload?.session.status !== "in_progress" || realtimeFeedback,
  );

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    try {
      setError(null);
      const result = await api<SessionPayload>(`/api/sessions/${id}`);
      if (generation !== loadGenerationRef.current) return;
      setValidationMessage(null);
      let recovery: Awaited<ReturnType<typeof readRecovery>>;
      let recoveryStorageFailed = false;
      try {
        recovery = await readRecovery(id);
      } catch {
        recovery = undefined;
        recoveryStorageFailed = true;
      }
      if (generation !== loadGenerationRef.current) return;
      if (result.session.status !== "in_progress") {
        if (recovery) void deleteRecovery(id).catch(() => undefined);
        setPayload(result);
        sessionRef.current = result.session;
        lastQueuedDraft.current = result.session.draftText;
        setDraft(result.session.draftText);
        draftRef.current = result.session.draftText;
        setCloudConflict(null);
        recoveryUnavailableRef.current = false;
        setRecoveryUnavailable(false);
        syncStateRef.current = "synced";
        setSyncState("synced");
        return;
      }
      const recoveryIsValid = recovery
        ? draftTextSchema.safeParse(recovery.draftText).success
        : false;
      if (recovery && !recoveryIsValid) {
        try {
          await deleteRecovery(id);
        } catch {
          recoveryStorageFailed = true;
        }
        if (generation !== loadGenerationRef.current) return;
        setValidationMessage({
          kind: "unsafe",
          position: (findUnsafeControl(recovery.draftText) ?? 0) + 1,
        });
      }
      if (
        recovery &&
        recoveryIsValid &&
        recovery.draftText === result.session.draftText
      ) {
        try {
          await deleteRecovery(id);
        } catch {
          recoveryStorageFailed = true;
        }
        if (generation !== loadGenerationRef.current) return;
      }
      // Recovery records are deleted only after the exact draft snapshot is
      // acknowledged by the server. If one remains, it is authoritative even
      // when an older save response gave the cloud row a later wall-clock time.
      const recovered = Boolean(
        recovery &&
        recoveryIsValid &&
        recovery.draftText !== result.session.draftText,
      );
      const recoveryConflictsWithCloud = Boolean(
        recovered && recovery!.serverVersion !== result.session.version,
      );
      const nextDraft = recovered
        ? recovery!.draftText
        : result.session.draftText;
      setPayload(result);
      sessionRef.current = result.session;
      lastQueuedDraft.current = result.session.draftText;
      setDraft(nextDraft);
      draftRef.current = nextDraft;
      setCloudConflict(recoveryConflictsWithCloud ? result.session : null);
      recoveryUnavailableRef.current = recoveryStorageFailed;
      setRecoveryUnavailable(recoveryStorageFailed);
      const nextSyncState = recoveryConflictsWithCloud
        ? "conflict"
        : recovered
          ? "local"
          : "synced";
      syncStateRef.current = nextSyncState;
      setSyncState(nextSyncState);
    } catch (caught) {
      if (generation !== loadGenerationRef.current) return;
      setError(caught);
    }
  }, [id]);

  useEffect(() => {
    void load();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const unsubscribe = subscribePreferenceChanges(({ key, value }) => {
      if (key !== LIVE_CHECK_PREFERENCE_KEY) return;
      setRealtimeFeedback(value !== "off");
    });
    // Reconcile a change that landed between the initial render and effect.
    setRealtimeFeedback(readLiveCheckPreference());
    const onCleared = () => setRealtimeFeedback(true);
    window.addEventListener(PREFERENCES_CLEARED_EVENT, onCleared);
    return () => {
      unsubscribe();
      window.removeEventListener(PREFERENCES_CLEARED_EVENT, onCleared);
    };
  }, []);

  useEffect(() => {
    if (payload?.session.status !== "in_progress") return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [payload?.session.id, payload?.session.status]);

  useEffect(() => {
    let dataSpaceReplacementHandled = false;
    const channel =
      typeof BroadcastChannel === "function"
        ? new BroadcastChannel("lyrics-dictation:data")
        : null;
    const handleDataSpaceReplacement = () => {
      if (dataSpaceReplacementHandled) return;
      dataSpaceReplacementHandled = true;
      loadGenerationRef.current += 1;
      invalidateRecoveryWrites();
      sessionRef.current = null;
      mutationIntentRef.current = null;
      lastQueuedDraft.current = null;
      syncStateRef.current = "synced";
      void deleteRecovery(id)
        .catch(() => undefined)
        .finally(() => navigate("/", { replace: true }));
    };
    const revalidate = async () => {
      if (
        syncStateRef.current === "synced" &&
        document.visibilityState === "visible"
      ) {
        // IndexedDB is shared by tabs. A retained session recovery may belong
        // to another tab that is actively editing, so a clean tab must not
        // adopt or overwrite it merely because a save broadcast arrived.
        try {
          if (!(await readRecovery(id)) && !dataSpaceReplacementHandled)
            await load();
        } catch {
          if (
            syncStateRef.current === "synced" &&
            document.visibilityState === "visible" &&
            !dataSpaceReplacementHandled
          )
            await load();
        }
      }
    };
    if (channel)
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data as {
          type?: string;
          songId?: string;
          sessionId?: string | null;
        } | null;
        const currentSession = sessionRef.current;
        if (message?.type === "data-space-replaced") {
          handleDataSpaceReplacement();
          return;
        }
        if (
          message?.type === "song-deleted" &&
          message.songId === currentSession?.songId
        ) {
          sessionRef.current = null;
          void deleteRecovery(id)
            .catch(() => undefined)
            .finally(() => navigate("/"));
          return;
        }
        if (
          currentSession &&
          message?.type === "session-replaced" &&
          message.songId === currentSession.songId &&
          message.sessionId !== currentSession.id
        ) {
          const songId = currentSession.songId;
          sessionRef.current = null;
          void deleteRecovery(id)
            .catch(() => undefined)
            .finally(() =>
              navigate(
                message.sessionId
                  ? `/dictation/${message.sessionId}`
                  : `/songs/${songId}`,
              ),
            );
          return;
        }
        void revalidate();
      };
    const onVisibility = () => void revalidate();
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === DATA_SPACE_REPLACED_STORAGE_KEY &&
        event.newValue !== null
      )
        handleDataSpaceReplacement();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("storage", onStorage);
    return () => {
      channel?.close();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("storage", onStorage);
    };
  }, [id, load, navigate]);

  useEffect(() => {
    const flushRecovery = () => {
      const current = sessionRef.current;
      const draftSnapshot = draftRef.current;
      if (
        !current ||
        current.status !== "in_progress" ||
        (!recoveryUnavailableRef.current &&
          !["local", "error"].includes(syncStateRef.current)) ||
        draftSnapshot === current.draftText
      ) {
        return;
      }
      void api(`/api/sessions/${current.id}`, {
        method: "PATCH",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": mutationIntentRef.current?.key ?? idempotencyKey(),
        },
        body: JSON.stringify({
          version: current.version,
          draftText: draftSnapshot,
          action: "save",
        }),
      }).catch(() => undefined);
    };
    window.addEventListener("pagehide", flushRecovery);
    return () => window.removeEventListener("pagehide", flushRecovery);
  }, []);

  const enqueueSave = useCallback(
    (action: "save" | "complete", draftSnapshot = draftRef.current) => {
      saveChain.current = saveChain.current
        .catch(() => undefined)
        .then(async () => {
          const current = sessionRef.current;
          if (!current || current.status !== "in_progress") return;
          syncStateRef.current = "saving";
          setSyncState("saving");
          const fingerprint = JSON.stringify([
            current.id,
            current.version,
            action,
            draftSnapshot,
          ]);
          if (mutationIntentRef.current?.fingerprint !== fingerprint) {
            mutationIntentRef.current = {
              fingerprint,
              key: idempotencyKey(),
            };
          }
          try {
            const result = await api<{ session: DictationSession }>(
              `/api/sessions/${current.id}`,
              {
                method: "PATCH",
                headers: {
                  "Idempotency-Key": mutationIntentRef.current.key,
                },
                body: JSON.stringify({
                  version: current.version,
                  draftText: draftSnapshot,
                  action,
                }),
              },
            );
            sessionRef.current = result.session;
            if (mutationIntentRef.current?.fingerprint === fingerprint) {
              mutationIntentRef.current = null;
            }
            setPayload((existing) =>
              existing ? { ...existing, session: result.session } : existing,
            );
            if (action === "save") {
              await deleteRecoveryIfConfirmed(current.id, draftSnapshot);
              if (draftRef.current === draftSnapshot) {
                recoveryUnavailableRef.current = false;
                setRecoveryUnavailable(false);
              }
              const nextSyncState =
                draftRef.current === draftSnapshot ? "synced" : "local";
              syncStateRef.current = nextSyncState;
              setSyncState(nextSyncState);
              broadcastDataChanged();
            } else {
              await deleteRecovery(current.id);
              syncStateRef.current = "synced";
              setSyncState("synced");
              broadcastDataChanged();
            }
          } catch (caught) {
            if (
              caught instanceof ApiClientError &&
              caught.code === "VERSION_CONFLICT"
            ) {
              const currentCloud = caught.details?.current as
                DictationSession | undefined;
              if (currentCloud) setCloudConflict(currentCloud);
              syncStateRef.current = "conflict";
              setSyncState("conflict");
            } else {
              syncStateRef.current = "error";
              setSyncState("error");
            }
            if (action !== "save") throw caught;
          }
        });
      return saveChain.current;
    },
    [],
  );

  useEffect(() => {
    const sessionStatus = payload?.session.status;
    if (
      sessionStatus !== "in_progress" ||
      cloudConflict !== null ||
      draft === lastQueuedDraft.current
    )
      return;
    const timer = window.setTimeout(() => {
      lastQueuedDraft.current = draft;
      void enqueueSave("save", draft);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [
    cloudConflict,
    draft,
    enqueueSave,
    payload?.session.status,
    retryGeneration,
  ]);

  const onChange = (next: string) => {
    loadGenerationRef.current += 1;
    setValidationMessage(null);
    setDraft(next);
    draftRef.current = next;
    syncStateRef.current = "local";
    setSyncState("local");
    const current = sessionRef.current;
    if (current) {
      const sequence = ++recoveryWriteSequenceRef.current;
      void writeRecovery({
        sessionId: current.id,
        songId: current.songId,
        draftText: next,
        serverVersion: current.version,
        updatedAt: Date.now(),
      })
        .then(() => {
          if (
            sequence === recoveryWriteSequenceRef.current &&
            draftRef.current === next
          ) {
            recoveryUnavailableRef.current = false;
            setRecoveryUnavailable(false);
          }
        })
        .catch(() => {
          if (
            sequence === recoveryWriteSequenceRef.current &&
            draftRef.current === next
          ) {
            recoveryUnavailableRef.current = true;
            setRecoveryUnavailable(true);
          }
        });
    }
  };

  const adoptCloudDraft = async () => {
    if (!cloudConflict) return;
    loadGenerationRef.current += 1;
    const acceptedCloud = cloudConflict;
    sessionRef.current = acceptedCloud;
    setPayload((existing) =>
      existing ? { ...existing, session: acceptedCloud } : existing,
    );
    setDraft(acceptedCloud.draftText);
    draftRef.current = acceptedCloud.draftText;
    lastQueuedDraft.current = acceptedCloud.draftText;
    let recoveryStorageFailed = false;
    try {
      await deleteRecovery(acceptedCloud.id);
    } catch {
      recoveryStorageFailed = true;
    }
    setCloudConflict(null);
    recoveryUnavailableRef.current = recoveryStorageFailed;
    setRecoveryUnavailable(recoveryStorageFailed);
    syncStateRef.current = "synced";
    setSyncState("synced");
  };

  const keepLocal = () => {
    if (!cloudConflict) return;
    loadGenerationRef.current += 1;
    sessionRef.current = cloudConflict;
    setPayload((existing) =>
      existing ? { ...existing, session: cloudConflict } : existing,
    );
    setCloudConflict(null);
    syncStateRef.current = "local";
    setSyncState("local");
    lastQueuedDraft.current = draftRef.current;
    void enqueueSave("save");
  };

  const submit = async () => {
    if (!payload || !confirm(t("submitConfirm"))) return;
    try {
      await enqueueSave("complete");
    } catch (caught) {
      setError(caught);
    }
  };

  const percent = grade
    ? sessionAccuracy({
        correctCount: grade.correct,
        incorrectCount: grade.incorrect,
        extraCount: grade.extra,
        missingCount: grade.missing,
      })
    : 0;
  const isTerminal = payload?.session.status !== "in_progress";
  const partialPreview = Boolean(payload && !isTerminal && approximate);
  useEffect(() => {
    if (
      !grade ||
      checking ||
      (!realtimeFeedback && payload?.session.status === "in_progress")
    ) {
      setAnnouncedSummary("");
      return;
    }
    if (partialPreview) {
      setAnnouncedSummary(t("partialFeedback"));
      return;
    }
    const timer = window.setTimeout(() => {
      setAnnouncedSummary(
        t("gradingSummary", {
          percent,
          correct: grade.correct,
          incorrect: grade.incorrect,
          extra: grade.extra,
          missing: grade.missing,
        }),
      );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    checking,
    grade,
    partialPreview,
    payload?.session.status,
    percent,
    realtimeFeedback,
    t,
  ]);

  if (error && !payload)
    return (
      <div className="page page-narrow">
        <ErrorNotice error={error} onRetry={() => void load()} />
      </div>
    );
  if (!payload) return <LoadingState />;

  const isPerfect = isTerminal && Boolean(grade?.complete);
  const finishedAt = isTerminal
    ? (payload.session.completedAt ?? payload.session.updatedAt)
    : clockNow;
  const elapsedTime = formatElapsedTime(finishedAt - payload.session.startedAt);
  const feedbackVisible = isTerminal || realtimeFeedback;
  const displayedGrade =
    isTerminal && grade
      ? {
          ...grade,
          actual: grade.revealed,
          states: grade.revealedStates,
          markers: [],
        }
      : feedbackVisible
        ? grade
        : null;
  const syncLabel =
    recoveryUnavailable && syncState !== "synced"
      ? t("unsafeDraft")
      : syncState === "synced"
        ? t("synced")
        : syncState === "saving"
          ? t("savingDraft")
          : syncState === "error"
            ? t("syncError")
            : t("notSynced");

  return (
    <div className="dictation-page">
      <header className="dictation-header">
        <div>
          <Link className="back-link" to={`/songs/${payload.session.songId}`}>
            ← {payload.songTitle}
          </Link>
          <h1>{t(isTerminal ? "resultPageTitle" : "dictationTitle")}</h1>
          {!isTerminal ? <p>{t("dictationIntro")}</p> : null}
        </div>
        <div className="dictation-header-meta">
          <span className="elapsed-time">
            {t("elapsedTime", { duration: elapsedTime })}
          </span>
          {!isTerminal ? (
            <div className="sync-state-wrap">
              <span
                className={`sync-state sync-${recoveryUnavailable && syncState !== "synced" ? "error" : syncState}`}
                role="status"
                aria-live="polite"
              >
                <span aria-hidden="true" /> {syncLabel}
              </span>
              {syncState === "error" ? (
                <button
                  className="button button-ghost button-compact"
                  type="button"
                  onClick={() => {
                    const current = sessionRef.current;
                    if (current) {
                      const snapshot = draftRef.current;
                      const sequence = ++recoveryWriteSequenceRef.current;
                      void writeRecovery({
                        sessionId: current.id,
                        songId: current.songId,
                        draftText: snapshot,
                        serverVersion: current.version,
                        updatedAt: Date.now(),
                      })
                        .then(() => {
                          if (
                            sequence === recoveryWriteSequenceRef.current &&
                            draftRef.current === snapshot
                          ) {
                            recoveryUnavailableRef.current = false;
                            setRecoveryUnavailable(false);
                          }
                        })
                        .catch(() => {
                          if (
                            sequence === recoveryWriteSequenceRef.current &&
                            draftRef.current === snapshot
                          ) {
                            recoveryUnavailableRef.current = true;
                            setRecoveryUnavailable(true);
                          }
                        });
                    }
                    lastQueuedDraft.current = null;
                    setRetryGeneration((current) => current + 1);
                  }}
                >
                  {t("retrySync")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      {isPerfect ? (
        <section className="completion-banner" role="status">
          <span aria-hidden="true">✓</span>
          <div>
            <h2>{t("completedTitle")}</h2>
            <p>{t("completedBody")}</p>
          </div>
        </section>
      ) : null}

      {syncState === "conflict" ? (
        <section className="notice notice-warning conflict-notice" role="alert">
          <p>{t("versionConflict")}</p>
          <div>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => void adoptCloudDraft()}
            >
              {t("useCloudDraft")}
            </button>
            <button
              className="button button-primary"
              type="button"
              onClick={keepLocal}
            >
              {t("keepLocalDraft")}
            </button>
          </div>
        </section>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      {validationMessage ? (
        <div className="notice notice-warning" role="alert">
          {validationMessage.kind === "limit" ? (
            t("draftLimit")
          ) : (
            <>
              {t("error_UNSAFE_CONTROL_CHARACTER")}{" "}
              {t("unsafePosition", {
                position: validationMessage.position,
              })}
            </>
          )}
        </div>
      ) : null}

      <section
        className={`editor-panel${isTerminal ? " editor-panel-result" : ""}`}
      >
        <div className="progress-row">
          <div className="progress-toolbar">
            <div className="progress-copy">
              {feedbackVisible ? (
                <>
                  <strong>
                    {partialPreview
                      ? t("partialFeedback")
                      : t("progressLabel", { percent })}
                  </strong>
                  {checking ? <span>{t("checking")}</span> : null}
                </>
              ) : (
                <strong>{t("realtimeFeedbackOff")}</strong>
              )}
            </div>
            {!isTerminal ? (
              <button
                className="feedback-switch"
                type="button"
                role="switch"
                aria-checked={realtimeFeedback}
                onClick={() => {
                  const next = !realtimeFeedback;
                  writePreference(
                    LIVE_CHECK_PREFERENCE_KEY,
                    next ? "on" : "off",
                  );
                  setRealtimeFeedback(next);
                }}
              >
                <span>{t("realtimeFeedback")}</span>
                <i aria-hidden="true" />
              </button>
            ) : null}
          </div>
          {feedbackVisible && !partialPreview ? (
            <div className="progress-track" aria-hidden="true">
              <span style={{ width: `${percent}%` }} />
            </div>
          ) : null}
        </div>
        <p
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {announcedSummary}
        </p>
        <DictationEditor
          value={isTerminal ? (grade?.revealedText ?? draft) : draft}
          grade={displayedGrade}
          onChange={onChange}
          onLimit={() => setValidationMessage({ kind: "limit" })}
          onInvalid={(position) =>
            setValidationMessage({ kind: "unsafe", position })
          }
          label={t(isTerminal ? "resultEditorLabel" : "editorLabel")}
          placeholder={t("editorPlaceholder")}
          missingLabel={t("missingHere")}
          descriptionId={isTerminal ? "result-change-legend" : undefined}
          readOnly={isTerminal}
        />
        {isTerminal ? (
          <>
            <p className="result-change-legend" id="result-change-legend">
              <span className="legend-removed">{t("resultRemovedLegend")}</span>
              <span className="legend-replacement">
                {t("resultReplacementLegend")}
              </span>
              <span className="legend-addition">
                {t("resultAdditionLegend")}
              </span>
            </p>
            <section className="sr-only" aria-label={t("correctedAnswerLabel")}>
              <h2>{t("correctedAnswerLabel")}</h2>
              <p>{payload.studyText}</p>
            </section>
          </>
        ) : null}
        {feedbackVisible && !partialPreview ? (
          <div
            className="grade-summary"
            aria-label={t("progressLabel", { percent })}
          >
            <span className="grade-correct">
              <i /> {t("correct")} <strong>{grade?.correct ?? 0}</strong>
            </span>
            <span className="grade-incorrect">
              <i /> {t("incorrect")} <strong>{grade?.incorrect ?? 0}</strong>
            </span>
            <span className="grade-extra">
              <i /> {t("extra")} <strong>{grade?.extra ?? 0}</strong>
            </span>
            <span className="grade-missing">
              <i /> {t("missing")} <strong>{grade?.missing ?? 0}</strong>
            </span>
          </div>
        ) : null}
      </section>

      <div className="dictation-actions">
        {isTerminal ? (
          <Link
            className="button button-primary"
            to={`/songs/${payload.session.songId}`}
          >
            {t("practiceAgain")}
          </Link>
        ) : (
          <button
            className="button button-ghost"
            type="button"
            onClick={() => void submit()}
          >
            {t("submitDictation")}
          </button>
        )}
      </div>
    </div>
  );
};
