import { describe, expect, it } from "vitest";
import { acceptLifecycleToken } from "../../src/api";

describe("lifecycle token deduplication", () => {
  it("deduplicates interleaved transports and bounds retained tokens", () => {
    const recent = new Set<string>();

    expect(acceptLifecycleToken(recent, "event-a")).toBe(true);
    expect(acceptLifecycleToken(recent, "event-b")).toBe(true);
    expect(acceptLifecycleToken(recent, "event-b")).toBe(false);
    expect(acceptLifecycleToken(recent, "event-a")).toBe(false);

    for (let index = 0; index < 64; index += 1) {
      expect(acceptLifecycleToken(recent, `event-${index}`)).toBe(true);
    }
    expect(recent.size).toBe(64);
    expect(acceptLifecycleToken(recent, "event-a")).toBe(true);
    expect(recent.size).toBe(64);
  });
});
