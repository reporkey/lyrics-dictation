import { afterEach, describe, expect, it } from "vitest";
import { ANALYTICS_MEASUREMENT_ID, initAnalytics } from "../../src/analytics";

afterEach(() => {
  document.querySelector("script[data-google-analytics]")?.remove();
  delete (window as Window & { dataLayer?: unknown[][] }).dataLayer;
  delete (window as Window & { gtag?: (...args: unknown[]) => void }).gtag;
});

describe("analytics initialization", () => {
  it("does not load analytics outside the production hostname", () => {
    expect(initAnalytics("localhost")).toBe(false);
    expect(document.querySelector("script[data-google-analytics]")).toBeNull();
  });

  it("loads the production tag once and queues privacy-conscious defaults", () => {
    expect(initAnalytics("dictation.reporkey.com")).toBe(true);
    expect(initAnalytics("dictation.reporkey.com")).toBe(true);

    const scripts = document.querySelectorAll("script[data-google-analytics]");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.getAttribute("src")).toBe(
      `https://www.googletagmanager.com/gtag/js?id=${ANALYTICS_MEASUREMENT_ID}`,
    );

    const dataLayer = (window as Window & { dataLayer?: unknown[][] })
      .dataLayer;
    expect(dataLayer).toHaveLength(2);
    expect(Array.from(dataLayer?.[1] ?? [])).toEqual([
      "config",
      ANALYTICS_MEASUREMENT_ID,
      {
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
      },
    ]);
  });
});
