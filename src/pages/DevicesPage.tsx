import { useMemo, useState } from "react";
import { api, broadcastDataChanged, idempotencyKey } from "../api";
import { useAppData } from "../app-data";
import { ErrorNotice } from "../components/Feedback";
import { useI18n } from "../i18n";
import type { PairingPreview } from "../lib/types";
import { deleteAllRecovery, hasAnyRecovery } from "../recovery";

interface PairingCodeResult {
  code: string;
  expiresAt: number;
}

export const DevicesPage = () => {
  const { locale, t } = useI18n();
  const { data, reload } = useAppData();
  const [pairingCode, setPairingCode] = useState<PairingCodeResult | null>(
    null,
  );
  const [enteredCode, setEnteredCode] = useState("");
  const [preview, setPreview] = useState<PairingPreview | null>(null);
  const [pending, setPending] = useState<
    "code" | "preview" | "join" | "leave" | string | null
  >(null);
  const [error, setError] = useState<unknown>(null);
  const [joined, setJoined] = useState(false);
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );

  if (!data) return null;

  const describeDevice = (device: (typeof data.devices)[number]) => {
    const platform =
      device.platform === "Android" && device.deviceType === "phone"
        ? t("androidPhone")
        : device.platform === "Android" && device.deviceType === "tablet"
          ? t("androidTablet")
          : device.platform;
    const browser = device.browser
      ? `${device.browser}${device.browserMajorVersion ? ` ${device.browserMajorVersion}` : ""}`
      : null;
    return (
      [platform, browser].filter(Boolean).join(" · ") || t("deviceInfoPending")
    );
  };

  const createCode = async () => {
    setPending("code");
    setError(null);
    try {
      setPairingCode(
        await api<PairingCodeResult>("/api/devices/pairing-code", {
          method: "POST",
        }),
      );
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(null);
    }
  };

  const reviewJoin = async () => {
    setPending("preview");
    setError(null);
    setJoined(false);
    try {
      setPreview(
        await api<PairingPreview>("/api/devices/pairing-preview", {
          method: "POST",
          body: JSON.stringify({ code: enteredCode }),
        }),
      );
    } catch (caught) {
      setPreview(null);
      setError(caught);
    } finally {
      setPending(null);
    }
  };

  const join = async () => {
    const localRecovery = await hasAnyRecovery();
    const confirmReplace = Boolean(
      preview?.requiresConfirmation || localRecovery,
    );
    if (confirmReplace && !confirm(t("joinReplaceConfirm"))) return;
    setPending("join");
    setError(null);
    try {
      await api("/api/devices/join", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: JSON.stringify({ code: enteredCode, confirmReplace }),
      });
      await deleteAllRecovery();
      broadcastDataChanged();
      setPreview(null);
      setEnteredCode("");
      setPairingCode(null);
      setJoined(true);
      await reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(null);
    }
  };

  const leave = async () => {
    if (!confirm(t("leaveGroupConfirm"))) return;
    setPending("leave");
    setError(null);
    try {
      await api("/api/devices/leave", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
      });
      broadcastDataChanged();
      setPairingCode(null);
      await reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(null);
    }
  };

  const remove = async (id: string, label: string) => {
    if (!confirm(t("removeDeviceConfirm", { device: label }))) return;
    setPending(id);
    setError(null);
    try {
      await api(`/api/devices/${encodeURIComponent(id)}/remove`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
      });
      broadcastDataChanged();
      setPairingCode(null);
      await reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="page page-narrow devices-page">
      <section className="page-heading stacked-heading">
        <p className="eyebrow">{t("devices")}</p>
        <h1>{t("devicesTitle")}</h1>
        <p>{t("devicesIntro")}</p>
        <p className="device-privacy-note">{t("deviceInfoPrivacy")}</p>
      </section>

      {error ? <ErrorNotice error={error} /> : null}
      {joined ? (
        <p className="notice notice-success" role="status">
          {t("pairingJoined")}
        </p>
      ) : null}

      <section className="device-panel" aria-labelledby="device-list-title">
        <div className="device-panel-heading">
          <div>
            <h2 id="device-list-title">{t("devices")}</h2>
            <p>
              {data.paired
                ? t("pairedDeviceStatus", { count: data.devices.length })
                : t("privateDeviceStatus")}
            </p>
          </div>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => void createCode()}
            disabled={pending !== null}
          >
            {pending === "code"
              ? t("creatingPairingCode")
              : t("createPairingCode")}
          </button>
        </div>

        <ul className="device-list">
          {data.devices.map((device) => {
            const name = t("deviceName", { label: device.label });
            return (
              <li key={device.id}>
                <div>
                  <strong>{name}</strong>
                  {device.isThisDevice ? (
                    <span className="status-pill">{t("thisDevice")}</span>
                  ) : null}
                  <p className="device-client-info">{describeDevice(device)}</p>
                  <p className="device-last-active">
                    {t("lastActive", {
                      date: formatter.format(device.lastActiveAt),
                    })}
                  </p>
                </div>
                {!device.isThisDevice && data.paired ? (
                  <button
                    className="button button-danger-ghost"
                    type="button"
                    onClick={() => void remove(device.id, name)}
                    disabled={pending !== null}
                  >
                    {t("removeDevice")}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>

        {pairingCode ? (
          <div className="pairing-code" role="status">
            <span>{t("pairingCodeTitle")}</span>
            <strong>{pairingCode.code}</strong>
            <p>{t("pairingCodeHint")}</p>
          </div>
        ) : null}

        {data.paired ? (
          <button
            className="button button-danger-ghost leave-group-button"
            type="button"
            onClick={() => void leave()}
            disabled={pending !== null}
          >
            {t("leaveGroup")}
          </button>
        ) : null}
      </section>

      <section className="device-panel join-panel" aria-labelledby="join-title">
        <div>
          <h2 id="join-title">{t("joinDeviceTitle")}</h2>
          <p>{t("joinDeviceHint")}</p>
        </div>
        <label className="field">
          <span>{t("pairingCodeLabel")}</span>
          <input
            value={enteredCode}
            onChange={(event) => {
              setEnteredCode(event.target.value);
              setPreview(null);
              setJoined(false);
            }}
            placeholder={t("pairingCodePlaceholder")}
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
          />
        </label>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => void reviewJoin()}
          disabled={!enteredCode.trim() || pending !== null || data.paired}
        >
          {pending === "preview" ? t("reviewingPairing") : t("previewPairing")}
        </button>

        {preview ? (
          <div className="replace-warning">
            <h3>{t("replaceWarningTitle")}</h3>
            <p>
              {preview.requiresConfirmation
                ? t("replaceWarning", {
                    songs: preview.replacement.songs,
                    drafts: preview.replacement.activeDrafts,
                    history: preview.replacement.history,
                  })
                : t("emptyReplaceWarning")}
            </p>
            <button
              className="button button-primary"
              type="button"
              onClick={() => void join()}
              disabled={pending !== null}
            >
              {pending === "join" ? t("joiningDevice") : t("joinDevice")}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
};
