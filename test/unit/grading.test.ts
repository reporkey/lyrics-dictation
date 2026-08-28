import { describe, expect, it } from "vitest";
import {
  alignTokens,
  gradeCompletion,
  gradeDraft,
  projectText,
} from "../../src/lib/grading";

describe("formatting-insensitive projection", () => {
  it.each([
    "Hello, world!",
    "Hello world",
    "Hello\nworld",
    "H e l l o\tworld ♪ ❤️",
  ])("treats %s as the same lyric content", (actual) => {
    const grade = gradeDraft("Hello, world!", actual, false);
    expect(grade.complete).toBe(true);
    expect(grade.incorrect + grade.extra + grade.missing).toBe(0);
  });

  it("treats Chinese reflow and punctuation as equivalent", () => {
    expect(gradeDraft("我，爱你。", "我\n爱 你", false).complete).toBe(true);
  });

  it("post-normalizes a combining mark separated by formatting", () => {
    expect(gradeDraft("é", "e \u0301", true).complete).toBe(true);
  });

  it("canonically reorders combining marks across removed formatting", () => {
    expect(gradeDraft("\u0323\u0345", "\u0345 \u0323", true).complete).toBe(
      true,
    );
    expect(gradeDraft("A\u0323\u0345", "A\u0345\n\u0323", true).complete).toBe(
      true,
    );
  });

  it("retains editor offsets for decomposed graphemes", () => {
    const projected = projectText("e\u0301x", true);
    expect(projected.normalizedOriginal).toBe("éx");
    expect(projected.originals[0]).toMatchObject({
      text: "e\u0301",
      from: 0,
      to: 2,
    });
    expect(projected.originals[1]).toMatchObject({ from: 2, to: 3 });
  });

  it("treats a numeric keycap as its underlying number", () => {
    expect(gradeDraft("Room 1", "Room 1️⃣", false).complete).toBe(true);
  });

  it("uses full Unicode case folding", () => {
    expect(gradeDraft("STRASSE", "Straße", false).complete).toBe(true);
    expect(gradeDraft("STRASSE", "Straße", true).complete).toBe(false);
  });

  it("keeps case-fold expansion provenance specific to each origin", () => {
    const grade = gradeDraft("xś", "ß.́", false);
    expect(grade.correct).toBe(1);
    expect(grade.incorrect).toBe(1);
    expect(grade.states.filter((state) => state === "incorrect")).toHaveLength(
      1,
    );
    expect(grade.states.filter((state) => state === "correct")).toHaveLength(1);
  });

  it("uses identical whole-stream Greek case-fold ordering in UI and server", () => {
    const value = "\u1f88\u0323";
    const projected = projectText(value, false).text;
    const authoritative = gradeCompletion(value, projected, false);
    expect(authoritative.complete).toBe(true);
    expect(gradeDraft(projected, value, false).complete).toBe(true);
  });

  it("keeps presentation-only emoji, flags, modifiers, and symbols neutral", () => {
    const grade = gradeDraft("Fly 1 high", "✈️ Fly 🏳️‍🌈 1️⃣ 👋🏽 high 🇨🇳 ♪", false);
    expect(grade.complete).toBe(true);
    expect(
      grade.actual.originals.filter((part) => !part.projection),
    ).not.toHaveLength(0);
  });

  it("judges standalone combining marks but joins marks across formatting", () => {
    expect(gradeDraft("e\u0301", "e—\u0301", true).complete).toBe(true);
    expect(gradeDraft("a", "a\u0301", true).incorrect).toBe(1);
  });

  it("is invariant under deterministic formatting mutations", () => {
    const expected = "Alpha中文42";
    const neutral = [
      " ",
      "\n",
      "\t",
      "\u000b",
      "\u000c",
      "\u0085",
      ",",
      "。",
      "♪",
      "✨",
      "—",
    ];
    for (let seed = 0; seed < 64; seed += 1) {
      let actual = "";
      [...expected].forEach((character, index) => {
        actual += neutral[(seed + index * 3) % neutral.length] + character;
      });
      actual += neutral[seed % neutral.length];
      expect(gradeDraft(expected, actual, true).complete).toBe(true);
    }
  });
});

describe("alignment and render semantics", () => {
  it("bounds authoritative completion checks at the maximum scalar limit", () => {
    expect(
      gradeCompletion("a".repeat(100_000), "界".repeat(100_000), true).complete,
    ).toBe(false);
    expect(
      gradeCompletion("A,中".repeat(25_000), "a \u4e2d".repeat(25_000), false)
        .complete,
    ).toBe(true);
  });
  it("renders substitution once without an omission marker", () => {
    const grade = gradeDraft("cat", "cut", true);
    expect(grade.incorrect).toBe(1);
    expect(grade.missing).toBe(0);
    expect(grade.markers).toEqual([]);
  });

  it("recovers after an early omission instead of cascading", () => {
    const grade = gradeDraft("abcdef", "abdef", true);
    expect(grade.correct).toBe(5);
    expect(grade.missing).toBe(1);
    expect(grade.incorrect).toBe(0);
    expect(grade.markers).toHaveLength(1);
  });

  it("anchors an empty draft omission at editor start", () => {
    const grade = gradeDraft("hello", " , \n", false);
    expect(grade.markers).toEqual([{ boundary: 0, count: 5, position: 0 }]);
  });

  it("keeps punctuation graphemes neutral", () => {
    const grade = gradeDraft("ab", "a,b", true);
    const comma = grade.actual.originals.findIndex((part) => part.text === ",");
    expect(grade.states[comma]).toBe("neutral");
  });

  it("returns an approximate result when the exact cell budget is exceeded", () => {
    const expected = projectText("abcdefghij", true).tokens;
    const actual = projectText("jihgfedcba", true).tokens;
    expect(alignTokens(expected, actual, 4).exact).toBe(false);
  });

  it("uses deterministic non-crossing anchors for oversized regions", () => {
    const expected = projectText("aaaaXbbbbYcccc", true).tokens;
    const actual = projectText("zzzzXwwwwYvvvv", true).tokens;
    const result = alignTokens(expected, actual, 4);
    expect(result.exact).toBe(false);
    expect(
      result.operations.filter((operation) => operation.type === "match"),
    ).toEqual([
      { type: "match", expectedIndex: 4, actualIndex: 4 },
      { type: "match", expectedIndex: 9, actualIndex: 9 },
    ]);
  });

  it("places collapsed omission runs at stable judged boundaries", () => {
    expect(gradeDraft("abcd", "acd", true).markers).toEqual([
      { boundary: 1, count: 1, position: 1 },
    ]);
    expect(gradeDraft("abcd", "abc", true).markers).toEqual([
      { boundary: 3, count: 1, position: 3 },
    ]);
    expect(gradeDraft("abcdef", "af", true).markers).toEqual([
      { boundary: 1, count: 4, position: 1 },
    ]);
    expect(gradeDraft("abcd", "a ,\ncd", true).markers[0]?.boundary).toBe(1);
  });

  it("uses deterministic tie-breaking for repeated text", () => {
    const first = gradeDraft("abababab", "ababab", true);
    const second = gradeDraft("abababab", "ababab", true);
    expect(first.markers).toEqual(second.markers);
    expect(first.missing).toBe(2);
    expect(first.incorrect).toBe(0);
  });
});
