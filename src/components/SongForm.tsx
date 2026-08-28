import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../i18n";
import { inferSourceKind, parseLyrics } from "../lib/lyrics";
import { LIMITS, type SourceKind } from "../lib/constants";
import { ErrorNotice } from "./Feedback";

export interface SongFormValue {
  title: string;
  artist: string;
  sourceText: string;
  sourceKind: SourceKind;
}

export const SongForm = ({
  initial,
  onSubmit,
  submitLabel,
  pending,
  warnOnEdit = false,
}: {
  initial?: SongFormValue;
  onSubmit: (value: SongFormValue) => Promise<void>;
  submitLabel: string;
  pending: boolean;
  warnOnEdit?: boolean;
}) => {
  const { t } = useI18n();
  const [value, setValue] = useState<SongFormValue>(
    initial ?? { title: "", artist: "", sourceText: "", sourceKind: "plain" },
  );
  const [selectedFile, setSelectedFile] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [formatExplicit, setFormatExplicit] = useState(Boolean(initial));

  const review = (sourceText: string, sourceKind = value.sourceKind) => {
    try {
      const parsed = parseLyrics(sourceText, sourceKind);
      setError(null);
      setValue((current) => ({
        ...current,
        sourceText: parsed.sourceText,
        sourceKind,
        title: current.title || parsed.title,
        artist: current.artist || parsed.artist,
      }));
    } catch (caught) {
      // Preserve an inferred LRC choice even when review fails. Otherwise the
      // submit path could silently reinterpret the same input as plain text.
      setValue((current) => ({ ...current, sourceKind }));
      setError(caught);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(?:txt|lrc)$/iu.test(file.name)) {
      setError(new Error("FILE_TYPE"));
      return;
    }
    if (file.size > LIMITS.uploadBytes) {
      setError(new Error("SOURCE_BYTES_EXCEEDED"));
      return;
    }
    try {
      const bytes = await file.arrayBuffer();
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      const sourceKind = inferSourceKind(file.name, text);
      setSelectedFile(file.name);
      setFormatExplicit(true);
      setValue({ title: "", artist: "", sourceText: text, sourceKind });
      review(text, sourceKind);
    } catch {
      setError(new Error("FILE_DECODE"));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setError(null);
      const parsed = parseLyrics(value.sourceText, value.sourceKind);
      await onSubmit({
        ...value,
        title: value.title || parsed.title,
        artist: value.artist || parsed.artist,
        sourceText: parsed.sourceText,
      });
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <form className="song-form" onSubmit={(event) => void submit(event)}>
      <div className="file-row">
        <label className="button button-secondary file-button">
          {t("chooseFile")}
          <input
            type="file"
            accept=".txt,.lrc,text/plain,application/x-subrip"
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
        </label>
        {selectedFile ? (
          <span className="subtle">
            {t("selectedFile", { name: selectedFile })}
          </span>
        ) : null}
      </div>
      <label className="field field-wide">
        <span>{t("lyricsSource")}</span>
        <textarea
          rows={14}
          value={value.sourceText}
          placeholder={t("lyricsPlaceholder")}
          onChange={(event) =>
            setValue((current) => ({
              ...current,
              sourceText: event.target.value,
            }))
          }
          onBlur={() => {
            if (!value.sourceText) return;
            review(
              value.sourceText,
              formatExplicit
                ? value.sourceKind
                : inferSourceKind("", value.sourceText),
            );
          }}
        />
      </label>
      <div className="form-grid">
        <label className="field">
          <span>{t("songTitle")}</span>
          <input
            value={value.title}
            onChange={(event) =>
              setValue((current) => ({ ...current, title: event.target.value }))
            }
          />
        </label>
        <label className="field">
          <span>{t("artistOptional")}</span>
          <input
            value={value.artist}
            onChange={(event) =>
              setValue((current) => ({
                ...current,
                artist: event.target.value,
              }))
            }
          />
        </label>
        <label className="field">
          <span>{t("sourceFormat")}</span>
          <select
            value={value.sourceKind}
            onChange={(event) => {
              setFormatExplicit(true);
              setValue((current) => ({
                ...current,
                sourceKind: event.target.value as SourceKind,
              }));
            }}
          >
            <option value="plain">{t("plainText")}</option>
            <option value="lrc">{t("lrc")}</option>
          </select>
        </label>
      </div>
      {warnOnEdit ? (
        <p className="notice notice-warning">{t("sourceUpdatedWarning")}</p>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      <div className="form-actions">
        <button
          className="button button-primary"
          type="submit"
          disabled={pending}
        >
          {pending ? t("saving") : submitLabel}
        </button>
        <Link className="button button-ghost" to="/">
          {t("cancel")}
        </Link>
      </div>
    </form>
  );
};
