import { describe, expect, it } from "vitest";
import {
  formatElapsedTime,
  sessionAccuracy,
} from "../../src/lib/session-metrics";

describe("session metrics", () => {
  it("counts wrong, extra, and missing text against accuracy", () => {
    expect(
      sessionAccuracy({
        correctCount: 7,
        incorrectCount: 1,
        extraCount: 1,
        missingCount: 1,
      }),
    ).toBe(70);
    expect(
      sessionAccuracy({
        correctCount: 0,
        incorrectCount: 0,
        extraCount: 0,
        missingCount: 0,
      }),
    ).toBe(0);
  });

  it("formats elapsed time with stable tabular fields", () => {
    expect(formatElapsedTime(-1)).toBe("00:00");
    expect(formatElapsedTime(65_999)).toBe("01:05");
    expect(formatElapsedTime(3_661_000)).toBe("1:01:01");
  });
});
