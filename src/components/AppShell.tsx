import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAppData } from "../app-data";
import { useI18n } from "../i18n";
import { ErrorNotice, LoadingState } from "./Feedback";

const readThemePreference = (): "light" | "dark" | null => {
  const stored = localStorage.getItem("lyrics-dictation:theme");
  if (stored === "light" || stored === "dark") return stored;
  return null;
};

const systemTheme = (): "light" | "dark" =>
  matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

export const AppShell = ({ children }: { children: ReactNode }) => {
  const { locale, t } = useI18n();
  const { changeLocale, data, deleting, deleted, error, loading, reload } =
    useAppData();
  const [theme, setTheme] = useState<"light" | "dark">(
    () => readThemePreference() ?? systemTheme(),
  );
  const [settingsError, setSettingsError] = useState<unknown>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const followSystem = (event: MediaQueryListEvent) => {
      if (!readThemePreference()) setTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", followSystem);
    return () => media.removeEventListener("change", followSystem);
  }, []);

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
          <div
            className="language-switch"
            data-locale={locale}
            role="group"
            aria-label={t("language")}
          >
            <button
              type="button"
              data-testid="language-zh"
              aria-pressed={locale === "zh-CN"}
              aria-label={t("chinese")}
              onClick={() => {
                setSettingsError(null);
                if (locale !== "zh-CN")
                  void changeLocale("zh-CN").catch(setSettingsError);
              }}
            >
              中
            </button>
            <button
              type="button"
              data-testid="language-en"
              aria-pressed={locale === "en"}
              aria-label={t("english")}
              onClick={() => {
                setSettingsError(null);
                if (locale !== "en")
                  void changeLocale("en").catch(setSettingsError);
              }}
            >
              EN
            </button>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={() => {
              const next = theme === "light" ? "dark" : "light";
              localStorage.setItem("lyrics-dictation:theme", next);
              setTheme(next);
            }}
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
