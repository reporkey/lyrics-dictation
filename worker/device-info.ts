export type DeviceType = "desktop" | "phone" | "tablet" | "unknown";

export interface DeviceClientInfo {
  platform: string | null;
  browser: string | null;
  browserMajorVersion: string | null;
  deviceType: DeviceType;
}

const majorVersion = (value: string | undefined) => {
  const major = value?.match(/^\d{1,4}/u)?.[0];
  return major ?? null;
};

const matchBrowser = (
  userAgent: string,
  expression: RegExp,
  browser: string,
) => {
  const match = userAgent.match(expression);
  return match
    ? { browser, browserMajorVersion: majorVersion(match[1]) }
    : null;
};

const browserFromUserAgent = (userAgent: string) =>
  matchBrowser(userAgent, /(?:Edg|EdgA|EdgiOS)\/(\d+)/iu, "Edge") ??
  matchBrowser(userAgent, /OPR\/(\d+)/iu, "Opera") ??
  matchBrowser(userAgent, /SamsungBrowser\/(\d+)/iu, "Samsung Internet") ??
  matchBrowser(userAgent, /CriOS\/(\d+)/iu, "Chrome") ??
  matchBrowser(userAgent, /FxiOS\/(\d+)/iu, "Firefox") ??
  matchBrowser(userAgent, /Firefox\/(\d+)/iu, "Firefox") ??
  matchBrowser(userAgent, /(?:HeadlessChrome|Chrome)\/(\d+)/iu, "Chrome") ??
  (/(?:iPhone|iPad|iPod)/iu.test(userAgent) && /AppleWebKit/iu.test(userAgent)
    ? (matchBrowser(userAgent, /Version\/(\d+)/iu, "Safari") ?? {
        browser: "Safari",
        browserMajorVersion: null,
      })
    : null) ??
  (/Safari\//iu.test(userAgent) && !/(?:Chrome|Chromium)\//iu.test(userAgent)
    ? matchBrowser(userAgent, /Version\/(\d+)/iu, "Safari")
    : null);

const browserFromClientHints = (brands: string) => {
  const candidates = [...brands.matchAll(/"([^"]+)"\s*;\s*v="(\d+)/gu)];
  const priorities = [
    ["Microsoft Edge", "Edge"],
    ["Google Chrome", "Chrome"],
    ["Opera", "Opera"],
    ["Chromium", "Chrome"],
  ] as const;
  for (const [brand, normalized] of priorities) {
    const candidate = candidates.find((match) => match[1] === brand);
    if (candidate) {
      return {
        browser: normalized,
        browserMajorVersion: majorVersion(candidate[2]),
      };
    }
  }
  return null;
};

const normalizedHintPlatform = (value: string | null) => {
  const platform = value?.trim().replace(/^"|"$/gu, "");
  switch (platform?.toLowerCase()) {
    case "macos":
      return "Mac";
    case "windows":
      return "Windows";
    case "android":
      return "Android";
    case "chrome os":
    case "chromium os":
      return "ChromeOS";
    case "linux":
      return "Linux";
    case "ios":
      return "iPhone";
    default:
      return null;
  }
};

const platformFromUserAgent = (userAgent: string) => {
  if (/iPad/iu.test(userAgent)) return "iPad";
  if (/(?:iPhone|iPod)/iu.test(userAgent)) return "iPhone";
  if (/Android/iu.test(userAgent)) return "Android";
  if (/Windows/iu.test(userAgent)) return "Windows";
  if (/CrOS/iu.test(userAgent)) return "ChromeOS";
  if (/(?:Macintosh|Mac OS X)/iu.test(userAgent)) return "Mac";
  if (/Linux/iu.test(userAgent)) return "Linux";
  return null;
};

const detectDeviceType = (
  userAgent: string,
  mobileHint: string | null,
  platform: string | null,
): DeviceType => {
  if (/iPad|Tablet/iu.test(userAgent)) return "tablet";
  if (/(?:iPhone|iPod)/iu.test(userAgent)) return "phone";
  if (/Android/iu.test(userAgent))
    return /Mobile/iu.test(userAgent) ? "phone" : "tablet";
  if (mobileHint?.trim() === "?1") return "phone";
  if (platform) return "desktop";
  return "unknown";
};

export const detectDeviceClientInfo = (headers: Headers): DeviceClientInfo => {
  const userAgent = headers.get("user-agent") ?? "";
  const browser =
    browserFromUserAgent(userAgent) ??
    browserFromClientHints(headers.get("sec-ch-ua") ?? "");
  const platform =
    platformFromUserAgent(userAgent) ??
    normalizedHintPlatform(headers.get("sec-ch-ua-platform"));
  return {
    platform,
    browser: browser?.browser ?? null,
    browserMajorVersion: browser?.browserMajorVersion ?? null,
    deviceType: detectDeviceType(
      userAgent,
      headers.get("sec-ch-ua-mobile"),
      platform,
    ),
  };
};
