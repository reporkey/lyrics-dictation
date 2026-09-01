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

const observeFirstEditorPaint = (page: Page, documentLength: number) =>
  page.evaluate(
    ({ expectedLength }) =>
      new Promise<{ judgedText: string; unjudgedText: string }>(
        (resolve, reject) => {
          const editor =
            document.querySelector<HTMLElement>(".dictation-editor");
          const content = editor?.querySelector<HTMLElement>(".cm-content");
          if (!editor || !content) {
            reject(new Error("Dictation editor was not mounted"));
            return;
          }
          let framePending = false;
          const timeout = window.setTimeout(() => {
            observer.disconnect();
            reject(new Error("The edited document was not painted"));
          }, 10_000);
          const sample = () => {
            framePending = false;
            if (editor.dataset.documentLength !== String(expectedLength))
              return;
            let judgedText = "";
            let unjudgedText = "";
            const walker = document.createTreeWalker(
              content,
              NodeFilter.SHOW_TEXT,
            );
            let node = walker.nextNode();
            while (node) {
              const text = node.textContent ?? "";
              const parent = node.parentElement;
              if (
                parent?.closest(
                  ".cm-judged-correct, .cm-judged-incorrect, .cm-judged-extra",
                )
              )
                judgedText += text;
              else if (!parent?.closest(".cm-placeholder"))
                unjudgedText += text;
              node = walker.nextNode();
            }
            window.clearTimeout(timeout);
            observer.disconnect();
            resolve({ judgedText, unjudgedText });
          };
          const observer = new MutationObserver(() => {
            if (framePending) return;
            framePending = true;
            window.requestAnimationFrame(sample);
          });
          observer.observe(editor, {
            attributes: true,
            characterData: true,
            childList: true,
            subtree: true,
          });
        },
      ),
    { expectedLength: documentLength },
  );

test("introduces the app and links to its public source repository", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByText(
      "Add lyrics you love, choose a song, and write it from memory at your own pace. Spaces, line breaks, and punctuation do not affect scoring, and you can review feedback and past results as you practice.",
    ),
  ).toBeVisible();
  const repository = page.getByRole("link", {
    name: "View source on GitHub (opens in a new tab)",
    exact: true,
  });
  await expect(repository).toHaveAttribute(
    "href",
    "https://github.com/reporkey/lyrics-dictation",
  );
  await expect(repository).toHaveAttribute("target", "_blank");
  await expect(page.locator(".header-controls > :last-child")).toHaveAttribute(
    "href",
    "https://github.com/reporkey/lyrics-dictation",
  );
  await expect(repository).toHaveText("");

  await page.getByTestId("language-zh").click();
  await expect(
    page.getByText(
      "把喜欢的歌词加入歌词库，选一首凭记忆自由默写。空格、换行和标点不会影响判断，你可以随时查看提示与结果，在一次次练习中记住整首歌。",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "在 GitHub 查看源码（新标签页打开）",
      exact: true,
    }),
  ).toBeVisible();
});

test("keeps a perfect draft editable until submission and toggles live feedback", async ({
  page,
}) => {
  await importSong(page);
  await page.getByRole("button", { name: "Start dictation" }).click();
  const editor = page.getByRole("textbox", { name: "Lyrics dictation editor" });
  await expect(editor).toBeVisible();
  await expect(page.locator(".cm-missing-marker")).toHaveCount(1);

  const feedback = page.getByRole("switch", { name: "Live feedback" });
  expect((await feedback.boundingBox())?.height).toBeGreaterThanOrEqual(32);
  await expect(feedback).toHaveAttribute("aria-checked", "true");
  await feedback.click();
  await expect(feedback).toHaveAttribute("aria-checked", "false");
  await expect(page.locator(".cm-missing-marker")).toHaveCount(0);
  await expect(page.locator(".grade-summary")).toHaveCount(0);

  await editor.fill("Hxllo, world!\n你好");
  await expect(page.locator(".cm-judged-incorrect")).toHaveCount(0);
  await feedback.click();
  await expect(page.locator(".cm-judged-incorrect")).toContainText("x");
  await expect(page.locator(".cm-judged-correct").first()).toBeVisible();

  await editor.focus();
  await editor.press("ControlOrMeta+A");
  await editor.press("Backspace");
  await expect(page.getByText("Accuracy 0%")).toBeVisible();
  await editor.fill("H e l l o world\n你，好！ ♪");
  await expect(page.getByText("Accuracy 100%")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "You remembered the whole song" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { level: 1, name: "Write from memory" }),
  ).toBeVisible();
  await expect(editor).not.toHaveAttribute("aria-readonly", "true");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Submit dictation" }).click();
  await expect(
    page.getByRole("heading", { name: "You remembered the whole song" }),
  ).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("Accuracy 100%")).toBeVisible();
});

test("applies live feedback before the first painted frame", async ({
  page,
}) => {
  await importSong(page, { title: "First paint", lyrics: "Hello" });
  await page.getByRole("button", { name: "Start dictation" }).click();
  const editor = page.getByRole("textbox", { name: "Lyrics dictation editor" });
  await editor.focus();
  const firstPaint = observeFirstEditorPaint(page, 1);
  await editor.pressSequentially("H");
  expect(await firstPaint).toEqual({
    judgedText: "H",
    unjudgedText: "",
  });
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
  await expect(page.getByText(/Lyrics with timestamps such as/)).toBeVisible();
  await page.getByRole("button", { name: "Save song" }).click();
  await page.getByRole("button", { name: "Start dictation" }).click();

  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() === "PATCH")
      await route.abort("internetdisconnected");
    else await route.continue();
  });
  const editor = page.getByRole("textbox", { name: "Lyrics dictation editor" });
  await editor.fill("first line");
  await expect(
    page.getByText(/saved on this device|Not saved yet/),
  ).toBeVisible({
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
  await expect(page.getByText(/saved on this device/)).toBeVisible({
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
        const opened = indexedDB.open("lyrics-dictation-recovery", 3);
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
      "This dictation changed in another tab. Your text on this page has been kept. Choose which version to use.",
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
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({
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
    page.getByText(
      "This draft is saved on this device, but syncing is temporarily unavailable.",
    ),
  ).toBeVisible();
  allowSave = true;
  await page.getByRole("button", { name: "Try saving again" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
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
  await expect(page.getByText("0 attempts", { exact: true })).toBeVisible();
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
  await expect(page.getByText(/已保存|尚未保存/)).toBeVisible();
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
        const opened = indexedDB.open("lyrics-dictation-recovery", 3);
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
        const opened = indexedDB.open("lyrics-dictation-recovery", 3);
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

test("paints feedback immediately for a maximum-scale draft", async ({
  page,
}) => {
  const source = Array.from({ length: 30 }, () => "a".repeat(2_000)).join("\n");
  await importSong(page, { title: "Large feedback", lyrics: source });
  await page.getByRole("button", { name: "Start dictation" }).click();
  const editor = page.getByRole("textbox", { name: "Lyrics dictation editor" });
  await expect(editor).toBeVisible();
  const draft = `b${source.slice(1)}`;
  const firstPaint = observeFirstEditorPaint(page, draft.length);
  await editor.fill(draft);
  const firstPaintResult = await firstPaint;
  expect(firstPaintResult.unjudgedText).toBe("");
  expect(firstPaintResult.judgedText.length).toBeGreaterThan(0);
  await expect(page.getByText("Accuracy 100%")).toBeVisible();
  await expect(page.locator(".grade-summary")).toBeVisible();
  await editor.press("ControlOrMeta+Home");
  await expect(page.locator(".cm-judged-incorrect").first()).toContainText("b");
  await expect(
    page.getByRole("heading", { name: "You remembered the whole song" }),
  ).toHaveCount(0);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Submit dictation" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Dictation result" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Checking…")).toHaveCount(0);
  await expect(page.locator(".grade-correct strong")).toHaveText("59999");
  await expect(page.locator(".grade-incorrect strong")).toHaveText("1");
  await expect(page.locator(".cm-result-removed").first()).toHaveText("b");
  await expect(page.locator(".cm-result-replacement").first()).toHaveText("a");
});

test("renders a corrected result larger than the editable draft limit", async ({
  page,
}) => {
  const source = Array.from({ length: 30 }, () => "a".repeat(2_000)).join("\n");
  await importSong(page, { title: "Large result", lyrics: source });
  await page.getByRole("button", { name: "Start dictation" }).click();
  const editor = page.getByRole("textbox", { name: "Lyrics dictation editor" });
  await editor.fill("界".repeat(60_000));
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Submit dictation" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Dictation result" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".dictation-editor")).toHaveAttribute(
    "data-document-length",
    "120029",
    { timeout: 20_000 },
  );
  await expect(page.locator(".grade-incorrect strong")).toHaveText("60000");
  await expect(page.locator(".grade-missing strong")).toHaveText("0");
  await expect(page.getByText(/maximum supported size/i)).toHaveCount(0);
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
  await editor.press(
    process.platform === "darwin" ? "Meta+Shift+z" : "Control+y",
  );
  await expect(editor).toHaveText("abcd");

  await editor.press("ControlOrMeta+A");
  await editor.type("ab ,");
  await editor.press("Enter");
  await editor.type(" c—d♪ef");
  await expect(editor).toHaveText("ab ,\n c—d♪ef");
  await expect(page.getByText("Accuracy 100%")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "You remembered the whole song" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Submit dictation" }),
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
  await expect(page.getByText(/^Elapsed \d{2}:\d{2}$/u)).toBeVisible();
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
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({
    timeout: 5_000,
  });
  releaseSecondSave();
  await expect(second.getByText(/changed in another tab/)).toBeVisible({
    timeout: 5_000,
  });
  await expect(secondEditor).toHaveText("xyz");
  await second.getByRole("button", { name: "Use saved version" }).click();
  await expect(secondEditor).toHaveText("abc");
});

test("distinguishes rewritten mistakes from added omissions in results", async ({
  page,
}) => {
  await importSong(page, {
    title: "Result colors",
    lyrics: "还可以问候\n别忘记我",
  });
  await page.getByRole("button", { name: "Start dictation" }).click();
  await page
    .getByRole("textbox", { name: "Lyrics dictation editor" })
    .fill("还会问候\n别忘我");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Submit dictation" }).click();

  const addition = page.locator(".cm-result-addition");
  const removed = page.locator(".cm-result-removed");
  const replacement = page.locator(".cm-result-replacement");
  await expect(addition).toHaveText("记");
  await expect(removed).toHaveText("会");
  await expect(replacement).toHaveText("可以");
  const [additionBackground, replacementBackground] = await Promise.all([
    addition.evaluate((element) => getComputedStyle(element).backgroundColor),
    replacement.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ]);
  expect(additionBackground).not.toBe(replacementBackground);
  await expect(
    page.getByText("Red strikethrough: what you wrote"),
  ).toBeVisible();
  await expect(
    page.getByText("Yellow underline: corrected text"),
  ).toBeVisible();
  await expect(
    page.getByText("Green double underline: added omission"),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Reviewed dictation result" }),
  ).toHaveAttribute("aria-describedby", "result-change-legend");
  await expect(
    page.getByRole("region", {
      name: "Correct lyrics without revision marks",
    }),
  ).toContainText("还可以问候");
  expect(
    await replacement.evaluate(
      (element) => getComputedStyle(element).textDecorationStyle,
    ),
  ).toBe("solid");
  expect(
    await addition.evaluate(
      (element) => getComputedStyle(element).textDecorationStyle,
    ),
  ).toBe("double");
  expect(
    await removed.evaluate(
      (element) => getComputedStyle(element).textDecorationLine,
    ),
  ).toContain("line-through");
});

test("reveals a corrected result in place and reopens it from practice history", async ({
  page,
}) => {
  await importSong(page, { title: "Terminal attempt", lyrics: "a,b\nc" });
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect(
    page.getByRole("textbox", { name: "Lyrics dictation editor" }),
  ).toBeVisible();
  const activeElapsed = page.locator(".elapsed-time");
  const initialElapsed = await activeElapsed.textContent();
  await expect
    .poll(() => activeElapsed.textContent(), { timeout: 3_000 })
    .not.toBe(initialElapsed);
  const sessionUrl = page.url();
  await page
    .getByRole("textbox", { name: "Lyrics dictation editor" })
    .fill("a b xZ");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Submit dictation" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Dictation result" }),
  ).toBeVisible();
  await expect(page).toHaveURL(sessionUrl);
  await expect(page.locator(".result-banner")).toHaveCount(0);
  await expect(page.locator(".sync-state-wrap")).toHaveCount(0);
  await expect(page.getByText(/^Elapsed \d{2}:\d{2}$/u)).toBeVisible();
  const revealed = page.getByRole("textbox", {
    name: "Reviewed dictation result",
  });
  await expect(revealed).toHaveText("a b xZc");
  await expect(revealed).toHaveAttribute("aria-readonly", "true");
  expect(
    (await page.locator(".cm-judged-correct").allTextContents()).join(""),
  ).toBe("ab");
  await expect(page.locator(".cm-result-removed")).toHaveText("xZ");
  await expect(page.locator(".cm-result-replacement")).toHaveText("c");
  expect(
    await page
      .locator(".cm-result-removed")
      .evaluate((element) => getComputedStyle(element).textDecorationLine),
  ).toContain("line-through");

  await page.evaluate(
    ({ sessionId }) =>
      new Promise<void>((resolve, reject) => {
        const opened = indexedDB.open("lyrics-dictation-recovery", 3);
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
    page.getByRole("textbox", { name: "Reviewed dictation result" }),
  ).toHaveText("a b xZc");
  await expect(page.getByText(/changed in another tab/)).toHaveCount(0);

  await page.getByRole("link", { name: "Terminal attempt" }).click();
  await expect(page.getByText("1 attempt", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Practice history" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(page.locator(".song-card-metric")).toHaveText("1 attempt");
  await expect(page.locator(".song-card-characters")).toHaveText(
    "3 characters",
  );
  await expect(page.locator(".song-card")).not.toContainText("Accuracy");
  await expect(page.locator(".activity-section")).toHaveCount(0);
  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Practice history" }),
  ).toBeVisible();
  const historyResult = page.locator(".history-link").filter({
    hasText: "Terminal attempt",
  });
  await expect(historyResult).toContainText("Accuracy 50%");
  await expect(historyResult).toContainText(/Elapsed \d{2}:\d{2}/u);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await historyResult.click();
  await expect(page).toHaveURL(sessionUrl);
  await expect(
    page.getByRole("textbox", { name: "Reviewed dictation result" }),
  ).toHaveText("a b xZc");
  await expect(page.getByRole("link", { name: "Back to song" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Submit dictation" }),
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
  await expect(page.getByRole("heading", { name: "你的数据" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "请使用同一个浏览器" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "数据保留期限" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "基础使用统计" }),
  ).toBeVisible();
  await expect(page.getByText(/Cloudflare|D1|Cookie/u)).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除所有数据" }).click();
  await expect(
    page.getByText(
      "All lyrics, unfinished dictations, and dictation results have been deleted.",
    ),
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
  await expect(
    page.getByRole("button", { name: "Delete all my data" }),
  ).toBeVisible();

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
    page.getByText(
      "All lyrics, unfinished dictations, and dictation results have been deleted.",
    ),
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
  await expect(
    page.getByText(/saved on this device|Not saved yet/),
  ).toBeVisible();
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
    page.getByText(
      "All lyrics, unfinished dictations, and dictation results have been deleted.",
    ),
  ).toHaveCount(0);
  await expect(sibling.getByText("Local deletion retry")).toHaveCount(0);
  await expect(sibling.getByText("Loading…")).toBeVisible();
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
    page.getByText(
      "All lyrics, unfinished dictations, and dictation results have been deleted.",
    ),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const open = indexedDB.open("lyrics-dictation-recovery", 3);
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
    sibling.getByText(
      "All lyrics, unfinished dictations, and dictation results have been deleted.",
    ),
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
  await expect(
    page.getByText(/saved on this device|Not saved yet/),
  ).toBeVisible();
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
    page.getByText(
      "All lyrics, unfinished dictations, and dictation results have been deleted.",
    ),
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

test("pairs two browser devices, replaces local records, syncs, and leaves with a snapshot", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const deviceA = await contextA.newPage();
  const deviceB = await contextB.newPage();
  try {
    await importSong(deviceA, { title: "Shared device song", lyrics: "alpha" });
    await deviceA.goto("/devices");
    await deviceA.getByRole("button", { name: "Create pairing code" }).click();
    const code = await deviceA.locator(".pairing-code strong").innerText();
    expect(code).toMatch(/^[23456789A-Z]{4}(?:-[23456789A-Z]{4}){2}$/u);

    await importSong(deviceB, {
      title: "Local song to replace",
      lyrics: "beta",
    });
    await deviceB.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open("lyrics-dictation-recovery", 3);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const transaction = open.result.transaction("drafts", "readwrite");
            transaction.objectStore("drafts").put({
              sessionId: "local-recovery",
              songId: "local-song",
              draftText: "not synced",
              serverVersion: 1,
              updatedAt: Date.now(),
            });
            transaction.oncomplete = () => {
              open.result.close();
              resolve();
            };
            transaction.onerror = () => reject(transaction.error);
          };
        }),
    );
    await deviceB.goto("/devices");
    await deviceB.getByLabel("Pairing code").fill(code.toLowerCase());
    await deviceB.getByRole("button", { name: "Review join" }).click();
    await expect(
      deviceB.getByRole("heading", {
        name: "This device's records will be replaced",
      }),
    ).toBeVisible();
    await expect(deviceB.getByText(/erase 1 songs/u)).toBeVisible();
    deviceB.once("dialog", (dialog) => dialog.accept());
    await deviceB.getByRole("button", { name: "Join and sync" }).click();
    await expect(deviceB.getByText("This device is now paired")).toBeVisible();
    await expect(deviceB.getByText("2 devices currently share")).toBeVisible();
    await expect(deviceB.locator(".device-client-info")).toHaveCount(2);
    await expect(deviceB.locator(".device-client-info").first()).toContainText(
      /(?:Mac|Linux|Windows) · Chrome \d+/u,
    );
    await deviceB.getByRole("link", { name: "Library", exact: true }).click();
    await expect(deviceB.getByText("Shared device song")).toBeVisible();
    await expect(deviceB.getByText("Local song to replace")).toHaveCount(0);
    expect(
      await deviceB.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const open = indexedDB.open("lyrics-dictation-recovery", 3);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const transaction = open.result.transaction("drafts", "readonly");
              const count = transaction.objectStore("drafts").count();
              count.onsuccess = () => {
                const result = count.result;
                open.result.close();
                resolve(result);
              };
              count.onerror = () => reject(count.error);
            };
          }),
      ),
    ).toBe(0);

    await importSong(deviceB, {
      title: "Created on device B",
      lyrics: "gamma",
    });
    await deviceA.goto("/");
    await expect(deviceA.getByText("Created on device B")).toBeVisible();

    await deviceB.goto("/privacy");
    await expect(
      deviceB.getByText("leave the device group first"),
    ).toBeVisible();
    await expect(
      deviceB.getByRole("button", { name: "Delete all my data" }),
    ).toHaveCount(0);
    await deviceB.getByRole("link", { name: "Devices" }).last().click();
    deviceB.once("dialog", (dialog) => dialog.accept());
    await deviceB.getByRole("button", { name: "Leave device group" }).click();
    await expect(
      deviceB.getByText("This device currently has a private library."),
    ).toBeVisible();
    await deviceB.getByRole("link", { name: "Library", exact: true }).click();
    await expect(deviceB.getByText("Shared device song")).toBeVisible();
    await expect(deviceB.getByText("Created on device B")).toBeVisible();

    await importSong(deviceA, { title: "After split A only", lyrics: "delta" });
    await deviceB.goto("/");
    await expect(deviceB.getByText("After split A only")).toHaveCount(0);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("clears obsolete recovery after a join response is interrupted", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const deviceA = await contextA.newPage();
  const deviceB = await contextB.newPage();
  try {
    await importSong(deviceA, {
      title: "Recovery namespace song",
      lyrics: "alpha",
    });
    await deviceA.goto("/devices");
    await deviceA.getByRole("button", { name: "Create pairing code" }).click();
    const code = await deviceA.locator(".pairing-code strong").innerText();

    await deviceB.goto("/");
    await deviceB.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open("lyrics-dictation-recovery", 3);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const transaction = open.result.transaction("drafts", "readwrite");
            transaction.objectStore("drafts").put({
              sessionId: "obsolete-after-join",
              songId: "obsolete-song",
              draftText: "old local draft",
              serverVersion: 1,
              updatedAt: Date.now(),
            });
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
          };
        }),
    );
    const status = await deviceB.evaluate(async (pairingCode) => {
      const response = await fetch("/api/devices/join", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ code: pairingCode, confirmReplace: true }),
      });
      return response.status;
    }, code);
    expect(status).toBe(200);

    // Simulate the page disappearing after the server response but before the
    // device-management click handler can clear IndexedDB.
    await deviceB.reload();
    await expect(deviceB.getByText("Recovery namespace song")).toBeVisible();
    expect(
      await deviceB.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const open = indexedDB.open("lyrics-dictation-recovery", 3);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const transaction = open.result.transaction("drafts", "readonly");
              const count = transaction.objectStore("drafts").count();
              count.onsuccess = () => resolve(count.result);
              count.onerror = () => reject(count.error);
            };
          }),
      ),
    ).toBe(0);
  } finally {
    await contextA.close();
    await contextB.close();
  }
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

  await page.goto("/devices");
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

  await page.getByRole("textbox", { name: "歌词默写输入框" }).fill("One 三");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "提交默写" }).click();
  results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);

  await page.getByRole("link", { name: "Accessible Song" }).click();
  results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);

  await page.getByRole("link", { name: "记录", exact: true }).click();
  await expect(page.getByText("正确率 50%", { exact: true })).toBeVisible();
  await expect(page.getByText(/^耗时 \d{2}:\d{2}$/u)).toBeVisible();
  results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});
