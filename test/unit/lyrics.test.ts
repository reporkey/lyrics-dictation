import { describe, expect, it } from "vitest";
import {
  inferSourceKind,
  normalizeSource,
  parseLyrics,
} from "../../src/lib/lyrics";

describe("lyrics parsing", () => {
  it("preserves bracketed and timestamp-like text in plain mode", () => {
    const parsed = parseLyrics(
      "[ti:Literal title]\n[00:01.25]Literal line",
      "plain",
    );
    expect(parsed.title).toBe("");
    expect(parsed.studyLines).toEqual([
      "[ti:Literal title]",
      "[00:01.25]Literal line",
    ]);
  });

  it("does not accept a colon as an LRC fractional separator", () => {
    const parsed = parseLyrics("[00:01:25]literal", "lrc");
    expect(parsed.studyLines).toEqual(["[00:01:25]literal"]);
  });
  it("normalizes BOM and line endings", () => {
    expect(normalizeSource("\uFEFFone\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  });

  it("extracts recognized LRC metadata and sorts fully timed occurrences", () => {
    const parsed = parseLyrics(
      "[ar:Test Artist]\n[ti:Test Song]\n[00:10.00]second\n[00:01.50][00:20.00]first",
      "lrc",
    );
    expect(parsed.title).toBe("Test Song");
    expect(parsed.artist).toBe("Test Artist");
    expect(parsed.studyLines).toEqual(["first", "second", "first"]);
  });

  it("recognizes common timestamp precision and preserves tie source order", () => {
    const parsed = parseLyrics(
      "[02:03]whole\n[00:01.2]tenth\n[00:01.200]same-a\n[00:01.200]same-b",
      "lrc",
    );
    expect(parsed.studyLines).toEqual(["tenth", "same-a", "same-b", "whole"]);
  });

  it("preserves source order when timed and untimed lines are mixed", () => {
    const parsed = parseLyrics(
      "[00:10.00]later\nuntimed\n[00:01.00]earlier",
      "lrc",
    );
    expect(parsed.studyLines).toEqual(["later", "untimed", "earlier"]);
  });

  it("keeps unknown and malformed bracket text as lyrics", () => {
    const parsed = parseLyrics("[mood:bright]\n[not a tag\nhello", "lrc");
    expect(parsed.studyLines).toEqual(["[mood:bright]", "[not a tag", "hello"]);
  });

  it("rejects formatting-only lyrics and unsafe controls", () => {
    expect(() => parseLyrics("... ♪ ❤️", "plain")).toThrow(
      "LYRICS_CONTENT_REQUIRED",
    );
    expect(() => parseLyrics("safe\u202Ehidden", "plain")).toThrow(
      "UNSAFE_CONTROL_CHARACTER",
    );
  });

  it("infers LRC from extension or content", () => {
    expect(inferSourceKind("song.lrc", "plain")).toBe("lrc");
    expect(inferSourceKind("song.txt", "[00:01]line")).toBe("lrc");
    expect(inferSourceKind("song.txt", "line")).toBe("plain");
    expect(inferSourceKind("song.txt", "[offset:120]")).toBe("lrc");
  });

  it("enforces source line count and scalar length boundaries", () => {
    expect(() => parseLyrics(`${"a\n".repeat(2_000)}a`, "plain")).toThrow(
      "SOURCE_LINES_EXCEEDED",
    );
    expect(() => parseLyrics("a".repeat(2_001), "plain")).toThrow(
      "SOURCE_LINE_TOO_LONG",
    );
    expect(
      parseLyrics("a\n".repeat(1_999) + "a", "plain").studyLines,
    ).toHaveLength(2_000);
  });

  it("rejects LRC timestamp expansion beyond the draft capacity", () => {
    const line = `${"[0:0]".repeat(200)}${"a".repeat(1_000)}`;
    expect([...line]).toHaveLength(2_000);
    expect(() => parseLyrics(line, "lrc")).toThrow("STUDY_CONTENT_EXCEEDED");
    const manyLines = `${line}\n`.repeat(49);
    expect([...manyLines]).toHaveLength(98_049);
    expect(() => parseLyrics(manyLines, "lrc")).toThrow(
      "STUDY_CONTENT_EXCEEDED",
    );
  });
});
