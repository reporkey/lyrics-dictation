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
      <NavLink to="/import">{t("importLyrics")}</NavLink>
      <NavLink to="/privacy">{t("privacy")}</NavLink>
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
