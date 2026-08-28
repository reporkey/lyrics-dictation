import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/lib/constants";
import { messageCatalogs } from "../../src/i18n";
import { findUnsafeControl } from "../../src/lib/text-policy";
import {
  draftTextSchema,
  parseJson,
  sourceTextSchema,
  titleSchema,
} from "../../src/lib/validation";

describe("shared validation boundaries", () => {
  it("accepts exact source and draft scalar limits", () => {
    const value = "a".repeat(LIMITS.sourceScalars);
    expect(sourceTextSchema.safeParse(value).success).toBe(true);
    expect(draftTextSchema.safeParse(value).success).toBe(true);
  });

  it("rejects one scalar beyond the limit", () => {
    const value = "a".repeat(LIMITS.sourceScalars + 1);
    expect(sourceTextSchema.safeParse(value).success).toBe(false);
    expect(draftTextSchema.safeParse(value).success).toBe(false);
  });

  it("rejects unsafe control characters in drafts", () => {
    expect(draftTextSchema.safeParse("safe\u202Ehidden").success).toBe(false);
    expect(draftTextSchema.safeParse("safe\u200dhidden").success).toBe(false);
    expect(draftTextSchema.safeParse("emoji 👋🏽 and ❤️").success).toBe(true);
    expect(draftTextSchema.safeParse("digit 1️⃣").success).toBe(true);
    expect(draftTextSchema.safeParse("orphan 🏽").success).toBe(false);
    expect(draftTextSchema.safeParse("broken 👋‍").success).toBe(false);
    expect(draftTextSchema.safeParse("letter A️").success).toBe(false);
    expect(draftTextSchema.safeParse("broken \ud800").success).toBe(false);
    expect(draftTextSchema.safeParse("valid 😀").success).toBe(true);
    expect(draftTextSchema.safeParse("duplicate 👋🏽🏽").success).toBe(false);
    expect(draftTextSchema.safeParse("duplicate ❤️️").success).toBe(false);
    expect(draftTextSchema.safeParse("family 👩‍👩‍👧").success).toBe(true);
  });

  it("allows every control-category Unicode White_Space exception", () => {
    const whitespace = "\u000b\u000c\u0085";
    expect(draftTextSchema.safeParse(`a${whitespace}b`).success).toBe(true);
    expect(findUnsafeControl(whitespace)).toBeNull();
  });

  it("rejects every standalone Unicode format control", () => {
    let formatControls = 0;
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      const character = String.fromCodePoint(codePoint);
      if (!/\p{Cf}/u.test(character)) continue;
      formatControls += 1;
      expect(draftTextSchema.safeParse(`a${character}b`).success).toBe(false);
    }
    expect(formatControls).toBeGreaterThan(100);
    expect(draftTextSchema.safeParse("family 👩‍👩‍👧").success).toBe(true);
  });

  it("allows only pinned RGI emoji sequences around hidden components", () => {
    const england = "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
    expect(draftTextSchema.safeParse(england).success).toBe(true);
    for (const invalid of [
      "😀\u{e0061}\u{e007f}",
      "🏴\u{e0061}\u{e007f}",
      "😀‍😀",
      "❤🏽",
      "❤🏽‍😀",
    ]) {
      expect(draftTextSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("normalizes line endings before applying source and draft limits", () => {
    expect(sourceTextSchema.parse("a\r\nb\rc")).toBe("a\nb\nc");
    expect(draftTextSchema.parse("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("cancels an unbounded JSON stream at the transport limit", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://lyrics.test/api/songs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(parseJson(request, draftTextSchema)).rejects.toMatchObject({
      code: "REQUEST_BODY_TOO_LARGE",
      status: 413,
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(LIMITS.jsonBodyBytes / (64 * 1024) + 2);
  });

  it("returns 413 even when stream cancellation rejects or never settles", async () => {
    for (const cancel of [
      () => Promise.reject(new Error("cancel failed")),
      () => new Promise<void>(() => undefined),
    ]) {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(LIMITS.jsonBodyBytes + 1));
        },
        cancel,
      });
      const request = new Request("https://lyrics.test/api/songs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      await expect(parseJson(request, draftTextSchema)).rejects.toMatchObject({
        code: "REQUEST_BODY_TOO_LARGE",
        status: 413,
      });
    }
  });

  it("rejects a declared oversized body before reading it", async () => {
    const request = new Request("https://lyrics.test/api/songs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(LIMITS.jsonBodyBytes + 1),
      },
      body: '"small"',
    });
    await expect(parseJson(request, draftTextSchema)).rejects.toMatchObject({
      code: "REQUEST_BODY_TOO_LARGE",
      status: 413,
    });
    expect(request.bodyUsed).toBe(false);
  });

  it("enforces independent UTF-8 byte and metadata scalar limits", () => {
    const exactBytes = "你".repeat(Math.floor(LIMITS.uploadBytes / 3));
    expect(sourceTextSchema.safeParse(exactBytes).success).toBe(true);
    expect(sourceTextSchema.safeParse(`${exactBytes}你`).success).toBe(false);
    expect(titleSchema.safeParse("a".repeat(LIMITS.titleScalars)).success).toBe(
      true,
    );
    expect(
      titleSchema.safeParse("a".repeat(LIMITS.titleScalars + 1)).success,
    ).toBe(false);
  });

  it("reports the earliest unsafe Unicode-scalar position", () => {
    expect(findUnsafeControl("😀a\u202Eb\u0001")).toBe(2);
    expect(findUnsafeControl("😀a\u0001b\u202E")).toBe(2);
    expect(findUnsafeControl("😀a\u200Db")).toBe(2);
  });

  it("keeps locale keys and interpolation placeholders in parity", () => {
    const en = messageCatalogs.en;
    const zh = messageCatalogs["zh-CN"];
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(
        [...zh[key].matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]).sort(),
      ).toEqual(
        [...en[key].matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]).sort(),
      );
    }
  });
});
