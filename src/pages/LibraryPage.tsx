import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAppData } from "../app-data";
import { useI18n } from "../i18n";
import { ErrorNotice, LoadingState } from "../components/Feedback";
import {
  PREFERENCES_CLEARED_EVENT,
  readPreference,
  subscribePreferenceChanges,
  writePreference,
} from "../preferences";

type ViewMode = "cards" | "list";

const readViewMode = (): ViewMode =>
  readPreference("lyrics-dictation:library-view") === "list" ? "list" : "cards";

export const LibraryPage = () => {
  const { t, locale } = useI18n();
  const { data, loading, error, reload } = useAppData();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "title">("recent");
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const changeViewMode = (next: ViewMode) => {
    writePreference("lyrics-dictation:library-view", next);
    setViewMode(next);
  };
  useEffect(() => {
    const unsubscribe = subscribePreferenceChanges(({ key, value }) => {
      if (key !== "lyrics-dictation:library-view") return;
      setViewMode(value === "list" ? "list" : "cards");
    });
    // Reconcile a change that landed between the initial render and effect.
    setViewMode(readViewMode());
    const onCleared = () => setViewMode("cards");
    window.addEventListener(PREFERENCES_CLEARED_EVENT, onCleared);
    return () => {
      unsubscribe();
      window.removeEventListener(PREFERENCES_CLEARED_EVENT, onCleared);
    };
  }, []);
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
          <p className="library-intro">{t("libraryIntro")}</p>
          <p className="subtle">
            {t(data?.songs.length === 1 ? "songsCountOne" : "songsCount", {
              count: data?.songs.length ?? 0,
            })}
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
            <div
              className="view-switch"
              role="group"
              aria-label={t("viewMode")}
            >
              <button
                type="button"
                data-testid="view-cards"
                aria-label={t("cardView")}
                aria-pressed={viewMode === "cards"}
                title={t("cardView")}
                onClick={() => changeViewMode("cards")}
              >
                <svg aria-hidden="true" viewBox="0 0 16 16">
                  <rect x="2" y="2" width="5" height="5" rx="1" />
                  <rect x="9" y="2" width="5" height="5" rx="1" />
                  <rect x="2" y="9" width="5" height="5" rx="1" />
                  <rect x="9" y="9" width="5" height="5" rx="1" />
                </svg>
              </button>
              <button
                type="button"
                data-testid="view-list"
                aria-label={t("listView")}
                aria-pressed={viewMode === "list"}
                title={t("listView")}
                onClick={() => changeViewMode("list")}
              >
                <svg aria-hidden="true" viewBox="0 0 16 16">
                  <rect x="2" y="2" width="12" height="2" rx="1" />
                  <rect x="2" y="7" width="12" height="2" rx="1" />
                  <rect x="2" y="12" width="12" height="2" rx="1" />
                </svg>
              </button>
            </div>
          </div>
          <section
            className={`song-grid ${viewMode === "list" ? "song-list" : ""}`}
            data-view={viewMode}
            aria-label={t("library")}
          >
            {songs.map((song) => (
              <article className="song-card" key={song.id}>
                <div className="song-card-top">
                  <span className="source-badge">
                    {song.sourceKind === "plain" ? t("plainText") : t("lrc")}
                  </span>
                  {song.activeSessionId ? (
                    <span className="draft-dot">{t("activeDraft")}</span>
                  ) : null}
                </div>
                <div className="song-card-copy">
                  <h2>
                    <Link
                      to={`/songs/${song.id}`}
                      aria-label={t("openSong", { title: song.title })}
                    >
                      {song.title}
                    </Link>
                  </h2>
                  <p>{song.artist || t("untitledArtist")}</p>
                </div>
                <div className="song-card-footer">
                  <div className="song-card-metrics">
                    <span className="song-card-characters">
                      {t(
                        song.characterCount === 1
                          ? "characterCountOne"
                          : "characterCount",
                        { count: song.characterCount },
                      )}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="song-card-metric">
                      {t(
                        song.practiceSessions === 1
                          ? "practiceCountOne"
                          : "practiceCount",
                        { count: song.practiceSessions },
                      )}
                    </span>
                  </div>
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
    </div>
  );
};
