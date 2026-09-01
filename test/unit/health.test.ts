import { describe, expect, it, vi } from "vitest";
import { createHealthResponse } from "../../worker";

describe("health response", () => {
  const validSchema = {
    table_count: 11,
    identities_columns: 4,
    space_columns: 3,
    membership_columns: 4,
    pairing_columns: 4,
    song_columns: 6,
    session_columns: 7,
    settings_columns: 4,
    idempotency_columns: 6,
    rate_columns: 4,
    revoked_columns: 2,
    lock_columns: 5,
  };

  const databaseReturning = (schema: Record<string, number>) =>
    ({
      prepare: () => ({ first: () => Promise.resolve(schema) }),
    }) as unknown as D1Database;

  it.each([
    ["table", { ...validSchema, table_count: 10 }],
    ["column", { ...validSchema, settings_columns: 3 }],
  ])("returns 503 when a required runtime %s is missing", async (_, schema) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await createHealthResponse(databaseReturning(schema));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("unavailable");
    error.mockRestore();
  });

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
