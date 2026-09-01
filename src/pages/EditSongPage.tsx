import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, broadcastSessionReplaced, idempotencyKey } from "../api";
import { useAppData } from "../app-data";
import { ErrorNotice, LoadingState } from "../components/Feedback";
import { SongForm, type SongFormValue } from "../components/SongForm";
import { useI18n } from "../i18n";
import type { Song } from "../lib/types";
import { deleteRecoveryForSong } from "../recovery";

export const EditSongPage = () => {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const { data, dataRevision, reload } = useAppData();
  const navigate = useNavigate();
  const [song, setSong] = useState<Song | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const mutationIntentRef = useRef<{
    fingerprint: string;
    key: string;
  } | null>(null);

  useEffect(() => {
    void api<{ song: Song }>(`/api/songs/${id}`)
      .then((result) => setSong(result.song))
      .catch(setError);
  }, [id]);

  const latestSong = data?.songs.find((candidate) => candidate.id === id);
  useEffect(() => {
    if (!data || latestSong) return;
    navigate("/", { replace: true });
  }, [data, dataRevision, latestSong, navigate]);

  if (error && !song)
    return (
      <div className="page page-narrow">
        <ErrorNotice error={error} />
      </div>
    );
  if (!song) return <LoadingState />;

  const submit = async (value: SongFormValue) => {
    if (latestSong?.activeSessionId && !confirm(t("sourceUpdatedWarning")))
      return;
    setPending(true);
    const fingerprint = JSON.stringify([id, song.version, value]);
    if (mutationIntentRef.current?.fingerprint !== fingerprint) {
      mutationIntentRef.current = { fingerprint, key: idempotencyKey() };
    }
    const finish = async (saved: Song) => {
      await deleteRecoveryForSong(saved.id);
      mutationIntentRef.current = null;
      broadcastSessionReplaced(saved.id, null);
      await reload();
      navigate(`/songs/${saved.id}`);
    };
    try {
      const result = await api<{ song: Song }>(`/api/songs/${id}`, {
        method: "PUT",
        headers: { "Idempotency-Key": mutationIntentRef.current.key },
        body: JSON.stringify({ ...value, version: song.version }),
      });
      await finish(result.song);
    } catch (caught) {
      try {
        const current = await api<{ song: Song }>(`/api/songs/${id}`);
        if (
          current.song.version > song.version &&
          current.song.title === value.title &&
          current.song.artist === value.artist &&
          current.song.sourceText === value.sourceText &&
          current.song.sourceKind === value.sourceKind
        ) {
          await finish(current.song);
          return;
        }
      } catch {
        // Preserve the original mutation error and intent for a safe retry.
      }
      throw caught;
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="page page-narrow">
      <section className="page-heading stacked-heading">
        <p className="eyebrow">{song.artist || t("untitledArtist")}</p>
        <h1>{t("editSong")}</h1>
      </section>
      <SongForm
        initial={{
          title: song.title,
          artist: song.artist,
          sourceText: song.sourceText,
          sourceKind: song.sourceKind,
        }}
        onSubmit={submit}
        submitLabel={t("saveSong")}
        pending={pending}
        warnOnEdit={Boolean(
          latestSong?.activeSessionId ?? song.activeSessionId,
        )}
      />
    </div>
  );
};
