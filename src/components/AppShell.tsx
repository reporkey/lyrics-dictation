import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAppData } from "../app-data";
import { useI18n } from "../i18n";
import {
  PREFERENCES_CLEARED_EVENT,
  readPreference,
  subscribePreferenceChanges,
  writePreference,
} from "../preferences";
import { ErrorNotice, LoadingState } from "./Feedback";

const GITHUB_REPOSITORY_URL = "https://github.com/reporkey/lyrics-dictation";

const readThemePreference = (): "light" | "dark" | null => {
  const stored = readPreference("lyrics-dictation:theme");
  if (stored === "light" || stored === "dark") return stored;
  return null;
};

const systemTheme = (): "light" | "dark" =>
  matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

const applyTheme = (theme: "light" | "dark") => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const color = theme === "dark" ? "#131915" : "#f5f3ee";
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", color);
};

export const AppShell = ({ children }: { children: ReactNode }) => {
  const { locale, t } = useI18n();
  const { changeLocale, data, deleting, deleted, error, loading, reload } =
    useAppData();
  const [theme, setTheme] = useState<"light" | "dark">(
    () => readThemePreference() ?? systemTheme(),
  );
  const [settingsError, setSettingsError] = useState<unknown>(null);
  const primaryNavigation = (variant: "desktop" | "mobile") => (
    <nav
      className={`primary-nav primary-nav-${variant}`}
      aria-label={t("appName")}
    >
      <NavLink to="/">{t("library")}</NavLink>
      <NavLink to="/history">
        {t(variant === "mobile" ? "historyNav" : "practiceHistory")}
      </NavLink>
      <NavLink to="/import">
        {t(variant === "mobile" ? "importNav" : "importLyrics")}
      </NavLink>
      <NavLink to="/privacy">
        {t(variant === "mobile" ? "privacyNav" : "privacy")}
      </NavLink>
    </nav>
  );

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const followSystem = (event: MediaQueryListEvent) => {
      if (!readThemePreference()) setTheme(event.matches ? "dark" : "light");
    };
    const unsubscribe = subscribePreferenceChanges(({ key, value }) => {
      if (key !== "lyrics-dictation:theme") return;
      if (value === "light" || value === "dark") {
        setTheme(value);
      } else {
        setTheme(systemTheme());
      }
    });
    // A preference can change after render but before this effect subscribes.
    setTheme(readThemePreference() ?? systemTheme());
    const resetPreference = () => setTheme(systemTheme());
    media.addEventListener("change", followSystem);
    window.addEventListener(PREFERENCES_CLEARED_EVENT, resetPreference);
    return () => {
      media.removeEventListener("change", followSystem);
      unsubscribe();
      window.removeEventListener(PREFERENCES_CLEARED_EVENT, resetPreference);
    };
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
        {primaryNavigation("desktop")}
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
              writePreference("lyrics-dictation:theme", next);
              setTheme(next);
            }}
            aria-label={theme === "light" ? t("darkTheme") : t("lightTheme")}
            title={theme === "light" ? t("darkTheme") : t("lightTheme")}
          >
            <span aria-hidden="true">{theme === "light" ? "◐" : "☼"}</span>
          </button>
          <a
            className="github-link"
            href={GITHUB_REPOSITORY_URL}
            target="_blank"
            rel="noreferrer"
            aria-label={t("githubRepository")}
            title={t("githubRepository")}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18a2.65 2.65 0 0 0-1.1-1.46c-.9-.62.07-.61.07-.61a2.1 2.1 0 0 1 1.53 1.03 2.13 2.13 0 0 0 2.91.83 2.13 2.13 0 0 1 .63-1.34c-2.22-.25-4.55-1.11-4.55-4.94a3.87 3.87 0 0 1 1.03-2.68 3.6 3.6 0 0 1 .1-2.65s.84-.27 2.75 1.02a9.47 9.47 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02a3.6 3.6 0 0 1 .1 2.65 3.87 3.87 0 0 1 1.03 2.68c0 3.84-2.34 4.68-4.57 4.93a2.39 2.39 0 0 1 .68 1.86v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
            </svg>
          </a>
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
      {primaryNavigation("mobile")}
    </div>
  );
};
