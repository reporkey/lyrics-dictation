import type { Context } from "hono";
import { RATE_LIMITS } from "../src/lib/constants";
import { ApiError } from "./http";
import { ValidationError } from "../src/lib/validation";
import type { AppBindings, IdentityRecord } from "./types";

export type RateBucket = keyof typeof RATE_LIMITS;

interface RateRow {
  request_count: number;
  window_started_at: number;
}

export const enforceRateLimit = async (
  context: Context<AppBindings>,
  identity: IdentityRecord,
  bucket: RateBucket,
) => {
  const config = RATE_LIMITS[bucket];
  const now = Date.now();
  const expiredBefore = now - config.windowSeconds * 1000;
  const row = await context.env.DB.prepare(
    `INSERT INTO rate_limits (identity_id, bucket, window_started_at, request_count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(identity_id, bucket) DO UPDATE SET
       request_count = CASE WHEN window_started_at <= ? THEN 1 ELSE request_count + 1 END,
       window_started_at = CASE WHEN window_started_at <= ? THEN ? ELSE window_started_at END
     RETURNING request_count, window_started_at`,
  )
    .bind(identity.id, bucket, now, expiredBefore, expiredBefore, now)
    .first<RateRow>();
  if (row && row.request_count > config.limit) {
    const retryAfter = Math.max(
      1,
      Math.ceil(
        (row.window_started_at + config.windowSeconds * 1000 - now) / 1000,
      ),
    );
    throw new ApiError("RATE_LIMITED", 429, undefined, {
      "Retry-After": String(retryAfter),
    });
  }
};

const validIdempotencyKey = (value: string | undefined): value is string =>
  Boolean(value && /^[A-Za-z0-9_-]{8,128}$/u.test(value));

export const requireIdempotencyKey = (
  context: Context<AppBindings>,
): string => {
  const key = context.req.header("Idempotency-Key");
  if (!validIdempotencyKey(key))
    throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", 400);
  return key;
};

interface StoredResponse {
  status: number;
  response_json: string;
}

export const withIdempotency = async (
  context: Context<AppBindings>,
  identity: IdentityRecord,
  operation: string,
  execute: (key: string) => Promise<Response>,
  recoverInProgress?: (key: string) => Promise<Response | null>,
): Promise<Response> => {
  const key = requireIdempotencyKey(context);

  const stored = await context.env.DB.prepare(
    "SELECT status, response_json FROM idempotency_keys WHERE identity_id = ? AND operation = ? AND key = ?",
  )
    .bind(identity.id, operation, key)
    .first<StoredResponse>();
  if (stored) {
    if (stored.status === 0) {
      const recovered = await recoverInProgress?.(key);
      if (!recovered)
        throw new ApiError("IDEMPOTENCY_IN_PROGRESS", 409, undefined, {
          "Retry-After": "1",
        });
      const recoveredBody = await recovered.clone().text();
      await context.env.DB.prepare(
        "UPDATE idempotency_keys SET status = ?, response_json = ? WHERE identity_id = ? AND operation = ? AND key = ? AND status = 0",
      )
        .bind(recovered.status, recoveredBody, identity.id, operation, key)
        .run();
      recovered.headers.set("Idempotency-Replayed", "true");
      return recovered;
    }
    const response = new Response(stored.response_json, {
      status: stored.status,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Replayed": "true",
      },
    });
    return response;
  }

  const reserved = await context.env.DB.prepare(
    "INSERT OR IGNORE INTO idempotency_keys (identity_id, operation, key, status, response_json, created_at) VALUES (?, ?, ?, 0, '', ?)",
  )
    .bind(identity.id, operation, key, Date.now())
    .run();
  if (!reserved.meta.changes)
    throw new ApiError("IDEMPOTENCY_IN_PROGRESS", 409);

  try {
    const response = await execute(key);
    const body = await response.clone().text();
    await context.env.DB.prepare(
      "UPDATE idempotency_keys SET status = ?, response_json = ? WHERE identity_id = ? AND operation = ? AND key = ?",
    )
      .bind(response.status, body, identity.id, operation, key)
      .run();
    return response;
  } catch (error) {
    // Only deterministic pre-mutation failures may release the reservation.
    // An unknown D1/runtime failure can occur after the mutation committed; in
    // that ambiguous window retaining status=0 prevents a duplicate retry.
    if (error instanceof ApiError || error instanceof ValidationError) {
      await context.env.DB.prepare(
        "DELETE FROM idempotency_keys WHERE identity_id = ? AND operation = ? AND key = ? AND status = 0",
      )
        .bind(identity.id, operation, key)
        .run();
    }
    throw error;
  }
};

export const deterministicMutationId = async (
  identity: IdentityRecord,
  operation: string,
  key: string,
) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${identity.credentialHash}:${operation}:${key}`,
      ),
    ),
  );
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const mutationFingerprint = async (value: unknown) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
