import { z } from "zod";
import { LIMITS } from "./constants";
import { findUnsafeControl } from "./text-policy";

const scalarLength = (value: string) => [...value].length;
const byteLength = (value: string) =>
  new TextEncoder().encode(value).byteLength;

export const titleSchema = z
  .string()
  .trim()
  .min(1, "TITLE_REQUIRED")
  .refine(
    (value) => scalarLength(value) <= LIMITS.titleScalars,
    "TITLE_TOO_LONG",
  )
  .refine(
    (value) => findUnsafeControl(value) === null,
    "UNSAFE_CONTROL_CHARACTER",
  );

export const artistSchema = z
  .string()
  .refine(
    (value) => scalarLength(value) <= LIMITS.artistScalars,
    "ARTIST_TOO_LONG",
  )
  .refine(
    (value) => findUnsafeControl(value) === null,
    "UNSAFE_CONTROL_CHARACTER",
  );

export const sourceTextSchema = z
  .string()
  .transform((value) => value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n"))
  .refine(
    (value) => byteLength(value) <= LIMITS.uploadBytes,
    "SOURCE_BYTES_EXCEEDED",
  )
  .refine(
    (value) => scalarLength(value) <= LIMITS.sourceScalars,
    "SOURCE_CHARS_EXCEEDED",
  );

export const draftTextSchema = z
  .string()
  .transform((value) => value.replace(/\r\n?/gu, "\n"))
  .refine(
    (value) => byteLength(value) <= LIMITS.draftBytes,
    "DRAFT_BYTES_EXCEEDED",
  )
  .refine(
    (value) => scalarLength(value) <= LIMITS.draftScalars,
    "DRAFT_CHARS_EXCEEDED",
  )
  .refine(
    (value) => findUnsafeControl(value) === null,
    "UNSAFE_CONTROL_CHARACTER",
  );

export const songInputSchema = z.object({
  title: titleSchema,
  artist: artistSchema,
  sourceText: sourceTextSchema,
  sourceKind: z.enum(["plain", "lrc"]),
});

export const songUpdateSchema = songInputSchema.extend({
  version: z.number().int().positive(),
});

export const settingsUpdateSchema = z.object({
  locale: z.enum(["en", "zh-CN"]),
  version: z.number().int().positive(),
});

export const sessionStartSchema = z.object({
  restart: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
});

export const sessionUpdateSchema = z.object({
  version: z.number().int().positive(),
  draftText: draftTextSchema,
  action: z.enum(["save", "complete", "abandon"]).default("save"),
});

export const parseJson = async <T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ValidationError("UNSUPPORTED_MEDIA_TYPE", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > LIMITS.jsonBodyBytes
  ) {
    throw new ValidationError("REQUEST_BODY_TOO_LARGE", 413);
  }
  let value: unknown;
  try {
    if (!request.body) throw new Error("Missing body");
    const reader = request.body.getReader();
    const bytes = new Uint8Array(LIMITS.jsonBodyBytes);
    let total = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (total + chunk.byteLength > LIMITS.jsonBodyBytes) {
        void reader.cancel("Request body limit exceeded").catch(() => {
          // Cancellation is best-effort. A broken source must not replace or
          // delay the deterministic 413 response.
        });
        throw new ValidationError("REQUEST_BODY_TOO_LARGE", 413);
      }
      bytes.set(chunk, total);
      total += chunk.byteLength;
    }
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, total),
      ),
    );
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("INVALID_JSON", 400);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError("VALIDATION_ERROR", 400, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
};

export class ValidationError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}
