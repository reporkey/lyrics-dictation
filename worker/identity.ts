import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  IDENTITY_COOKIE_DEV,
  IDENTITY_COOKIE_PROD,
  IDENTITY_INITIAL_MAX_AGE_SECONDS,
  IDENTITY_MAX_AGE_SECONDS,
  IDENTITY_RENEW_AFTER_SECONDS,
  type Locale,
} from "../src/lib/constants";
import { detectDeviceClientInfo, type DeviceType } from "./device-info";
import { ApiError } from "./http";
import type { AppBindings, IdentityRecord } from "./types";

interface IdentityRow {
  id: string;
  credential_hash: string;
  data_space_id: string;
  data_space_version: number;
  public_device_id: string;
  device_label: string;
  device_platform: string | null;
  device_browser: string | null;
  browser_major_version: string | null;
  device_type: DeviceType;
  recovery_namespace: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

export interface IdentityResolution {
  identity: IdentityRecord | null;
  credential: string | null;
  setCookie: boolean;
  clearCookie: boolean;
}

const isLocal = (url: URL) =>
  ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
const cookieName = (url: URL) =>
  isLocal(url) ? IDENTITY_COOKIE_DEV : IDENTITY_COOKIE_PROD;

const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const createCredential = () =>
  bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));

const isCredentialShape = (value: string | undefined): value is string =>
  Boolean(value && /^[A-Za-z0-9_-]{43}$/u.test(value));

const hashCredential = async (credential: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(credential),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const rowToIdentity = (row: IdentityRow): IdentityRecord => ({
  id: row.id,
  credentialHash: row.credential_hash,
  dataSpaceId: row.data_space_id,
  dataSpaceVersion: row.data_space_version,
  publicDeviceId: row.public_device_id,
  deviceLabel: row.device_label,
  recoveryNamespace: row.recovery_namespace,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  expiresAt: row.expires_at,
});

const readIdentityRow = (database: D1Database, credentialHash: string) =>
  database
    .prepare(
      `SELECT i.id, i.credential_hash, i.created_at, i.last_seen_at, i.expires_at,
         m.data_space_id, m.public_device_id, m.device_label,
         m.device_platform, m.device_browser, m.browser_major_version,
         m.device_type, m.recovery_namespace,
         w.version AS data_space_version
       FROM identities i
       JOIN device_memberships m ON m.identity_id = i.id
       JOIN data_spaces w ON w.id = m.data_space_id
       WHERE i.credential_hash = ?`,
    )
    .bind(credentialHash)
    .first<IdentityRow>();

const detectedLocale = (request: Request): Locale => {
  const preferences = (request.headers.get("accept-language") ?? "")
    .split(",")
    .map((part, index) => {
      const [locale, ...parameters] = part.trim().toLowerCase().split(";");
      const qualityParameter = parameters.find((value) =>
        value.trim().startsWith("q="),
      );
      const quality = qualityParameter
        ? Number(qualityParameter.trim().slice(2))
        : 1;
      return {
        locale,
        quality: Number.isFinite(quality) ? quality : 0,
        index,
      };
    })
    .filter((preference) => preference.quality > 0)
    .sort(
      (left, right) => right.quality - left.quality || left.index - right.index,
    );
  for (const { locale } of preferences) {
    if (locale.split("-")[0] === "zh") return "zh-CN";
    if (locale === "en" || locale.startsWith("en-")) return "en";
  }
  return "en";
};

export const resolveIdentity = async (
  context: Context<AppBindings>,
  allowCreate: boolean,
): Promise<IdentityResolution> => {
  const url = new URL(context.req.url);
  const name = cookieName(url);
  const supplied = getCookie(context, name);
  const now = Date.now();
  const detectedDevice = detectDeviceClientInfo(context.req.raw.headers);

  if (isCredentialShape(supplied)) {
    const hash = await hashCredential(supplied);
    let row = await readIdentityRow(context.env.DB, hash);
    if (row && row.expires_at > now) {
      const devicePlatform = detectedDevice.platform ?? row.device_platform;
      const deviceBrowser = detectedDevice.browser ?? row.device_browser;
      const browserMajorVersion =
        detectedDevice.browserMajorVersion ?? row.browser_major_version;
      const deviceType =
        detectedDevice.deviceType === "unknown"
          ? row.device_type
          : detectedDevice.deviceType;
      if (
        devicePlatform !== row.device_platform ||
        deviceBrowser !== row.device_browser ||
        browserMajorVersion !== row.browser_major_version ||
        deviceType !== row.device_type
      ) {
        await context.env.DB.prepare(
          `UPDATE device_memberships
           SET device_platform = ?, device_browser = ?,
               browser_major_version = ?, device_type = ?
           WHERE identity_id = ?`,
        )
          .bind(
            devicePlatform,
            deviceBrowser,
            browserMajorVersion,
            deviceType,
            row.id,
          )
          .run();
        row.device_platform = devicePlatform;
        row.device_browser = deviceBrowser;
        row.browser_major_version = browserMajorVersion;
        row.device_type = deviceType;
      }
      const shouldRenew =
        now - row.last_seen_at >= IDENTITY_RENEW_AFTER_SECONDS * 1000;
      if (shouldRenew) {
        const expiresAt = now + IDENTITY_MAX_AGE_SECONDS * 1000;
        const renewed = await context.env.DB.prepare(
          "UPDATE identities SET last_seen_at = ?, expires_at = ? WHERE id = ? AND credential_hash = ? AND expires_at > ?",
        )
          .bind(now, expiresAt, row.id, hash, now)
          .run();
        if (!renewed.meta.changes) {
          const concurrent = await readIdentityRow(context.env.DB, hash);
          if (concurrent && concurrent.expires_at > now) {
            return {
              identity: rowToIdentity(concurrent),
              credential: supplied,
              setCookie: true,
              clearCookie: false,
            };
          }
          row = null;
        }
        if (!row) {
          // A concurrent expiry cleanup won. Continue through revocation and
          // optional fresh-identity creation without returning stale space data.
        } else {
          row.last_seen_at = now;
          row.expires_at = expiresAt;
        }
      }
      if (row)
        return {
          identity: rowToIdentity(row),
          credential: supplied,
          setCookie: shouldRenew,
          clearCookie: false,
        };
    }
    if (row) {
      const cleanup = await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE data_spaces SET version = version + 1, updated_at = ?
           WHERE id = (
             SELECT member.data_space_id FROM device_memberships member
             JOIN identities expired ON expired.id = member.identity_id
             WHERE member.identity_id = ? AND expired.expires_at <= ?
           )`,
        ).bind(now, row.id, now),
        context.env.DB.prepare(
          `DELETE FROM pairing_codes
           WHERE claimed_by_identity_id IS NULL AND data_space_id = (
             SELECT member.data_space_id FROM device_memberships member
             JOIN identities expired ON expired.id = member.identity_id
             WHERE member.identity_id = ? AND expired.expires_at <= ?
           )`,
        ).bind(row.id, now),
        context.env.DB.prepare(
          `DELETE FROM data_spaces
           WHERE id = (
             SELECT member.data_space_id FROM device_memberships member
             JOIN identities expired ON expired.id = member.identity_id
             WHERE member.identity_id = ? AND expired.expires_at <= ?
           ) AND (
             SELECT COUNT(*) FROM device_memberships
             WHERE data_space_id = data_spaces.id
           ) = 1`,
        ).bind(row.id, now),
        context.env.DB.prepare(
          "DELETE FROM identities WHERE id = ? AND credential_hash = ? AND expires_at <= ?",
        ).bind(row.id, hash, now),
      ]);
      if (!cleanup[3].meta.changes) {
        const concurrent = await readIdentityRow(context.env.DB, hash);
        if (concurrent && concurrent.expires_at > now) {
          return {
            identity: rowToIdentity(concurrent),
            credential: supplied,
            setCookie: true,
            clearCookie: false,
          };
        }
        if (concurrent) throw new ApiError("VERSION_CONFLICT", 409);
      }
    }

    const revoked = await context.env.DB.prepare(
      "SELECT expires_at FROM revoked_credentials WHERE credential_hash = ? AND expires_at > ?",
    )
      .bind(hash, now)
      .first<{ expires_at: number }>();
    if (revoked) {
      return {
        identity: null,
        credential: null,
        setCookie: false,
        clearCookie: true,
      };
    }
  }

  if (!allowCreate)
    return {
      identity: null,
      credential: null,
      setCookie: false,
      clearCookie: false,
    };

  // A browser credential is the primary rate-limit key. Creation has no
  // credential yet, so add a narrow edge limit to stop repeated cookie
  // disposal from minting unlimited anonymous identities. Cloudflare sets
  // CF-Connecting-IP in production; local/test requests without it keep the
  // deterministic local workflow.
  const clientAddress = context.req.header("CF-Connecting-IP");
  if (clientAddress && !isLocal(url)) {
    const limited = await context.env.ANONYMOUS_IDENTITY_RATE_LIMITER.limit({
      key: clientAddress,
    });
    if (!limited.success) {
      throw new ApiError("RATE_LIMITED", 429, undefined, {
        "Retry-After": "60",
      });
    }
  }

  const credential = createCredential();
  const credentialHash = await hashCredential(credential);
  const identity: IdentityRecord = {
    id: crypto.randomUUID(),
    credentialHash,
    dataSpaceId: crypto.randomUUID(),
    dataSpaceVersion: 1,
    publicDeviceId: crypto.randomUUID(),
    deviceLabel: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(3)))
      .slice(0, 4)
      .toUpperCase(),
    recoveryNamespace: crypto.randomUUID(),
    createdAt: now,
    lastSeenAt: now,
    // Empty bootstrap-only identities are cheap to create and therefore use a
    // short initial lifetime. A successful write promotes them to the normal
    // one-year retention period in the API middleware.
    expiresAt: now + IDENTITY_INITIAL_MAX_AGE_SECONDS * 1000,
  };
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO identities (id, credential_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(identity.id, credentialHash, now, now, identity.expiresAt),
    context.env.DB.prepare(
      "INSERT INTO data_spaces (id, version, mutation_token, created_at, updated_at) VALUES (?, 1, NULL, ?, ?)",
    ).bind(identity.dataSpaceId, now, now),
    context.env.DB.prepare(
      `INSERT INTO device_memberships
         (identity_id, data_space_id, public_device_id, device_label,
          recovery_namespace, joined_at, device_platform, device_browser,
          browser_major_version, device_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      identity.id,
      identity.dataSpaceId,
      identity.publicDeviceId,
      identity.deviceLabel,
      identity.recoveryNamespace,
      now,
      detectedDevice.platform,
      detectedDevice.browser,
      detectedDevice.browserMajorVersion,
      detectedDevice.deviceType,
    ),
    context.env.DB.prepare(
      "INSERT INTO settings (identity_id, locale, version, updated_at) VALUES (?, ?, 1, ?)",
    ).bind(identity.id, detectedLocale(context.req.raw), now),
  ]);
  return { identity, credential, setCookie: true, clearCookie: false };
};

export const applyIdentityCookie = (
  context: Context,
  resolution: IdentityResolution,
) => {
  if (!resolution.setCookie || !resolution.credential) return;
  const url = new URL(context.req.url);
  setCookie(context, cookieName(url), resolution.credential, {
    path: "/",
    httpOnly: true,
    secure: !isLocal(url),
    sameSite: "Lax",
    expires: new Date(resolution.identity!.expiresAt),
  });
};

export const expireIdentityCookie = (context: Context) => {
  const url = new URL(context.req.url);
  deleteCookie(context, cookieName(url), {
    path: "/",
    secure: !isLocal(url),
    httpOnly: true,
    sameSite: "Lax",
  });
};
