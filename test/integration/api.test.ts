import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runRetentionCleanup } from "../../worker";
import { LIMITS, RATE_LIMITS } from "../../src/lib/constants";
import { gradeSubmission } from "../../src/lib/grading";

const base = "https://lyrics.example.test";

const request = async (
  path: string,
  init: RequestInit = {},
  cookie?: string,
) => {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  if (init.method && !["GET", "HEAD"].includes(init.method))
    headers.set("Origin", base);
  if (cookie) headers.set("Cookie", cookie);
  return SELF.fetch(`${base}${path}`, { ...init, headers });
};

const bootstrap = async (language = "en") => {
  const response = await request("/api/bootstrap", {
    headers: { "Accept-Language": language },
  });
  const setCookie = response.headers.get("set-cookie");
  expect(response.status).toBe(200);
  expect(setCookie).toContain("__Host-ld_identity=");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Lax");
  return {
    cookie: setCookie!.split(";")[0],
    response,
    body: await response.json<any>(),
  };
};

const createSong = async (
  cookie: string,
  title = "Test song",
  sourceText = "Hello, world!\n你好",
) => {
  const response = await request(
    "/api/songs",
    {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        title,
        artist: "Tester",
        sourceText,
        sourceKind: "plain",
      }),
    },
    cookie,
  );
  return { response, body: await response.json<any>() };
};

const identityIdFor = async (cookie: string) => {
  const credential = cookie.split("=")[1];
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(credential),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return (
    await env.DB.prepare("SELECT id FROM identities WHERE credential_hash = ?")
      .bind(hash)
      .first<{ id: string }>()
  )?.id;
};

const fingerprint = async (value: unknown) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

describe("Worker API with a real D1 binding", () => {
  it("paginates every historical result with a stable cursor", async () => {
    const { cookie } = await bootstrap();
    const created = await createSong(cookie, "History pages");
    const identityId = await identityIdFor(cookie);
    const songId = created.body.song.id;
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 21 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO sessions
           (id, identity_id, song_id, status, draft_text, study_text, case_sensitive,
            version, started_at, updated_at, completed_at)
           VALUES (?, ?, ?, 'completed', 'Hello world你好', 'Hello, world!\n你好', 0,
            1, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          identityId,
          songId,
          now - index,
          now - index,
          now - index,
        ),
      ),
    );

    const first = await request(`/api/songs/${songId}`, {}, cookie);
    const firstBody = await first.json<any>();
    expect(firstBody.history).toHaveLength(20);
    expect(firstBody.historyCursor).toMatch(/^\d+:[0-9a-f-]{36}$/iu);

    const second = await request(
      `/api/songs/${songId}?historyCursor=${encodeURIComponent(firstBody.historyCursor)}`,
      {},
      cookie,
    );
    const secondBody = await second.json<any>();
    expect(secondBody.history).toHaveLength(1);
    expect(secondBody.historyCursor).toBeNull();
    expect(
      new Set([
        ...firstBody.history.map((session: any) => session.id),
        ...secondBody.history.map((session: any) => session.id),
      ]).size,
    ).toBe(21);
  });

  it("issues an anonymous cookie and stores only its hash", async () => {
    const { cookie, body, response } = await bootstrap("zh-CN");
    expect(body.locale).toBe("zh-CN");
    expect(body.localeExplicit).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const rawCredential = cookie.split("=")[1];
    const row = await env.DB.prepare(
      "SELECT credential_hash FROM identities",
    ).first<{ credential_hash: string }>();
    expect(row?.credential_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(row?.credential_hash).not.toContain(rawCredential);
  });

  it("honors language preference order and quality", async () => {
    expect((await bootstrap("en-US,en;q=0.9,zh-CN;q=0.1")).body.locale).toBe(
      "en",
    );
    expect((await bootstrap("fr;q=1,zh-Hans;q=0.8,en;q=0.2")).body.locale).toBe(
      "zh-CN",
    );
    expect((await bootstrap("zh-TW")).body.locale).toBe("zh-CN");
    expect((await bootstrap("zh-HK")).body.locale).toBe("zh-CN");
    expect((await bootstrap("zh-Hant")).body.locale).toBe("zh-CN");
  });

  it("marks a locale as explicit after the user changes it", async () => {
    const initial = await bootstrap("en-US");
    expect(initial.body.localeExplicit).toBe(false);
    const changed = await request(
      "/api/settings",
      {
        method: "PATCH",
        body: JSON.stringify({ locale: "zh-CN", version: 1 }),
      },
      initial.cookie,
    );
    expect(changed.status).toBe(200);
    expect(await changed.json<any>()).toMatchObject({
      locale: "zh-CN",
      localeExplicit: true,
      version: 2,
    });
    const restored = await request("/api/bootstrap", {}, initial.cookie);
    expect(await restored.json<any>()).toMatchObject({
      locale: "zh-CN",
      localeExplicit: true,
      settingsVersion: 2,
    });
  });

  it("does not recover malformed or expired identities and renews valid ones", async () => {
    const malformed = await request(
      "/api/bootstrap",
      {},
      "__Host-ld_identity=not-a-credential",
    );
    expect(malformed.status).toBe(200);
    expect(malformed.headers.get("set-cookie")).toContain(
      "__Host-ld_identity=",
    );

    const existing = await bootstrap();
    const raw = existing.cookie.split("=")[1];
    const identityId = await identityIdFor(existing.cookie);
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE identities SET last_seen_at = ?, expires_at = ? WHERE id = ?",
    )
      .bind(now - 2 * 86_400_000, now + 86_400_000, identityId)
      .run();
    const renewed = await request("/api/bootstrap", {}, existing.cookie);
    expect(renewed.headers.get("set-cookie")).toContain(raw);

    await env.DB.prepare("UPDATE identities SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, identityId)
      .run();
    const replacement = await request("/api/bootstrap", {}, existing.cookie);
    expect(replacement.status).toBe(200);
    expect(replacement.headers.get("set-cookie")).not.toContain(raw);
    expect((await replacement.json<any>()).songs).toEqual([]);
  });

  it("enforces same-origin writes", async () => {
    const { cookie } = await bootstrap();
    const response = await SELF.fetch(`${base}/api/songs`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        title: "No origin",
        artist: "",
        sourceText: "hello",
        sourceKind: "plain",
      }),
    });
    expect(response.status).toBe(403);
    expect((await response.json<any>()).error.code).toBe("ORIGIN_MISMATCH");
  });

  it("rejects cross-site writes before creating or rotating identity", async () => {
    const existing = await bootstrap();
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM identities",
    ).first<{ count: number }>();
    const response = await SELF.fetch(`${base}/api/settings`, {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "locale=zh-CN",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json<any>()).error.code).toBe("ORIGIN_MISMATCH");
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM identities",
    ).first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
    expect(await identityIdFor(existing.cookie)).toBeDefined();
  });

  it("requires JSON and applies private security headers to errors", async () => {
    const { cookie } = await bootstrap();
    const response = await request(
      "/api/songs",
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: "not json",
      },
      cookie,
    );
    expect(response.status).toBe(415);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect((await response.json<any>()).error.code).toBe(
      "UNSUPPORTED_MEDIA_TYPE",
    );
  });

  it("rejects oversized JSON at the transport boundary and charges abuse buckets", async () => {
    const { cookie } = await bootstrap();
    const oversized = await request(
      "/api/songs",
      {
        method: "POST",
        headers: { "Idempotency-Key": "oversized-json-body" },
        body: JSON.stringify({
          title: "Oversized",
          artist: "",
          sourceText: "a".repeat(LIMITS.jsonBodyBytes),
          sourceKind: "plain",
        }),
      },
      cookie,
    );
    expect(oversized.status).toBe(413);
    expect((await oversized.json<any>()).error.code).toBe(
      "REQUEST_BODY_TOO_LARGE",
    );
    const identityId = await identityIdFor(cookie);
    const buckets = await env.DB.prepare(
      "SELECT bucket, request_count FROM rate_limits WHERE identity_id = ? ORDER BY bucket",
    )
      .bind(identityId)
      .all<{ bucket: string; request_count: number }>();
    expect(buckets.results).toEqual([
      { bucket: "import", request_count: 1 },
      { bucket: "mutation", request_count: 1 },
    ]);
  });

  it("rejects and rate-counts missing idempotency keys before parsing", async () => {
    const { cookie } = await bootstrap();
    const response = await request(
      "/api/songs",
      {
        method: "POST",
        body: JSON.stringify({
          title: "Large missing-key request",
          artist: "",
          sourceText: "a".repeat(LIMITS.sourceScalars),
          sourceKind: "plain",
        }),
      },
      cookie,
    );
    expect(response.status).toBe(400);
    expect((await response.json<any>()).error.code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    const identityId = await identityIdFor(cookie);
    const buckets = await env.DB.prepare(
      "SELECT bucket, request_count FROM rate_limits WHERE identity_id = ? ORDER BY bucket",
    )
      .bind(identityId)
      .all<{ bucket: string; request_count: number }>();
    expect(buckets.results).toEqual([
      { bucket: "import", request_count: 1 },
      { bucket: "mutation", request_count: 1 },
    ]);
  });

  it("accepts Unicode control-category whitespace as neutral lyrics", async () => {
    const { cookie } = await bootstrap();
    const response = await request(
      "/api/songs",
      {
        method: "POST",
        headers: { "Idempotency-Key": "unicode-whitespace" },
        body: JSON.stringify({
          title: "Unicode whitespace",
          artist: "",
          sourceText: "a\u000bb\u000cc\u0085d",
          sourceKind: "plain",
        }),
      },
      cookie,
    );
    expect(response.status).toBe(201);
    expect((await response.json<any>()).song.studyText).toBe(
      "a\u000bb\u000cc\u0085d",
    );
  });

  it("rate-counts malformed song-delete versions", async () => {
    const { cookie } = await bootstrap();
    const response = await request(
      "/api/songs/not-a-song?version=bad",
      {
        method: "DELETE",
        headers: { "Idempotency-Key": "bad-delete-version" },
      },
      cookie,
    );
    expect(response.status).toBe(400);
    const identityId = await identityIdFor(cookie);
    const buckets = await env.DB.prepare(
      "SELECT bucket, request_count FROM rate_limits WHERE identity_id = ? ORDER BY bucket",
    )
      .bind(identityId)
      .all<{ bucket: string; request_count: number }>();
    expect(buckets.results).toEqual([
      { bucket: "destructive", request_count: 1 },
      { bucket: "mutation", request_count: 1 },
    ]);
  });

  it("isolates songs between anonymous identities", async () => {
    const owner = await bootstrap();
    const other = await bootstrap();
    const created = await createSong(owner.cookie);
    expect(created.response.status).toBe(201);
    const leaked = await request(
      `/api/songs/${created.body.song.id}`,
      {},
      other.cookie,
    );
    expect(leaked.status).toBe(404);
    expect((await leaked.json<any>()).error.code).toBe("SONG_NOT_FOUND");
  });

  it("supports idempotent creation and optimistic conflict rejection", async () => {
    const { cookie } = await bootstrap();
    const key = crypto.randomUUID();
    const init = {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({
        title: "Idempotent",
        artist: "",
        sourceText: "hello",
        sourceKind: "plain",
      }),
    };
    const first = await request("/api/songs", init, cookie);
    const firstBody = await first.json<any>();
    const second = await request("/api/songs", init, cookie);
    const secondBody = await second.json<any>();
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(secondBody.song.id).toBe(firstBody.song.id);

    const changedIntent = await request(
      "/api/songs",
      {
        ...init,
        body: JSON.stringify({
          title: "Different payload",
          artist: "",
          sourceText: "hello",
          sourceKind: "plain",
        }),
      },
      cookie,
    );
    const changedBody = await changedIntent.json<any>();
    expect(changedIntent.status).toBe(201);
    expect(changedIntent.headers.get("idempotency-replayed")).toBeNull();
    expect(changedBody.song.id).not.toBe(firstBody.song.id);

    const stale = await request(
      `/api/songs/${firstBody.song.id}`,
      {
        method: "PUT",
        body: JSON.stringify({
          title: "Edited",
          artist: "",
          sourceText: "hello",
          sourceKind: "plain",
          version: 99,
        }),
      },
      cookie,
    );
    expect(stale.status).toBe(409);
    expect((await stale.json<any>()).error.code).toBe("VERSION_CONFLICT");
  });

  it("validates untrusted input and never stores dangerous controls", async () => {
    const { cookie } = await bootstrap();
    const response = await request(
      "/api/songs",
      {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          title: "<img src=x onerror=alert(1)>",
          artist: "<script>x</script>",
          sourceText: "safe\u202Ehidden",
          sourceKind: "plain",
        }),
      },
      cookie,
    );
    expect(response.status).toBe(400);
    expect((await response.json<any>()).error.code).toBe(
      "UNSAFE_CONTROL_CHARACTER",
    );
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS count FROM songs").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);

    const surrogate = await request(
      "/api/songs",
      {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          title: "Broken surrogate",
          artist: "",
          sourceText: "a\ud800b",
          sourceKind: "plain",
        }),
      },
      cookie,
    );
    expect(surrogate.status).toBe(400);
    expect((await surrogate.json<any>()).error.code).toBe(
      "UNSAFE_CONTROL_CHARACTER",
    );
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS count FROM songs").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
  });

  it("stores markup-shaped lyric content only as inert text", async () => {
    const { cookie } = await bootstrap();
    const title = "<img src=x onerror=alert(1)>";
    const lyrics = "<script>globalThis.pwned=true</script>";
    const created = await request(
      "/api/songs",
      {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          title,
          artist: "<b>artist</b>",
          sourceText: lyrics,
          sourceKind: "plain",
        }),
      },
      cookie,
    );
    expect(created.status).toBe(201);
    const song = (await created.json<any>()).song;
    expect(song.title).toBe(title);
    expect(song.sourceText).toBe(lyrics);
    const row = await env.DB.prepare(
      "SELECT title, source_text FROM songs WHERE id = ?",
    )
      .bind(song.id)
      .first<{ title: string; source_text: string }>();
    expect(row).toEqual({ title, source_text: lyrics });
  });

  it("enforces numeric rate-limit boundaries with Retry-After", async () => {
    const allowed = await bootstrap();
    const allowedIdentityId = await identityIdFor(allowed.cookie);
    await env.DB.prepare(
      "INSERT INTO rate_limits (identity_id, bucket, window_started_at, request_count) VALUES (?, 'mutation', ?, ?)",
    )
      .bind(allowedIdentityId, Date.now(), RATE_LIMITS.mutation.limit - 1)
      .run();
    const boundary = await request(
      "/api/settings",
      {
        method: "PATCH",
        body: JSON.stringify({ locale: "zh-CN", version: 1 }),
      },
      allowed.cookie,
    );
    expect(boundary.status).toBe(200);

    const limited = await bootstrap();
    const limitedIdentityId = await identityIdFor(limited.cookie);
    await env.DB.prepare(
      "INSERT INTO rate_limits (identity_id, bucket, window_started_at, request_count) VALUES (?, 'mutation', ?, ?)",
    )
      .bind(limitedIdentityId, Date.now(), RATE_LIMITS.mutation.limit)
      .run();
    const rejected = await request(
      "/api/settings",
      {
        method: "PATCH",
        body: JSON.stringify({ locale: "zh-CN", version: 1 }),
      },
      limited.cookie,
    );
    expect(rejected.status).toBe(429);
    expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await rejected.json<any>()).error.code).toBe("RATE_LIMITED");
  });

  it("creates, autosaves, completes, and cascades a session", async () => {
    const { cookie } = await bootstrap();
    const created = await createSong(cookie);
    const song = created.body.song;
    const started = await request(
      `/api/songs/${song.id}/sessions`,
      {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ restart: false, caseSensitive: false }),
      },
      cookie,
    );
    const session = (await started.json<any>()).session;
    const saved = await request(
      `/api/sessions/${session.id}`,
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "session-save-0001" },
        body: JSON.stringify({
          version: session.version,
          draftText: "Hxllo",
          action: "save",
        }),
      },
      cookie,
    );
    const savedBody = await saved.json<any>();
    expect(savedBody.session.draftText).toBe("Hxllo");
    expect(savedBody.session.status).toBe("in_progress");
    const identityId = await identityIdFor(cookie);
    await env.DB.prepare(
      "UPDATE idempotency_keys SET status = 0, response_json = '' WHERE identity_id = ? AND key = ?",
    )
      .bind(identityId, "session-save-0001")
      .run();
    const replayedSave = await request(
      `/api/sessions/${session.id}`,
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "session-save-0001" },
        body: JSON.stringify({
          version: session.version,
          draftText: "Hxllo",
          action: "save",
        }),
      },
      cookie,
    );
    expect(replayedSave.headers.get("idempotency-replayed")).toBe("true");
    expect((await replayedSave.json<any>()).session.version).toBe(
      savedBody.session.version,
    );

    const completed = await request(
      `/api/sessions/${session.id}`,
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "session-complete-0001" },
        body: JSON.stringify({
          version: savedBody.session.version,
          draftText: "Hello world 你好",
          action: "complete",
        }),
      },
      cookie,
    );
    expect(completed.status).toBe(200);
    expect((await completed.json<any>()).session.status).toBe("completed");
    const detail = await request(`/api/songs/${song.id}`, {}, cookie);
    const detailBody = await detail.json<any>();
    expect(detailBody.history).toHaveLength(1);
    expect(detailBody.history[0].status).toBe("completed");

    const removed = await request(
      `/api/songs/${song.id}?version=${song.version}`,
      { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } },
      cookie,
    );
    expect(removed.status).toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
  });

  it("returns one stable active session for concurrent starts", async () => {
    const { cookie } = await bootstrap();
    const created = await createSong(cookie, "Concurrent start");
    const path = `/api/songs/${created.body.song.id}/sessions`;
    const [first, second] = await Promise.all([
      request(
        path,
        {
          method: "POST",
          headers: { "Idempotency-Key": "concurrent-start-a" },
          body: JSON.stringify({ restart: false, caseSensitive: false }),
        },
        cookie,
      ),
      request(
        path,
        {
          method: "POST",
          headers: { "Idempotency-Key": "concurrent-start-b" },
          body: JSON.stringify({ restart: false, caseSensitive: false }),
        },
        cookie,
      ),
    ]);
    expect([200, 201]).toContain(first.status);
    expect([200, 201]).toContain(second.status);
    const firstBody = await first.json<any>();
    const secondBody = await second.json<any>();
    expect(firstBody.session.id).toBe(secondBody.session.id);
  });

  it("handles concurrent forced restarts and leaves one active session", async () => {
    const { cookie } = await bootstrap();
    const created = await createSong(cookie, "Concurrent restart");
    const path = `/api/songs/${created.body.song.id}/sessions`;
    const initial = await request(
      path,
      {
        method: "POST",
        headers: { "Idempotency-Key": "initial-session-start" },
        body: JSON.stringify({ restart: false, caseSensitive: false }),
      },
      cookie,
    );
    expect(initial.status).toBe(201);

    const responses = await Promise.all([
      request(
        path,
        {
          method: "POST",
          headers: { "Idempotency-Key": "concurrent-restart-a" },
          body: JSON.stringify({ restart: true, caseSensitive: false }),
        },
        cookie,
      ),
      request(
        path,
        {
          method: "POST",
          headers: { "Idempotency-Key": "concurrent-restart-b" },
          body: JSON.stringify({ restart: true, caseSensitive: false }),
        },
        cookie,
      ),
      request(
        path,
        {
          method: "POST",
          headers: { "Idempotency-Key": "concurrent-restart-c" },
          body: JSON.stringify({ restart: true, caseSensitive: false }),
        },
        cookie,
      ),
    ]);
    responses.forEach((response) =>
      expect([200, 201]).toContain(response.status),
    );
    const bodies = await Promise.all(
      responses.map((response) => response.json<any>()),
    );
    expect(new Set(bodies.map((body) => body.session.id)).size).toBe(1);
    const active = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE song_id = ? AND status = 'in_progress'",
    )
      .bind(created.body.song.id)
      .first<{ count: number }>();
    expect(active?.count).toBe(1);
    const activeId = await env.DB.prepare(
      "SELECT id FROM sessions WHERE song_id = ? AND status = 'in_progress'",
    )
      .bind(created.body.song.id)
      .first<{ id: string }>();
    expect(bodies[0].session.id).toBe(activeId?.id);
  });

  it("does not let a concurrent resume swallow a forced restart", async () => {
    const { cookie } = await bootstrap();
    const created = await createSong(cookie, "Resume restart overlap");
    const path = `/api/songs/${created.body.song.id}/sessions`;
    const initialResponse = await request(
      path,
      {
        method: "POST",
        headers: { "Idempotency-Key": "resume-restart-initial" },
        body: JSON.stringify({ restart: false, caseSensitive: false }),
      },
      cookie,
    );
    const initial = (await initialResponse.json<any>()).session;
    const resumedPromise = request(
      path,
      {
        method: "POST",
        headers: { "Idempotency-Key": "resume-restart-resume" },
        body: JSON.stringify({ restart: false, caseSensitive: false }),
      },
      cookie,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const restartedPromise = request(
      path,
      {
        method: "POST",
        headers: { "Idempotency-Key": "resume-restart-restart" },
        body: JSON.stringify({ restart: true, caseSensitive: false }),
      },
      cookie,
    );
    const [resumed, restarted] = await Promise.all([
      resumedPromise,
      restartedPromise,
    ]);
    expect(resumed.status).toBe(200);
    expect((await resumed.json<any>()).session.id).toBe(initial.id);
    expect(restarted.status).toBe(201);
    const restartedBody = await restarted.json<any>();
    expect(restartedBody.session.id).not.toBe(initial.id);
    const oldResponse = await request(
      `/api/sessions/${initial.id}`,
      {},
      cookie,
    );
    expect((await oldResponse.json<any>()).session.status).not.toBe(
      "in_progress",
    );
  });

  it("submits an incomplete dictation with bounded final counts", async () => {
    const { cookie } = await bootstrap();
    const created = await createSong(
      cookie,
      "Distributed submission errors",
      "abcXdefYghi",
    );
    const started = await request(
      `/api/songs/${created.body.song.id}/sessions`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "abandon-counts-start" },
        body: JSON.stringify({ restart: false, caseSensitive: false }),
      },
      cookie,
    );
    const session = (await started.json<any>()).session;
    const submitted = await request(
      `/api/sessions/${session.id}`,
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "abandon-counts-end" },
        body: JSON.stringify({
          version: session.version,
          draftText: "abcZdefWghi",
          action: "complete",
        }),
      },
      cookie,
    );
    expect(submitted.status).toBe(200);
    const body = await submitted.json<any>();
    expect(body.session.status).toBe("completed");
    expect(body.session.completedAt).not.toBeNull();
    expect(body.session.correctCount).toBe(9);
    expect(body.session.incorrectCount).toBe(2);
    expect(body.grade).toMatchObject({ correct: 9, incorrect: 2 });
    const detail = await request(
      `/api/songs/${created.body.song.id}`,
      {},
      cookie,
    );
    expect((await detail.json<any>()).song).toMatchObject({
      practiceSessions: 1,
      completedSessions: 1,
      latestAccuracy: 82,
    });
  });

  it("keeps the legacy abandon response compatible with an already-open UI", async () => {
    const { cookie } = await bootstrap();
    const created = await createSong(cookie, "Legacy submit");
    const started = await request(
      `/api/songs/${created.body.song.id}/sessions`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "legacy-submit-start" },
        body: JSON.stringify({ restart: false, caseSensitive: false }),
      },
      cookie,
    );
    const session = (await started.json<any>()).session;
    const submitted = await request(
      `/api/sessions/${session.id}`,
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "legacy-submit-end" },
        body: JSON.stringify({
          version: session.version,
          draftText: "Hello",
          action: "abandon",
        }),
      },
      cookie,
    );
    expect(submitted.status).toBe(200);
    expect((await submitted.json<any>()).session).toMatchObject({
      status: "abandoned",
      correctCount: 5,
      missingCount: 7,
    });
  });

  it("submits drafts with aggregates during forced restart and lyric edit", async () => {
    const { cookie } = await bootstrap();
    const created = await createSong(cookie, "Implicit abandon counts");
    const path = `/api/songs/${created.body.song.id}/sessions`;
    const started = await request(
      path,
      {
        method: "POST",
        headers: { "Idempotency-Key": "implicit-abandon-start" },
        body: JSON.stringify({ restart: false, caseSensitive: false }),
      },
      cookie,
    );
    const first = (await started.json<any>()).session;
    await request(
      `/api/sessions/${first.id}`,
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "implicit-abandon-save" },
        body: JSON.stringify({
          version: first.version,
          draftText: "Hello",
          action: "save",
        }),
      },
      cookie,
    );
    const restarted = await request(
      path,
      {
        method: "POST",
        headers: { "Idempotency-Key": "implicit-abandon-restart" },
        body: JSON.stringify({ restart: true, caseSensitive: false }),
      },
      cookie,
    );
    expect(restarted.status).toBe(201);
    const oldAfterRestart = await request(
      `/api/sessions/${first.id}`,
      {},
      cookie,
    );
    expect(await oldAfterRestart.json<any>()).toMatchObject({
      session: { status: "abandoned", correctCount: 5, missingCount: 7 },
    });

    const second = (await restarted.json<any>()).session;
    await request(
      `/api/sessions/${second.id}`,
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "implicit-edit-save" },
        body: JSON.stringify({
          version: second.version,
          draftText: "Hello",
          action: "save",
        }),
      },
      cookie,
    );
    const edited = await request(
      `/api/songs/${created.body.song.id}`,
      {
        method: "PUT",
        body: JSON.stringify({
          title: "Edited after draft",
          artist: "Tester",
          sourceText: "A completely different lyric",
          sourceKind: "plain",
          version: created.body.song.version,
        }),
      },
      cookie,
    );
    expect(edited.status).toBe(200);
    const oldAfterEdit = await request(
      `/api/sessions/${second.id}`,
      {},
      cookie,
    );
    expect(await oldAfterEdit.json<any>()).toMatchObject({
      session: { status: "abandoned", correctCount: 5, missingCount: 7 },
      studyText: "Hello, world!\n你好",
    });
  });

  it("keeps a submitted draft consistent when autosave races restart", async () => {
    const { cookie } = await bootstrap();
    const created = await createSong(cookie, "Restart race");
    const path = `/api/songs/${created.body.song.id}/sessions`;
    const started = await request(
      path,
      {
        method: "POST",
        headers: { "Idempotency-Key": "restart-race-start" },
        body: JSON.stringify({ restart: false, caseSensitive: false }),
      },
      cookie,
    );
    const initial = (await started.json<any>()).session;
    const firstSave = await request(
      `/api/sessions/${initial.id}`,
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "restart-race-first-save" },
        body: JSON.stringify({
          version: initial.version,
          draftText: "Hello",
          action: "save",
        }),
      },
      cookie,
    );
    const saved = (await firstSave.json<any>()).session;
    const [racingSave, restarted] = await Promise.all([
      request(
        `/api/sessions/${initial.id}`,
        {
          method: "PATCH",
          headers: { "Idempotency-Key": "restart-race-second-save" },
          body: JSON.stringify({
            version: saved.version,
            draftText: "Hello world",
            action: "save",
          }),
        },
        cookie,
      ),
      request(
        path,
        {
          method: "POST",
          headers: { "Idempotency-Key": "restart-race-restart" },
          body: JSON.stringify({ restart: true, caseSensitive: false }),
        },
        cookie,
      ),
    ]);
    expect([200, 409]).toContain(racingSave.status);
    expect(restarted.status).toBe(201);
    const restartedBody = await restarted.json<any>();
    const oldResponse = await request(
      `/api/sessions/${initial.id}`,
      {},
      cookie,
    );
    const old = (await oldResponse.json<any>()).session;
    const expected = gradeSubmission(
      "Hello, world!\n你好",
      old.draftText,
      false,
    );
    expect(old).toMatchObject({
      status: expected.complete ? "completed" : "abandoned",
      correctCount: expected.correct,
      incorrectCount: expected.incorrect,
      extraCount: expected.extra,
      missingCount: expected.missing,
    });
    const replay = await request(
      path,
      {
        method: "POST",
        headers: { "Idempotency-Key": "restart-race-restart" },
        body: JSON.stringify({ restart: true, caseSensitive: false }),
      },
      cookie,
    );
    expect(replay.status).toBe(201);
    expect((await replay.json<any>()).session.id).toBe(
      restartedBody.session.id,
    );
  });

  it("never mixes a stale draft with fresh counts when autosave races lyric editing", async () => {
    const { cookie } = await bootstrap();
    const created = await createSong(cookie, "Edit race");
    const started = await request(
      `/api/songs/${created.body.song.id}/sessions`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "edit-race-start" },
        body: JSON.stringify({ restart: false, caseSensitive: false }),
      },
      cookie,
    );
    const initial = (await started.json<any>()).session;
    const firstSave = await request(
      `/api/sessions/${initial.id}`,
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "edit-race-first-save" },
        body: JSON.stringify({
          version: initial.version,
          draftText: "Hello",
          action: "save",
        }),
      },
      cookie,
    );
    const saved = (await firstSave.json<any>()).session;
    const [racingSave, edited] = await Promise.all([
      request(
        `/api/sessions/${initial.id}`,
        {
          method: "PATCH",
          headers: { "Idempotency-Key": "edit-race-second-save" },
          body: JSON.stringify({
            version: saved.version,
            draftText: "Hello world",
            action: "save",
          }),
        },
        cookie,
      ),
      request(
        `/api/songs/${created.body.song.id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            title: "Edited race",
            artist: "Tester",
            sourceText: "New lyric",
            sourceKind: "plain",
            version: created.body.song.version,
          }),
        },
        cookie,
      ),
    ]);
    expect([200, 409]).toContain(racingSave.status);
    expect([200, 409]).toContain(edited.status);
    expect([racingSave.status, edited.status]).toContain(200);
    const oldResponse = await request(
      `/api/sessions/${initial.id}`,
      {},
      cookie,
    );
    const old = (await oldResponse.json<any>()).session;
    if (old.status !== "in_progress") {
      const expected = gradeSubmission(
        "Hello, world!\n你好",
        old.draftText,
        false,
      );
      expect(old).toMatchObject({
        status: expected.complete ? "completed" : "abandoned",
        correctCount: expected.correct,
        incorrectCount: expected.incorrect,
        extraCount: expected.extra,
        missingCount: expected.missing,
      });
    }
  });

  it("never replays an old active session for an uncommitted forced restart", async () => {
    const { cookie } = await bootstrap();
    const created = await createSong(cookie, "Restart reservation");
    const songId = created.body.song.id;
    const path = `/api/songs/${songId}/sessions`;
    const initial = await request(
      path,
      {
        method: "POST",
        headers: { "Idempotency-Key": "restart-reservation-initial" },
        body: JSON.stringify({ restart: false, caseSensitive: false }),
      },
      cookie,
    );
    const oldSession = (await initial.json<any>()).session;
    const identityId = await identityIdFor(cookie);
    const input = { restart: true, caseSensitive: false };
    const operation = `session:start:${songId}:${await fingerprint(input)}`;
    await env.DB.prepare(
      "INSERT INTO idempotency_keys (identity_id, operation, key, status, response_json, created_at) VALUES (?, ?, ?, 0, '', ?)",
    )
      .bind(identityId, operation, "restart-reservation-key", Date.now())
      .run();

    const replay = await request(
      path,
      {
        method: "POST",
        headers: { "Idempotency-Key": "restart-reservation-key" },
        body: JSON.stringify(input),
      },
      cookie,
    );
    expect(replay.status).toBe(409);
    expect((await replay.json<any>()).error.code).toBe(
      "IDEMPOTENCY_IN_PROGRESS",
    );
    const active = await env.DB.prepare(
      "SELECT id FROM sessions WHERE song_id = ? AND status = 'in_progress'",
    )
      .bind(songId)
      .first<{ id: string }>();
    expect(active?.id).toBe(oldSession.id);
  });

  it("stores normalized drafts without grading maximum divergent saves", async () => {
    const { cookie } = await bootstrap();
    const sourceText = `${"a".repeat(1_999)}\n`.repeat(50);
    const createdResponse = await request(
      "/api/songs",
      {
        method: "POST",
        headers: { "Idempotency-Key": "maximum-song-create" },
        body: JSON.stringify({
          title: "Maximum",
          artist: "",
          sourceText,
          sourceKind: "plain",
        }),
      },
      cookie,
    );
    expect(createdResponse.status).toBe(201);
    const song = (await createdResponse.json<any>()).song;
    const started = await request(
      `/api/songs/${song.id}/sessions`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "maximum-session-start" },
        body: JSON.stringify({ restart: false, caseSensitive: true }),
      },
      cookie,
    );
    const session = (await started.json<any>()).session;
    const saved = await request(
      `/api/sessions/${session.id}`,
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "maximum-session-save" },
        body: JSON.stringify({
          version: session.version,
          draftText: `${"b".repeat(99_999)}\r`,
          action: "save",
        }),
      },
      cookie,
    );
    expect(saved.status).toBe(200);
    expect((await saved.json<any>()).session.draftText.endsWith("\n")).toBe(
      true,
    );
  });

  it("deletes all data, expires the cookie, and is safe to retry", async () => {
    const { cookie } = await bootstrap();
    await createSong(cookie);
    const identityId = await identityIdFor(cookie);
    await env.DB.prepare("UPDATE identities SET last_seen_at = ? WHERE id = ?")
      .bind(Date.now() - 2 * 86_400_000, identityId)
      .run();
    const first = await request("/api/data", { method: "DELETE" }, cookie);
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(first.headers.get("set-cookie")).not.toMatch(/Max-Age=[1-9]/u);

    const trailing = await request(
      "/api/songs",
      {
        method: "POST",
        headers: { "Idempotency-Key": "post-delete-race" },
        body: JSON.stringify({
          title: "Must not return",
          artist: "",
          sourceText: "deleted",
          sourceKind: "plain",
        }),
      },
      cookie,
    );
    expect(trailing.status).toBe(404);
    expect((await trailing.json<any>()).error.code).toBe("IDENTITY_NOT_FOUND");
    expect(trailing.headers.get("set-cookie")).toContain("Max-Age=0");

    const second = await request("/api/data", { method: "DELETE" }, cookie);
    expect(second.status).toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS count FROM identities").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS count FROM songs").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM revoked_credentials",
        ).first<{ count: number }>()
      )?.count,
    ).toBe(1);
    const revocation = await env.DB.prepare(
      "SELECT expires_at FROM revoked_credentials",
    ).first<{ expires_at: number }>();
    expect(revocation!.expires_at).toBeGreaterThan(
      Date.now() + 364 * 24 * 60 * 60 * 1000,
    );
  });

  it("purges expired identities and their dependent records", async () => {
    const { cookie } = await bootstrap();
    await createSong(cookie);
    await env.DB.prepare("UPDATE identities SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    await env.DB.prepare(
      "INSERT INTO revoked_credentials (credential_hash, expires_at) VALUES (?, ?)",
    )
      .bind("expired-revocation", Date.now() - 1)
      .run();
    await runRetentionCleanup(env);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS count FROM identities").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS count FROM songs").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM revoked_credentials",
        ).first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });
});
