import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiClientError,
  api,
  broadcastDataChanged,
  idempotencyKey,
} from "../api";
import { DictationEditor } from "../components/DictationEditor";
import { ErrorNotice, LoadingState } from "../components/Feedback";
import { useGrading } from "../hooks/useGrading";
import { useI18n } from "../i18n";
import type { DictationSession } from "../lib/types";
import { draftTextSchema } from "../lib/validation";
import { findUnsafeControl } from "../lib/text-policy";
import {
  deleteRecovery,
  deleteRecoveryIfConfirmed,
  readRecovery,
  writeRecovery,
} from "../recovery";

type SyncState = "synced" | "local" | "saving" | "error" | "conflict";

interface SessionPayload {
  session: DictationSession;
  studyText: string;
  songTitle: string;
}

export const DictationPage = () => {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [payload, setPayload] = useState<SessionPayload | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [syncState, setSyncState] = useState<SyncState>("synced");
  const syncStateRef = useRef<SyncState>("synced");
  syncStateRef.current = syncState;
  const [validationMessage, setValidationMessage] = useState<
    { kind: "limit" } | { kind: "unsafe"; position: number } | null
  >(null);
  const [cloudConflict, setCloudConflict] = useState<DictationSession | null>(
    null,
  );
  const [completionDraft, setCompletionDraft] = useState<string | null>(null);
  const [announcedSummary, setAnnouncedSummary] = useState("");
  const sessionRef = useRef<DictationSession | null>(null);
  const draftRef = useRef("");
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const completionQueued = useRef(false);
  const lastQueuedDraft = useRef<string | null>(null);
  const mutationIntentRef = useRef<{
    fingerprint: string;
    key: string;
  } | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);

  const { grade, checking } = useGrading(
    payload?.studyText ?? "",
    draft,
    payload?.session.caseSensitive ?? false,
  );

  const load = useCallback(async () => {
    try {
      setError(null);
      const result = await api<SessionPayload>(`/api/sessions/${id}`);
      const recovery = await readRecovery(id);
      const recoveryIsValid = recovery
        ? draftTextSchema.safeParse(recovery.draftText).success
        : false;
      if (recovery && !recoveryIsValid) {
        await deleteRecovery(id);
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
        await deleteRecovery(id);
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
      const nextSyncState = recoveryConflictsWithCloud
        ? "conflict"
        : recovered
          ? "local"
          : "synced";
      syncStateRef.current = nextSyncState;
      setSyncState(nextSyncState);
    } catch (caught) {
      setError(caught);
    }
  }, [id]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    const channel =
      typeof BroadcastChannel === "function"
        ? new BroadcastChannel("lyrics-dictation:data")
        : null;
    const revalidate = async () => {
      if (
        syncStateRef.current === "synced" &&
        document.visibilityState === "visible"
      ) {
        // IndexedDB is shared by tabs. A retained session recovery may belong
        // to another tab that is actively editing, so a clean tab must not
        // adopt or overwrite it merely because a save broadcast arrived.
        if (!(await readRecovery(id))) await load();
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
        if (
          message?.type === "song-deleted" &&
          message.songId === currentSession?.songId
        ) {
          sessionRef.current = null;
          void deleteRecovery(id).finally(() => navigate("/"));
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
          void deleteRecovery(id).finally(() =>
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
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      channel?.close();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [id, load, navigate]);

  useEffect(() => {
    const flushRecovery = () => {
      const current = sessionRef.current;
      const draftSnapshot = draftRef.current;
      if (
        !current ||
        current.status !== "in_progress" ||
        !["local", "error"].includes(syncStateRef.current) ||
        draftSnapshot === current.draftText
      ) {
        return;
      }
      void api(`/api/sessions/${current.id}`, {
        method: "PATCH",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey(),
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
    (
      action: "save" | "complete" | "abandon",
      draftSnapshot = draftRef.current,
    ) => {
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
            if (action === "abandon") {
              await deleteRecovery(current.id);
              syncStateRef.current = "synced";
              setSyncState("synced");
              broadcastDataChanged();
            } else {
              await deleteRecoveryIfConfirmed(current.id, draftSnapshot);
              const nextSyncState =
                draftRef.current === draftSnapshot ? "synced" : "local";
              syncStateRef.current = nextSyncState;
              setSyncState(nextSyncState);
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
      completionDraft !== null ||
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
    completionDraft,
    draft,
    enqueueSave,
    payload?.session.status,
    retryGeneration,
  ]);

  useEffect(() => {
    if (
      !grade?.complete ||
      checking ||
      !payload ||
      payload.session.status !== "in_progress" ||
      completionQueued.current
    )
      return;
    completionQueued.current = true;
    setCompletionDraft(draft);
  }, [checking, draft, grade?.complete, payload]);

  useEffect(() => {
    if (completionDraft === null) return;
    void enqueueSave("complete", completionDraft).catch((caught) => {
      completionQueued.current = false;
      setCompletionDraft(null);
      setError(caught);
    });
  }, [completionDraft, enqueueSave]);

  const onChange = (next: string) => {
    setValidationMessage(null);
    setDraft(next);
    draftRef.current = next;
    syncStateRef.current = "local";
    setSyncState("local");
    const current = sessionRef.current;
    if (current) {
      void writeRecovery({
        sessionId: current.id,
        songId: current.songId,
        draftText: next,
        serverVersion: current.version,
        updatedAt: Date.now(),
      });
    }
  };

  const adoptCloudDraft = async () => {
    if (!cloudConflict) return;
    sessionRef.current = cloudConflict;
    setPayload((existing) =>
      existing ? { ...existing, session: cloudConflict } : existing,
    );
    setDraft(cloudConflict.draftText);
    draftRef.current = cloudConflict.draftText;
    lastQueuedDraft.current = cloudConflict.draftText;
    await deleteRecovery(cloudConflict.id);
    setCloudConflict(null);
    syncStateRef.current = "synced";
    setSyncState("synced");
  };

  const keepLocal = () => {
    if (!cloudConflict) return;
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

  const abandon = async () => {
    if (!payload || !confirm(t("revealConfirm"))) return;
    try {
      await enqueueSave("abandon");
      navigate(`/songs/${payload.session.songId}`);
    } catch (caught) {
      setError(caught);
    }
  };

  const percent = Math.round((grade?.progress ?? 0) * 100);
  useEffect(() => {
    if (!grade || checking) return;
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
  }, [checking, grade, percent, t]);

  if (error && !payload)
    return (
      <div className="page page-narrow">
        <ErrorNotice error={error} onRetry={() => void load()} />
      </div>
    );
  if (!payload) return <LoadingState />;

  const isCompleted = payload.session.status === "completed";
  const isTerminal = payload.session.status !== "in_progress";
  const syncLabel =
    syncState === "synced"
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
          <h1>{t("dictationTitle")}</h1>
          <p>{t("dictationIntro")}</p>
        </div>
        <div className="sync-state-wrap">
          <span className={`sync-state sync-${syncState}`}>
            <span aria-hidden="true" /> {syncLabel}
          </span>
          {syncState === "error" ? (
            <button
              className="button button-ghost button-compact"
              type="button"
              onClick={() => {
                lastQueuedDraft.current = null;
                setRetryGeneration((current) => current + 1);
              }}
            >
              {t("retrySync")}
            </button>
          ) : null}
        </div>
      </header>

      {isCompleted ? (
        <section
          className="completion-banner"
          role="status"
          aria-live="assertive"
        >
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

      <section className="editor-panel">
        <div className="progress-row">
          <div className="progress-copy">
            <strong>{t("progressLabel", { percent })}</strong>
            {checking ? <span>{t("checking")}</span> : null}
          </div>
          <div className="progress-track" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </div>
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
          value={draft}
          grade={grade}
          onChange={onChange}
          onLimit={() => setValidationMessage({ kind: "limit" })}
          onInvalid={(position) =>
            setValidationMessage({ kind: "unsafe", position })
          }
          label={t("editorLabel")}
          placeholder={t("editorPlaceholder")}
          missingLabel={t("missingHere")}
          readOnly={isTerminal || completionDraft !== null}
        />
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
            onClick={() => void abandon()}
          >
            {t("finishReveal")}
          </button>
        )}
      </div>
    </div>
  );
};
