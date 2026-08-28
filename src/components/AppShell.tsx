import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAppData } from "../app-data";
import { useI18n } from "../i18n";
import { ErrorNotice, LoadingState } from "./Feedback";

const readTheme = (): "light" | "dark" => {
  const stored = localStorage.getItem("lyrics-dictation:theme");
  if (stored === "light" || stored === "dark") return stored;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

export const AppShell = ({ children }: { children: ReactNode }) => {
  const { locale, t } = useI18n();
  const { changeLocale, data, deleting, deleted, error, loading, reload } =
    useAppData();
  const [theme, setTheme] = useState(readTheme);
  const [settingsError, setSettingsError] = useState<unknown>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("lyrics-dictation:theme", theme);
  }, [theme]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        {t("skipToContent")}
      </a>
      <header className="site-header">
        <Link className="wordmark" to="/" aria-label={t("appName")}>
          <span className="wordmark-mark" aria-hidden="true">
            Ld
          </span>
          <span>{t("appName")}</span>
        </Link>
        <nav className="primary-nav" aria-label={t("appName")}>
          <NavLink to="/">{t("library")}</NavLink>
          <NavLink to="/import">{t("importLyrics")}</NavLink>
          <NavLink to="/privacy">{t("privacy")}</NavLink>
        </nav>
        <div className="header-controls">
          <label className="select-compact">
            <span className="sr-only">{t("language")}</span>
            <select
              value={locale}
              onChange={(event) => {
                setSettingsError(null);
                void changeLocale(event.target.value as "en" | "zh-CN").catch(
                  setSettingsError,
                );
              }}
            >
              <option value="en">EN</option>
              <option value="zh-CN">中文</option>
            </select>
          </label>
          <button
            className="icon-button"
            type="button"
            onClick={() =>
              setTheme((current) => (current === "light" ? "dark" : "light"))
            }
            aria-label={theme === "light" ? t("darkTheme") : t("lightTheme")}
            title={theme === "light" ? t("darkTheme") : t("lightTheme")}
          >
            <span aria-hidden="true">{theme === "light" ? "◐" : "☼"}</span>
          </button>
        </div>
      </header>
      <main id="main-content">
        {deleting ? (
          <LoadingState />
        ) : deleted ? (
          <div className="page page-narrow">
            <p className="notice notice-success" role="status">
              {t("dataDeleted")}
            </p>
          </div>
        ) : settingsError ? (
          <div className="global-notice">
            <ErrorNotice error={settingsError} />
          </div>
        ) : null}
        {!deleting && !deleted && loading && !data ? (
          <LoadingState />
        ) : error && !data ? (
          <ErrorNotice error={error} onRetry={() => void reload()} />
        ) : !deleting && !deleted ? (
          children
        ) : null}
      </main>
    </div>
  );
};
