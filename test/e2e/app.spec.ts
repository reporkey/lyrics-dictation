import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const importSong = async (
  page: Page,
  { title = "Paper Moon", lyrics = "Hello, world!\n你好" } = {},
) => {
  await page.goto("/import");
  await page.getByLabel("Lyrics text").fill(lyrics);
  await page.getByLabel("Song title").fill(title);
  await page.getByRole("button", { name: "Save song" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
  ).toBeVisible();
};

test("imports a song and completes a formatting-insensitive full-document dictation", async ({
  page,
}) => {
  await importSong(page);
  await page.getByRole("button", { name: "Start dictation" }).click();
  const editor = page.getByRole("textbox", { name: "Lyrics dictation editor" });
  await expect(editor).toBeVisible();
  await expect(page.locator(".cm-missing-marker")).toHaveCount(1);

  await editor.fill("Hxllo, world!\n你好");
  await expect(page.locator(".cm-judged-incorrect")).toContainText("x");
  await expect(page.locator(".cm-judged-correct").first()).toBeVisible();

  await editor.fill("H e l l o world\n你，好！ ♪");
  await expect(
    page.getByRole("heading", { name: "You remembered the whole song" }),
  ).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("100% of lyric content matched")).toBeVisible();
});

test("uploads LRC, restores a locally recovered draft, and isolates another browser", async ({
  browser,
}) => {
  const owner = await browser.newContext({ locale: "en-US" });
  const page = await owner.newPage();
  await page.goto("/import");
  await page.locator('input[type="file"]').setInputFiles({
    name: "original.lrc",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "[ti:Cloud Song]\n[ar:Test Artist]\n[00:01.00]first line\n[00:02.00]second line",
    ),
  });
  await expect(page.getByLabel("Song title")).toHaveValue("Cloud Song");
  await page.getByRole("button", { name: "Save song" }).click();
  await page.getByRole("button", { name: "Start dictation" }).click();

  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() === "PATCH")
      await route.abort("internetdisconnected");
    else await route.continue();
  });
  const editor = page.getByRole("textbox", { name: "Lyrics dictation editor" });
  await editor.fill("first line");
  await expect(page.getByText(/Draft is safe|Not yet synced/)).toBeVisible({
    timeout: 5_000,
  });
  await page.unroute("**/api/sessions/*");
  await page.reload();
  await expect(editor).toHaveText("first line");

  const stranger = await browser.newContext({ locale: "en-US" });
  const strangerPage = await stranger.newPage();
  await strangerPage.goto("/");
  await expect(
    strangerPage.getByRole("heading", { name: "Your lyric shelf is ready" }),
  ).toBeVisible();
  await expect(strangerPage.getByText("Cloud Song")).toHaveCount(0);
  await stranger.close();
  await owner.close();
});

test("failed inferred LRC review cannot silently submit as plain text", async ({
  page,
}) => {
  await page.goto("/import");
  await page.getByLabel("Lyrics text").fill("[ti:Metadata only]");
  await page.getByLabel("Song title").fill("Should not save");
  await expect(page.getByLabel("Source format")).toHaveValue("lrc");
  await page.getByRole("button", { name: "Save song" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Add at least one lyric letter or number",
  );
  await expect(page).toHaveURL(/\/import$/u);
});

test("an older autosave response cannot erase a newer local recovery", async ({
  page,
}) => {
  await importSong(page, { title: "Save race", lyrics: "abcdef" });
  await page.getByRole("button", { name: "Start dictation" }).click();
  const editor = page.getByRole("textbox", { name: "Lyrics dictation editor" });

  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let patchCount = 0;
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    patchCount += 1;
    if (patchCount === 1) {
      markFirstStarted();
      await firstCanFinish;
      await route.continue();
      return;
    }
    await route.abort("internetdisconnected");
  });

  await editor.fill("abc");
  await firstStarted;
  await editor.fill("abcd");
  releaseFirst();
  await expect(page.getByText(/Draft is safe on this device/)).toBeVisible({
    timeout: 8_000,
  });
  await page.reload();
  await expect(editor).toHaveText("abcd");
});

test("a stale local recovery requires an explicit choice before overwriting newer cloud text", async ({
  page,
}) => {
  await importSong(page, { title: "Recovery conflict", lyrics: "abcdef" });
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect(
    page.getByRole("textbox", { name: "Lyrics dictation editor" }),
  ).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split("/").at(-1)!;
  const sessionPayload = await page.evaluate(async () => {
    const response = await fetch(
      location.pathname.replace("/dictation/", "/api/sessions/"),
    );
    return response.json() as Promise<{
      session: { songId: string; version: number };
    }>;
  });

  await page.evaluate(
    ({ sessionId, songId, version }) =>
      new Promise<void>((resolve, reject) => {
        const opened = indexedDB.open("lyrics-dictation-recovery", 2);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const transaction = opened.result.transaction("drafts", "readwrite");
          transaction.onerror = () => reject(transaction.error);
          transaction.oncomplete = () => resolve();
          transaction.objectStore("drafts").put({
            sessionId,
            songId,
            draftText: "local text",
            serverVersion: version,
            updatedAt: Date.now(),
          });
        };
      }),
    {
      sessionId,
      songId: sessionPayload.session.songId,
      version: sessionPayload.session.version,
    },
  );
  const cloudSave = await page.evaluate(
    async ({ sessionId, version }) => {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          version,
          draftText: "cloud text",
          action: "save",
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { sessionId, version: sessionPayload.session.version },
  );
  expect(cloudSave.status).toBe(200);

  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Lyrics dictation editor" }),
  ).toHaveText("local text");
  await expect(
    page.getByText(
      "This draft changed elsewhere. Your local writing has been preserved.",
    ),
  ).toBeVisible();
  await page.waitForTimeout(1_200);
  const afterReload = await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${id}`);
    return response.json() as Promise<{
      session: { draftText: string };
    }>;
  }, sessionId);
  expect(afterReload.session.draftText).toBe("cloud text");
});

test("retries a lost create response with the same idempotency key", async ({
  page,
}) => {
  const keys: string[] = [];
  let dropped = false;
  await page.route("**/api/songs", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    keys.push(route.request().headers()["idempotency-key"]);
    if (!dropped) {
      dropped = true;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await importSong(page, { title: "One intent", lyrics: "single lyric" });
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(1);
  await page
    .getByRole("link", { name: /Library/ })
    .first()
    .click();
  await expect(page.getByRole("link", { name: "Open One intent" })).toHaveCount(
    1,
  );
});

test("autosaves once per edit and never loops while idle", async ({ page }) => {
  await importSong(page, { title: "Quiet save", lyrics: "abcdef" });
  await page.getByRole("button", { name: "Start dictation" }).click();
  let patchCount = 0;
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() === "PATCH") patchCount += 1;
    await route.continue();
  });
  await page.waitForTimeout(2_200);
  expect(patchCount).toBe(0);
  await page
    .getByRole("textbox", { name: "Lyrics dictation editor" })
    .fill("abc");
  await expect(page.getByText("Synced", { exact: true })).toBeVisible({
    timeout: 5_000,
  });
  expect(patchCount).toBe(1);
  await page.waitForTimeout(2_200);
  expect(patchCount).toBe(1);
});

test("manual autosave retry retains the logical idempotency key", async ({
  page,
}) => {
  await importSong(page, { title: "Retry draft", lyrics: "abcdef" });
  await page.getByRole("button", { name: "Start dictation" }).click();
  const keys: string[] = [];
  let allowSave = false;
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    keys.push(route.request().headers()["idempotency-key"]);
    if (allowSave) await route.continue();
    else await route.abort("internetdisconnected");
  });
  await page
    .getByRole("textbox", { name: "Lyrics dictation editor" })
    .fill("abc");
  await expect(
    page.getByText("Draft is safe on this device, but cloud sync failed."),
  ).toBeVisible();
  allowSave = true;
  await page.getByRole("button", { name: "Retry sync" }).click();
  await expect(page.getByText("Synced", { exact: true })).toBeVisible();
  expect(keys.length).toBeGreaterThanOrEqual(3);
  expect(new Set(keys).size).toBe(1);
});

test("serializes first bootstrap across tabs so one identity owns new data", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "en-US" });
  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([first.goto("/"), second.goto("/")]);
  await expect(
    first.getByRole("heading", { name: "Your lyric shelf is ready" }),
  ).toBeVisible();
  await expect(
    second.getByRole("heading", { name: "Your lyric shelf is ready" }),
  ).toBeVisible();
  const identityCookies = (await context.cookies()).filter((cookie) =>
    cookie.name.includes("ld_identity"),
  );
  expect(identityCookies).toHaveLength(1);

  await importSong(first, { title: "Shared first visit", lyrics: "same key" });
  await second.reload();
  await expect(
    second.getByRole("link", { name: "Open Shared first visit" }),
  ).toBeVisible();
  await context.close();
});

test("a cross-site top-level POST cannot replace the anonymous identity", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your lyric shelf is ready" }),
  ).toBeVisible();
  const before = (await page.context().cookies()).find((cookie) =>
    cookie.name.includes("ld_identity"),
  );
  expect(before).toBeDefined();
  await page.goto(
    `data:text/html,${encodeURIComponent(`
      <form method="post" action="http://127.0.0.1:41789/api/settings">
        <input name="locale" value="zh-CN">
      </form>
      <script>document.forms[0].submit()</script>
    `)}`,
  );
  await expect(page).toHaveURL("http://127.0.0.1:41789/api/settings");
  await expect(page.locator("body")).toContainText("ORIGIN_MISMATCH");
  const after = (await page.context().cookies()).find((cookie) =>
    cookie.name.includes("ld_identity"),
  );
  expect(after?.value).toBe(before?.value);
});

test("a manual language choice during first bootstrap wins and syncs", async ({
  page,
}) => {
  let releaseBootstrap!: () => void;
  const mayFinishBootstrap = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  await page.route("**/api/bootstrap", async (route) => {
    await mayFinishBootstrap;
    await route.continue();
  });
  await page.goto("/");
  await page.getByTestId("language-zh").click();
  await expect(page.getByRole("link", { name: "歌词默写" })).toBeVisible();
  releaseBootstrap();
  await expect(page.getByRole("heading", { name: "还没有歌词" })).toBeVisible();

  await page.unroute("**/api/bootstrap");
  await page.reload();
  await expect(page.getByTestId("language-zh")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("heading", { name: "还没有歌词" })).toBeVisible();
});

test("follows browser defaults until explicit language and theme choices persist", async ({
  browser,
}) => {
  const context = await browser.newContext({
    locale: "zh-TW",
    colorScheme: "dark",
  });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByTestId("language-zh")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#131915",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("lyrics-dictation:locale")),
  ).toBeNull();
  expect(
    await page.evaluate(() => localStorage.getItem("lyrics-dictation:theme")),
  ).toBeNull();

  await page.getByTestId("language-en").click();
  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect(page.getByTestId("language-en")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#f5f3ee",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("lyrics-dictation:locale")),
  ).toBe("en");
  expect(
    await page.evaluate(() => localStorage.getItem("lyrics-dictation:theme")),
  ).toBe("light");

  await page.reload();
  await expect(page.getByTestId("language-en")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.evaluate(() => localStorage.removeItem("lyrics-dictation:locale"));
  await page.reload();
  await expect(page.getByTestId("language-en")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("lyrics-dictation:locale")),
  ).toBe("en");
  await context.close();
});

test("coalesces rapid language changes so the final choice wins", async ({
  page,
}) => {
  let releaseFirst!: () => void;
  let markFirstCommitted!: () => void;
  const firstCanReturn = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstCommitted = new Promise<void>((resolve) => {
    markFirstCommitted = resolve;
  });
  let patchCount = 0;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    patchCount += 1;
    if (patchCount === 1) {
      const response = await route.fetch();
      markFirstCommitted();
      await firstCanReturn;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  await page.getByTestId("language-zh").click();
  await firstCommitted;
  await page.getByTestId("language-en").click();
  releaseFirst();
  await expect(page.getByTestId("language-en")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => patchCount).toBe(2);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const response = await fetch("/api/bootstrap");
        return ((await response.json()) as { locale: string }).locale;
      }),
    )
    .toBe("en");
  expect(
    await page.evaluate(() => localStorage.getItem("lyrics-dictation:locale")),
  ).toBe("en");
});

test("switches between card and list library layouts and remembers the choice", async ({
  page,
}) => {
  await importSong(page, { title: "Layout song", lyrics: "layout" });
  await page.goto("/");
  await expect(page.getByText("1 song", { exact: true })).toBeVisible();
  await expect(page.getByText("Plain text", { exact: true })).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Search songs or artists" })
    .focus();
  expect(
    await page.locator(".search-field").evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0
      );
    }),
  ).toBe(true);
  const library = page.locator(".song-grid");
  await expect(library).toHaveAttribute("data-view", "cards");
  const cardHeight = await page
    .locator(".song-card")
    .first()
    .evaluate((element) => element.getBoundingClientRect().height);

  await page.getByTestId("view-list").click();
  await expect(library).toHaveAttribute("data-view", "list");
  await expect(page.getByTestId("view-list")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    await page.evaluate(() =>
      localStorage.getItem("lyrics-dictation:library-view"),
    ),
  ).toBe("list");
  const listHeight = await page
    .locator(".song-card")
    .first()
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(listHeight).toBeLessThan(cardHeight);

  await page.reload();
  await expect(library).toHaveAttribute("data-view", "list");
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.getByText("0×", { exact: true })).toBeVisible();
  await page.getByTestId("view-cards").click();
  await expect(library).toHaveAttribute("data-view", "cards");
});

test("synchronizes language, theme, and library layout across tabs", async ({
  page,
}) => {
  await importSong(page, { title: "Shared preferences", lyrics: "shared" });
  await page.goto("/");
  const sibling = await page.context().newPage();
  await sibling.goto("/");

  await page.getByTestId("view-list").click();
  await expect(sibling.locator(".song-grid")).toHaveAttribute(
    "data-view",
    "list",
  );
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(sibling.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("language-zh").click();
  await expect(sibling.getByTestId("language-zh")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await sibling.close();
});

test("keeps preferences usable when localStorage is unavailable", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
    Storage.prototype.removeItem = () => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
  });
  await importSong(page, { title: "Storage fallback", lyrics: "fallback" });
  await page.goto("/");
  await page.getByTestId("view-list").click();
  await expect(page.locator(".song-grid")).toHaveAttribute("data-view", "list");
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("language-zh").click();
  await expect(page.getByTestId("language-zh")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("link", { name: "查看《Storage fallback》" }).click();
  await page.getByRole("button", { name: "开始默写" }).click();
  await page.getByRole("textbox", { name: "歌词默写输入框" }).fill("fall");
  await expect(page.getByText(/已保存|尚未同步/)).toBeVisible();
  await page.goto("/privacy");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除所有数据" }).click();
  await expect(page.locator(".notice-success")).toBeVisible();
  expect(
    (await page.context().cookies()).filter((cookie) =>
      cookie.name.includes("ld_identity"),
    ),
  ).toHaveLength(0);
  expect(
    await page.evaluate(async () => {
      const request = indexedDB.open("lyrics-dictation-recovery");
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction("drafts", "readonly");
      const countRequest = transaction.objectStore("drafts").count();
      return new Promise<number>((resolve, reject) => {
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => reject(countRequest.error);
      });
    }),
  ).toBe(0);
  expect(
    await page.evaluate(async () => {
      const response = await fetch("/api/bootstrap");
      const payload = (await response.json()) as { songs: unknown[] };
      return payload.songs.length;
    }),
  ).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("uploads TXT, renders markup as text, edits, searches, and deletes", async ({
  page,
}) => {
  await page.goto("/import");
  await page.locator('input[type="file"]').setInputFiles({
    name: "<img-onerror>.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("A harmless <script>-shaped lyric"),
  });
  await page.getByLabel("Song title").fill("<img src=x onerror=alert(1)>");
  await page.getByRole("button", { name: "Save song" }).click();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "<img src=x onerror=alert(1)>",
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(globalThis, "pwned"))).toBe(
    undefined,
  );
  await expect(page.locator("main img")).toHaveCount(0);

  await page.getByRole("link", { name: "Edit song" }).click();
  await page.getByLabel("Song title").fill("Safe title");
  await page.getByLabel("Lyrics text").fill("Edited lyric");
  await page.getByRole("button", { name: "Save song" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Safe title" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: /Library/ })
    .first()
    .click();
  await page.getByPlaceholder("Search songs or artists").fill("safe");
  await expect(
    page.getByRole("link", { name: "Open Safe title" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open Safe title" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete song" }).click();
  await expect(page.getByText("Safe title")).toHaveCount(0);
});

test("a stale song tab still clears another tab's local recovery on delete", async ({
  context,
  page,
}) => {
  await importSong(page, { title: "Stale delete", lyrics: "abcdef" });
  const staleSongPage = await context.newPage();
  await staleSongPage.goto(page.url());
  await expect(
    staleSongPage.getByRole("heading", { name: "Stale delete" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Start dictation" }).click();
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() === "PATCH")
      await route.abort("internetdisconnected");
    else await route.continue();
  });
  await page
    .getByRole("textbox", { name: "Lyrics dictation editor" })
    .fill("abc");
  await page.waitForTimeout(200);

  staleSongPage.once("dialog", (dialog) => dialog.accept());
  await staleSongPage.getByRole("button", { name: "Delete song" }).click();
  await expect(
    staleSongPage.getByRole("heading", { name: "Your lyric shelf is ready" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  const recoveryCount = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const opened = indexedDB.open("lyrics-dictation-recovery", 2);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const request = opened.result
            .transaction("drafts", "readonly")
            .objectStore("drafts")
            .count();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        };
      }),
  );
  expect(recoveryCount).toBe(0);
});

test("a forced restart replaces a stale unsynced tab without zombie recovery", async ({
  context,
  page,
}) => {
  await importSong(page, { title: "Cross-tab restart", lyrics: "abcdef" });
  const songUrl = page.url();
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect(
    page.getByRole("textbox", { name: "Lyrics dictation editor" }),
  ).toBeVisible();
  const oldSessionUrl = page.url();
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() === "PATCH")
      await route.abort("internetdisconnected");
    else await route.continue();
  });
  await page
    .getByRole("textbox", { name: "Lyrics dictation editor" })
    .fill("abc");

  const restart = await context.newPage();
  await restart.goto(songUrl);
  restart.once("dialog", (dialog) => dialog.accept());
  await restart.getByRole("button", { name: "Start over" }).click();
  await expect(restart).toHaveURL(/\/dictation\//u);
  await expect(page).toHaveURL(/\/dictation\//u);
  expect(page.url()).not.toBe(oldSessionUrl);
  await expect(page.locator(".cm-placeholder")).toHaveText(
    "Begin writing from memory…",
  );
  const recoveryCount = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const opened = indexedDB.open("lyrics-dictation-recovery", 2);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const count = opened.result
            .transaction("drafts", "readonly")
            .objectStore("drafts")
            .count();
          count.onerror = () => reject(count.error);
          count.onsuccess = () => resolve(count.result);
        };
      }),
  );
  expect(recoveryCount).toBe(0);
});

test("rejects unsupported or invalid files and preserves an over-limit draft", async ({
  page,
}) => {
  await page.goto("/import");
  const upload = page.locator('input[type="file"]');
  await upload.setInputFiles({
    name: "lyrics.html",
    mimeType: "text/html",
    buffer: Buffer.from("<b>not accepted</b>"),
  });
  await expect(page.getByRole("alert")).toContainText(
    "Choose a .txt or .lrc file.",
  );
  await upload.setInputFiles({
    name: "broken.txt",
    mimeType: "text/plain",
    buffer: Buffer.from([0xff, 0xfe, 0xff]),
  });
  await expect(page.getByRole("alert")).toContainText(
    "The file must be valid UTF-8 text.",
  );

  await page.getByLabel("Lyrics text").fill("short lyric");
  await page.getByLabel("Song title").fill("Limits");
  await page.getByRole("button", { name: "Save song" }).click();
  await page.getByRole("button", { name: "Start dictation" }).click();
  const editor = page.getByRole("textbox", { name: "Lyrics dictation editor" });
  await editor.fill("safe");
  await editor.fill("ab\u202Ecd");
  await expect(page.getByRole("alert")).toContainText("position 3");
  await expect(editor).toHaveText("safe");
  await editor.fill("a".repeat(100_001));
  await expect(editor).toHaveText("safe");
  await expect(page.getByRole("alert")).toContainText("maximum supported size");
});

test("keeps bounded visible feedback for a divergent maximum-scale draft", async ({
  page,
}) => {
  const source = Array.from({ length: 30 }, () => "a".repeat(2_000)).join("\n");
  await importSong(page, { title: "Large feedback", lyrics: source });
  await page.getByRole("button", { name: "Start dictation" }).click();
  const editor = page.getByRole("textbox", { name: "Lyrics dictation editor" });
  await editor.fill(`b${source.slice(1)}`);
  await expect(page.locator(".grade-correct strong")).not.toHaveText("0");
  await editor.press("ControlOrMeta+Home");
  await expect(page.locator(".cm-judged-incorrect").first()).toContainText("b");
  await expect(
    page.getByRole("heading", { name: "You remembered the whole song" }),
  ).toHaveCount(0);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "End and reveal lyrics" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Dictation result" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Checking…")).toHaveCount(0);
  await expect(page.locator(".grade-correct strong")).toHaveText("59999");
  await expect(page.locator(".grade-incorrect strong")).toHaveText("1");
  await expect(page.locator(".cm-judged-incorrect").first()).toHaveText("a");
});

test("keeps editor decorations out of text, preserves undo, and recovers alignment", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await importSong(page, { title: "Alignment", lyrics: "abcdef" });
  await page.getByRole("button", { name: "Start dictation" }).click();
  const editor = page.getByRole("textbox", { name: "Lyrics dictation editor" });

  await editor.fill("xabdef");
  await expect(page.locator(".cm-judged-incorrect")).toContainText("x");
  const missing = page.getByRole("img", { name: /Missing text here/ });
  await expect(missing).toBeVisible();
  await expect(missing).toHaveText("");
  expect(
    await page
      .locator(".cm-judged-incorrect")
      .first()
      .evaluate((element) => getComputedStyle(element).textDecorationLine),
  ).toContain("underline");

  await editor.press("ControlOrMeta+A");
  await editor.press("ControlOrMeta+C");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "xabdef",
  );

  await editor.fill("abc");
  await expect(editor).toHaveText("abc");
  await page.waitForTimeout(600);
  await editor.press("End");
  await editor.type("d");
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveText("abc");
  await editor.press("ControlOrMeta+Shift+z");
  await expect(editor).toHaveText("abcd");

  await editor.fill("ab ,\n c—d♪ef");
  await expect(
    page.getByRole("heading", { name: "You remembered the whole song" }),
  ).toBeVisible();
  await expect(page.locator(".cm-missing-marker")).toHaveCount(0);
});

test("surfaces a cross-tab version conflict without discarding either draft", async ({
  context,
  page,
}) => {
  await importSong(page, { title: "Two tabs", lyrics: "abcdef" });
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect(
    page.getByRole("textbox", { name: "Lyrics dictation editor" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/dictation\//u);
  const sessionUrl = page.url();
  const second = await context.newPage();
  await second.goto(sessionUrl);
  const firstEditor = page.getByRole("textbox", {
    name: "Lyrics dictation editor",
  });
  const secondEditor = second.getByRole("textbox", {
    name: "Lyrics dictation editor",
  });
  let releaseSecondSave!: () => void;
  const secondMaySave = new Promise<void>((resolve) => {
    releaseSecondSave = resolve;
  });
  await second.route("**/api/sessions/*", async (route) => {
    if (route.request().method() === "PATCH") await secondMaySave;
    await route.continue();
  });
  await firstEditor.fill("abc");
  await secondEditor.fill("xyz");
  await expect(page.getByText("Synced", { exact: true })).toBeVisible({
    timeout: 5_000,
  });
  releaseSecondSave();
  await expect(second.getByText(/changed elsewhere/)).toBeVisible({
    timeout: 5_000,
  });
  await expect(secondEditor).toHaveText("xyz");
  await second.getByRole("button", { name: "Use cloud draft" }).click();
  await expect(secondEditor).toHaveText("abc");
});

test("reveals a corrected result in place and reopens it from practice history", async ({
  page,
}) => {
  await importSong(page, { title: "Terminal attempt", lyrics: "a,b\nc" });
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect(
    page.getByRole("textbox", { name: "Lyrics dictation editor" }),
  ).toBeVisible();
  const sessionUrl = page.url();
  await page
    .getByRole("textbox", { name: "Lyrics dictation editor" })
    .fill("a b xZ");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "End and reveal lyrics" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Dictation result" }),
  ).toBeVisible();
  await expect(page).toHaveURL(sessionUrl);
  await expect(page.locator(".result-banner")).toHaveCount(0);
  await expect(page.locator(".sync-state-wrap")).toHaveCount(0);
  const revealed = page.getByRole("textbox", {
    name: "Corrected dictation result",
  });
  await expect(revealed).toHaveText("a b xc");
  await expect(revealed).toHaveAttribute("aria-readonly", "true");
  expect(
    (await page.locator(".cm-judged-correct").allTextContents()).join(""),
  ).toBe("ab");
  expect(
    (await page.locator(".cm-judged-incorrect").allTextContents()).join(""),
  ).toBe("c");
  await expect(page.locator(".cm-judged-extra")).toHaveText("x");

  await page.evaluate(
    ({ sessionId }) =>
      new Promise<void>((resolve, reject) => {
        const opened = indexedDB.open("lyrics-dictation-recovery", 2);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const transaction = opened.result.transaction("drafts", "readwrite");
          transaction.objectStore("drafts").put({
            sessionId,
            songId: "stale-song",
            draftText: "stale local text",
            serverVersion: 0,
            updatedAt: Date.now(),
          });
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    { sessionId: sessionUrl.split("/").at(-1)! },
  );
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Corrected dictation result" }),
  ).toHaveText("a b xc");
  await expect(page.getByText(/changed elsewhere/)).toHaveCount(0);

  await page.getByRole("link", { name: "Terminal attempt" }).click();
  await expect(page.getByText("1 attempt", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Practice history" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: /View result/ }).click();
  await expect(page).toHaveURL(sessionUrl);
  await expect(
    page.getByRole("textbox", { name: "Corrected dictation result" }),
  ).toHaveText("a b xc");
  await expect(
    page.getByRole("link", { name: "Practice again" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "End and reveal lyrics" }),
  ).toHaveCount(0);
});

test("switches to Chinese and deletes all local and cloud data", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("language-zh").click();
  await expect(page.getByRole("heading", { name: "歌词库" })).toBeVisible();
  await page.getByRole("button", { name: "切换到深色模式" }).click();
  await page.getByRole("link", { name: "导入歌词" }).first().click();
  await page.getByLabel("歌词内容").fill("月光，照着我");
  await page.getByLabel("歌名").fill("月光");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "月光" }),
  ).toBeVisible();
  await page.goto("/");
  await page.getByTestId("view-list").click();
  await page.getByRole("link", { name: "隐私与数据" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除所有数据" }).click();
  await expect(
    page.getByText("All data was deleted from this browser and the cloud."),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("lyrics-dictation:library-view"),
    ),
  ).toBeNull();
  expect(
    (await page.context().cookies()).filter((cookie) =>
      cookie.name.includes("ld_identity"),
    ),
  ).toHaveLength(0);
  await expect(page.getByText("月光")).toHaveCount(0);
});

test("a bootstrap issued before delete cannot restore deleted UI state", async ({
  page,
}) => {
  await importSong(page, {
    title: "Delete race secret",
    lyrics: "private words",
  });
  await page.goto("/privacy");

  let markCaptured!: () => void;
  let releaseResponse!: () => void;
  const captured = new Promise<void>((resolve) => {
    markCaptured = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    markCaptured();
    await release;
    await route.fulfill({ response }).catch(() => undefined);
  });

  await page.evaluate(() => {
    const channel = new BroadcastChannel("lyrics-dictation:data");
    channel.postMessage({ type: "changed", at: Date.now() });
    channel.close();
  });
  await captured;

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete all my data" }).click();
  await expect(
    page.getByText("All data was deleted from this browser and the cloud."),
  ).toBeVisible();
  releaseResponse();
  await page.waitForTimeout(100);
  expect(
    (await page.context().cookies()).filter((cookie) =>
      cookie.name.includes("ld_identity"),
    ),
  ).toHaveLength(0);
  await page.goto("/");
  await expect(page.getByText("Delete race secret")).toHaveCount(0);
});

test("failed local recovery deletion is retryable and never reports success", async ({
  page,
}) => {
  await importSong(page, {
    title: "Local deletion retry",
    lyrics: "private recovery",
  });
  await page.getByRole("button", { name: "Start dictation" }).click();
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() === "PATCH")
      await route.abort("internetdisconnected");
    else await route.continue();
  });
  await page
    .getByRole("textbox", { name: "Lyrics dictation editor" })
    .fill("private");
  await expect(page.getByText(/Draft is safe|Not yet synced/)).toBeVisible();
  const sibling = await page.context().newPage();
  await sibling.goto("/");
  await expect(sibling.getByText("Local deletion retry")).toBeVisible();
  await page.evaluate(() =>
    localStorage.setItem("lyrics-dictation:library-view", "list"),
  );
  await page.goto("/privacy");

  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.clear;
    let rejectOnce = true;
    IDBObjectStore.prototype.clear = function (this: IDBObjectStore) {
      const request = original.call(this);
      if (rejectOnce) {
        rejectOnce = false;
        queueMicrotask(() => {
          try {
            this.transaction.abort();
          } catch {
            // The transaction already failed, which is the intended fixture.
          }
        });
      }
      return request;
    };
    (
      globalThis as typeof globalThis & {
        restoreRecoveryClear?: () => void;
      }
    ).restoreRecoveryClear = () => {
      IDBObjectStore.prototype.clear = original;
    };
  });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete all my data" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByText("All data was deleted from this browser and the cloud."),
  ).toHaveCount(0);
  await expect(sibling.getByText("Local deletion retry")).toHaveCount(0);
  await expect(sibling.getByText("Loading your library…")).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("lyrics-dictation:locale")),
  ).toBeNull();
  expect(
    await page.evaluate(() => localStorage.getItem("lyrics-dictation:theme")),
  ).toBeNull();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("lyrics-dictation:library-view"),
    ),
  ).toBeNull();

  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & {
        restoreRecoveryClear?: () => void;
      }
    ).restoreRecoveryClear?.();
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete all my data" }).click();
  await expect(
    page.getByText("All data was deleted from this browser and the cloud."),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const open = indexedDB.open("lyrics-dictation-recovery", 2);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const count = open.result
                .transaction("drafts", "readonly")
                .objectStore("drafts")
                .count();
              count.onerror = () => reject(count.error);
              count.onsuccess = () => resolve(count.result);
            };
          }),
      ),
    )
    .toBe(0);
  await expect(
    sibling.getByText("All data was deleted from this browser and the cloud."),
  ).toBeVisible();
  await sibling.close();
});

test("reload resumes a durable pending local deletion before bootstrap", async ({
  page,
}) => {
  await importSong(page, {
    title: "Durable deletion retry",
    lyrics: "private reload recovery",
  });
  await page.getByRole("button", { name: "Start dictation" }).click();
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() === "PATCH")
      await route.abort("internetdisconnected");
    else await route.continue();
  });
  await page
    .getByRole("textbox", { name: "Lyrics dictation editor" })
    .fill("private");
  await expect(page.getByText(/Draft is safe|Not yet synced/)).toBeVisible();
  await page.goto("/privacy");
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.clear;
    let rejectOnce = true;
    IDBObjectStore.prototype.clear = function (this: IDBObjectStore) {
      const request = original.call(this);
      if (rejectOnce) {
        rejectOnce = false;
        queueMicrotask(() => this.transaction.abort());
      }
      return request;
    };
  });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete all my data" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("lyrics-dictation:deletion-pending"),
    ),
  ).not.toBeNull();

  await page.reload();
  await expect(
    page.getByText("All data was deleted from this browser and the cloud."),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("lyrics-dictation:deletion-pending"),
    ),
  ).toBeNull();
  expect(
    (await page.context().cookies()).filter((cookie) =>
      cookie.name.includes("ld_identity"),
    ),
  ).toHaveLength(0);
});

test("storage fallback boots when BroadcastChannel is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your lyric shelf is ready" }),
  ).toBeVisible();
});

test("an IndexedDB marker completes deletion when the storage setter throws", async ({
  page,
}) => {
  await importSong(page, {
    title: "Crash window secret",
    lyrics: "private crash words",
  });
  const sibling = await page.context().newPage();
  await sibling.goto("/");
  await expect(sibling.getByText("Crash window secret")).toBeVisible();
  await page.goto("/privacy");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (
      this: Storage,
      key: string,
      value: string,
    ) {
      original.call(this, key, value);
      if (key === "lyrics-dictation:deletion-pending") {
        throw new Error("interrupted after durable marker write");
      }
    };
  });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete all my data" }).click();
  await expect(page.locator(".notice-success")).toBeVisible();
  await expect(sibling.getByText("Crash window secret")).toHaveCount(0);
  await expect(sibling.locator(".notice-success")).toBeVisible();
  expect(
    (await page.context().cookies()).filter((cookie) =>
      cookie.name.includes("ld_identity"),
    ),
  ).toHaveLength(0);
  expect(
    await page.evaluate(async () => {
      const request = indexedDB.open("lyrics-dictation-deletion");
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction("markers", "readonly");
      const countRequest = transaction.objectStore("markers").count();
      return new Promise<number>((resolve, reject) => {
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => reject(countRequest.error);
      });
    }),
  ).toBe(0);
  await sibling.close();
});

test("mobile navigation stays in the viewport without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your lyric shelf is ready" }),
  ).toBeVisible();
  const measurements = await page.evaluate(() => {
    const navigation = document.querySelector(".primary-nav-mobile")!;
    const rect = navigation.getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      navTop: rect.top,
      navBottom: rect.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  expect(measurements.documentWidth).toBeLessThanOrEqual(
    measurements.viewportWidth,
  );
  expect(measurements.navTop).toBeGreaterThanOrEqual(0);
  expect(measurements.navBottom).toBeLessThanOrEqual(
    measurements.viewportHeight,
  );

  await page.locator("body").focus();
  const focusRegions: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    focusRegions.push(
      await page.evaluate(() => {
        const active = document.activeElement;
        if (active?.classList.contains("icon-button")) return "theme";
        if (active?.closest("main")) return "main";
        if (active?.closest(".primary-nav-mobile")) return "mobile-nav";
        return "header";
      }),
    );
    if (focusRegions.at(-1) === "mobile-nav") break;
  }
  expect(focusRegions.indexOf("theme")).toBeGreaterThanOrEqual(0);
  expect(focusRegions.indexOf("main")).toBeGreaterThan(
    focusRegions.indexOf("theme"),
  );
  expect(focusRegions.indexOf("mobile-nav")).toBeGreaterThan(
    focusRegions.lastIndexOf("main"),
  );
});

test("@a11y critical screens have no detectable WCAG A/AA violations", async ({
  page,
}) => {
  await page.goto("/");
  let results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);

  await page.goto("/import");
  results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);

  await importSong(page, { title: "Accessible Song", lyrics: "One two\n三四" });
  await page.goto("/");
  await page.getByTestId("language-zh").click();
  await page.getByRole("button", { name: "切换到深色模式" }).click();
  await page.getByTestId("view-list").click();
  await page.setViewportSize({ width: 360, height: 800 });
  results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);

  await page.getByRole("link", { name: "查看《Accessible Song》" }).click();
  await page.getByRole("button", { name: "开始默写" }).click();
  results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});
