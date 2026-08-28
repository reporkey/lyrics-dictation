import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAppData } from "../app-data";
import { useI18n } from "../i18n";
import { ErrorNotice, LoadingState } from "../components/Feedback";

export const LibraryPage = () => {
  const { t, locale } = useI18n();
  const { data, loading, error, reload } = useAppData();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "title">("recent");
  const songs = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale);
    return [...(data?.songs ?? [])]
      .filter(
        (song) =>
          !normalized ||
          song.title.toLocaleLowerCase(locale).includes(normalized) ||
          song.artist.toLocaleLowerCase(locale).includes(normalized),
      )
      .sort((a, b) =>
        sort === "title"
          ? a.title.localeCompare(b.title, locale)
          : b.updatedAt - a.updatedAt,
      );
  }, [data?.songs, locale, query, sort]);

  if (loading) return <LoadingState />;
  if (error && !data)
    return <ErrorNotice error={error} onRetry={() => void reload()} />;

  return (
    <div className="page page-library">
      <section className="page-heading library-heading">
        <div>
          <p className="eyebrow">{t("appName")}</p>
          <h1>{t("library")}</h1>
          <p className="subtle">
            {t("songsCount", { count: data?.songs.length ?? 0 })}
          </p>
        </div>
        <Link className="button button-primary" to="/import">
          <span aria-hidden="true">＋</span> {t("importLyrics")}
        </Link>
      </section>

      {!data?.songs.length ? (
        <section className="empty-state">
          <div className="empty-mark" aria-hidden="true">
            Aa
          </div>
          <h2>{t("emptyTitle")}</h2>
          <p>{t("emptyBody")}</p>
          <Link className="button button-primary" to="/import">
            {t("addFirstSong")}
          </Link>
        </section>
      ) : (
        <>
          <div className="library-tools">
            <label className="search-field">
              <span aria-hidden="true">⌕</span>
              <span className="sr-only">{t("searchSongs")}</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("searchSongs")}
              />
            </label>
            <label className="select-compact sort-select">
              <span className="sr-only">{t("sortLabel")}</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as typeof sort)}
              >
                <option value="recent">{t("sortRecent")}</option>
                <option value="title">{t("sortTitle")}</option>
              </select>
            </label>
          </div>
          <section className="song-grid" aria-label={t("library")}>
            {songs.map((song) => (
              <article className="song-card" key={song.id}>
                <div className="song-card-top">
                  <span className="source-badge">
                    {song.sourceKind.toUpperCase()}
                  </span>
                  {song.activeSessionId ? (
                    <span className="draft-dot">{t("activeDraft")}</span>
                  ) : null}
                </div>
                <h2>
                  <Link
                    to={`/songs/${song.id}`}
                    aria-label={t("openSong", { title: song.title })}
                  >
                    {song.title}
                  </Link>
                </h2>
                <p>{song.artist || t("untitledArtist")}</p>
                <div className="song-card-footer">
                  <span>
                    {t("completedPractice", { count: song.completedSessions })}
                  </span>
                  <Link
                    className="card-arrow"
                    to={`/songs/${song.id}`}
                    aria-hidden="true"
                    tabIndex={-1}
                  >
                    →
                  </Link>
                </div>
              </article>
            ))}
          </section>
        </>
      )}

      {data?.recentSessions.length ? (
        <section className="activity-section">
          <h2>{t("recentActivity")}</h2>
          <div className="activity-list">
            {data.recentSessions.map((session) => (
              <Link
                to={`/songs/${session.songId}`}
                className="activity-row"
                key={session.id}
              >
                <span>
                  <strong>{session.songTitle}</strong>
                  <small>
                    {t("startedAt", {
                      date: new Intl.DateTimeFormat(locale, {
                        dateStyle: "medium",
                      }).format(session.startedAt),
                    })}
                  </small>
                </span>
                <span className={`status-pill status-${session.status}`}>
                  {session.status === "completed"
                    ? t("statusCompleted")
                    : t("statusAbandoned")}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
};
