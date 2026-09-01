export const LIMITS = {
  jsonBodyBytes: 1024 * 1024,
  uploadBytes: 256 * 1024,
  sourceScalars: 100_000,
  draftBytes: 256 * 1024,
  draftScalars: 100_000,
  sourceLines: 2_000,
  lineScalars: 2_000,
  titleScalars: 200,
  artistScalars: 200,
} as const;

export const UNICODE_PROFILE = "Unicode 15.1 conformance fixtures";
export const IDENTITY_COOKIE_PROD = "__Host-ld_identity";
export const IDENTITY_COOKIE_DEV = "ld_identity_dev";
export const IDENTITY_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
export const IDENTITY_RENEW_AFTER_SECONDS = 24 * 60 * 60;

export const RATE_LIMITS = {
  mutation: { limit: 120, windowSeconds: 60 },
  import: { limit: 20, windowSeconds: 60 * 60 },
  destructive: { limit: 10, windowSeconds: 60 * 60 },
  pairing: { limit: 30, windowSeconds: 60 * 60 },
} as const;

export const PAIRING_CODE_LIFETIME_SECONDS = 10 * 60;
export const PAIRING_CODE_LENGTH = 12;

export type Locale = "en" | "zh-CN";
export type SourceKind = "plain" | "lrc";
export type SessionStatus = "in_progress" | "completed" | "abandoned";
