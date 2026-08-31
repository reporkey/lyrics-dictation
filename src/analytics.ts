export const ANALYTICS_MEASUREMENT_ID = "G-3HVWYHJWZF";

type AnalyticsWindow = Window & {
  dataLayer?: unknown[][];
  gtag?: (...args: unknown[]) => void;
};

export const initAnalytics = (hostname = window.location.hostname): boolean => {
  if (hostname !== "dictation.reporkey.com") return false;
  if (document.querySelector("script[data-google-analytics]")) return true;

  const analyticsWindow = window as AnalyticsWindow;
  const dataLayer = (analyticsWindow.dataLayer ??= []);
  function gtag(...args: unknown[]) {
    dataLayer.push(args);
  }
  analyticsWindow.gtag = gtag;
  gtag("js", new Date());
  gtag("config", ANALYTICS_MEASUREMENT_ID, {
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  const script = document.createElement("script");
  script.async = true;
  script.dataset.googleAnalytics = ANALYTICS_MEASUREMENT_ID;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${ANALYTICS_MEASUREMENT_ID}`;
  document.head.appendChild(script);
  return true;
};
