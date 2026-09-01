import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiErrorPayload } from "../src/lib/types";
import { ValidationError } from "../src/lib/validation";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
    public readonly headers?: HeadersInit,
  ) {
    super(code);
  }
}

export const jsonError = (
  context: Context,
  code: string,
  status: number,
  details?: Record<string, unknown>,
  headers?: HeadersInit,
) => {
  const payload: ApiErrorPayload = {
    error: { code, message: code, ...(details ? { details } : {}) },
  };
  const response = context.json(payload, status as never);
  if (headers) {
    new Headers(headers).forEach((value, key) =>
      response.headers.set(key, value),
    );
  }
  return response;
};

export const handleError = (error: Error, context: Context) => {
  if (error instanceof ApiError) {
    return jsonError(
      context,
      error.code,
      error.status,
      error.details,
      error.headers,
    );
  }
  if (error instanceof ValidationError) {
    return jsonError(context, error.code, error.status, error.details);
  }
  if (error instanceof HTTPException) {
    return jsonError(context, "HTTP_ERROR", error.status);
  }
  console.error(
    JSON.stringify({
      level: "error",
      event: "request_failed",
      error: error.name,
    }),
  );
  return jsonError(context, "INTERNAL_ERROR", 500);
};

export const requireSameOrigin = (request: Request) => {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  if (!origin || origin !== url.origin)
    throw new ApiError("ORIGIN_MISMATCH", 403);
};

export const requireTrustedApiFetchSite = (request: Request) => {
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  // Same-origin application requests and direct/non-browser clients are
  // allowed. Cross-origin browser embeds must not mint disposable identities
  // through a credentialed or cookie-less GET.
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ApiError("ORIGIN_MISMATCH", 403);
  }
};
