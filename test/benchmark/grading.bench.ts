import { bench, describe } from "vitest";
import {
  gradeAbandonment,
  gradeCompletion,
  gradeDraft,
} from "../../src/lib/grading";

describe("whole-document grading", () => {
  bench("short mixed Chinese/English edit", () => {
    gradeDraft("Moonlight照着我 tonight", "Moon light，照着你 tonight", false);
  });

  bench("long near-match", () => {
    const expected = "alpha中文42".repeat(300);
    gradeDraft(
      expected,
      `${expected.slice(0, 1_200)}x${expected.slice(1_201)}`,
      false,
    );
  });

  bench("highly repetitive omission", () => {
    gradeDraft("abab".repeat(250), "abab".repeat(249), true);
  });

  bench("totally different bounded refinement", () => {
    gradeDraft("a".repeat(2_000), "界".repeat(2_000), true, 750_000);
  });

  bench("large exact paste fast path", () => {
    const value = "Line，with symbols ♪ 中文 123\n".repeat(400);
    gradeDraft(
      value,
      value.replaceAll("，", " ").replaceAll("\n", "  "),
      false,
    );
  });

  bench("maximum-size exact rendered result", () => {
    const value = "a".repeat(100_000);
    gradeDraft(value, value, true);
  });

  bench("long divergent live preview", () => {
    gradeDraft("a".repeat(20_000), "界".repeat(20_000), true, 750_000);
  });

  bench("maximum-size divergent completion check", () => {
    gradeCompletion("a".repeat(100_000), "b".repeat(100_000), true);
  });

  bench("maximum-size divergent abandonment counts", () => {
    gradeAbandonment("a".repeat(100_000), "b".repeat(100_000), true);
  });
});
