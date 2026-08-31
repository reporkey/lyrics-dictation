import { Hono, type Context } from "hono";
import { IDENTITY_MAX_AGE_SECONDS } from "../src/lib/constants";
import { gradeSubmission, projectJudgedText } from "../src/lib/grading";
import { parseLyrics } from "../src/lib/lyrics";
import type { BootstrapPayload } from "../src/lib/types";
import {
  parseJson,
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

const songSelect = `
  SELECT s.*,
    (SELECT id FROM sessions x WHERE x.song_id = s.id AND x.identity_id = s.identity_id AND x.status = 'in_progress' LIMIT 1) AS active_session_id,
    (SELECT COUNT(*) FROM sessions x WHERE x.song_id = s.id AND x.identity_id = s.identity_id AND x.status != 'in_progress') AS practice_sessions,
    (SELECT COUNT(*) FROM sessions x WHERE x.song_id = s.id AND x.identity_id = s.identity_id AND x.status = 'completed') AS completed_sessions,
    (SELECT CASE
       WHEN x.correct_count + x.incorrect_count + x.extra_count + x.missing_count = 0 THEN 0
       ELSE CAST(ROUND(
         100.0 * x.correct_count /
         (x.correct_count + x.incorrect_count + x.extra_count + x.missing_count)
       ) AS INTEGER)
     END
     FROM sessions x
     WHERE x.song_id = s.id AND x.identity_id = s.identity_id AND x.status != 'in_progress'
     ORDER BY COALESCE(x.completed_at, x.updated_at) DESC, x.id DESC
     LIMIT 1) AS latest_accuracy
  FROM songs s`;

const requireIdentity = (context: AppContext): IdentityRecord => {
  const identity = context.get("identity");
  if (!identity) throw new ApiError("IDENTITY_NOT_FOUND", 404);
  return identity;
};

const persistMissingCharacterCounts = async (
  database: D1Database,
  identityId: string,
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
             WHERE id = ? AND identity_id = ? AND study_text = ? AND character_count IS NULL`,
          )
          .bind(song.character_count, song.id, identityId, song.study_text),
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
  const deadline = Date.now() + 1_000;
  const now = Date.now();
  const acquired = await context.env.DB.prepare(
    `INSERT INTO session_start_locks
       (song_id, owner_key, expires_at, intent_restart, result_session_id)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(song_id) DO UPDATE SET
       owner_key = excluded.owner_key,
       expires_at = excluded.expires_at,
       intent_restart = excluded.intent_restart,
       result_session_id = NULL
     WHERE session_start_locks.expires_at <= ?`,
  )
    .bind(songId, key, now + 5_000, restart ? 1 : 0, now)
    .run();
  if (acquired.meta.changes) return { owned: true };
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    const lock = await context.env.DB.prepare(
      `SELECT owner_key, intent_restart, result_session_id
       FROM session_start_locks WHERE song_id = ?`,
    )
      .bind(songId)
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
  await context.env.DB.prepare(
    `UPDATE session_start_locks SET result_session_id = ?
     WHERE song_id = ? AND owner_key = ?`,
  )
    .bind(sessionId, songId, key)
    .run();
};

const releaseSessionStartLock = async (
  context: AppContext,
  songId: string,
  key: string,
) => {
  await context.env.DB.prepare(
    "DELETE FROM session_start_locks WHERE song_id = ? AND owner_key = ?",
  )
    .bind(songId, key)
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
  const [settings, songs, sessions] = await Promise.all([
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
      `${songSelect} WHERE s.identity_id = ? ORDER BY s.updated_at DESC`,
    )
      .bind(identity.id)
      .all<SongRow>(),
    context.env.DB.prepare(
      `SELECT x.*, s.title AS song_title FROM sessions x
       JOIN songs s ON s.id = x.song_id AND s.identity_id = x.identity_id
       WHERE x.identity_id = ? AND x.status != 'in_progress'
       ORDER BY COALESCE(x.completed_at, x.updated_at) DESC LIMIT 10`,
    )
      .bind(identity.id)
      .all<SessionRow>(),
  ]);
  await persistMissingCharacterCounts(
    context.env.DB,
    identity.id,
    songs.results,
  );
  const payload: BootstrapPayload = {
    locale: settings?.locale ?? "en",
    localeExplicit: settings?.locale_explicit === 1,
    settingsVersion: settings?.version ?? 1,
    songs: songs.results.map(toSongSummary),
    recentSessions: sessions.results.map(toRecent),
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
        `${songSelect} WHERE s.identity_id = ? AND s.id = ?`,
      )
        .bind(identity.id, id)
        .first<SongRow>();
      if (existing) return context.json({ song: toSong(existing) }, 201);
      await context.env.DB.prepare(
        `INSERT INTO songs
       (id, identity_id, title, artist, source_text, study_text, character_count, source_kind, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
        .bind(
          id,
          identity.id,
          input.title,
          input.artist,
          parsed.sourceText,
          parsed.studyText,
          projectJudgedText(parsed.studyText, true).count,
          input.sourceKind,
          now,
          now,
        )
        .run();
      const row = await context.env.DB.prepare(
        `${songSelect} WHERE s.identity_id = ? AND s.id = ?`,
      )
        .bind(identity.id, id)
        .first<SongRow>();
      return context.json({ song: toSong(row!) }, 201);
    },
    async (key) => {
      const id = await deterministicMutationId(identity, operation, key);
      const row = await context.env.DB.prepare(
        `${songSelect} WHERE s.identity_id = ? AND s.id = ?`,
      )
        .bind(identity.id, id)
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
    context.env.DB.prepare(`${songSelect} WHERE s.identity_id = ? AND s.id = ?`)
      .bind(identity.id, context.req.param("id"))
      .first<SongRow>(),
    context.env.DB.prepare(
      `SELECT x.*, s.title AS song_title FROM sessions x
       JOIN songs s ON s.id = x.song_id AND s.identity_id = x.identity_id
       WHERE x.identity_id = ? AND x.song_id = ? AND x.status != 'in_progress'
         AND (x.updated_at < ? OR (x.updated_at = ? AND x.id < ?))
       ORDER BY x.updated_at DESC, x.id DESC LIMIT 21`,
    )
      .bind(
        identity.id,
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
     JOIN songs s ON s.id = x.song_id AND s.identity_id = x.identity_id
     WHERE x.identity_id = ? AND x.status != 'in_progress'
       AND (x.updated_at < ? OR (x.updated_at = ? AND x.id < ?))
     ORDER BY x.updated_at DESC, x.id DESC LIMIT 21`,
  )
    .bind(identity.id, beforeUpdatedAt, beforeUpdatedAt, beforeId)
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
     JOIN songs s ON s.id = x.song_id AND s.identity_id = x.identity_id
     WHERE x.song_id = ? AND x.identity_id = ? AND x.status = 'in_progress'`,
  )
    .bind(context.req.param("id"), identity.id)
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
     WHERE id = ? AND identity_id = ? AND version = ?
       AND NOT EXISTS (
         SELECT 1 FROM sessions
         WHERE song_id = ? AND identity_id = ? AND status = 'in_progress'
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
    identity.id,
    input.version,
    songId,
    identity.id,
  );
  const statements: D1PreparedStatement[] = [];
  if (active) {
    statements.push(
      context.env.DB.prepare(
        `UPDATE sessions SET status = ?, correct_count = ?, incorrect_count = ?,
           extra_count = ?, missing_count = ?, updated_at = ?, completed_at = ?, version = version + 1
         WHERE id = ? AND song_id = ? AND identity_id = ? AND version = ? AND status = 'in_progress'
           AND EXISTS (
             SELECT 1 FROM songs WHERE id = ? AND identity_id = ? AND version = ?
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
        identity.id,
        active.version,
        songId,
        identity.id,
        input.version,
      ),
    );
  }
  statements.push(update);
  const results = await context.env.DB.batch(statements);
  const result = results.at(-1)!;
  if (!result.meta.changes) throw new ApiError("VERSION_CONFLICT", 409);
  const row = await context.env.DB.prepare(
    `${songSelect} WHERE s.identity_id = ? AND s.id = ?`,
  )
    .bind(identity.id, context.req.param("id"))
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
        "DELETE FROM songs WHERE id = ? AND identity_id = ? AND version = ?",
      )
        .bind(songId, identity.id, version)
        .run();
      if (!result.meta.changes) throw new ApiError("VERSION_CONFLICT", 409);
      return context.json({ deleted: true });
    },
    async () => {
      const row = await context.env.DB.prepare(
        "SELECT id FROM songs WHERE id = ? AND identity_id = ?",
      )
        .bind(songId, identity.id)
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
            "SELECT * FROM sessions WHERE id = ? AND song_id = ? AND identity_id = ? AND status = 'in_progress'",
          )
            .bind(lock.resultSessionId, songId, identity.id)
            .first<SessionRow>();
          if (concurrent)
            return context.json({ session: toSession(concurrent) });
        }
        const exists = await context.env.DB.prepare(
          "SELECT 1 AS found FROM songs WHERE id = ? AND identity_id = ?",
        )
          .bind(songId, identity.id)
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
          "SELECT * FROM sessions WHERE id = ? AND identity_id = ?",
        )
          .bind(id, identity.id)
          .first<SessionRow>();
        if (existingByKey) {
          lockResultSessionId = existingByKey.id;
          return context.json({ session: toSession(existingByKey) }, 201);
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const song = await context.env.DB.prepare(
            "SELECT id, study_text, version FROM songs WHERE id = ? AND identity_id = ?",
          )
            .bind(songId, identity.id)
            .first<{ id: string; study_text: string; version: number }>();
          if (!song) throw new ApiError("SONG_NOT_FOUND", 404);
          const active = await context.env.DB.prepare(
            "SELECT * FROM sessions WHERE song_id = ? AND identity_id = ? AND status = 'in_progress'",
          )
            .bind(song.id, identity.id)
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
                 WHERE id = ? AND identity_id = ? AND version = ? AND status = 'in_progress'
                   AND EXISTS (
                     SELECT 1 FROM songs WHERE id = ? AND identity_id = ? AND version = ?
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
                identity.id,
                active.version,
                song.id,
                identity.id,
                song.version,
              ),
            );
          }
          statements.push(
            context.env.DB.prepare(
              `INSERT INTO sessions
               (id, identity_id, song_id, status, draft_text, study_text, case_sensitive, version, started_at, updated_at)
               SELECT ?, ?, s.id, 'in_progress', '', s.study_text, ?, 1, ?, ?
               FROM songs s
               WHERE s.id = ? AND s.identity_id = ? AND s.version = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM sessions
                   WHERE song_id = s.id AND identity_id = s.identity_id AND status = 'in_progress'
                 )`,
            ).bind(
              id,
              identity.id,
              input.caseSensitive ? 1 : 0,
              now,
              now,
              song.id,
              identity.id,
              song.version,
            ),
          );
          const results = await context.env.DB.batch(statements);
          if (results.at(-1)?.meta.changes) {
            const row = await context.env.DB.prepare(
              "SELECT * FROM sessions WHERE id = ? AND identity_id = ?",
            )
              .bind(id, identity.id)
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
        "SELECT * FROM sessions WHERE id = ? AND identity_id = ?",
      )
        .bind(id, identity.id)
        .first<SessionRow>();
      if (row) return context.json({ session: toSession(row) }, 201);
      if (input.restart) return null;
      const active = await context.env.DB.prepare(
        "SELECT * FROM sessions WHERE song_id = ? AND identity_id = ? AND status = 'in_progress'",
      )
        .bind(songId, identity.id)
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
     JOIN songs s ON s.id = x.song_id AND s.identity_id = x.identity_id
     WHERE x.id = ? AND x.identity_id = ?`,
  )
    .bind(context.req.param("id"), identity.id)
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
         JOIN songs s ON s.id = x.song_id AND s.identity_id = x.identity_id
         WHERE x.id = ? AND x.identity_id = ?`,
      )
        .bind(sessionId, identity.id)
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
         WHERE id = ? AND identity_id = ? AND version = ? AND status = 'in_progress'
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
          identity.id,
          input.version,
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
        "SELECT * FROM sessions WHERE id = ? AND identity_id = ?",
      )
        .bind(sessionId, identity.id)
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

app.delete("/api/data", async (context) => {
  const identity = context.get("identity");
  if (!identity) {
    expireIdentityCookie(context);
    return context.json({ deleted: true });
  }
  await enforceRateLimit(context, identity, "destructive");
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT OR REPLACE INTO revoked_credentials (credential_hash, expires_at) VALUES (?, ?)",
    ).bind(
      identity.credentialHash,
      Math.max(
        identity.expiresAt,
        Date.now() + IDENTITY_MAX_AGE_SECONDS * 1000,
      ),
    ),
    context.env.DB.prepare(
      "DELETE FROM identities WHERE id = ? AND credential_hash = ?",
    ).bind(identity.id, identity.credentialHash),
  ]);
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
    env.DB.prepare("DELETE FROM identities WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM idempotency_keys WHERE created_at <= ?").bind(
      staleIdempotency,
    ),
    env.DB.prepare(
      "DELETE FROM revoked_credentials WHERE expires_at <= ?",
    ).bind(now),
  ]);
  console.log(
    JSON.stringify({
      level: "info",
      event: "retention_cleanup",
      identitiesDeleted: results[0].meta.changes,
      idempotencyDeleted: results[1].meta.changes,
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
