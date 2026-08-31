import { describe, expect, it, vi } from "vitest";
import { createHealthResponse } from "../../worker";

describe("health response", () => {
  it("returns no diagnostic details when D1 is unavailable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const database = {
      prepare: () => ({
        first: () => Promise.reject(new Error("private database detail")),
      }),
    } as unknown as D1Database;

    const response = await createHealthResponse(database);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("unavailable");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
