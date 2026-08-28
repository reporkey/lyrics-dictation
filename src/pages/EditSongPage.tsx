import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, broadcastSessionReplaced } from "../api";
import { useAppData } from "../app-data";
import { ErrorNotice, LoadingState } from "../components/Feedback";
import { SongForm, type SongFormValue } from "../components/SongForm";
import { useI18n } from "../i18n";
import type { Song } from "../lib/types";
import { deleteRecoveryForSong } from "../recovery";

export const EditSongPage = () => {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const { reload } = useAppData();
  const navigate = useNavigate();
  const [song, setSong] = useState<Song | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void api<{ song: Song }>(`/api/songs/${id}`)
      .then((result) => setSong(result.song))
      .catch(setError);
  }, [id]);

  if (error && !song)
    return (
      <div className="page page-narrow">
        <ErrorNotice error={error} />
      </div>
    );
  if (!song) return <LoadingState />;

  const submit = async (value: SongFormValue) => {
    setPending(true);
    try {
      const result = await api<{ song: Song }>(`/api/songs/${id}`, {
        method: "PUT",
        body: JSON.stringify({ ...value, version: song.version }),
      });
      await deleteRecoveryForSong(song.id);
      broadcastSessionReplaced(song.id, null);
      await reload();
      navigate(`/songs/${result.song.id}`);
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
        warnOnEdit={Boolean(song.activeSessionId)}
      />
    </div>
  );
};
