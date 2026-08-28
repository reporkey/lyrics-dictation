import { useRef, useState } from "react";
import {
  broadcastDataDeleted,
  broadcastDeletionStarted,
  deleteCloudData,
} from "../api";
import { ErrorNotice } from "../components/Feedback";
import { useI18n } from "../i18n";
import {
  finishPendingLocalDeletion,
  hasLocalDeletionPending,
  markDeletionPending,
} from "../recovery";
import { useAppData } from "../app-data";

export const PrivacyPage = () => {
  const { t } = useI18n();
  const { beginDeletion, clearAfterDeletion, reportDeletionFailure } =
    useAppData();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [deleted, setDeleted] = useState(false);
  const cloudDeletedRef = useRef(false);

  const remove = async () => {
    if (!confirm(t("deleteAllConfirm"))) return;
    setPending(true);
    setError(null);
    try {
      if (!cloudDeletedRef.current) {
        markDeletionPending("server");
        // Invalidate and abort every older request before yielding again. This
        // prevents a delayed bootstrap/renewal response from restoring deleted
        // state or the revoked identity cookie.
        beginDeletion();
        broadcastDeletionStarted();
        await deleteCloudData();
        cloudDeletedRef.current = true;
      }
      markDeletionPending("local");
      broadcastDeletionStarted();
      await finishPendingLocalDeletion();
      broadcastDataDeleted();
      clearAfterDeletion();
      setDeleted(true);
      setPending(false);
    } catch (caught) {
      if (cloudDeletedRef.current || hasLocalDeletionPending()) {
        beginDeletion();
        broadcastDeletionStarted();
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
          <p>{t("retention")}</p>
        </article>
        <article>
          <span className="privacy-icon" aria-hidden="true">
            ∅
          </span>
          <p>{t("noAnalytics")}</p>
        </article>
      </section>
      {error ? <ErrorNotice error={error} /> : null}
      <section className="delete-data-panel">
        {deleted ? (
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
