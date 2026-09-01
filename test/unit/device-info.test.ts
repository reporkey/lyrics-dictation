import { describe, expect, it } from "vitest";
import { detectDeviceClientInfo } from "../../worker/device-info";

describe("device client information", () => {
  it("normalizes Chromium client hints without retaining raw values", () => {
    const headers = new Headers({
      "Sec-CH-UA":
        '"Not_A Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"macOS"',
      "User-Agent":
        "Mozilla/5.0 AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36",
    });

    expect(detectDeviceClientInfo(headers)).toEqual({
      platform: "Mac",
      browser: "Chrome",
      browserMajorVersion: "145",
      deviceType: "desktop",
    });
  });

  it("distinguishes Edge on Windows", () => {
    const headers = new Headers({
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0",
    });
    expect(detectDeviceClientInfo(headers)).toEqual({
      platform: "Windows",
      browser: "Edge",
      browserMajorVersion: "145",
      deviceType: "desktop",
    });
  });

  it.each([
    {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1",
      expected: {
        platform: "iPhone",
        browser: "Safari",
        browserMajorVersion: "26",
        deviceType: "phone",
      },
    },
    {
      userAgent:
        "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1",
      expected: {
        platform: "iPad",
        browser: "Safari",
        browserMajorVersion: "26",
        deviceType: "tablet",
      },
    },
    {
      userAgent:
        "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 Chrome/145.0.0.0 Mobile Safari/537.36",
      expected: {
        platform: "Android",
        browser: "Chrome",
        browserMajorVersion: "145",
        deviceType: "phone",
      },
    },
  ])("normalizes common mobile browsers", ({ userAgent, expected }) => {
    expect(
      detectDeviceClientInfo(new Headers({ "User-Agent": userAgent })),
    ).toEqual(expected);
  });

  it("returns a safe unknown description for absent or unrecognized headers", () => {
    expect(detectDeviceClientInfo(new Headers())).toEqual({
      platform: null,
      browser: null,
      browserMajorVersion: null,
      deviceType: "unknown",
    });
  });
});
