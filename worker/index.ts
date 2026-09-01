import { Hono, type Context } from "hono";
import {
  IDENTITY_MAX_AGE_SECONDS,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_LIFETIME_SECONDS,
} from "../src/lib/constants";
import { gradeSubmission, projectJudgedText } from "../src/lib/grading";
import { parseLyrics } from "../src/lib/lyrics";
import type {
  BootstrapPayload,
  DeviceInfo,
  PairingPreview,
} from "../src/lib/types";
import {
  parseJson,
  pairingJoinSchema,
  pairingPreviewSchema,
  sessionStartSchema,
  sessionUpdateSchema,
  settingsUpdateSchema,
  songInputSchema,
  songUpdateSchema,
} from "../src/lib/validation";
import {
  toRecent,
  toSession,
  toSong,
  toSongSummary,
  type SessionRow,
  type SongRow,
} from "./db";
import {
  deterministicMutationId,
  enforceRateLimit,
  mutationFingerprint,
  requireIdempotencyKey,
  withIdempotency,
} from "./guards";
import { ApiError, handleError, requireSameOrigin } from "./http";
import {
  applyIdentityCookie,
  expireIdentityCookie,
  resolveIdentity,
} from "./identity";
import type { AppBindings, IdentityRecord } from "./types";

type AppContext = Context<AppBindings>;

const app = new Hono<AppBindings>();

export const createHealthResponse = async (
  database: D1Database,
): Promise<Response> => {
  const headers = {
    "Cache-Control": "no-store",
    "CDN-Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=UTF-8",
    "X-Content-Type-Options": "nosniff",
  };
  try {
    const result = await database
      .prepare("SELECT 1 AS healthy")
      .first<{ healthy: number }>();
    if (result?.healthy !== 1) throw new Error("Unexpected D1 health result");
    return new Response("ok", { status: 200, headers });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "healthcheck_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return new Response("unavailable", { status: 503, headers });
  }
};

app.on(["GET", "HEAD"], "/healthz", (context) =>
  createHealthResponse(context.env.DB),
);

const songSelect = `
  SELECT s.*,
    (SELECT id FROM sessions x WHERE x.song_id = s.id AND x.data_space_id = s.data_space_id AND x.status = 'in_progress' LIMIT 1) AS active_session_id,
    (SELECT COUNT(*) FROM sessions x WHERE x.song_id = s.id AND x.data_space_id = s.data_space_id AND x.status != 'in_progress') AS practice_sessions,
    (SELECT COUNT(*) FROM sessions x WHERE x.song_id = s.id AND x.data_space_id = s.data_space_id AND x.status = 'completed') AS completed_sessions,
    (SELECT CASE
       WHEN x.correct_count + x.incorrect_count + x.extra_count + x.missing_count = 0 THEN 0
       ELSE CAST(ROUND(
         100.0 * x.correct_count /
         (x.correct_count + x.incorrect_count + x.extra_count + x.missing_count)
       ) AS INTEGER)
     END
     FROM sessions x
     WHERE x.song_id = s.id AND x.data_space_id = s.data_space_id AND x.status != 'in_progress'
     ORDER BY COALESCE(x.completed_at, x.updated_at) DESC, x.id DESC
     LIMIT 1) AS latest_accuracy
  FROM songs s`;

const requireIdentity = (context: AppContext): IdentityRecord => {
  const identity = context.get("identity");
  if (!identity) throw new ApiError("IDENTITY_NOT_FOUND", 404);
  return identity;
};

interface DeviceRow {
  identity_id: string;
  public_device_id: string;
  device_label: string;
  device_platform: string | null;
  device_browser: string | null;
  browser_major_version: string | null;
  device_type: DeviceInfo["deviceType"];
  joined_at: number;
  last_seen_at: number;
}

const listDevices = async (
  database: D1Database,
  identity: IdentityRecord,
): Promise<DeviceInfo[]> => {
  const rows = await database
    .prepare(
      `SELECT m.identity_id, m.public_device_id, m.device_label, m.joined_at,
         m.device_platform, m.device_browser, m.browser_major_version,
         m.device_type, i.last_seen_at
       FROM device_memberships m
       JOIN identities i ON i.id = m.identity_id
       WHERE m.data_space_id = ?
       ORDER BY m.joined_at, m.public_device_id`,
    )
    .bind(identity.dataSpaceId)
    .all<DeviceRow>();
  return rows.results.map((row) => ({
    id: row.public_device_id,
    label: row.device_label,
    platform: row.device_platform,
    browser: row.device_browser,
    browserMajorVersion: row.browser_major_version,
    deviceType: row.device_type,
    isThisDevice: row.identity_id === identity.id,
    joinedAt: row.joined_at,
    lastActiveAt: row.last_seen_at,
  }));
};

const pairingAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const createPairingCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_CODE_LENGTH));
  return [...bytes].map((byte) => pairingAlphabet[byte & 31]).join("");
};

const displayPairingCode = (code: string) =>
  code.match(/.{1,4}/gu)?.join("-") ?? code;

const hashPairingCode = async (code: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(code),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

interface ReplacementCounts {
  songs: number;
  active_drafts: number;
  history: number;
}

const replacementCounts = async (
  database: D1Database,
  dataSpaceId: string,
): Promise<ReplacementCounts> =>
  (await database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM songs WHERE data_space_id = ?) AS songs,
         (SELECT COUNT(*) FROM sessions WHERE data_space_id = ? AND status = 'in_progress') AS active_drafts,
         (SELECT COUNT(*) FROM sessions WHERE data_space_id = ? AND status != 'in_progress') AS history`,
    )
    .bind(dataSpaceId, dataSpaceId, dataSpaceId)
    .first<ReplacementCounts>()) ?? {
    songs: 0,
    active_drafts: 0,
    history: 0,
  };

const persistMissingCharacterCounts = async (
  database: D1Database,
  dataSpaceId: string,
  songs: SongRow[],
) => {
  const missing = songs.filter(
    (song) =>
      song.character_count === null || song.character_count === undefined,
  );
  if (missing.length === 0) return;
  for (const song of missing) {
    song.character_count = projectJudgedText(song.study_text, true).count;
  }
  for (let start = 0; start < missing.length; start += 50) {
    await database.batch(
      missing.slice(start, start + 50).map((song) =>
        database
          .prepare(
            `UPDATE songs SET character_count = ?
             WHERE id = ? AND data_space_id = ? AND study_text = ? AND character_count IS NULL`,
          )
          .bind(song.character_count, song.id, dataSpaceId, song.study_text),
      ),
    );
  }
};

const parseHistoryCursor = (rawCursor?: string) => {
  if (!rawCursor)
    return { beforeUpdatedAt: Number.MAX_SAFE_INTEGER, beforeId: "\uffff" };
  const separator = rawCursor.indexOf(":");
  const timestamp = rawCursor.slice(0, separator);
  const id = rawCursor.slice(separator + 1);
  if (
    separator <= 0 ||
    !/^\d{1,16}$/u.test(timestamp) ||
    !/^[0-9a-f-]{36}$/iu.test(id) ||
    !Number.isSafeInteger(Number(timestamp))
  ) {
    throw new ApiError("VALIDATION_ERROR", 400);
  }
  return { beforeUpdatedAt: Number(timestamp), beforeId: id };
};

const parseCountedMutation = async <T>(
  context: AppContext,
  identity: IdentityRecord,
  parse: () => Promise<T>,
  buckets: Array<"mutation" | "import"> = ["mutation"],
): Promise<T> => {
  try {
    return await parse();
  } catch (error) {
    for (const bucket of buckets) {
      await enforceRateLimit(context, identity, bucket);
    }
    throw error;
  }
};

const requireCountedIdempotency = async (
  context: AppContext,
  identity: IdentityRecord,
  buckets: Array<"mutation" | "import" | "destructive"> = ["mutation"],
) => {
  try {
    requireIdempotencyKey(context);
  } catch (error) {
    for (const bucket of buckets) {
      await enforceRateLimit(context, identity, bucket);
    }
    throw error;
  }
};

const waitForSessionStartLock = async (
  context: AppContext,
  songId: string,
  key: string,
  restart: boolean,
): Promise<{ owned: boolean; resultSessionId?: string }> => {
  const dataSpaceId = requireIdentity(context).dataSpaceId;
  const deadline = Date.now() + 1_000;
  const now = Date.now();
  const acquired = await context.env.DB.prepare(
    `INSERT INTO session_start_locks
       (data_space_id, song_id, owner_key, expires_at, intent_restart, result_session_id)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(data_space_id, song_id) DO UPDATE SET
       owner_key = excluded.owner_key,
       expires_at = excluded.expires_at,
       intent_restart = excluded.intent_restart,
       result_session_id = NULL
     WHERE session_start_locks.expires_at <= ?`,
  )
    .bind(dataSpaceId, songId, key, now + 5_000, restart ? 1 : 0, now)
    .run();
  if (acquired.meta.changes) return { owned: true };
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    const lock = await context.env.DB.prepare(
      `SELECT owner_key, intent_restart, result_session_id
       FROM session_start_locks WHERE data_space_id = ? AND song_id = ?`,
    )
      .bind(dataSpaceId, songId)
      .first<{
        owner_key: string;
        intent_restart: number;
        result_session_id: string | null;
      }>();
    if (!lock) return { owned: false };
    if (lock.result_session_id && (!restart || Boolean(lock.intent_restart))) {
      return { owned: false, resultSessionId: lock.result_session_id };
    }
  }
  throw new ApiError("IDEMPOTENCY_IN_PROGRESS", 409, undefined, {
    "Retry-After": "1",
  });
};

const publishSessionStartResult = async (
  context: AppContext,
  songId: string,
  key: string,
  sessionId: string,
) => {
  const dataSpaceId = requireIdentity(context).dataSpaceId;
  await context.env.DB.prepare(
    `UPDATE session_start_locks SET result_session_id = ?
     WHERE data_space_id = ? AND song_id = ? AND owner_key = ?`,
  )
    .bind(sessionId, dataSpaceId, songId, key)
    .run();
};

const releaseSessionStartLock = async (
  context: AppContext,
  songId: string,
  key: string,
) => {
  const dataSpaceId = requireIdentity(context).dataSpaceId;
  await context.env.DB.prepare(
    "DELETE FROM session_start_locks WHERE data_space_id = ? AND song_id = ? AND owner_key = ?",
  )
    .bind(dataSpaceId, songId, key)
    .run();
};

app.use("/api/*", async (context, next) => {
  await next();
  context.header("Cache-Control", "no-store");
  context.header("CDN-Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Frame-Options", "DENY");
  context.header(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  if (new URL(context.req.url).protocol === "https:") {
    context.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
});

// Reject cross-site writes before resolving or creating an anonymous identity.
// A SameSite cookie may be absent on an attacker-triggered request; creating a
// replacement identity first would overwrite the victim's credential even
// though the mutation itself is rejected.
app.use("/api/*", async (context, next) => {
  requireSameOrigin(context.req.raw);
  await next();
});

app.use("/api/*", async (context, next) => {
  const isDeleteAll =
    context.req.method === "DELETE" && context.req.path === "/api/data";
  const resolution = await resolveIdentity(context, !isDeleteAll);
  context.set("identity", resolution.identity);
  await next();
  if (!isDeleteAll) {
    if (resolution.clearCookie) expireIdentityCookie(context);
    else if (resolution.setCookie && resolution.identity) {
      const current = await context.env.DB.prepare(
        `SELECT 1 AS present FROM identities i
         WHERE i.id = ? AND i.credential_hash = ?
           AND NOT EXISTS (
             SELECT 1 FROM revoked_credentials r
             WHERE r.credential_hash = i.credential_hash AND r.expires_at > ?
           )`,
      )
        .bind(
          resolution.identity.id,
          resolution.identity.credentialHash,
          Date.now(),
        )
        .first<{ present: number }>();
      if (current) applyIdentityCookie(context, resolution);
      else expireIdentityCookie(context);
    }
  }
});

app.get("/api/bootstrap", async (context) => {
  const identity = requireIdentity(context);
  const [settings, songs, sessions, devices] = await Promise.all([
    context.env.DB.prepare(
      "SELECT locale, locale_explicit, version FROM settings WHERE identity_id = ?",
    )
      .bind(identity.id)
      .first<{
        locale: "en" | "zh-CN";
        locale_explicit: number;
        version: number;
      }>(),
    context.env.DB.prepare(
      `${songSelect} WHERE s.data_space_id = ? ORDER BY s.updated_at DESC`,
    )
      .bind(identity.dataSpaceId)
      .all<SongRow>(),
    context.env.DB.prepare(
      `SELECT x.*, s.title AS song_title FROM sessions x
       JOIN songs s ON s.id = x.song_id AND s.data_space_id = x.data_space_id
       WHERE x.data_space_id = ? AND x.status != 'in_progress'
       ORDER BY COALESCE(x.completed_at, x.updated_at) DESC LIMIT 10`,
    )
      .bind(identity.dataSpaceId)
      .all<SessionRow>(),
    listDevices(context.env.DB, identity),
  ]);
  await persistMissingCharacterCounts(
    context.env.DB,
    identity.dataSpaceId,
    songs.results,
  );
  const payload: BootstrapPayload = {
    locale: settings?.locale ?? "en",
    localeExplicit: settings?.locale_explicit === 1,
    settingsVersion: settings?.version ?? 1,
    songs: songs.results.map(toSongSummary),
    recentSessions: sessions.results.map(toRecent),
    devices,
    paired: devices.length > 1,
    recoveryNamespace: identity.recoveryNamespace,
  };
  return context.json(payload);
});

app.patch("/api/settings", async (context) => {
  const identity = requireIdentity(context);
  await enforceRateLimit(context, identity, "mutation");
  const input = await parseJson(context.req.raw, settingsUpdateSchema);
  const result = await context.env.DB.prepare(
    "UPDATE settings SET locale = ?, locale_explicit = 1, version = version + 1, updated_at = ? WHERE identity_id = ? AND version = ? RETURNING version",
  )
    .bind(input.locale, Date.now(), identity.id, input.version)
    .first<{ version: number }>();
  if (!result) throw new ApiError("VERSION_CONFLICT", 409);
  return context.json({
    locale: input.locale,
    localeExplicit: true,
    version: result.version,
  });
});

app.post("/api/songs", async (context) => {
  const identity = requireIdentity(context);
  await requireCountedIdempotency(context, identity, ["mutation", "import"]);
  const input = await parseCountedMutation(
    context,
    identity,
    () => parseJson(context.req.raw, songInputSchema),
    ["mutation", "import"],
  );
  const operation = `song:create:${await mutationFingerprint(input)}`;
  return withIdempotency(
    context,
    identity,
    operation,
    async (key) => {
      await enforceRateLimit(context, identity, "mutation");
      await enforceRateLimit(context, identity, "import");
      const parsed = parseLyrics(input.sourceText, input.sourceKind);
      const now = Date.now();
      const id = await deterministicMutationId(identity, operation, key);
      const existing = await context.env.DB.prepare(
        `${songSelect} WHERE s.data_space_id = ? AND s.id = ?`,
      )
        .bind(identity.dataSpaceId, id)
        .first<SongRow>();
      if (existing) return context.json({ song: toSong(existing) }, 201);
      const inserted = await context.env.DB.prepare(
        `INSERT INTO songs
       (data_space_id, id, title, artist, source_text, study_text, character_count, source_kind, version, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
       FROM data_spaces w
       WHERE w.id = ? AND w.version = ? AND w.mutation_token IS NULL`,
      )
        .bind(
          identity.dataSpaceId,
          id,
          input.title,
          input.artist,
          parsed.sourceText,
          parsed.studyText,
          projectJudgedText(parsed.studyText, true).count,
          input.sourceKind,
          now,
          now,
          identity.dataSpaceId,
          identity.dataSpaceVersion,
        )
        .run();
      if (!inserted.meta.changes) throw new ApiError("VERSION_CONFLICT", 409);
      const row = await context.env.DB.prepare(
        `${songSelect} WHERE s.data_space_id = ? AND s.id = ?`,
      )
        .bind(identity.dataSpaceId, id)
        .first<SongRow>();
      return context.json({ song: toSong(row!) }, 201);
    },
    async (key) => {
      const id = await deterministicMutationId(identity, operation, key);
      const row = await context.env.DB.prepare(
        `${songSelect} WHERE s.data_space_id = ? AND s.id = ?`,
      )
        .bind(identity.dataSpaceId, id)
        .first<SongRow>();
      return row ? context.json({ song: toSong(row) }, 201) : null;
    },
  );
});

app.get("/api/songs/:id", async (context) => {
  const identity = requireIdentity(context);
  const { beforeUpdatedAt, beforeId } = parseHistoryCursor(
    context.req.query("historyCursor"),
  );
  const [row, history] = await Promise.all([
    context.env.DB.prepare(
      `${songSelect} WHERE s.data_space_id = ? AND s.id = ?`,
    )
      .bind(identity.dataSpaceId, context.req.param("id"))
      .first<SongRow>(),
    context.env.DB.prepare(
      `SELECT x.*, s.title AS song_title FROM sessions x
       JOIN songs s ON s.id = x.song_id AND s.data_space_id = x.data_space_id
       WHERE x.data_space_id = ? AND x.song_id = ? AND x.status != 'in_progress'
         AND (x.updated_at < ? OR (x.updated_at = ? AND x.id < ?))
       ORDER BY x.updated_at DESC, x.id DESC LIMIT 21`,
    )
      .bind(
        identity.dataSpaceId,
        context.req.param("id"),
        beforeUpdatedAt,
        beforeUpdatedAt,
        beforeId,
      )
      .all<SessionRow>(),
  ]);
  if (!row) throw new ApiError("SONG_NOT_FOUND", 404);
  const visibleHistory = history.results.slice(0, 20);
  const lastVisible = visibleHistory.at(-1);
  return context.json({
    song: toSong(row),
    history: visibleHistory.map(toRecent),
    historyCursor:
      history.results.length > visibleHistory.length && lastVisible
        ? `${lastVisible.updated_at}:${lastVisible.id}`
        : null,
  });
});

app.get("/api/sessions", async (context) => {
  const identity = requireIdentity(context);
  const { beforeUpdatedAt, beforeId } = parseHistoryCursor(
    context.req.query("historyCursor"),
  );
  const history = await context.env.DB.prepare(
    `SELECT x.*, s.title AS song_title FROM sessions x
     JOIN songs s ON s.id = x.song_id AND s.data_space_id = x.data_space_id
     WHERE x.data_space_id = ? AND x.status != 'in_progress'
       AND (x.updated_at < ? OR (x.updated_at = ? AND x.id < ?))
     ORDER BY x.updated_at DESC, x.id DESC LIMIT 21`,
  )
    .bind(identity.dataSpaceId, beforeUpdatedAt, beforeUpdatedAt, beforeId)
    .all<SessionRow>();
  const visibleHistory = history.results.slice(0, 20);
  const lastVisible = visibleHistory.at(-1);
  return context.json({
    history: visibleHistory.map(toRecent),
    historyCursor:
      history.results.length > visibleHistory.length && lastVisible
        ? `${lastVisible.updated_at}:${lastVisible.id}`
        : null,
  });
});

app.put("/api/songs/:id", async (context) => {
  const identity = requireIdentity(context);
  await enforceRateLimit(context, identity, "mutation");
  const input = await parseJson(context.req.raw, songUpdateSchema);
  const parsed = parseLyrics(input.sourceText, input.sourceKind);
  const active = await context.env.DB.prepare(
    `SELECT x.*, COALESCE(x.study_text, s.study_text) AS session_study_text FROM sessions x
     JOIN songs s ON s.id = x.song_id AND s.data_space_id = x.data_space_id
     WHERE x.song_id = ? AND x.data_space_id = ? AND x.status = 'in_progress'`,
  )
    .bind(context.req.param("id"), identity.dataSpaceId)
    .first<SessionRow>();
  const submittedGrade = active
    ? gradeSubmission(
        active.session_study_text!,
        active.draft_text,
        Boolean(active.case_sensitive),
      )
    : {
        exact: false,
        complete: false,
        correct: 0,
        incorrect: 0,
        extra: 0,
        missing: 0,
        expectedCount: 0,
      };
  const now = Date.now();
  const songId = context.req.param("id");
  const update = context.env.DB.prepare(
    `UPDATE songs SET title = ?, artist = ?, source_text = ?, study_text = ?, character_count = ?, source_kind = ?,
      version = version + 1, updated_at = ?
     WHERE id = ? AND data_space_id = ? AND version = ?
       AND EXISTS (
         SELECT 1 FROM data_spaces w
         WHERE w.id = ? AND w.version = ? AND w.mutation_token IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM sessions
         WHERE song_id = ? AND data_space_id = ? AND status = 'in_progress'
       )`,
  ).bind(
    input.title,
    input.artist,
    parsed.sourceText,
    parsed.studyText,
    projectJudgedText(parsed.studyText, true).count,
    input.sourceKind,
    now,
    songId,
    identity.dataSpaceId,
    input.version,
    identity.dataSpaceId,
    identity.dataSpaceVersion,
    songId,
    identity.dataSpaceId,
  );
  const statements: D1PreparedStatement[] = [];
  if (active) {
    statements.push(
      context.env.DB.prepare(
        `UPDATE sessions SET status = ?, correct_count = ?, incorrect_count = ?,
           extra_count = ?, missing_count = ?, updated_at = ?, completed_at = ?, version = version + 1
         WHERE id = ? AND song_id = ? AND data_space_id = ? AND version = ? AND status = 'in_progress'
           AND EXISTS (
             SELECT 1 FROM data_spaces w
             WHERE w.id = ? AND w.version = ? AND w.mutation_token IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM songs WHERE id = ? AND data_space_id = ? AND version = ?
           )`,
      ).bind(
        submittedGrade.complete ? "completed" : "abandoned",
        submittedGrade.correct,
        submittedGrade.incorrect,
        submittedGrade.extra,
        submittedGrade.missing,
        now,
        now,
        active.id,
        songId,
        identity.dataSpaceId,
        active.version,
        identity.dataSpaceId,
        identity.dataSpaceVersion,
        songId,
        identity.dataSpaceId,
        input.version,
      ),
    );
  }
  statements.push(update);
  const results = await context.env.DB.batch(statements);
  const result = results.at(-1)!;
  if (!result.meta.changes) throw new ApiError("VERSION_CONFLICT", 409);
  const row = await context.env.DB.prepare(
    `${songSelect} WHERE s.data_space_id = ? AND s.id = ?`,
  )
    .bind(identity.dataSpaceId, context.req.param("id"))
    .first<SongRow>();
  return context.json({ song: toSong(row!) });
});

app.delete("/api/songs/:id", async (context) => {
  const identity = requireIdentity(context);
  await requireCountedIdempotency(context, identity, [
    "mutation",
    "destructive",
  ]);
  const songId = context.req.param("id");
  const version = Number(context.req.query("version"));
  if (!Number.isInteger(version) || version <= 0) {
    await enforceRateLimit(context, identity, "mutation");
    await enforceRateLimit(context, identity, "destructive");
    throw new ApiError("VALIDATION_ERROR", 400);
  }
  return withIdempotency(
    context,
    identity,
    `song:delete:${songId}:${version}`,
    async () => {
      await enforceRateLimit(context, identity, "mutation");
      await enforceRateLimit(context, identity, "destructive");
      const result = await context.env.DB.prepare(
        `DELETE FROM songs
         WHERE id = ? AND data_space_id = ? AND version = ?
           AND EXISTS (
             SELECT 1 FROM data_spaces w
             WHERE w.id = ? AND w.version = ? AND w.mutation_token IS NULL
           )`,
      )
        .bind(
          songId,
          identity.dataSpaceId,
          version,
          identity.dataSpaceId,
          identity.dataSpaceVersion,
        )
        .run();
      if (!result.meta.changes) throw new ApiError("VERSION_CONFLICT", 409);
      return context.json({ deleted: true });
    },
    async () => {
      const row = await context.env.DB.prepare(
        "SELECT id FROM songs WHERE id = ? AND data_space_id = ?",
      )
        .bind(songId, identity.dataSpaceId)
        .first<{ id: string }>();
      return row ? null : context.json({ deleted: true });
    },
  );
});

app.post("/api/songs/:id/sessions", async (context) => {
  const identity = requireIdentity(context);
  await requireCountedIdempotency(context, identity);
  const input = await parseCountedMutation(context, identity, () =>
    parseJson(context.req.raw, sessionStartSchema),
  );
  const songId = context.req.param("id");
  const operation = `session:start:${songId}:${await mutationFingerprint(input)}`;
  return withIdempotency(
    context,
    identity,
    operation,
    async (key) => {
      await enforceRateLimit(context, identity, "mutation");
      let ownsLock = false;
      for (let attempt = 0; attempt < 3 && !ownsLock; attempt += 1) {
        const lock = await waitForSessionStartLock(
          context,
          songId,
          key,
          input.restart,
        );
        ownsLock = lock.owned;
        if (ownsLock) break;
        if (lock.resultSessionId) {
          const concurrent = await context.env.DB.prepare(
            "SELECT * FROM sessions WHERE id = ? AND song_id = ? AND data_space_id = ? AND status = 'in_progress'",
          )
            .bind(lock.resultSessionId, songId, identity.dataSpaceId)
            .first<SessionRow>();
          if (concurrent)
            return context.json({ session: toSession(concurrent) });
        }
        const exists = await context.env.DB.prepare(
          "SELECT 1 AS found FROM songs WHERE id = ? AND data_space_id = ?",
        )
          .bind(songId, identity.dataSpaceId)
          .first<{ found: number }>();
        if (!exists) throw new ApiError("SONG_NOT_FOUND", 404);
      }
      if (!ownsLock) {
        throw new ApiError("IDEMPOTENCY_IN_PROGRESS", 409, undefined, {
          "Retry-After": "1",
        });
      }
      let lockResultSessionId: string | null = null;
      try {
        const id = await deterministicMutationId(identity, operation, key);
        const existingByKey = await context.env.DB.prepare(
          "SELECT * FROM sessions WHERE id = ? AND data_space_id = ?",
        )
          .bind(id, identity.dataSpaceId)
          .first<SessionRow>();
        if (existingByKey) {
          lockResultSessionId = existingByKey.id;
          return context.json({ session: toSession(existingByKey) }, 201);
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const song = await context.env.DB.prepare(
            "SELECT id, study_text, version FROM songs WHERE id = ? AND data_space_id = ?",
          )
            .bind(songId, identity.dataSpaceId)
            .first<{ id: string; study_text: string; version: number }>();
          if (!song) throw new ApiError("SONG_NOT_FOUND", 404);
          const active = await context.env.DB.prepare(
            "SELECT * FROM sessions WHERE song_id = ? AND data_space_id = ? AND status = 'in_progress'",
          )
            .bind(song.id, identity.dataSpaceId)
            .first<SessionRow>();
          if (active && !input.restart) {
            lockResultSessionId = active.id;
            return context.json({ session: toSession(active) });
          }

          const now = Date.now();
          const statements: D1PreparedStatement[] = [];
          if (active) {
            const submittedGrade = gradeSubmission(
              active.study_text ?? song.study_text,
              active.draft_text,
              Boolean(active.case_sensitive),
            );
            statements.push(
              context.env.DB.prepare(
                `UPDATE sessions SET status = ?, correct_count = ?, incorrect_count = ?,
                 extra_count = ?, missing_count = ?, version = version + 1, updated_at = ?, completed_at = ?
                 WHERE id = ? AND data_space_id = ? AND version = ? AND status = 'in_progress'
                   AND EXISTS (
                     SELECT 1 FROM data_spaces w
                     WHERE w.id = ? AND w.version = ? AND w.mutation_token IS NULL
                   )
                   AND EXISTS (
                     SELECT 1 FROM songs WHERE id = ? AND data_space_id = ? AND version = ?
                   )`,
              ).bind(
                submittedGrade.complete ? "completed" : "abandoned",
                submittedGrade.correct,
                submittedGrade.incorrect,
                submittedGrade.extra,
                submittedGrade.missing,
                now,
                now,
                active.id,
                identity.dataSpaceId,
                active.version,
                identity.dataSpaceId,
                identity.dataSpaceVersion,
                song.id,
                identity.dataSpaceId,
                song.version,
              ),
            );
          }
          statements.push(
            context.env.DB.prepare(
              `INSERT INTO sessions
               (data_space_id, id, song_id, status, draft_text, study_text, case_sensitive, version, started_at, updated_at)
               SELECT ?, ?, s.id, 'in_progress', '', s.study_text, ?, 1, ?, ?
               FROM songs s
               WHERE s.id = ? AND s.data_space_id = ? AND s.version = ?
                 AND EXISTS (
                   SELECT 1 FROM data_spaces w
                   WHERE w.id = s.data_space_id AND w.version = ?
                     AND w.mutation_token IS NULL
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM sessions
                   WHERE song_id = s.id AND data_space_id = s.data_space_id AND status = 'in_progress'
                 )`,
            ).bind(
              identity.dataSpaceId,
              id,
              input.caseSensitive ? 1 : 0,
              now,
              now,
              song.id,
              identity.dataSpaceId,
              song.version,
              identity.dataSpaceVersion,
            ),
          );
          const results = await context.env.DB.batch(statements);
          if (results.at(-1)?.meta.changes) {
            const row = await context.env.DB.prepare(
              "SELECT * FROM sessions WHERE id = ? AND data_space_id = ?",
            )
              .bind(id, identity.dataSpaceId)
              .first<SessionRow>();
            lockResultSessionId = row!.id;
            return context.json({ session: toSession(row!) }, 201);
          }
        }
        throw new ApiError("VERSION_CONFLICT", 409);
      } finally {
        // Keep the lease briefly so requests that arrived together observe
        // this result instead of immediately restarting it again.
        if (lockResultSessionId) {
          await publishSessionStartResult(
            context,
            songId,
            key,
            lockResultSessionId,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        await releaseSessionStartLock(context, songId, key);
      }
    },
    async (key) => {
      const id = await deterministicMutationId(identity, operation, key);
      const row = await context.env.DB.prepare(
        "SELECT * FROM sessions WHERE id = ? AND data_space_id = ?",
      )
        .bind(id, identity.dataSpaceId)
        .first<SessionRow>();
      if (row) return context.json({ session: toSession(row) }, 201);
      if (input.restart) return null;
      const active = await context.env.DB.prepare(
        "SELECT * FROM sessions WHERE song_id = ? AND data_space_id = ? AND status = 'in_progress'",
      )
        .bind(songId, identity.dataSpaceId)
        .first<SessionRow>();
      if (active) return context.json({ session: toSession(active) });
      return null;
    },
  );
});

app.get("/api/sessions/:id", async (context) => {
  const identity = requireIdentity(context);
  const row = await context.env.DB.prepare(
    `SELECT x.*, COALESCE(x.study_text, s.study_text) AS session_study_text,
       s.title AS song_title FROM sessions x
     JOIN songs s ON s.id = x.song_id AND s.data_space_id = x.data_space_id
     WHERE x.id = ? AND x.data_space_id = ?`,
  )
    .bind(context.req.param("id"), identity.dataSpaceId)
    .first<SessionRow>();
  if (!row) throw new ApiError("SESSION_NOT_FOUND", 404);
  return context.json({
    session: toSession(row),
    studyText: row.session_study_text,
    songTitle: row.song_title,
  });
});

app.patch("/api/sessions/:id", async (context) => {
  const identity = requireIdentity(context);
  await requireCountedIdempotency(context, identity);
  const input = await parseCountedMutation(context, identity, () =>
    parseJson(context.req.raw, sessionUpdateSchema),
  );
  const sessionId = context.req.param("id");
  const operation = `session:${sessionId}:${input.action}:${await mutationFingerprint(input)}`;
  return withIdempotency(
    context,
    identity,
    operation,
    async () => {
      await enforceRateLimit(context, identity, "mutation");
      const row = await context.env.DB.prepare(
        `SELECT x.*, COALESCE(x.study_text, s.study_text) AS session_study_text FROM sessions x
         JOIN songs s ON s.id = x.song_id AND s.data_space_id = x.data_space_id
         WHERE x.id = ? AND x.data_space_id = ?`,
      )
        .bind(sessionId, identity.dataSpaceId)
        .first<SessionRow>();
      if (!row) throw new ApiError("SESSION_NOT_FOUND", 404);
      if (row.version !== input.version) {
        throw new ApiError("VERSION_CONFLICT", 409, {
          current: toSession(row),
        });
      }
      if (row.status !== "in_progress")
        throw new ApiError("SESSION_NOT_ACTIVE", 409);
      const grade =
        input.action !== "save"
          ? gradeSubmission(
              row.session_study_text!,
              input.draftText,
              Boolean(row.case_sensitive),
            )
          : {
              complete: false,
              correct: row.correct_count,
              incorrect: row.incorrect_count,
              extra: row.extra_count,
              missing: row.missing_count,
              expectedCount: 0,
            };
      const now = Date.now();
      const status =
        input.action === "save"
          ? "in_progress"
          : input.action === "abandon" && !grade.complete
            ? "abandoned"
            : "completed";
      const result = await context.env.DB.prepare(
        `UPDATE sessions SET draft_text = ?, status = ?, correct_count = ?, incorrect_count = ?,
          extra_count = ?, missing_count = ?, version = version + 1, updated_at = ?, completed_at = ?
         WHERE id = ? AND data_space_id = ? AND version = ? AND status = 'in_progress'
           AND EXISTS (
             SELECT 1 FROM data_spaces w
             WHERE w.id = ? AND w.version = ? AND w.mutation_token IS NULL
           )
         RETURNING *`,
      )
        .bind(
          input.draftText,
          status,
          grade.correct,
          grade.incorrect,
          grade.extra,
          grade.missing,
          now,
          status === "in_progress" ? null : now,
          row.id,
          identity.dataSpaceId,
          input.version,
          identity.dataSpaceId,
          identity.dataSpaceVersion,
        )
        .first<SessionRow>();
      if (!result) throw new ApiError("VERSION_CONFLICT", 409);
      return context.json({
        session: toSession(result),
        grade: {
          correct: grade.correct,
          incorrect: grade.incorrect,
          extra: grade.extra,
          missing: grade.missing,
          complete: grade.complete,
        },
      });
    },
    async () => {
      const recovered = await context.env.DB.prepare(
        "SELECT * FROM sessions WHERE id = ? AND data_space_id = ?",
      )
        .bind(sessionId, identity.dataSpaceId)
        .first<SessionRow>();
      const expectedStatuses =
        input.action === "save"
          ? ["in_progress"]
          : input.action === "complete"
            ? ["completed"]
            : ["completed", "abandoned"];
      if (
        !recovered ||
        recovered.version !== input.version + 1 ||
        recovered.draft_text !== input.draftText ||
        !expectedStatuses.includes(recovered.status)
      ) {
        return null;
      }
      return context.json({
        session: toSession(recovered),
        grade: {
          correct: recovered.correct_count,
          incorrect: recovered.incorrect_count,
          extra: recovered.extra_count,
          missing: recovered.missing_count,
          complete:
            recovered.status !== "in_progress" &&
            recovered.incorrect_count === 0 &&
            recovered.extra_count === 0 &&
            recovered.missing_count === 0,
        },
      });
    },
  );
});

app.post("/api/devices/pairing-code", async (context) => {
  const identity = requireIdentity(context);
  await enforceRateLimit(context, identity, "pairing");
  await enforceRateLimit(context, identity, "mutation");
  const now = Date.now();
  const code = createPairingCode();
  const codeHash = await hashPairingCode(code);
  const expiresAt = now + PAIRING_CODE_LIFETIME_SECONDS * 1000;
  const results = await context.env.DB.batch([
    context.env.DB.prepare(
      `DELETE FROM pairing_codes
       WHERE data_space_id = ? AND claimed_by_identity_id IS NULL
         AND EXISTS (
           SELECT 1 FROM device_memberships
           WHERE identity_id = ? AND data_space_id = ?
         )`,
    ).bind(identity.dataSpaceId, identity.id, identity.dataSpaceId),
    context.env.DB.prepare(
      `INSERT INTO pairing_codes
         (code_hash, data_space_id, created_by_identity_id, created_at, expires_at)
       SELECT ?, m.data_space_id, ?, ?, ?
       FROM device_memberships m
       WHERE m.identity_id = ? AND m.data_space_id = ?`,
    ).bind(
      codeHash,
      identity.id,
      now,
      expiresAt,
      identity.id,
      identity.dataSpaceId,
    ),
  ]);
  if (!results[1].meta.changes) throw new ApiError("VERSION_CONFLICT", 409);
  return context.json({ code: displayPairingCode(code), expiresAt });
});

app.post("/api/devices/pairing-preview", async (context) => {
  const identity = requireIdentity(context);
  await enforceRateLimit(context, identity, "pairing");
  const input = await parseJson(context.req.raw, pairingPreviewSchema);
  const codeHash = await hashPairingCode(input.code);
  const target = await context.env.DB.prepare(
    `SELECT p.data_space_id,
       (SELECT COUNT(*) FROM device_memberships m
        WHERE m.data_space_id = p.data_space_id) AS member_count
     FROM pairing_codes p
     WHERE p.code_hash = ? AND p.expires_at > ?
       AND p.claimed_by_identity_id IS NULL`,
  )
    .bind(codeHash, Date.now())
    .first<{ data_space_id: string; member_count: number }>();
  if (!target) throw new ApiError("PAIRING_CODE_INVALID", 404);
  if (target.data_space_id === identity.dataSpaceId)
    throw new ApiError("PAIRING_CODE_OWN_GROUP", 409);
  const currentMembers = await context.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM device_memberships WHERE data_space_id = ?",
  )
    .bind(identity.dataSpaceId)
    .first<{ count: number }>();
  if (Number(currentMembers?.count ?? 0) > 1)
    throw new ApiError("PAIRING_EXIT_REQUIRED", 409);
  const replacement = await replacementCounts(
    context.env.DB,
    identity.dataSpaceId,
  );
  const preview: PairingPreview = {
    destinationDeviceCount: Number(target.member_count),
    replacement: {
      songs: Number(replacement.songs),
      activeDrafts: Number(replacement.active_drafts),
      history: Number(replacement.history),
    },
    requiresConfirmation:
      Number(replacement.songs) > 0 ||
      Number(replacement.active_drafts) > 0 ||
      Number(replacement.history) > 0,
  };
  return context.json(preview);
});

app.post("/api/devices/join", async (context) => {
  const identity = requireIdentity(context);
  await enforceRateLimit(context, identity, "pairing");
  await requireCountedIdempotency(context, identity);
  const input = await parseJson(context.req.raw, pairingJoinSchema);
  const codeHash = await hashPairingCode(input.code);
  const operation = `device:join:${codeHash}`;
  return withIdempotency(
    context,
    identity,
    operation,
    async (key) => {
      await enforceRateLimit(context, identity, "mutation");
      const now = Date.now();
      const source = await context.env.DB.prepare(
        `SELECT m.data_space_id, w.version,
           (SELECT COUNT(*) FROM device_memberships x
            WHERE x.data_space_id = m.data_space_id) AS member_count
         FROM device_memberships m
         JOIN data_spaces w ON w.id = m.data_space_id
         WHERE m.identity_id = ?`,
      )
        .bind(identity.id)
        .first<{
          data_space_id: string;
          version: number;
          member_count: number;
        }>();
      if (!source) throw new ApiError("IDENTITY_NOT_FOUND", 404);
      if (Number(source.member_count) > 1)
        throw new ApiError("PAIRING_EXIT_REQUIRED", 409);
      const target = await context.env.DB.prepare(
        `SELECT p.data_space_id, w.version
         FROM pairing_codes p
         JOIN data_spaces w ON w.id = p.data_space_id
         WHERE p.code_hash = ? AND p.expires_at > ?
           AND p.claimed_by_identity_id IS NULL`,
      )
        .bind(codeHash, now)
        .first<{ data_space_id: string; version: number }>();
      if (!target) throw new ApiError("PAIRING_CODE_INVALID", 404);
      if (target.data_space_id === source.data_space_id)
        throw new ApiError("PAIRING_CODE_OWN_GROUP", 409);
      const replacement = await replacementCounts(
        context.env.DB,
        source.data_space_id,
      );
      const hasRecords =
        Number(replacement.songs) > 0 ||
        Number(replacement.active_drafts) > 0 ||
        Number(replacement.history) > 0;
      if (hasRecords && !input.confirmReplace)
        throw new ApiError("PAIRING_CONFIRMATION_REQUIRED", 409, {
          replacement: {
            songs: Number(replacement.songs),
            activeDrafts: Number(replacement.active_drafts),
            history: Number(replacement.history),
          },
        });
      const token = crypto.randomUUID();
      const recoveryNamespace = crypto.randomUUID();
      const results = await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE data_spaces SET mutation_token = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND mutation_token IS NULL
             AND EXISTS (
               SELECT 1 FROM data_spaces source
               JOIN device_memberships membership
                 ON membership.data_space_id = source.id
                AND membership.identity_id = ?
               WHERE source.id = ? AND source.version = ?
                 AND source.mutation_token IS NULL
             )
           RETURNING id`,
        ).bind(
          token,
          now,
          target.data_space_id,
          target.version,
          identity.id,
          source.data_space_id,
          source.version,
        ),
        context.env.DB.prepare(
          `UPDATE data_spaces SET mutation_token = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND mutation_token IS NULL
             AND EXISTS (SELECT 1 FROM data_spaces WHERE id = ? AND mutation_token = ?)
           RETURNING id`,
        ).bind(
          token,
          now,
          source.data_space_id,
          source.version,
          target.data_space_id,
          token,
        ),
        context.env.DB.prepare(
          `UPDATE pairing_codes
           SET claimed_by_identity_id = ?, claimed_at = ?
           WHERE code_hash = ? AND data_space_id = ? AND expires_at > ?
             AND claimed_by_identity_id IS NULL
             AND EXISTS (SELECT 1 FROM data_spaces WHERE id = ? AND mutation_token = ?)
             AND EXISTS (SELECT 1 FROM data_spaces WHERE id = ? AND mutation_token = ?)
             AND EXISTS (
               SELECT 1 FROM device_memberships
               WHERE identity_id = ? AND data_space_id = ?
             )
           RETURNING data_space_id`,
        ).bind(
          identity.id,
          now,
          codeHash,
          target.data_space_id,
          now,
          target.data_space_id,
          token,
          source.data_space_id,
          token,
          identity.id,
          source.data_space_id,
        ),
        context.env.DB.prepare(
          `UPDATE device_memberships
           SET data_space_id = ?, recovery_namespace = ?, joined_at = ?
           WHERE identity_id = ? AND data_space_id = ?
             AND EXISTS (
               SELECT 1 FROM pairing_codes
               WHERE code_hash = ? AND claimed_by_identity_id = ?
             )`,
        ).bind(
          target.data_space_id,
          recoveryNamespace,
          now,
          identity.id,
          source.data_space_id,
          codeHash,
          identity.id,
        ),
        context.env.DB.prepare(
          `UPDATE idempotency_keys
           SET status = 409,
               response_json = '{"error":{"code":"VERSION_CONFLICT","message":"VERSION_CONFLICT"}}'
           WHERE identity_id = ? AND NOT (operation = ? AND key = ?)
             AND EXISTS (
               SELECT 1 FROM pairing_codes
               WHERE code_hash = ? AND claimed_by_identity_id = ?
             )`,
        ).bind(identity.id, operation, key, codeHash, identity.id),
        context.env.DB.prepare(
          `DELETE FROM data_spaces
           WHERE id = ? AND mutation_token = ?
             AND NOT EXISTS (
               SELECT 1 FROM device_memberships WHERE data_space_id = ?
             )`,
        ).bind(source.data_space_id, token, source.data_space_id),
        context.env.DB.prepare(
          `DELETE FROM pairing_codes
           WHERE data_space_id = ? AND claimed_by_identity_id IS NULL
             AND EXISTS (
               SELECT 1 FROM data_spaces WHERE id = ? AND mutation_token = ?
             )
             AND EXISTS (
               SELECT 1 FROM pairing_codes
               WHERE code_hash = ? AND claimed_by_identity_id = ?
             )`,
        ).bind(
          target.data_space_id,
          target.data_space_id,
          token,
          codeHash,
          identity.id,
        ),
        context.env.DB.prepare(
          "UPDATE data_spaces SET mutation_token = NULL WHERE id = ? AND mutation_token = ?",
        ).bind(target.data_space_id, token),
      ]);
      if (!results[2].meta.changes || !results[3].meta.changes)
        throw new ApiError("VERSION_CONFLICT", 409);
      return context.json({ joined: true });
    },
    async () => {
      const joined = await context.env.DB.prepare(
        `SELECT 1 AS found
         FROM pairing_codes p
         JOIN device_memberships m
           ON m.identity_id = p.claimed_by_identity_id
          AND m.data_space_id = p.data_space_id
         WHERE p.code_hash = ? AND p.claimed_by_identity_id = ?`,
      )
        .bind(codeHash, identity.id)
        .first<{ found: number }>();
      return joined ? context.json({ joined: true }) : null;
    },
  );
});

const cloneDeviceIntoPrivateSpace = async (
  context: AppContext,
  targetIdentityId: string,
  sourceSpaceId: string,
  sourceVersion: number,
  newSpaceId: string,
) => {
  const now = Date.now();
  const token = crypto.randomUUID();
  const results = await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE data_spaces SET mutation_token = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND mutation_token IS NULL
       RETURNING id`,
    ).bind(token, now, sourceSpaceId, sourceVersion),
    context.env.DB.prepare(
      `INSERT INTO data_spaces (id, version, mutation_token, created_at, updated_at)
       SELECT ?, 1, NULL, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM data_spaces WHERE id = ? AND mutation_token = ?
       ) AND EXISTS (
         SELECT 1 FROM device_memberships
         WHERE identity_id = ? AND data_space_id = ?
       )`,
    ).bind(
      newSpaceId,
      now,
      now,
      sourceSpaceId,
      token,
      targetIdentityId,
      sourceSpaceId,
    ),
    context.env.DB.prepare(
      `INSERT INTO songs
         (data_space_id, id, title, artist, source_text, study_text,
          source_kind, version, created_at, updated_at, character_count)
       SELECT ?, id, title, artist, source_text, study_text,
         source_kind, version, created_at, updated_at, character_count
       FROM songs
       WHERE data_space_id = ? AND EXISTS (
         SELECT 1 FROM data_spaces WHERE id = ? AND mutation_token = ?
       )`,
    ).bind(newSpaceId, sourceSpaceId, sourceSpaceId, token),
    context.env.DB.prepare(
      `INSERT INTO sessions
         (data_space_id, id, song_id, status, draft_text, case_sensitive,
          correct_count, incorrect_count, extra_count, missing_count,
          version, started_at, updated_at, completed_at, study_text)
       SELECT ?, id, song_id, status, draft_text, case_sensitive,
         correct_count, incorrect_count, extra_count, missing_count,
         version, started_at, updated_at, completed_at, study_text
       FROM sessions
       WHERE data_space_id = ? AND EXISTS (
         SELECT 1 FROM data_spaces WHERE id = ? AND mutation_token = ?
       )`,
    ).bind(newSpaceId, sourceSpaceId, sourceSpaceId, token),
    context.env.DB.prepare(
      `UPDATE device_memberships SET data_space_id = ?, joined_at = ?
       WHERE identity_id = ? AND data_space_id = ?
         AND EXISTS (
           SELECT 1 FROM data_spaces WHERE id = ? AND mutation_token = ?
         )`,
    ).bind(
      newSpaceId,
      now,
      targetIdentityId,
      sourceSpaceId,
      sourceSpaceId,
      token,
    ),
    context.env.DB.prepare(
      `DELETE FROM pairing_codes
       WHERE data_space_id = ? AND claimed_by_identity_id IS NULL
         AND EXISTS (
           SELECT 1 FROM data_spaces WHERE id = ? AND mutation_token = ?
         )
         AND EXISTS (
           SELECT 1 FROM device_memberships
           WHERE identity_id = ? AND data_space_id = ?
         )`,
    ).bind(sourceSpaceId, sourceSpaceId, token, targetIdentityId, newSpaceId),
    context.env.DB.prepare(
      "UPDATE data_spaces SET mutation_token = NULL WHERE id = ? AND mutation_token = ?",
    ).bind(sourceSpaceId, token),
  ]);
  if (!results[0].meta.changes || !results[4].meta.changes)
    throw new ApiError("VERSION_CONFLICT", 409);
  return { separated: true };
};

app.post("/api/devices/leave", async (context) => {
  const identity = requireIdentity(context);
  await enforceRateLimit(context, identity, "destructive");
  await requireCountedIdempotency(context, identity, ["destructive"]);
  const operation = "device:leave";
  return withIdempotency(
    context,
    identity,
    operation,
    async (key) => {
      const state = await context.env.DB.prepare(
        `SELECT m.data_space_id, w.version,
           (SELECT COUNT(*) FROM device_memberships x
            WHERE x.data_space_id = m.data_space_id) AS member_count
         FROM device_memberships m
         JOIN data_spaces w ON w.id = m.data_space_id
         WHERE m.identity_id = ?`,
      )
        .bind(identity.id)
        .first<{
          data_space_id: string;
          version: number;
          member_count: number;
        }>();
      if (!state || Number(state.member_count) < 2)
        throw new ApiError("PAIRING_NOT_PAIRED", 409);
      const newSpaceId = await deterministicMutationId(
        identity,
        operation,
        key,
      );
      return context.json(
        await cloneDeviceIntoPrivateSpace(
          context,
          identity.id,
          state.data_space_id,
          state.version,
          newSpaceId,
        ),
      );
    },
    async (key) => {
      const newSpaceId = await deterministicMutationId(
        identity,
        operation,
        key,
      );
      const separated = await context.env.DB.prepare(
        "SELECT 1 AS found FROM device_memberships WHERE identity_id = ? AND data_space_id = ?",
      )
        .bind(identity.id, newSpaceId)
        .first<{ found: number }>();
      return separated ? context.json({ separated: true }) : null;
    },
  );
});

app.post("/api/devices/:id/remove", async (context) => {
  const identity = requireIdentity(context);
  await enforceRateLimit(context, identity, "destructive");
  await requireCountedIdempotency(context, identity, ["destructive"]);
  const publicDeviceId = context.req.param("id");
  if (!/^[0-9a-f-]{32,36}$/iu.test(publicDeviceId))
    throw new ApiError("DEVICE_NOT_FOUND", 404);
  const operation = `device:remove:${publicDeviceId}`;
  return withIdempotency(
    context,
    identity,
    operation,
    async (key) => {
      const target = await context.env.DB.prepare(
        `SELECT target.identity_id, target.data_space_id, w.version,
           (SELECT COUNT(*) FROM device_memberships x
            WHERE x.data_space_id = target.data_space_id) AS member_count
         FROM device_memberships target
         JOIN device_memberships actor
           ON actor.data_space_id = target.data_space_id
          AND actor.identity_id = ?
         JOIN data_spaces w ON w.id = target.data_space_id
         WHERE target.public_device_id = ? AND target.identity_id != ?`,
      )
        .bind(identity.id, publicDeviceId, identity.id)
        .first<{
          identity_id: string;
          data_space_id: string;
          version: number;
          member_count: number;
        }>();
      if (!target || Number(target.member_count) < 2)
        throw new ApiError("DEVICE_NOT_FOUND", 404);
      const newSpaceId = await deterministicMutationId(
        identity,
        operation,
        key,
      );
      return context.json(
        await cloneDeviceIntoPrivateSpace(
          context,
          target.identity_id,
          target.data_space_id,
          target.version,
          newSpaceId,
        ),
      );
    },
    async (key) => {
      const newSpaceId = await deterministicMutationId(
        identity,
        operation,
        key,
      );
      const separated = await context.env.DB.prepare(
        "SELECT 1 AS found FROM device_memberships WHERE public_device_id = ? AND data_space_id = ?",
      )
        .bind(publicDeviceId, newSpaceId)
        .first<{ found: number }>();
      return separated ? context.json({ separated: true }) : null;
    },
  );
});

app.delete("/api/data", async (context) => {
  const identity = context.get("identity");
  if (!identity) {
    expireIdentityCookie(context);
    return context.json({ deleted: true });
  }
  await enforceRateLimit(context, identity, "destructive");
  const membership = await context.env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM device_memberships
     WHERE data_space_id = ?`,
  )
    .bind(identity.dataSpaceId)
    .first<{ count: number }>();
  if (Number(membership?.count ?? 0) > 1)
    throw new ApiError("PAIRING_EXIT_REQUIRED", 409);
  const results = await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT OR REPLACE INTO revoked_credentials (credential_hash, expires_at)
       SELECT ?, ?
       WHERE (
         SELECT COUNT(*) FROM device_memberships WHERE data_space_id = ?
       ) = 1`,
    ).bind(
      identity.credentialHash,
      Math.max(
        identity.expiresAt,
        Date.now() + IDENTITY_MAX_AGE_SECONDS * 1000,
      ),
      identity.dataSpaceId,
    ),
    context.env.DB.prepare(
      `DELETE FROM identities
       WHERE id = ? AND credential_hash = ?
         AND (
           SELECT COUNT(*) FROM device_memberships WHERE data_space_id = ?
         ) = 1`,
    ).bind(identity.id, identity.credentialHash, identity.dataSpaceId),
    context.env.DB.prepare(
      `DELETE FROM data_spaces
       WHERE id = ? AND NOT EXISTS (
         SELECT 1 FROM device_memberships WHERE data_space_id = ?
       )`,
    ).bind(identity.dataSpaceId, identity.dataSpaceId),
  ]);
  if (!results[1].meta.changes)
    throw new ApiError("PAIRING_EXIT_REQUIRED", 409);
  expireIdentityCookie(context);
  return context.json({ deleted: true });
});

app.notFound((context) =>
  context.json({ error: { code: "NOT_FOUND", message: "NOT_FOUND" } }, 404),
);
app.onError(handleError);

export const runRetentionCleanup = async (env: Env) => {
  const now = Date.now();
  const staleIdempotency = now - 7 * 24 * 60 * 60 * 1000;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE data_spaces
       SET version = version + 1, updated_at = ?
       WHERE EXISTS (
         SELECT 1 FROM device_memberships m
         JOIN identities i ON i.id = m.identity_id
         WHERE m.data_space_id = data_spaces.id AND i.expires_at <= ?
       )`,
    ).bind(now, now),
    env.DB.prepare(
      `DELETE FROM pairing_codes
       WHERE claimed_by_identity_id IS NULL AND EXISTS (
         SELECT 1 FROM device_memberships m
         JOIN identities i ON i.id = m.identity_id
         WHERE m.data_space_id = pairing_codes.data_space_id
           AND i.expires_at <= ?
       )`,
    ).bind(now),
    env.DB.prepare("DELETE FROM identities WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      `DELETE FROM data_spaces
       WHERE NOT EXISTS (
         SELECT 1 FROM device_memberships
         WHERE device_memberships.data_space_id = data_spaces.id
       )`,
    ),
    env.DB.prepare("DELETE FROM idempotency_keys WHERE created_at <= ?").bind(
      staleIdempotency,
    ),
    env.DB.prepare(
      "DELETE FROM revoked_credentials WHERE expires_at <= ?",
    ).bind(now),
    env.DB.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?").bind(now),
  ]);
  console.log(
    JSON.stringify({
      level: "info",
      event: "retention_cleanup",
      identitiesDeleted: results[2].meta.changes,
      dataSpacesDeleted: results[3].meta.changes,
      idempotencyDeleted: results[4].meta.changes,
    }),
  );
};

export default {
  fetch: app.fetch,
  scheduled: (
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ) => {
    context.waitUntil(runRetentionCleanup(env));
  },
} satisfies ExportedHandler<Env>;
