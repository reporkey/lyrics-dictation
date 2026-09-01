import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAppData } from "../app-data";
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
  const { dataRevision } = useAppData();
  const [history, setHistory] = useState<RecentSession[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const loadGenerationRef = useRef(0);
  const olderGenerationRef = useRef(0);

  const load = useCallback(async (revision: number) => {
    if (!Number.isSafeInteger(revision)) return;
    const generation = ++loadGenerationRef.current;
    olderGenerationRef.current += 1;
    setLoading(true);
    setLoadingOlder(false);
    setError(null);
    try {
      const result = await api<HistoryPayload>("/api/sessions");
      if (generation !== loadGenerationRef.current) return;
      setHistory(result.history);
      setHistoryCursor(result.historyCursor);
    } catch (caught) {
      if (generation !== loadGenerationRef.current) return;
      setError(caught);
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(dataRevision);
    return () => {
      loadGenerationRef.current += 1;
      olderGenerationRef.current += 1;
    };
  }, [dataRevision, load]);

  const loadOlderHistory = async () => {
    if (!historyCursor) return;
    const loadGeneration = loadGenerationRef.current;
    const olderGeneration = ++olderGenerationRef.current;
    const cursor = historyCursor;
    setLoadingOlder(true);
    setError(null);
    try {
      const result = await api<HistoryPayload>(
        `/api/sessions?historyCursor=${encodeURIComponent(cursor)}`,
      );
      if (
        loadGeneration !== loadGenerationRef.current ||
        olderGeneration !== olderGenerationRef.current
      )
        return;
      setHistory((current) => {
        const known = new Set(current.map((session) => session.id));
        return [
          ...current,
          ...result.history.filter((session) => !known.has(session.id)),
        ];
      });
      setHistoryCursor(result.historyCursor);
    } catch (caught) {
      if (
        loadGeneration !== loadGenerationRef.current ||
        olderGeneration !== olderGenerationRef.current
      )
        return;
      setError(caught);
    } finally {
      if (
        loadGeneration === loadGenerationRef.current &&
        olderGeneration === olderGenerationRef.current
      )
        setLoadingOlder(false);
    }
  };

  if (loading) return <LoadingState />;
  if (error && !history.length)
    return (
      <ErrorNotice error={error} onRetry={() => void load(dataRevision)} />
    );

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
