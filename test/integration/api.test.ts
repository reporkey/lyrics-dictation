import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runRetentionCleanup } from "../../worker";
import { LIMITS, RATE_LIMITS, SPACE_LIMITS } from "../../src/lib/constants";
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
  if (cookie) {
    headers.set("Cookie", cookie);
    if (
      init.method &&
      !["GET", "HEAD"].includes(init.method) &&
      !headers.has("X-Recovery-Namespace")
    ) {
      const namespace = await recoveryNamespaceFor(cookie);
      if (namespace) headers.set("X-Recovery-Namespace", namespace);
    }
  }
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

const dataSpaceIdFor = async (cookie: string) => {
  const identityId = await identityIdFor(cookie);
  return (
    await env.DB.prepare(
      "SELECT data_space_id FROM device_memberships WHERE identity_id = ?",
    )
      .bind(identityId)
      .first<{ data_space_id: string }>()
  )?.data_space_id;
};

const recoveryNamespaceFor = async (cookie: string) => {
  const identityId = await identityIdFor(cookie);
  if (!identityId) return undefined;
  return (
    await env.DB.prepare(
      "SELECT recovery_namespace FROM device_memberships WHERE identity_id = ?",
    )
      .bind(identityId)
      .first<{ recovery_namespace: string }>()
  )?.recovery_namespace;
};

const pairingCodeFor = async (cookie: string) => {
  const response = await request(
    "/api/devices/pairing-code",
    { method: "POST" },
    cookie,
  );
  expect(response.status).toBe(200);
  return (await response.json<{ code: string }>()).code;
};

const joinPairingCode = (
  cookie: string,
  code: string,
  confirmReplace: boolean,
  key: string = crypto.randomUUID(),
) =>
  request(
    "/api/devices/join",
    {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ code, confirmReplace }),
    },
    cookie,
  );

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
  it("checks D1 health without creating an identity", async () => {
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM identities",
    ).first<{ count: number }>();

    const response = await request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("x-worker-commit")).toBe("development");
    expect(response.headers.get("set-cookie")).toBeNull();

    const head = await request("/healthz", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("set-cookie")).toBeNull();

    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM identities",
    ).first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it("edge-limits health checks before querying D1", async () => {
    const address = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const allowed = await request("/healthz", {
        headers: { "CF-Connecting-IP": address },
      });
      expect(allowed.status).toBe(200);
    }
    const rejected = await request("/healthz", {
      headers: { "CF-Connecting-IP": address },
    });
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("60");
    expect(await rejected.text()).toBe("rate limited");
  });

  it("paginates every historical result with a stable cursor", async () => {
    const { cookie } = await bootstrap();
    const firstSong = await createSong(cookie, "History pages A");
    const secondSong = await createSong(cookie, "History pages B");
    const dataSpaceId = await dataSpaceIdFor(cookie);
    const songIds = [firstSong.body.song.id, secondSong.body.song.id];
    const other = await bootstrap();
    const otherSong = await createSong(other.cookie, "Other user's history");
    const otherDataSpaceId = await dataSpaceIdFor(other.cookie);
    const now = Date.now();
    const sessionIds = Array.from({ length: 21 }, () => crypto.randomUUID());
    const otherSessionId = crypto.randomUUID();
    await env.DB.batch([
      ...sessionIds.map((sessionId, index) =>
        env.DB.prepare(
          `INSERT INTO sessions
           (id, data_space_id, song_id, status, draft_text, study_text, case_sensitive,
            version, started_at, updated_at, completed_at)
           VALUES (?, ?, ?, 'completed', 'Hello world你好', 'Hello, world!\n你好', 0,
            1, ?, ?, ?)`,
        ).bind(
          sessionId,
          dataSpaceId,
          songIds[index % songIds.length],
          now - 1_000,
          now,
          now,
        ),
      ),
      env.DB.prepare(
        `INSERT INTO sessions
           (id, data_space_id, song_id, status, draft_text, study_text, case_sensitive,
            version, started_at, updated_at, completed_at)
           VALUES (?, ?, ?, 'completed', 'private', 'private', 0, 1, ?, ?, ?)`,
      ).bind(
        otherSessionId,
        otherDataSpaceId,
        otherSong.body.song.id,
        now,
        now + 1,
        now + 1,
      ),
    ]);

    const first = await request("/api/sessions", {}, cookie);
    const firstBody = await first.json<any>();
    expect(firstBody.history).toHaveLength(20);
    expect(firstBody.historyCursor).toMatch(/^\d+:[0-9a-f-]{36}$/iu);

    const second = await request(
      `/api/sessions?historyCursor=${encodeURIComponent(firstBody.historyCursor)}`,
      {},
      cookie,
    );
    const secondBody = await second.json<any>();
    expect(secondBody.history).toHaveLength(1);
    expect(secondBody.historyCursor).toBeNull();
    const returned = [
      ...firstBody.history.map((session: any) => session.id),
      ...secondBody.history.map((session: any) => session.id),
    ];
    expect(returned).toEqual([...sessionIds].sort().reverse());
    expect(returned).not.toContain(otherSessionId);
    expect(
      new Set(firstBody.history.map((session: any) => session.songTitle)),
    ).toEqual(new Set(["History pages A", "History pages B"]));

    const otherHistory = await request("/api/sessions", {}, other.cookie);
    expect(
      (await otherHistory.json<any>()).history.map((entry: any) => entry.id),
    ).toEqual([otherSessionId]);

    const invalid = await request(
      "/api/sessions?historyCursor=not-a-cursor",
      {},
      cookie,
    );
    expect(invalid.status).toBe(400);
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

  it("stores only normalized device and browser details and refreshes them", async () => {
    const initial = await request("/api/bootstrap", {
      headers: {
        "Sec-CH-UA":
          '"Not_A Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"macOS"',
        "User-Agent":
          "Mozilla/5.0 AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36 private-extra-value",
      },
    });
    const cookie = initial.headers.get("set-cookie")!.split(";")[0];
    expect((await initial.json<any>()).devices[0]).toMatchObject({
      platform: "Mac",
      browser: "Chrome",
      browserMajorVersion: "145",
      deviceType: "desktop",
    });
    const stored = await env.DB.prepare(
      `SELECT device_platform, device_browser, browser_major_version, device_type
       FROM device_memberships`,
    ).first<{
      device_platform: string;
      device_browser: string;
      browser_major_version: string;
      device_type: string;
    }>();
    expect(stored).toEqual({
      device_platform: "Mac",
      device_browser: "Chrome",
      browser_major_version: "145",
      device_type: "desktop",
    });
    expect(JSON.stringify(stored)).not.toContain("private-extra-value");

    const refreshed = await request(
      "/api/bootstrap",
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0",
        },
      },
      cookie,
    );
    expect((await refreshed.json<any>()).devices[0]).toMatchObject({
      platform: "Mac",
      browser: "Firefox",
      browserMajorVersion: "146",
      deviceType: "desktop",
    });
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

  it("never returns old-space content after membership changes during identity renewal", async () => {
    const device = await bootstrap();
    const created = await createSong(
      device.cookie,
      "Old-space secret",
      "secret",
    );
    const identityId = await identityIdFor(device.cookie);
    const oldSpaceId = await dataSpaceIdFor(device.cookie);
    const newSpaceId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO data_spaces (id, version, mutation_token, created_at, updated_at) VALUES (?, 1, NULL, ?, ?)",
      ).bind(newSpaceId, now, now),
      env.DB.prepare(
        "UPDATE identities SET last_seen_at = ? WHERE id = ?",
      ).bind(now - 2 * 86_400_000, identityId),
      env.DB.prepare(
        `CREATE TRIGGER move_membership_during_renewal
         AFTER UPDATE OF last_seen_at ON identities
         WHEN NEW.id = '${identityId}'
         BEGIN
           UPDATE device_memberships SET data_space_id = '${newSpaceId}'
           WHERE identity_id = NEW.id;
         END`,
      ),
    ]);

    const response = await request(
      `/api/songs/${created.body.song.id}`,
      {},
      device.cookie,
    );
    await env.DB.prepare("DROP TRIGGER move_membership_during_renewal").run();

    expect([404, 409]).toContain(response.status);
    expect(await response.text()).not.toContain("Old-space secret");
    expect(await dataSpaceIdFor(device.cookie)).toBe(newSpaceId);
    expect(oldSpaceId).not.toBe(newSpaceId);
  });

  it("keeps an identity renewed during expired-row cleanup", async () => {
    const device = await bootstrap();
    const created = await createSong(
      device.cookie,
      "Renewed identity remains",
      "protected",
    );
    const identityId = await identityIdFor(device.cookie);
    const spaceId = await dataSpaceIdFor(device.cookie);
    const renewedUntil = Date.now() + 60 * 60 * 1000;
    await env.DB.prepare("UPDATE identities SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, identityId)
      .run();
    await env.DB.prepare(
      `CREATE TRIGGER renew_during_identity_cleanup
       AFTER UPDATE OF version ON data_spaces
       WHEN NEW.id = '${spaceId}'
       BEGIN
         UPDATE identities SET expires_at = ${renewedUntil}
         WHERE id = '${identityId}';
       END`,
    ).run();

    const response = await request("/api/bootstrap", {}, device.cookie);
    await env.DB.prepare("DROP TRIGGER renew_during_identity_cleanup").run();

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(device.cookie);
    expect((await response.json<any>()).songs[0].id).toBe(created.body.song.id);
    expect(await identityIdFor(device.cookie)).toBe(identityId);
    expect(await dataSpaceIdFor(device.cookie)).toBe(spaceId);
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

  it("limits anonymous identity minting even when every request discards its cookie", async () => {
    const address = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const responses: Response[] = [];
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      responses.push(
        await request("/api/bootstrap", {
          headers: { "CF-Connecting-IP": address },
        }),
      );
    }
    expect(
      responses.slice(0, 3).every((response) => response.status === 200),
    ).toBe(true);
    expect(responses[3].status).toBe(429);
    expect((await responses[3].json<any>()).error.code).toBe("RATE_LIMITED");
  });

  it("edge-limits repeated reads for an existing identity", async () => {
    const address = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    const first = await request("/api/bootstrap", {
      headers: { "CF-Connecting-IP": address },
    });
    const second = await request("/api/bootstrap", {
      headers: { "CF-Connecting-IP": address },
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const cookies = [first, second].map(
      (response) => response.headers.get("set-cookie")!.split(";")[0],
    );
    for (let attempt = 2; attempt < 300; attempt += 1) {
      const allowed = await request(
        "/api/bootstrap",
        { headers: { "CF-Connecting-IP": address } },
        cookies[attempt % cookies.length],
      );
      expect(allowed.status).toBe(200);
    }
    await env.DB.prepare("DELETE FROM identities WHERE id = ?")
      .bind(await identityIdFor(cookies[0]))
      .run();
    const identitiesBeforeRejection = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM identities",
    ).first<{ count: number }>();
    const rejected = await request(
      "/api/bootstrap",
      { headers: { "CF-Connecting-IP": address } },
      cookies[0],
    );
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("60");
    expect((await rejected.json<any>()).error.code).toBe("RATE_LIMITED");
    const identitiesAfterRejection = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM identities",
    ).first<{ count: number }>();
    expect(identitiesAfterRejection?.count).toBe(
      identitiesBeforeRejection?.count,
    );
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

  it("rejects cross-site browser reads before creating an identity", async () => {
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM identities",
    ).first<{ count: number }>();
    const response = await request("/api/bootstrap", {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await response.json<any>()).error.code).toBe("ORIGIN_MISMATCH");
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM identities",
    ).first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
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

  it("rejects valid idempotent mutations before parsing or reserving work", async () => {
    const device = await bootstrap();
    const identityId = await identityIdFor(device.cookie);
    await env.DB.prepare(
      "INSERT INTO rate_limits (identity_id, bucket, window_started_at, request_count) VALUES (?, 'mutation', ?, ?)",
    )
      .bind(identityId, Date.now(), RATE_LIMITS.mutation.limit)
      .run();
    const key = "limited-large-valid-write";
    const response = await request(
      "/api/songs",
      {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({
          title: "Must be rejected early",
          artist: "",
          sourceText: "a".repeat(LIMITS.sourceScalars),
          sourceKind: "plain",
        }),
      },
      device.cookie,
    );
    expect(response.status).toBe(429);
    expect((await response.json<any>()).error.code).toBe("RATE_LIMITED");
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM idempotency_keys WHERE identity_id = ? AND key = ?",
        )
          .bind(identityId, key)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM songs WHERE data_space_id = ?",
        )
          .bind(await dataSpaceIdFor(device.cookie))
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });

  it("creates, autosaves, completes, and cascades a session", async () => {
    const { cookie } = await bootstrap();
    const created = await createSong(cookie);
    const song = created.body.song;
    expect(song.characterCount).toBe(12);
    expect(
      (
        await env.DB.prepare("SELECT character_count FROM songs WHERE id = ?")
          .bind(song.id)
          .first<{ character_count: number }>()
      )?.character_count,
    ).toBe(12);
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
    expect(detailBody.song.characterCount).toBe(12);
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

  it("computes legacy character counts without adding bootstrap queries", async () => {
    const { cookie } = await bootstrap();
    const created = await createSong(cookie, "Legacy count", "A,中\nB");
    await env.DB.prepare("UPDATE songs SET character_count = NULL WHERE id = ?")
      .bind(created.body.song.id)
      .run();

    const response = await request("/api/bootstrap", {}, cookie);
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.songs[0].characterCount).toBe(3);
    expect(
      (
        await env.DB.prepare("SELECT character_count FROM songs WHERE id = ?")
          .bind(created.body.song.id)
          .first<{ character_count: number }>()
      )?.character_count,
    ).toBeNull();
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
    const dataSpaceId = await dataSpaceIdFor(cookie);
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
      "SELECT COUNT(*) AS count FROM sessions WHERE data_space_id = ? AND song_id = ? AND status = 'in_progress'",
    )
      .bind(dataSpaceId, created.body.song.id)
      .first<{ count: number }>();
    expect(active?.count).toBe(1);
    const activeId = await env.DB.prepare(
      "SELECT id FROM sessions WHERE data_space_id = ? AND song_id = ? AND status = 'in_progress'",
    )
      .bind(dataSpaceId, created.body.song.id)
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

  it("previews replacement, requires confirmation, and syncs across device cookies", async () => {
    const deviceA = await bootstrap();
    const shared = await createSong(deviceA.cookie, "Shared from A", "alpha");
    expect(shared.response.status).toBe(201);
    const code = await pairingCodeFor(deviceA.cookie);
    expect(code).toMatch(/^[23456789A-Z]{4}(?:-[23456789A-Z]{4}){2}$/u);

    const deviceB = await bootstrap();
    const replaced = await createSong(deviceB.cookie, "Replace me", "beta");
    expect(replaced.response.status).toBe(201);
    const preview = await request(
      "/api/devices/pairing-preview",
      {
        method: "POST",
        body: JSON.stringify({ code: code.toLowerCase().replaceAll("-", " ") }),
      },
      deviceB.cookie,
    );
    expect(preview.status).toBe(200);
    expect(await preview.json<any>()).toMatchObject({
      destinationDeviceCount: 1,
      replacement: { songs: 1, activeDrafts: 0, history: 0 },
      requiresConfirmation: true,
    });

    const unconfirmed = await joinPairingCode(deviceB.cookie, code, false);
    expect(unconfirmed.status).toBe(409);
    expect((await unconfirmed.json<any>()).error.code).toBe(
      "PAIRING_CONFIRMATION_REQUIRED",
    );

    const joined = await joinPairingCode(
      deviceB.cookie,
      code,
      true,
      "confirmed-device-join",
    );
    expect(joined.status).toBe(200);
    expect(await joined.json<any>()).toEqual({ joined: true });

    const bootstrapA = await request("/api/bootstrap", {}, deviceA.cookie);
    const bodyA = await bootstrapA.json<any>();
    const bootstrapB = await request("/api/bootstrap", {}, deviceB.cookie);
    const bodyB = await bootstrapB.json<any>();
    expect(bodyA.paired).toBe(true);
    expect(bodyB.paired).toBe(true);
    expect(bodyB.recoveryNamespace).not.toBe(deviceB.body.recoveryNamespace);
    expect(bodyA.devices).toHaveLength(2);
    expect(bodyB.devices).toHaveLength(2);
    expect(
      bodyA.devices.filter((device: any) => device.isThisDevice),
    ).toHaveLength(1);
    expect(bodyB.songs.map((song: any) => song.title)).toEqual([
      "Shared from A",
    ]);

    await createSong(deviceB.cookie, "Created on B", "gamma");
    const synchronizedA = await request("/api/bootstrap", {}, deviceA.cookie);
    expect(
      (await synchronizedA.json<any>()).songs.map((song: any) => song.title),
    ).toEqual(["Created on B", "Shared from A"]);

    const reused = await request(
      "/api/devices/pairing-preview",
      { method: "POST", body: JSON.stringify({ code }) },
      (await bootstrap()).cookie,
    );
    expect(reused.status).toBe(404);
    expect((await reused.json<any>()).error.code).toBe("PAIRING_CODE_INVALID");
  });

  it("does not consume a replaced pairing code or leave either space locked", async () => {
    const destination = await bootstrap();
    const code = await pairingCodeFor(destination.cookie);
    const destinationSpaceId = await dataSpaceIdFor(destination.cookie);
    const joining = await bootstrap();
    const sourceSpaceId = await dataSpaceIdFor(joining.cookie);

    await env.DB.prepare(
      `CREATE TRIGGER invalidate_pairing_code_during_join
       AFTER UPDATE OF mutation_token ON data_spaces
       WHEN NEW.id = '${destinationSpaceId}' AND NEW.mutation_token IS NOT NULL
       BEGIN
         DELETE FROM pairing_codes WHERE data_space_id = NEW.id;
       END`,
    ).run();
    const response = await joinPairingCode(
      joining.cookie,
      code,
      true,
      "pairing-code-race",
    );
    await env.DB.prepare(
      "DROP TRIGGER invalidate_pairing_code_during_join",
    ).run();

    expect(response.status).toBe(404);
    expect((await response.json<any>()).error.code).toBe(
      "PAIRING_CODE_INVALID",
    );
    const spaces = await env.DB.prepare(
      `SELECT id, mutation_token FROM data_spaces WHERE id IN (?, ?)`,
    )
      .bind(destinationSpaceId, sourceSpaceId)
      .all<{ id: string; mutation_token: string | null }>();
    expect(spaces.results).toHaveLength(2);
    expect(spaces.results.every((space) => space.mutation_token === null)).toBe(
      true,
    );
    expect(await dataSpaceIdFor(joining.cookie)).toBe(sourceSpaceId);
  });

  it("requires fresh confirmation when content appears as join begins", async () => {
    const destination = await bootstrap();
    const code = await pairingCodeFor(destination.cookie);
    const destinationSpaceId = await dataSpaceIdFor(destination.cookie);
    const joining = await bootstrap();
    const sourceSpaceId = await dataSpaceIdFor(joining.cookie);
    const now = Date.now();

    await env.DB.prepare(
      `CREATE TRIGGER add_source_content_during_join
       AFTER UPDATE OF mutation_token ON data_spaces
       WHEN NEW.id = '${destinationSpaceId}' AND NEW.mutation_token IS NOT NULL
       BEGIN
         INSERT INTO songs
           (data_space_id, id, title, artist, source_text, study_text,
            character_count, source_kind, version, created_at, updated_at)
         VALUES
           ('${sourceSpaceId}', 'join-race-song', 'Concurrent song', '',
            'late', 'late', 4, 'plain', 1, ${now}, ${now});
       END`,
    ).run();
    const response = await joinPairingCode(
      joining.cookie,
      code,
      false,
      "join-content-race",
    );
    await env.DB.prepare("DROP TRIGGER add_source_content_during_join").run();

    expect(response.status).toBe(409);
    const body = await response.json<any>();
    expect(body.error.code).toBe("PAIRING_CONFIRMATION_REQUIRED");
    expect(body.error.details.replacement.songs).toBe(1);
    expect(await dataSpaceIdFor(joining.cookie)).toBe(sourceSpaceId);
    expect(
      (
        await env.DB.prepare(
          "SELECT mutation_token FROM data_spaces WHERE id = ?",
        )
          .bind(destinationSpaceId)
          .first<{ mutation_token: string | null }>()
      )?.mutation_token,
    ).toBeNull();
  });

  it("scrubs replaced-device idempotency responses and blocks their replay", async () => {
    const deviceA = await bootstrap();
    await createSong(deviceA.cookie, "Destination record", "kept");
    const deviceB = await bootstrap();
    const oldBody = {
      title: "Old private record",
      artist: "",
      sourceText: "old private words",
      sourceKind: "plain",
    };
    const oldCreate = await request(
      "/api/songs",
      {
        method: "POST",
        headers: { "Idempotency-Key": "old-private-create" },
        body: JSON.stringify(oldBody),
      },
      deviceB.cookie,
    );
    expect(oldCreate.status).toBe(201);
    expect(
      (
        await joinPairingCode(
          deviceB.cookie,
          await pairingCodeFor(deviceA.cookie),
          true,
          "replace-and-scrub-cache",
        )
      ).status,
    ).toBe(200);

    const replay = await request(
      "/api/songs",
      {
        method: "POST",
        headers: { "Idempotency-Key": "old-private-create" },
        body: JSON.stringify(oldBody),
      },
      deviceB.cookie,
    );
    expect(replay.status).toBe(409);
    expect(await replay.text()).not.toContain("old private");
    const cached = await env.DB.prepare(
      "SELECT response_json FROM idempotency_keys WHERE identity_id = ? AND key = ?",
    )
      .bind(await identityIdFor(deviceB.cookie), "old-private-create")
      .first<{ response_json: string }>();
    expect(cached?.response_json).not.toContain("old private");
    expect(
      (
        await (await request("/api/bootstrap", {}, deviceB.cookie)).json<any>()
      ).songs.map((song: any) => song.title),
    ).toEqual(["Destination record"]);
  });

  it("stores only pairing-code hashes and invalidates replaced or expired codes", async () => {
    const deviceA = await bootstrap();
    const firstCode = await pairingCodeFor(deviceA.cookie);
    const secondCode = await pairingCodeFor(deviceA.cookie);
    const rows = await env.DB.prepare(
      "SELECT code_hash, expires_at FROM pairing_codes WHERE claimed_by_identity_id IS NULL",
    ).all<{ code_hash: string; expires_at: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].code_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows.results[0].code_hash).not.toContain(
      secondCode.replaceAll("-", ""),
    );
    const foreignKeys = await env.DB.prepare(
      "PRAGMA foreign_key_list(pairing_codes)",
    ).all<{ from: string; on_delete: string }>();
    expect(
      foreignKeys.results.find(
        (foreignKey) => foreignKey.from === "claimed_by_identity_id",
      )?.on_delete,
    ).toBe("CASCADE");
    const deviceB = await bootstrap();
    const replaced = await request(
      "/api/devices/pairing-preview",
      { method: "POST", body: JSON.stringify({ code: firstCode }) },
      deviceB.cookie,
    );
    expect(replaced.status).toBe(404);
    await env.DB.prepare(
      "UPDATE pairing_codes SET expires_at = ? WHERE code_hash = ?",
    )
      .bind(Date.now() - 1, rows.results[0].code_hash)
      .run();
    const expired = await request(
      "/api/devices/pairing-preview",
      { method: "POST", body: JSON.stringify({ code: secondCode }) },
      deviceB.cookie,
    );
    expect(expired.status).toBe(404);
  });

  it("does not revive a claimed code after the joining device is deleted", async () => {
    const deviceA = await bootstrap();
    const code = await pairingCodeFor(deviceA.cookie);
    const deviceB = await bootstrap();
    expect((await joinPairingCode(deviceB.cookie, code, true)).status).toBe(
      200,
    );
    expect(
      (
        await request(
          "/api/devices/leave",
          {
            method: "POST",
            headers: { "Idempotency-Key": "leave-before-delete" },
          },
          deviceB.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (await request("/api/data", { method: "DELETE" }, deviceB.cookie)).status,
    ).toBe(200);
    const deviceC = await bootstrap();
    const preview = await request(
      "/api/devices/pairing-preview",
      { method: "POST", body: JSON.stringify({ code }) },
      deviceC.cookie,
    );
    expect(preview.status).toBe(404);
  });

  it("keeps an unclaimed pairing code retryable when the source space is busy", async () => {
    const deviceA = await bootstrap();
    const code = await pairingCodeFor(deviceA.cookie);
    const targetSpaceId = await dataSpaceIdFor(deviceA.cookie);
    const targetVersionBefore = await env.DB.prepare(
      "SELECT version FROM data_spaces WHERE id = ?",
    )
      .bind(targetSpaceId)
      .first<{ version: number }>();
    const deviceB = await bootstrap();
    const sourceSpaceId = await dataSpaceIdFor(deviceB.cookie);
    await env.DB.prepare(
      "UPDATE data_spaces SET mutation_token = ? WHERE id = ?",
    )
      .bind("simulated-concurrent-mutation", sourceSpaceId)
      .run();

    const conflicted = await joinPairingCode(
      deviceB.cookie,
      code,
      true,
      "join-while-source-busy",
    );
    expect(conflicted.status).toBe(409);
    expect((await conflicted.json<any>()).error.code).toBe("VERSION_CONFLICT");
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM pairing_codes WHERE claimed_by_identity_id IS NULL",
        ).first<{ count: number }>()
      )?.count,
    ).toBe(1);
    const targetVersionAfter = await env.DB.prepare(
      "SELECT version FROM data_spaces WHERE id = ?",
    )
      .bind(targetSpaceId)
      .first<{ version: number }>();
    expect(targetVersionAfter?.version).toBe(targetVersionBefore?.version);

    await env.DB.prepare(
      "UPDATE data_spaces SET mutation_token = NULL WHERE id = ?",
    )
      .bind(sourceSpaceId)
      .run();
    const retried = await joinPairingCode(
      deviceB.cookie,
      code,
      true,
      "join-after-source-unlocked",
    );
    expect(retried.status).toBe(200);
    expect(
      (await (await request("/api/bootstrap", {}, deviceB.cookie)).json<any>())
        .paired,
    ).toBe(true);
  });

  it("blocks grouped deletion, snapshots on leave, and auto-dissolves both sides", async () => {
    const deviceA = await bootstrap();
    const created = await createSong(deviceA.cookie, "Before split", "one");
    const songId = created.body.song.id;
    const completedStart = await request(
      `/api/songs/${songId}/sessions`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "completed-before-split-start" },
        body: JSON.stringify({ restart: false, caseSensitive: false }),
      },
      deviceA.cookie,
    );
    const completedSession = (await completedStart.json<any>()).session;
    expect(
      (
        await request(
          `/api/sessions/${completedSession.id}`,
          {
            method: "PATCH",
            headers: { "Idempotency-Key": "completed-before-split-save" },
            body: JSON.stringify({
              version: completedSession.version,
              draftText: "one",
              action: "complete",
            }),
          },
          deviceA.cookie,
        )
      ).status,
    ).toBe(200);
    const activeStart = await request(
      `/api/songs/${songId}/sessions`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "active-before-split-start" },
        body: JSON.stringify({ restart: false, caseSensitive: false }),
      },
      deviceA.cookie,
    );
    const activeSession = (await activeStart.json<any>()).session;
    const activeSave = await request(
      `/api/sessions/${activeSession.id}`,
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "active-before-split-save" },
        body: JSON.stringify({
          version: activeSession.version,
          draftText: "shared draft",
          action: "save",
        }),
      },
      deviceA.cookie,
    );
    const savedActive = (await activeSave.json<any>()).session;
    const deviceB = await bootstrap();
    const code = await pairingCodeFor(deviceA.cookie);
    expect((await joinPairingCode(deviceB.cookie, code, true)).status).toBe(
      200,
    );
    const namespaceBeforeLeave = (
      await (await request("/api/bootstrap", {}, deviceB.cookie)).json<any>()
    ).recoveryNamespace;

    const blockedDelete = await request(
      "/api/data",
      { method: "DELETE" },
      deviceA.cookie,
    );
    expect(blockedDelete.status).toBe(409);
    expect((await blockedDelete.json<any>()).error.code).toBe(
      "PAIRING_EXIT_REQUIRED",
    );

    const left = await request(
      "/api/devices/leave",
      {
        method: "POST",
        headers: { "Idempotency-Key": "leave-with-snapshot" },
      },
      deviceB.cookie,
    );
    expect(left.status).toBe(200);
    expect(await left.json<any>()).toEqual({ separated: true });

    const afterA = await request("/api/bootstrap", {}, deviceA.cookie);
    const afterB = await request("/api/bootstrap", {}, deviceB.cookie);
    expect((await afterA.clone().json<any>()).paired).toBe(false);
    const afterBBody = await afterB.clone().json<any>();
    expect(afterBBody.paired).toBe(false);
    expect(afterBBody.recoveryNamespace).not.toBe(namespaceBeforeLeave);
    expect(
      (await afterA.json<any>()).songs.map((song: any) => song.title),
    ).toEqual(["Before split"]);
    expect(
      (await afterB.json<any>()).songs.map((song: any) => song.title),
    ).toEqual(["Before split"]);
    expect(
      (await (await request("/api/sessions", {}, deviceA.cookie)).json<any>())
        .history,
    ).toHaveLength(1);
    expect(
      (await (await request("/api/sessions", {}, deviceB.cookie)).json<any>())
        .history,
    ).toHaveLength(1);
    expect(
      (
        await (
          await request(`/api/sessions/${savedActive.id}`, {}, deviceB.cookie)
        ).json<any>()
      ).session.draftText,
    ).toBe("shared draft");

    const changedOnA = await request(
      `/api/sessions/${savedActive.id}`,
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "active-after-split-save-a" },
        body: JSON.stringify({
          version: savedActive.version,
          draftText: "only A draft",
          action: "save",
        }),
      },
      deviceA.cookie,
    );
    expect(changedOnA.status).toBe(200);
    expect(
      (
        await (
          await request(`/api/sessions/${savedActive.id}`, {}, deviceB.cookie)
        ).json<any>()
      ).session.draftText,
    ).toBe("shared draft");

    await createSong(deviceA.cookie, "Only A", "two");
    await createSong(deviceB.cookie, "Only B", "three");
    const divergentA = await request("/api/bootstrap", {}, deviceA.cookie);
    const divergentB = await request("/api/bootstrap", {}, deviceB.cookie);
    expect(
      (await divergentA.json<any>()).songs.map((song: any) => song.title),
    ).toEqual(["Only A", "Before split"]);
    expect(
      (await divergentB.json<any>()).songs.map((song: any) => song.title),
    ).toEqual(["Only B", "Before split"]);
  });

  it("lets any member remove another device while the removed device keeps a snapshot", async () => {
    const deviceA = await bootstrap();
    await createSong(deviceA.cookie, "Shared before removal", "one");
    const deviceB = await bootstrap();
    const code = await pairingCodeFor(deviceA.cookie);
    expect((await joinPairingCode(deviceB.cookie, code, true)).status).toBe(
      200,
    );
    const group = await request("/api/bootstrap", {}, deviceA.cookie);
    const otherDevice = (await group.json<any>()).devices.find(
      (device: any) => !device.isThisDevice,
    );

    const removed = await request(
      `/api/devices/${otherDevice.id}/remove`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "remove-other-device" },
      },
      deviceA.cookie,
    );
    expect(removed.status).toBe(200);
    expect(await removed.json<any>()).toEqual({ separated: true });
    const afterB = await request("/api/bootstrap", {}, deviceB.cookie);
    const bodyB = await afterB.json<any>();
    expect(bodyB.paired).toBe(false);
    expect(bodyB.songs.map((song: any) => song.title)).toEqual([
      "Shared before removal",
    ]);

    const cannotRemoveSelf = await request(
      `/api/devices/${bodyB.devices[0].id}/remove`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "cannot-remove-self" },
      },
      deviceB.cookie,
    );
    expect(cannotRemoveSelf.status).toBe(404);
  });

  it("lets any member add a third device and dissolves as members separate", async () => {
    const deviceA = await bootstrap();
    await createSong(deviceA.cookie, "Three-way shared", "one");
    const deviceB = await bootstrap();
    expect(
      (
        await joinPairingCode(
          deviceB.cookie,
          await pairingCodeFor(deviceA.cookie),
          true,
        )
      ).status,
    ).toBe(200);
    const deviceC = await bootstrap();
    expect(
      (
        await joinPairingCode(
          deviceC.cookie,
          await pairingCodeFor(deviceB.cookie),
          true,
        )
      ).status,
    ).toBe(200);
    const group = await request("/api/bootstrap", {}, deviceA.cookie);
    const groupBody = await group.json<any>();
    expect(groupBody.devices).toHaveLength(3);
    const deviceBPublicId = (
      await (await request("/api/bootstrap", {}, deviceB.cookie)).json<any>()
    ).devices.find((device: any) => device.isThisDevice).id;
    expect(
      (
        await request(
          `/api/devices/${deviceBPublicId}/remove`,
          {
            method: "POST",
            headers: { "Idempotency-Key": "remove-from-three-way" },
          },
          deviceA.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (await (await request("/api/bootstrap", {}, deviceA.cookie)).json<any>())
        .paired,
    ).toBe(true);
    expect(
      (await (await request("/api/bootstrap", {}, deviceB.cookie)).json<any>())
        .paired,
    ).toBe(false);
    expect(
      (
        await request(
          "/api/devices/leave",
          {
            method: "POST",
            headers: { "Idempotency-Key": "leave-final-two" },
          },
          deviceC.cookie,
        )
      ).status,
    ).toBe(200);
    for (const cookie of [deviceA.cookie, deviceB.cookie, deviceC.cookie]) {
      const state = await request("/api/bootstrap", {}, cookie);
      const body = await state.json<any>();
      expect(body.paired).toBe(false);
      expect(body.songs.map((song: any) => song.title)).toEqual([
        "Three-way shared",
      ]);
    }
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
      Date.now() + 23 * 60 * 60 * 1000,
    );
    expect(revocation!.expires_at).toBeLessThan(
      Date.now() + 25 * 60 * 60 * 1000,
    );
  });

  it("treats a concurrent completed deletion as idempotent success", async () => {
    const device = await bootstrap();
    await createSong(device.cookie, "Concurrent deletion", "private");
    const identityId = await identityIdFor(device.cookie);
    const spaceId = await dataSpaceIdFor(device.cookie);
    const credential = await env.DB.prepare(
      "SELECT credential_hash FROM identities WHERE id = ?",
    )
      .bind(identityId)
      .first<{ credential_hash: string }>();
    await env.DB.prepare(
      `CREATE TRIGGER complete_delete_after_resolution
       AFTER INSERT ON rate_limits
       WHEN NEW.identity_id = '${identityId}' AND NEW.bucket = 'destructive'
       BEGIN
         INSERT OR REPLACE INTO revoked_credentials (credential_hash, expires_at)
         VALUES ('${credential!.credential_hash}', ${Date.now() + 60 * 60 * 1000});
         DELETE FROM data_spaces WHERE id = '${spaceId}';
         DELETE FROM identities WHERE id = '${identityId}';
       END`,
    ).run();

    const response = await request(
      "/api/data",
      { method: "DELETE" },
      device.cookie,
    );
    await env.DB.prepare("DROP TRIGGER complete_delete_after_resolution").run();

    expect(response.status).toBe(200);
    expect(await response.json<any>()).toEqual({ deleted: true });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("refuses deletion when membership changes namespace after identity resolution", async () => {
    const deviceA = await bootstrap();
    const sharedSong = await createSong(
      deviceA.cookie,
      "Shared survives",
      "one",
    );
    const deviceB = await bootstrap();
    expect(
      (
        await joinPairingCode(
          deviceB.cookie,
          await pairingCodeFor(deviceA.cookie),
          true,
        )
      ).status,
    ).toBe(200);
    const sharedSpaceId = await dataSpaceIdFor(deviceA.cookie);
    const identityB = await identityIdFor(deviceB.cookie);
    const privateSpaceId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO data_spaces (id, version, mutation_token, created_at, updated_at) VALUES (?, 1, NULL, ?, ?)",
      ).bind(privateSpaceId, now, now),
      env.DB.prepare(
        `INSERT INTO songs
           (data_space_id, id, title, artist, source_text, study_text,
            character_count, source_kind, version, created_at, updated_at)
         SELECT ?, id, title, artist, source_text, study_text,
           character_count, source_kind, version, created_at, updated_at
         FROM songs WHERE data_space_id = ?`,
      ).bind(privateSpaceId, sharedSpaceId),
      env.DB.prepare(
        "UPDATE identities SET last_seen_at = ? WHERE id = ?",
      ).bind(now - 2 * 86_400_000, identityB),
      env.DB.prepare(
        `CREATE TRIGGER move_to_private_space_during_delete
         AFTER UPDATE OF last_seen_at ON identities
         WHEN NEW.id = '${identityB}'
         BEGIN
           UPDATE device_memberships
           SET data_space_id = '${privateSpaceId}', recovery_namespace = 'replacement-namespace'
           WHERE identity_id = NEW.id;
         END`,
      ),
    ]);

    const response = await request(
      "/api/data",
      { method: "DELETE" },
      deviceB.cookie,
    );
    await env.DB.prepare(
      "DROP TRIGGER move_to_private_space_during_delete",
    ).run();

    expect(response.status).toBe(409);
    expect((await response.json<any>()).error.code).toBe(
      "RECOVERY_NAMESPACE_MISMATCH",
    );
    expect(
      await env.DB.prepare("SELECT id FROM data_spaces WHERE id = ?")
        .bind(privateSpaceId)
        .first(),
    ).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM identities WHERE id = ?")
        .bind(identityB)
        .first(),
    ).not.toBeNull();
    const remaining = await request("/api/bootstrap", {}, deviceA.cookie);
    expect((await remaining.json<any>()).songs[0].id).toBe(
      sharedSong.body.song.id,
    );
  });

  it("keeps deletion revocation receipts globally bounded", async () => {
    const device = await bootstrap();
    const identityId = await identityIdFor(device.cookie);
    const credential = await env.DB.prepare(
      "SELECT credential_hash FROM identities WHERE id = ?",
    )
      .bind(identityId)
      .first<{ credential_hash: string }>();
    await env.DB.prepare(
      `WITH digits(value) AS (
         VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
       ), numbers(value) AS (
         SELECT a.value * 1000 + b.value * 100 + c.value * 10 + d.value
         FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d
       )
       INSERT INTO revoked_credentials (credential_hash, expires_at)
       SELECT printf('bounded-revocation-%05d', value), ? FROM numbers`,
    )
      .bind(Date.now() + 60 * 60 * 1000)
      .run();

    const deleted = await request(
      "/api/data",
      { method: "DELETE" },
      device.cookie,
    );
    expect(deleted.status).toBe(200);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM revoked_credentials",
        ).first<{ count: number }>()
      )?.count,
    ).toBe(10_000);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM revoked_credentials WHERE credential_hash = ?",
        )
          .bind(credential!.credential_hash)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  it("enforces a bounded per-space song count before cloning or bootstrap can grow unbounded", async () => {
    const device = await bootstrap();
    const dataSpaceId = await dataSpaceIdFor(device.cookie);
    const now = Date.now();
    await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < ?
       )
       INSERT INTO songs
         (data_space_id, id, title, artist, source_text, study_text,
          character_count, source_kind, version, created_at, updated_at)
       SELECT ?, printf('quota-song-%03d', value), printf('Song %d', value), '',
         'a', 'a', 1, 'plain', 1, ?, ? FROM sequence`,
    )
      .bind(SPACE_LIMITS.songs, dataSpaceId, now, now)
      .run();

    const response = await createSong(device.cookie, "One too many", "b");
    expect(response.response.status).toBe(409);
    expect(response.body.error.code).toBe("STORAGE_QUOTA_EXCEEDED");
  });

  it("keeps bootstrap-only identities short lived and promotes real users after a write", async () => {
    const device = await bootstrap();
    const identityId = await identityIdFor(device.cookie);
    const initial = await env.DB.prepare(
      "SELECT expires_at FROM identities WHERE id = ?",
    )
      .bind(identityId)
      .first<{ expires_at: number }>();
    expect(initial!.expires_at).toBeLessThan(Date.now() + 25 * 60 * 60 * 1000);

    await createSong(device.cookie, "Promotes retention", "one");
    const promoted = await env.DB.prepare(
      "SELECT expires_at FROM identities WHERE id = ?",
    )
      .bind(identityId)
      .first<{ expires_at: number }>();
    expect(promoted!.expires_at).toBeGreaterThan(
      Date.now() + 364 * 24 * 60 * 60 * 1000,
    );
  });

  it("never persists large lyric or draft bodies in idempotency rows", async () => {
    const device = await bootstrap();
    const key = "large-response-idempotency";
    const sourceText = Array.from({ length: 45 }, () => "x".repeat(1_999)).join(
      "\n",
    );
    const created = await request(
      "/api/songs",
      {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({
          title: "Large replay",
          artist: "",
          sourceText,
          sourceKind: "plain",
        }),
      },
      device.cookie,
    );
    expect(created.status).toBe(201);
    const row = await env.DB.prepare(
      "SELECT status, response_json FROM idempotency_keys WHERE key = ?",
    )
      .bind(key)
      .first<{ status: number; response_json: string }>();
    expect(row).toEqual({ status: -1, response_json: "" });

    const replay = await request(
      "/api/songs",
      {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({
          title: "Large replay",
          artist: "",
          sourceText,
          sourceKind: "plain",
        }),
      },
      device.cookie,
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect((await replay.json<any>()).song.sourceText).toBe(sourceText);
    expect(
      await env.DB.prepare(
        "SELECT 1 AS found FROM idempotency_keys WHERE key = ?",
      )
        .bind(key)
        .first(),
    ).toEqual({ found: 1 });
  });

  it("caps ambiguous idempotency reservations per identity and expires them", async () => {
    const device = await bootstrap();
    const identityId = await identityIdFor(device.cookie);
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 64 }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO idempotency_keys (identity_id, operation, key, status, response_json, created_at) VALUES (?, ?, ?, 0, '', ?)",
        ).bind(identityId, `held:${index}`, `held-key-${index}`, now),
      ),
    );
    const blocked = await createSong(device.cookie, "Capacity blocked", "one");
    expect(blocked.response.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");

    await env.DB.prepare(
      "UPDATE idempotency_keys SET created_at = ? WHERE identity_id = ? AND operation = ?",
    )
      .bind(now - 61 * 60 * 1000, identityId, "held:0")
      .run();
    const afterExpiry = await createSong(
      device.cookie,
      "Capacity recovers",
      "two",
    );
    expect(afterExpiry.response.status).toBe(201);
  });

  it("does not count compact completed tombstones as pending work", async () => {
    const device = await bootstrap();
    const identityId = await identityIdFor(device.cookie);
    await env.DB.batch(
      Array.from({ length: 64 }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO idempotency_keys (identity_id, operation, key, status, response_json, created_at) VALUES (?, ?, ?, -1, '', ?)",
        ).bind(
          identityId,
          `completed:${index}`,
          `completed-key-${index}`,
          Date.now() + index,
        ),
      ),
    );
    const created = await createSong(
      device.cookie,
      "Completed rows do not block",
      "one",
    );
    expect(created.response.status).toBe(201);
  });

  it("rejects stale mutations after a device changes data spaces", async () => {
    const deviceA = await bootstrap();
    const deviceB = await bootstrap();
    const staleNamespace = deviceB.body.recoveryNamespace;
    const joined = await joinPairingCode(
      deviceB.cookie,
      await pairingCodeFor(deviceA.cookie),
      true,
    );
    expect(joined.status).toBe(200);

    const staleWrite = await request(
      "/api/songs",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "stale-space-write",
          "X-Recovery-Namespace": staleNamespace,
        },
        body: JSON.stringify({
          title: "Must be fenced",
          artist: "",
          sourceText: "stale",
          sourceKind: "plain",
        }),
      },
      deviceB.cookie,
    );
    expect(staleWrite.status).toBe(409);
    expect((await staleWrite.json<any>()).error.code).toBe("VERSION_CONFLICT");
    expect(
      (await (await request("/api/bootstrap", {}, deviceA.cookie)).json<any>())
        .songs,
    ).toHaveLength(0);
  });

  it("does not finish an active draft when a lyric edit exceeds storage quota", async () => {
    const device = await bootstrap();
    const created = await createSong(device.cookie, "Protected draft", "one");
    const song = created.body.song;
    const started = await request(
      `/api/songs/${song.id}/sessions`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "quota-active-session" },
        body: JSON.stringify({ restart: false, caseSensitive: false }),
      },
      device.cookie,
    );
    const session = (await started.json<any>()).session;
    const spaceId = await dataSpaceIdFor(device.cookie);
    const now = Date.now();
    await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 13
       )
       INSERT INTO songs
         (data_space_id, id, title, artist, source_text, study_text,
          character_count, source_kind, version, created_at, updated_at)
       SELECT ?, printf('quota-filler-%02d', value), 'Filler', '',
         lower(hex(zeroblob(97100))), lower(hex(zeroblob(97100))),
         194200, 'plain', 1, ?, ? FROM sequence`,
    )
      .bind(spaceId, now, now)
      .run();
    const oversized = Array.from({ length: 49 }, () => "z".repeat(1_999)).join(
      "\n",
    );
    const edited = await request(
      `/api/songs/${song.id}`,
      {
        method: "PUT",
        body: JSON.stringify({
          title: song.title,
          artist: song.artist,
          sourceText: oversized,
          sourceKind: "plain",
          version: song.version,
        }),
      },
      device.cookie,
    );
    expect(edited.status).toBe(409);
    expect((await edited.json<any>()).error.code).toBe(
      "STORAGE_QUOTA_EXCEEDED",
    );
    const preserved = await env.DB.prepare(
      "SELECT status, version FROM sessions WHERE id = ?",
    )
      .bind(session.id)
      .first<{ status: string; version: number }>();
    expect(preserved).toEqual({ status: "in_progress", version: 1 });
  });

  it("bounds total session bytes before start, autosave, or cloning", async () => {
    const deviceA = await bootstrap();
    const created = await createSong(deviceA.cookie, "Session quota", "abcd");
    const song = created.body.song;
    const spaceId = await dataSpaceIdFor(deviceA.cookie);
    const now = Date.now();
    await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 64
       )
       INSERT INTO sessions
         (data_space_id, id, song_id, status, draft_text, study_text,
          case_sensitive, version, started_at, updated_at, completed_at)
       SELECT ?, printf('quota-session-%03d', value), ?, 'completed',
         lower(hex(zeroblob(?))), '', 0, 1, ?, ?, ? FROM sequence`,
    )
      .bind(spaceId, song.id, 128 * 1024, now, now, now)
      .run();

    const start = await request(
      `/api/songs/${song.id}/sessions`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "session-byte-limit-start" },
        body: JSON.stringify({ restart: false, caseSensitive: false }),
      },
      deviceA.cookie,
    );
    expect(start.status).toBe(409);
    expect((await start.json<any>()).error.code).toBe("STORAGE_QUOTA_EXCEEDED");

    await env.DB.prepare(
      `INSERT INTO sessions
         (data_space_id, id, song_id, status, draft_text, study_text,
          case_sensitive, version, started_at, updated_at, completed_at)
       VALUES (?, 'quota-overflow', ?, 'in_progress', 'x', 'abcd', 0, 1, ?, ?, NULL)`,
    )
      .bind(spaceId, song.id, now, now)
      .run();
    const autosave = await request(
      "/api/sessions/quota-overflow",
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "session-byte-limit-save" },
        body: JSON.stringify({ version: 1, draftText: "y", action: "save" }),
      },
      deviceA.cookie,
    );
    expect(autosave.status).toBe(409);
    expect((await autosave.json<any>()).error.code).toBe(
      "STORAGE_QUOTA_EXCEEDED",
    );
    const deviceB = await bootstrap();
    expect(
      (
        await joinPairingCode(
          deviceB.cookie,
          await pairingCodeFor(deviceA.cookie),
          true,
        )
      ).status,
    ).toBe(200);
    const leave = await request(
      "/api/devices/leave",
      {
        method: "POST",
        headers: { "Idempotency-Key": "clone-over-session-bytes" },
      },
      deviceB.cookie,
    );
    expect(leave.status).toBe(409);
    expect((await leave.json<any>()).error.code).toBe("STORAGE_QUOTA_EXCEEDED");
  });

  it("enforces the device cap atomically after a pairing code is issued", async () => {
    const destination = await bootstrap();
    const spaceId = await dataSpaceIdFor(destination.cookie);
    const now = Date.now();
    const addSyntheticDevices = async (from: number, to: number) => {
      for (let index = from; index <= to; index += 1) {
        const identityId = `device-cap-identity-${index}`;
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO identities (id, credential_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
          ).bind(
            identityId,
            `device-cap-hash-${index}`,
            now,
            now,
            now + 60_000,
          ),
          env.DB.prepare(
            `INSERT INTO device_memberships
               (identity_id, data_space_id, public_device_id, device_label,
                recovery_namespace, joined_at, device_type)
             VALUES (?, ?, ?, ?, ?, ?, 'unknown')`,
          ).bind(
            identityId,
            spaceId,
            `device-cap-public-${index}`,
            `D${index}`,
            `device-cap-namespace-${index}`,
            now,
          ),
          env.DB.prepare(
            "INSERT INTO settings (identity_id, locale, version, updated_at) VALUES (?, 'en', 1, ?)",
          ).bind(identityId, now),
        ]);
      }
    };
    await addSyntheticDevices(1, SPACE_LIMITS.devices - 2);
    const code = await pairingCodeFor(destination.cookie);
    await addSyntheticDevices(
      SPACE_LIMITS.devices - 1,
      SPACE_LIMITS.devices - 1,
    );
    const joining = await bootstrap();
    const response = await joinPairingCode(joining.cookie, code, true);
    expect(response.status).toBe(409);
    expect((await response.json<any>()).error.code).toBe(
      "STORAGE_QUOTA_EXCEEDED",
    );
    expect(await dataSpaceIdFor(joining.cookie)).not.toBe(spaceId);
  });

  it("cleans multiple retention batches without exceeding D1 bind limits", async () => {
    for (let index = 0; index < 50; index += 1) await bootstrap();
    await env.DB.prepare("UPDATE identities SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    await runRetentionCleanup(env);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS count FROM identities").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
  });

  it("does not delete a library renewed after the retention snapshot", async () => {
    const device = await bootstrap();
    const created = await createSong(
      device.cookie,
      "Renewed during cleanup",
      "still here",
    );
    const identityId = await identityIdFor(device.cookie);
    const spaceId = await dataSpaceIdFor(device.cookie);
    const renewedUntil = Date.now() + 60 * 60 * 1000;
    await env.DB.prepare("UPDATE identities SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, identityId)
      .run();
    await env.DB.prepare(
      `CREATE TRIGGER renew_during_retention_cleanup
       AFTER UPDATE OF version ON data_spaces
       WHEN NEW.id = '${spaceId}'
       BEGIN
         UPDATE identities SET expires_at = ${renewedUntil}
         WHERE id = '${identityId}';
       END`,
    ).run();

    await runRetentionCleanup(env);
    await env.DB.prepare("DROP TRIGGER renew_during_retention_cleanup").run();

    expect(await identityIdFor(device.cookie)).toBe(identityId);
    expect(await dataSpaceIdFor(device.cookie)).toBe(spaceId);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM songs WHERE id = ? AND data_space_id = ?",
        )
          .bind(created.body.song.id, spaceId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
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

  it("expires one paired device without deleting the remaining device's data", async () => {
    const deviceA = await bootstrap();
    await createSong(deviceA.cookie, "Retained shared song", "one");
    const deviceB = await bootstrap();
    expect(
      (
        await joinPairingCode(
          deviceB.cookie,
          await pairingCodeFor(deviceA.cookie),
          true,
        )
      ).status,
    ).toBe(200);
    const pendingCode = await pairingCodeFor(deviceA.cookie);
    const sharedSpaceId = await dataSpaceIdFor(deviceA.cookie);
    const versionBefore = await env.DB.prepare(
      "SELECT version FROM data_spaces WHERE id = ?",
    )
      .bind(sharedSpaceId)
      .first<{ version: number }>();
    const identityB = await identityIdFor(deviceB.cookie);
    await env.DB.prepare("UPDATE identities SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, identityB)
      .run();
    await runRetentionCleanup(env);
    const versionAfter = await env.DB.prepare(
      "SELECT version FROM data_spaces WHERE id = ?",
    )
      .bind(sharedSpaceId)
      .first<{ version: number }>();
    expect(versionAfter?.version).toBe((versionBefore?.version ?? 0) + 1);
    const deviceC = await bootstrap();
    const invalidatedCode = await request(
      "/api/devices/pairing-preview",
      { method: "POST", body: JSON.stringify({ code: pendingCode }) },
      deviceC.cookie,
    );
    expect(invalidatedCode.status).toBe(404);
    const remaining = await request("/api/bootstrap", {}, deviceA.cookie);
    const body = await remaining.json<any>();
    expect(body.paired).toBe(false);
    expect(body.devices).toHaveLength(1);
    expect(body.songs.map((song: any) => song.title)).toEqual([
      "Retained shared song",
    ]);
    const foreignKeys = await env.DB.prepare("PRAGMA foreign_key_check").all<{
      table: string;
    }>();
    expect(foreignKeys.results).toEqual([]);
  });
});
