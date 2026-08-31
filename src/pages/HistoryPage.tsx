import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ErrorNotice, LoadingState } from "../components/Feedback";
import { useI18n } from "../i18n";
import { formatElapsedTime, sessionAccuracy } from "../lib/session-metrics";
import type { RecentSession } from "../lib/types";

interface HistoryPayload {
  history: RecentSession[];
  historyCursor: string | null;
}

export const HistoryPage = () => {
  const { t, locale } = useI18n();
  const [history, setHistory] = useState<RecentSession[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api<HistoryPayload>("/api/sessions");
      setHistory(result.history);
      setHistoryCursor(result.historyCursor);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  const loadOlderHistory = async () => {
    if (!historyCursor) return;
    setLoadingOlder(true);
    setError(null);
    try {
      const result = await api<HistoryPayload>(
        `/api/sessions?historyCursor=${encodeURIComponent(historyCursor)}`,
      );
      setHistory((current) => {
        const known = new Set(current.map((session) => session.id));
        return [
          ...current,
          ...result.history.filter((session) => !known.has(session.id)),
        ];
      });
      setHistoryCursor(result.historyCursor);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoadingOlder(false);
    }
  };

  if (loading) return <LoadingState />;
  if (error && !history.length)
    return <ErrorNotice error={error} onRetry={() => void load()} />;

  return (
    <div className="page page-history">
      <section className="page-heading history-heading">
        <div>
          <p className="eyebrow">{t("appName")}</p>
          <h1>{t("practiceHistory")}</h1>
          <p className="subtle">{t("historyIntro")}</p>
        </div>
      </section>

      {error ? <ErrorNotice error={error} /> : null}
      {history.length ? (
        <ol className="history-list">
          {history.map((session) => {
            const finishedAt = session.completedAt ?? session.updatedAt;
            const formattedDate = new Intl.DateTimeFormat(locale, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(finishedAt);
            const duration = formatElapsedTime(finishedAt - session.startedAt);
            const accuracy = sessionAccuracy(session);
            return (
              <li key={session.id}>
                <Link
                  className="history-link history-page-link"
                  to={`/dictation/${session.id}`}
                >
                  <span className="history-title">
                    <strong>{session.songTitle}</strong>
                    <small>{t("completedAt", { date: formattedDate })}</small>
                  </span>
                  <span className="accuracy-pill">
                    {t("accuracyValue", { percent: accuracy })}
                  </span>
                  <span className="history-meta">
                    {t("elapsedTime", { duration })}
                  </span>
                  <strong className="history-action">
                    {t("viewResult")} <span aria-hidden="true">→</span>
                  </strong>
                </Link>
              </li>
            );
          })}
        </ol>
      ) : (
        <section className="empty-state history-empty">
          <div className="empty-mark" aria-hidden="true">
            ✓
          </div>
          <h2>{t("noPractice")}</h2>
          <p>{t("historyEmptyBody")}</p>
        </section>
      )}
      {historyCursor ? (
        <button
          className="button button-ghost history-more"
          type="button"
          disabled={loadingOlder}
          onClick={() => void loadOlderHistory()}
        >
          {loadingOlder ? t("loadingOlderResults") : t("loadOlderResults")}
        </button>
      ) : null}
    </div>
  );
};
