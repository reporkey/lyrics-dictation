import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiClientError,
  api,
  broadcastDataChanged,
  broadcastSessionReplaced,
  broadcastSongDeleted,
  idempotencyKey,
} from "../api";
import { useAppData } from "../app-data";
import { ErrorNotice, LoadingState } from "../components/Feedback";
import { useI18n } from "../i18n";
import type { DictationSession, Song } from "../lib/types";
import { deleteRecoveryForSong } from "../recovery";

export const SongPage = () => {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const { data, dataRevision, reload } = useAppData();
  const navigate = useNavigate();
  const [song, setSong] = useState<Song | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const startIntentRef = useRef<{
    fingerprint: string;
    key: string;
  } | null>(null);
  const deleteIntentRef = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);

  const load = useCallback(
    async (revision: number) => {
      if (!Number.isSafeInteger(revision)) return;
      const generation = ++loadGenerationRef.current;
      try {
        setError(null);
        const result = await api<{ song: Song }>(`/api/songs/${id}`);
        if (generation !== loadGenerationRef.current) return;
        setSong(result.song);
      } catch (caught) {
        if (generation !== loadGenerationRef.current) return;
        if (
          caught instanceof ApiClientError &&
          caught.code === "SONG_NOT_FOUND"
        )
          setSong(null);
        setError(caught);
      }
    },
    [id],
  );
  useEffect(() => {
    void load(dataRevision);
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [dataRevision, load]);

  useEffect(() => {
    if (!data || data.songs.some((candidate) => candidate.id === id)) return;
    loadGenerationRef.current += 1;
    setSong(null);
    setError(new ApiClientError("SONG_NOT_FOUND", 404));
  }, [data, id]);

  const start = async (restart: boolean) => {
    if (restart && !confirm(t("startOverConfirm"))) return;
    setPending(true);
    const fingerprint = JSON.stringify({ restart, caseSensitive });
    if (startIntentRef.current?.fingerprint !== fingerprint) {
      startIntentRef.current = { fingerprint, key: idempotencyKey() };
    }
    try {
      const result = await api<{ session: DictationSession }>(
        `/api/songs/${id}/sessions`,
        {
          method: "POST",
          headers: { "Idempotency-Key": startIntentRef.current.key },
          body: JSON.stringify({ restart, caseSensitive }),
        },
      );
      startIntentRef.current = null;
      if (restart) await deleteRecoveryForSong(id);
      if (restart) broadcastSessionReplaced(id, result.session.id);
      else broadcastDataChanged();
      navigate(`/dictation/${result.session.id}`);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (!song || !confirm(t("deleteSongConfirm"))) return;
    setPending(true);
    deleteIntentRef.current ??= idempotencyKey();
    try {
      await api(`/api/songs/${song.id}?version=${song.version}`, {
        method: "DELETE",
        headers: { "Idempotency-Key": deleteIntentRef.current },
      });
      deleteIntentRef.current = null;
      await deleteRecoveryForSong(song.id);
      broadcastSongDeleted(song.id);
      await reload();
      navigate("/");
    } catch (caught) {
      setError(caught);
      setPending(false);
    }
  };

  if (error && !song)
    return (
      <div className="page page-narrow">
        <ErrorNotice error={error} onRetry={() => void load(dataRevision)} />
      </div>
    );
  if (!song) return <LoadingState />;

  return (
    <div className="page page-song">
      <Link className="back-link" to="/">
        ← {t("library")}
      </Link>
      <section className="song-hero">
        <div>
          <p className="eyebrow">{song.artist || t("untitledArtist")}</p>
          <h1>{song.title}</h1>
          <p className="subtle">
            {t(
              song.practiceSessions === 1
                ? "practiceCountOne"
                : "practiceCount",
              {
                count: song.practiceSessions,
              },
            )}
          </p>
        </div>
        <div className="hero-actions">
          <button
            className="button button-primary"
            type="button"
            disabled={pending}
            onClick={() => void start(false)}
          >
            {song.activeSessionId ? t("resumeDictation") : t("startDictation")}
          </button>
          {song.activeSessionId ? (
            <button
              className="button button-secondary"
              type="button"
              disabled={pending}
              onClick={() => void start(true)}
            >
              {t("startOver")}
            </button>
          ) : null}
          {!song.activeSessionId ? (
            <label className="check-option">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(event) => setCaseSensitive(event.target.checked)}
              />
              <span>{t("caseSensitive")}</span>
            </label>
          ) : null}
        </div>
      </section>
      {error ? <ErrorNotice error={error} /> : null}
      <section className="lyrics-sheet">
        <div className="section-heading-row">
          <h2>{t("lyricsHeading")}</h2>
          <Link className="button button-ghost" to={`/songs/${song.id}/edit`}>
            {t("editSong")}
          </Link>
        </div>
        <pre>{song.studyText}</pre>
      </section>
      <div className="danger-zone">
        <button
          className="button button-danger-ghost"
          type="button"
          onClick={() => void remove()}
          disabled={pending}
        >
          {t("deleteSong")}
        </button>
      </div>
    </div>
  );
};
