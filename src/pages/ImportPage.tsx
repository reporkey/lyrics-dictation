import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, broadcastDataChanged, idempotencyKey } from "../api";
import { SongForm, type SongFormValue } from "../components/SongForm";
import { useAppData } from "../app-data";
import { useI18n } from "../i18n";
import type { Song } from "../lib/types";

export const ImportPage = () => {
  const { t } = useI18n();
  const { reload } = useAppData();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const intentRef = useRef<{ body: string; key: string } | null>(null);
  const submit = async (value: SongFormValue) => {
    setPending(true);
    const body = JSON.stringify(value);
    if (intentRef.current?.body !== body) {
      intentRef.current = { body, key: idempotencyKey() };
    }
    try {
      const result = await api<{ song: Song }>("/api/songs", {
        method: "POST",
        headers: { "Idempotency-Key": intentRef.current.key },
        body,
      });
      intentRef.current = null;
      broadcastDataChanged();
      await reload();
      navigate(`/songs/${result.song.id}`);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="page page-narrow">
      <section className="page-heading stacked-heading">
        <p className="eyebrow">{t("library")}</p>
        <h1>{t("importTitle")}</h1>
        <p>{t("importIntro")}</p>
      </section>
      <SongForm
        onSubmit={submit}
        submitLabel={t("saveSong")}
        pending={pending}
      />
    </div>
  );
};
