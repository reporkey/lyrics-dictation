import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ApiClientError,
  broadcastDeletionCancelled,
  broadcastDataDeleted,
  broadcastDeletionStarted,
  deleteCloudData,
} from "../api";
import { ErrorNotice } from "../components/Feedback";
import { useI18n } from "../i18n";
import {
  cancelPendingDeletion,
  clearCancelledDeletionMarker,
  finishPendingLocalDeletion,
  hasLocalDeletionPending,
  markDeletionPending,
  readDeletionPendingMarker,
} from "../recovery";
import { useAppData } from "../app-data";

export const PrivacyPage = () => {
  const { t } = useI18n();
  const {
    data,
    beginDeletion,
    cancelDeletion,
    clearAfterDeletion,
    refreshBeforeDeletion,
    reportDeletionFailure,
  } = useAppData();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [deleted, setDeleted] = useState(false);
  const cloudDeletedRef = useRef(false);

  const remove = async () => {
    if (!confirm(t("deleteAllConfirm"))) return;
    setPending(true);
    setError(null);
    const existingMarker = await readDeletionPendingMarker();
    let confirmedNamespace =
      existingMarker?.recoveryNamespace ?? data?.recoveryNamespace ?? null;
    let deletionStarted = false;
    let cloudDeleteAttempted = false;
    const attemptId = existingMarker?.attemptId ?? crypto.randomUUID();
    const safelyCancelDeletion = async () => {
      try {
        await cancelPendingDeletion(attemptId);
      } catch {
        // A pre-cloud marker failure means there is no ambiguous server
        // mutation to resume. The in-memory and cross-tab cancellation still
        // must restore the usable application.
      }
      cancelDeletion(attemptId);
      broadcastDeletionCancelled(attemptId);
      await clearCancelledDeletionMarker(attemptId);
      await refreshBeforeDeletion(true);
    };
    try {
      if (existingMarker?.stage === "server") {
        beginDeletion(false, attemptId);
        deletionStarted = true;
        broadcastDeletionStarted(attemptId);
        cloudDeleteAttempted = true;
        await deleteCloudData(confirmedNamespace ?? undefined);
        cloudDeletedRef.current = true;
      } else if (!cloudDeletedRef.current) {
        const latest = await refreshBeforeDeletion();
        if (latest.paired) {
          setError(new ApiClientError("PAIRING_EXIT_REQUIRED", 409));
          setPending(false);
          return;
        }
        confirmedNamespace = latest.recoveryNamespace;
        // Invalidate and abort every older request before yielding again. This
        // prevents a delayed bootstrap/renewal response from restoring deleted
        // state or the revoked identity cookie.
        beginDeletion(false, attemptId);
        deletionStarted = true;
        broadcastDeletionStarted(attemptId);
        await markDeletionPending("server", attemptId, confirmedNamespace);
        cloudDeleteAttempted = true;
        await deleteCloudData();
        cloudDeletedRef.current = true;
      }
      const localMarker = await markDeletionPending(
        "local",
        attemptId,
        confirmedNamespace ?? "",
      );
      broadcastDeletionStarted(attemptId);
      await finishPendingLocalDeletion({
        localMarkerMayExist: localMarker.localPersisted,
      });
      broadcastDataDeleted();
      clearAfterDeletion();
      setDeleted(true);
      setPending(false);
    } catch (caught) {
      if (
        deletionStarted &&
        !cloudDeletedRef.current &&
        caught instanceof ApiClientError &&
        ["PAIRING_EXIT_REQUIRED", "RECOVERY_NAMESPACE_MISMATCH"].includes(
          caught.code,
        )
      ) {
        try {
          await safelyCancelDeletion();
        } catch (cancellationFailure) {
          beginDeletion(false, attemptId);
          broadcastDeletionStarted(attemptId);
          reportDeletionFailure();
          setError(cancellationFailure);
          setPending(false);
          return;
        }
        setError(
          caught.code === "RECOVERY_NAMESPACE_MISMATCH"
            ? new ApiClientError("PAIRING_EXIT_REQUIRED", 409)
            : caught,
        );
        setPending(false);
        return;
      }
      if (deletionStarted && !cloudDeleteAttempted) {
        try {
          await safelyCancelDeletion();
        } catch (cancellationFailure) {
          setError(cancellationFailure);
          setPending(false);
          return;
        }
        setError(caught);
        setPending(false);
        return;
      }
      if (cloudDeletedRef.current || (await hasLocalDeletionPending())) {
        beginDeletion(false, attemptId);
        broadcastDeletionStarted(attemptId);
        reportDeletionFailure();
      }
      setError(caught);
      setPending(false);
    }
  };

  return (
    <div className="page page-narrow privacy-page">
      <section className="page-heading stacked-heading">
        <p className="eyebrow">{t("privacy")}</p>
        <h1>{t("dataTitle")}</h1>
        <p>{t("dataIntro")}</p>
      </section>
      <section className="privacy-grid">
        <article>
          <span className="privacy-icon" aria-hidden="true">
            ◉
          </span>
          <h2>{t("identityWarningTitle")}</h2>
          <p>{t("identityWarning")}</p>
        </article>
        <article>
          <span className="privacy-icon" aria-hidden="true">
            365
          </span>
          <h2>{t("retentionTitle")}</h2>
          <p>{t("retention")}</p>
        </article>
        <article>
          <span className="privacy-icon" aria-hidden="true">
            ∅
          </span>
          <h2>{t("noAnalyticsTitle")}</h2>
          <p>{t("noAnalytics")}</p>
        </article>
      </section>
      {error ? <ErrorNotice error={error} /> : null}
      <section className="delete-data-panel">
        {data?.paired ? (
          <div className="group-delete-blocked">
            <p>{t("groupDeleteBlocked")}</p>
            <Link className="button button-secondary" to="/devices">
              {t("devices")}
            </Link>
          </div>
        ) : deleted ? (
          <p className="notice notice-success" role="status">
            {t("dataDeleted")}
          </p>
        ) : (
          <button
            className="button button-danger"
            type="button"
            onClick={() => void remove()}
            disabled={pending}
          >
            {pending ? t("deleting") : t("deleteAll")}
          </button>
        )}
      </section>
    </div>
  );
};
