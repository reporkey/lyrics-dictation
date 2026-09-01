import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const pageErrors = new WeakMap<object, Error[]>();

test.beforeEach(async ({ context }) => {
  const errors: Error[] = [];
  pageErrors.set(context, errors);
  const observe = (page: Page) =>
    page.on("pageerror", (error) => errors.push(error));
  context.pages().forEach(observe);
  context.on("page", observe);
});

test.afterEach(async ({ context }) => {
  expect(
    (pageErrors.get(context) ?? []).map((error) => error.message),
    "unexpected browser page errors",
  ).toEqual([]);
});

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

test("keeps a perfect draft editable and remembers the live check choice", async ({
  page,
}) => {
  await importSong(page);
  await page.getByRole("button", { name: "Start dictation" }).click();
  const editor = page.getByRole("textbox", { name: "Lyrics dictation editor" });
  await expect(editor).toBeVisible();
  await expect(page.locator(".cm-missing-marker")).toHaveCount(1);

  const feedback = page.getByRole("switch", { name: "Live check" });
  expect((await feedback.boundingBox())?.height).toBeGreaterThanOrEqual(32);
  await expect(feedback).toHaveAttribute("aria-checked", "true");
  await feedback.click();
  await expect(feedback).toHaveAttribute("aria-checked", "false");
  await expect(page.locator(".cm-missing-marker")).toHaveCount(0);
  await expect(page.locator(".grade-summary")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("lyrics-dictation:live-check"),
    ),
  ).toBe("off");

  await page.reload();
  await expect(feedback).toHaveAttribute("aria-checked", "false");
  await expect(page.locator(".cm-missing-marker")).toHaveCount(0);

  const sibling = await page.context().newPage();
  await sibling.goto(page.url());
  const siblingFeedback = sibling.getByRole("switch", { name: "Live check" });
  await expect(siblingFeedback).toHaveAttribute("aria-checked", "false");

  await editor.fill("Hxllo, world!\n你好");
  await expect(page.locator(".cm-judged-incorrect")).toHaveCount(0);
  await feedback.click();
  await expect(siblingFeedback).toHaveAttribute("aria-checked", "true");
  await sibling.close();
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

test("deduplicates data changes delivered by both browser transports", async ({
  context,
  page,
}) => {
  await importSong(page, { title: "Transport source", lyrics: "alpha" });
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect(
    page.getByRole("textbox", { name: "Lyrics dictation editor" }),
  ).toBeVisible();
  const sessionUrl = page.url();

  const sibling = await context.newPage();
  await sibling.goto(sessionUrl);
  await expect(
    sibling.getByRole("textbox", { name: "Lyrics dictation editor" }),
  ).toBeVisible();
  let bootstrapRequests = 0;
  let sessionRequests = 0;
  await sibling.route("**/api/bootstrap", async (route) => {
    bootstrapRequests += 1;
    await route.continue();
  });
  await sibling.route("**/api/sessions/*", async (route) => {
    if (route.request().method() === "GET") sessionRequests += 1;
    await route.continue();
  });

  const actor = await context.newPage();
  await importSong(actor, { title: "Transport trigger", lyrics: "beta" });
  await expect.poll(() => bootstrapRequests).toBe(1);
  await expect.poll(() => sessionRequests).toBe(1);
  await sibling.waitForTimeout(500);
  expect(bootstrapRequests).toBe(1);
  expect(sessionRequests).toBe(1);

  await actor.close();
  await sibling.close();
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
      const bootstrap = (await fetch("/api/bootstrap").then((response) =>
        response.json(),
      )) as { recoveryNamespace: string };
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          "X-Recovery-Namespace": bootstrap.recoveryNamespace,
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

test("cross-tab deletion immediately removes lyrics from detail and edit pages", async ({
  context,
  page,
}) => {
  await importSong(page, {
    title: "Delete everywhere",
    lyrics: "private words",
  });
  const detailUrl = page.url();
  const detail = await context.newPage();
  const edit = await context.newPage();
  await detail.goto(detailUrl);
  await edit.goto(detailUrl);
  await edit.getByRole("link", { name: "Edit song" }).click();
  await expect(edit.getByLabel("Lyrics text")).toHaveValue("private words");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete song" }).click();
  await expect(detail.getByText("private words")).toHaveCount(0);
  await expect(detail.getByText("This song no longer exists.")).toBeVisible();
  await expect(edit).toHaveURL("/");
  await expect(edit.getByText("private words")).toHaveCount(0);
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
  await page.evaluate(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "lyrics-dictation:data-deletion-started",
        newValue: "late-completed-attempt",
      }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "lyrics-dictation:data-deletion-cancelled",
        newValue: "late-completed-attempt",
      }),
    );
  });
  await page.waitForTimeout(200);
  await expect(
    page.getByText(
      "All lyrics, unfinished dictations, and dictation results have been deleted.",
    ),
  ).toBeVisible();
  expect(
    (await page.context().cookies()).filter((cookie) =>
      cookie.name.includes("ld_identity"),
    ),
  ).toHaveLength(0);
});

test("a late deletion-started event cannot reverse a finalized cancellation", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await page.evaluate(() => {
    const token = "cancelled-before-start";
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "lyrics-dictation:data-deletion-cancelled",
        newValue: token,
      }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "lyrics-dictation:data-deletion-started",
        newValue: token,
      }),
    );
  });
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading" })).toHaveCount(0);
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
  let heldBootstrap = false;
  await page.route("**/api/bootstrap", async (route) => {
    if (heldBootstrap) {
      await route.continue();
      return;
    }
    heldBootstrap = true;
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

test("a delayed old bootstrap cannot roll the mutation fence back after pairing", async ({
  browser,
}) => {
  const joiningContext = await browser.newContext();
  const destinationContext = await browser.newContext();
  const staleTab = await joiningContext.newPage();
  const joiningTab = await joiningContext.newPage();
  const destination = await destinationContext.newPage();
  try {
    await importSong(destination, {
      title: "New namespace library",
      lyrics: "shared",
    });
    await destination.goto("/devices");
    await destination
      .getByRole("button", { name: "Create pairing code" })
      .click();
    const code = await destination.locator(".pairing-code strong").innerText();

    await staleTab.goto("/");
    await joiningTab.goto("/devices");
    const oldNamespace = await joiningTab.evaluate(
      async () =>
        (
          (await (await fetch("/api/bootstrap")).json()) as {
            recoveryNamespace: string;
          }
        ).recoveryNamespace,
    );
    let captured!: () => void;
    let release!: () => void;
    const oldResponseCaptured = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const oldResponseRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdOnce = true;
    await staleTab.route("**/api/bootstrap", async (route) => {
      if (!holdOnce) {
        await route.continue();
        return;
      }
      holdOnce = false;
      const response = await route.fetch();
      captured();
      await oldResponseRelease;
      await route.fulfill({ response });
    });
    await staleTab.evaluate(() => {
      const channel = new BroadcastChannel("lyrics-dictation:data");
      channel.postMessage({ type: "changed", at: Date.now() });
      channel.close();
    });
    await oldResponseCaptured;

    const joined = await joiningTab.evaluate(
      async ({ pairingCode, namespace }) => {
        const response = await fetch("/api/devices/join", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
            "X-Recovery-Namespace": namespace,
          },
          body: JSON.stringify({ code: pairingCode, confirmReplace: true }),
        });
        return response.status;
      },
      { pairingCode: code, namespace: oldNamespace },
    );
    expect(joined).toBe(200);
    await joiningTab.evaluate(() => {
      const channel = new BroadcastChannel("lyrics-dictation:data");
      channel.postMessage({
        type: "data-space-replaced",
        token: crypto.randomUUID(),
        at: Date.now(),
      });
      channel.close();
    });
    release();
    await expect(staleTab.getByText("New namespace library")).toBeVisible();

    await importSong(staleTab, {
      title: "Written after namespace change",
      lyrics: "fresh write",
    });
    await destination.goto("/");
    await expect(
      destination.getByText("Written after namespace change"),
    ).toBeVisible();
  } finally {
    await joiningContext.close();
    await destinationContext.close();
  }
});

test("retries an ambiguous cloud deletion on the same page", async ({
  page,
}) => {
  await importSong(page, {
    title: "Ambiguous delete secret",
    lyrics: "private words",
  });
  await page.goto("/privacy");
  let deleteAttempts = 0;
  await page.route("**/api/data", async (route) => {
    deleteAttempts += 1;
    if (deleteAttempts === 1) {
      await route.fetch();
      await route.abort("internetdisconnected");
      return;
    }
    await route.continue();
  });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete all my data" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete all my data" }),
  ).toBeEnabled();
  expect(deleteAttempts).toBe(1);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete all my data" }).click();
  await expect(
    page.getByText(
      "All lyrics, unfinished dictations, and dictation results have been deleted.",
    ),
  ).toBeVisible();
  expect(deleteAttempts).toBe(2);
});

test("does not mistake a pre-server deletion failure for success", async ({
  page,
}) => {
  await importSong(page, {
    title: "Pre-server delete secret",
    lyrics: "must really delete",
  });
  await page.goto("/privacy");
  let deleteAttempts = 0;
  await page.route("**/api/data", async (route) => {
    deleteAttempts += 1;
    if (deleteAttempts === 1) {
      await route.abort("internetdisconnected");
      return;
    }
    await route.continue();
  });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete all my data" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete all my data" }).click();
  await expect(
    page.getByText(
      "All lyrics, unfinished dictations, and dictation results have been deleted.",
    ),
  ).toBeVisible();
  expect(deleteAttempts).toBe(2);
});

test("a stale privacy tab recovers when another device joins before deletion", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const stalePrivacy = await contextA.newPage();
  const deviceManager = await contextA.newPage();
  const joiningDevice = await contextB.newPage();
  try {
    await importSong(stalePrivacy, {
      title: "Paired deletion guard",
      lyrics: "private words",
    });
    await stalePrivacy.goto("/privacy");
    await expect(
      stalePrivacy.getByRole("button", { name: "Delete all my data" }),
    ).toBeVisible();
    const staleBootstrap = await stalePrivacy.evaluate(async () => {
      const response = await fetch("/api/bootstrap");
      return response.json();
    });

    await deviceManager.goto("/devices");
    await deviceManager
      .getByRole("button", { name: "Create pairing code" })
      .click();
    const code = await deviceManager
      .locator(".pairing-code strong")
      .innerText();
    await joiningDevice.goto("/devices");
    await joiningDevice.getByLabel("Pairing code").fill(code);
    await joiningDevice.getByRole("button", { name: "Review join" }).click();
    await joiningDevice.getByRole("button", { name: "Join and sync" }).click();
    await expect(
      joiningDevice.getByText("This device is now paired"),
    ).toBeVisible();

    let serveStaleBootstrap = true;
    await stalePrivacy.route("**/api/bootstrap", async (route) => {
      if (serveStaleBootstrap) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(staleBootstrap),
        });
      } else {
        await route.continue();
      }
    });
    await stalePrivacy.route("**/api/data", async (route) => {
      serveStaleBootstrap = false;
      await route.continue();
    });

    stalePrivacy.once("dialog", (dialog) => dialog.accept());
    await stalePrivacy
      .getByRole("button", { name: "Delete all my data" })
      .click();
    await expect(stalePrivacy.locator(".group-delete-blocked")).toContainText(
      "Leave the current device group before doing this.",
    );
    await expect(
      stalePrivacy
        .locator(".group-delete-blocked")
        .getByRole("link", { name: "Devices", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        stalePrivacy.evaluate(() =>
          localStorage.getItem("lyrics-dictation:deletion-pending"),
        ),
      )
      .toBeNull();
    expect(
      await stalePrivacy.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const open = indexedDB.open("lyrics-dictation-deletion", 1);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const transaction = open.result.transaction(
                "markers",
                "readonly",
              );
              const count = transaction.objectStore("markers").count();
              count.onsuccess = () => {
                open.result.close();
                resolve(count.result);
              };
              count.onerror = () => reject(count.error);
            };
          }),
      ),
    ).toBe(0);

    await expect(
      deviceManager.getByText("2 devices currently share"),
    ).toBeVisible();
    await stalePrivacy
      .locator(".group-delete-blocked")
      .getByRole("link", { name: "Devices", exact: true })
      .click();
    await expect(
      stalePrivacy.getByText("2 devices currently share"),
    ).toBeVisible();

    await stalePrivacy.goto("/privacy");
    await stalePrivacy.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          localStorage.setItem("lyrics-dictation:deletion-pending", "server");
          const open = indexedDB.open("lyrics-dictation-deletion", 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const transaction = open.result.transaction("markers", "readwrite");
            transaction
              .objectStore("markers")
              .put("server", "lyrics-dictation:deletion-pending");
            transaction.oncomplete = () => {
              open.result.close();
              resolve();
            };
            transaction.onerror = () => reject(transaction.error);
          };
        }),
    );
    await stalePrivacy.reload();
    await expect(stalePrivacy.locator(".group-delete-blocked")).toContainText(
      "Leave the current device group before doing this.",
    );
    await expect
      .poll(() =>
        stalePrivacy.evaluate(() =>
          localStorage.getItem("lyrics-dictation:deletion-pending"),
        ),
      )
      .toBeNull();
    await expect(
      deviceManager.getByText("2 devices currently share"),
    ).toBeVisible();
  } finally {
    await stalePrivacy.unrouteAll({ behavior: "ignoreErrors" });
    await contextA.close();
    await contextB.close();
  }
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
  await page.getByRole("switch", { name: "Live check" }).click();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("lyrics-dictation:live-check"),
    ),
  ).toBe("off");
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
  expect(
    await page.evaluate(() =>
      localStorage.getItem("lyrics-dictation:live-check"),
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
      page.evaluate(async () => {
        const open = indexedDB.open("lyrics-dictation-recovery", 3);
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          open.onerror = () => reject(open.error);
          open.onsuccess = () => resolve(open.result);
        });
        const transaction = database.transaction(
          ["drafts", "meta"],
          "readonly",
        );
        const count = (store: "drafts" | "meta") =>
          new Promise<number>((resolve, reject) => {
            const request = transaction.objectStore(store).count();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
          });
        const [drafts, meta] = await Promise.all([
          count("drafts"),
          count("meta"),
        ]);
        database.close();
        return { drafts, meta };
      }),
    )
    .toEqual({ drafts: 0, meta: 0 });
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

test("drops unscoped version-2 recovery drafts during migration", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      const open = indexedDB.open("lyrics-dictation-recovery", 2);
      open.onupgradeneeded = () => {
        const drafts = open.result.createObjectStore("drafts", {
          keyPath: "sessionId",
        });
        drafts.createIndex("by-song", "songId");
        drafts.put({
          sessionId: "legacy-session",
          songId: "legacy-song",
          draftText: "lyrics from a previous anonymous identity",
          serverVersion: 1,
          updatedAt: Date.now(),
        });
      };
      open.onsuccess = () => open.result.close();
    });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Your lyric shelf is ready" }),
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
                count.onsuccess = () => {
                  open.result.close();
                  resolve(count.result);
                };
              };
            }),
        ),
      )
      .toBe(0);
  } finally {
    await context.close();
  }
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
  await contextB.addInitScript(() => {
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: undefined,
    });
  });
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
    await deviceB.route("**/api/sessions/*", async (route) => {
      if (route.request().method() === "PATCH")
        await route.abort("internetdisconnected");
      else await route.continue();
    });
    await deviceB.getByRole("button", { name: "Start dictation" }).click();
    const leavingDraft = deviceB.getByRole("textbox", {
      name: "Lyrics dictation editor",
    });
    await leavingDraft.fill("unsynced draft kept after leaving");
    await expect(
      deviceB.getByText(/saved on this device|Not saved yet/u),
    ).toBeVisible();
    await deviceA.goto("/");
    await expect(deviceA.getByText("Created on device B")).toBeVisible();

    await deviceB.goto("/privacy");
    await expect(
      deviceB.getByText(
        "Leave the current device group before doing this. The remaining devices keep their own shared copy.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      deviceB.getByRole("button", { name: "Delete all my data" }),
    ).toHaveCount(0);
    const deviceBSibling = await contextB.newPage();
    await deviceBSibling.goto("/privacy");
    await expect(deviceBSibling.locator(".group-delete-blocked")).toBeVisible();
    await deviceB.getByRole("link", { name: "Devices" }).last().click();
    const leaveKeys: string[] = [];
    await deviceB.route("**/api/devices/leave", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      leaveKeys.push(route.request().headers()["idempotency-key"] ?? "");
      await route.fetch();
      await route.abort("internetdisconnected");
    });
    deviceB.once("dialog", (dialog) => dialog.accept());
    await deviceB.getByRole("button", { name: "Leave device group" }).click();
    await expect(
      deviceB.getByText("This device currently has a private library."),
    ).toBeVisible();
    await expect(deviceB.getByText("This device is now paired")).toHaveCount(0);
    await expect(
      deviceBSibling.getByRole("button", { name: "Delete all my data" }),
    ).toBeVisible();
    await expect(deviceBSibling.locator(".group-delete-blocked")).toHaveCount(
      0,
    );
    expect(leaveKeys).toHaveLength(2);
    expect(new Set(leaveKeys).size).toBe(1);
    await deviceB.unroute("**/api/sessions/*");
    await deviceB.getByRole("link", { name: "Library", exact: true }).click();
    await expect(deviceB.getByText("Shared device song")).toBeVisible();
    await expect(deviceB.getByText("Created on device B")).toBeVisible();
    await deviceB.getByText("Created on device B", { exact: true }).click();
    await deviceB.getByRole("button", { name: "Resume dictation" }).click();
    await expect(
      deviceB.getByRole("textbox", { name: "Lyrics dictation editor" }),
    ).toHaveText("unsynced draft kept after leaving");

    await importSong(deviceA, { title: "After split A only", lyrics: "delta" });
    await deviceB.goto("/");
    await expect(deviceB.getByText("After split A only")).toHaveCount(0);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("joining a device stops stale unsynced editors from restoring replaced data", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const deviceA = await contextA.newPage();
  const staleEditor = await contextB.newPage();
  try {
    await importSong(deviceA, {
      title: "Shared replacement song",
      lyrics: "alpha",
    });
    await deviceA.goto("/devices");
    await deviceA.getByRole("button", { name: "Create pairing code" }).click();
    const code = await deviceA.locator(".pairing-code strong").innerText();

    await importSong(staleEditor, {
      title: "Discarded local song",
      lyrics: "beta",
    });
    await staleEditor.getByRole("button", { name: "Start dictation" }).click();
    await staleEditor.route("**/api/sessions/*", async (route) => {
      if (route.request().method() === "PATCH")
        await route.abort("internetdisconnected");
      else await route.continue();
    });
    await staleEditor
      .getByRole("textbox", { name: "Lyrics dictation editor" })
      .fill("unsynced discarded draft");
    await expect(
      staleEditor.getByText(/saved on this device|Not saved yet/u),
    ).toBeVisible();
    await expect
      .poll(() =>
        staleEditor.evaluate(
          () =>
            new Promise<number>((resolve, reject) => {
              const open = indexedDB.open("lyrics-dictation-recovery", 3);
              open.onerror = () => reject(open.error);
              open.onsuccess = () => {
                const transaction = open.result.transaction(
                  "drafts",
                  "readonly",
                );
                const count = transaction.objectStore("drafts").count();
                count.onsuccess = () => {
                  open.result.close();
                  resolve(count.result);
                };
                count.onerror = () => reject(count.error);
              };
            }),
        ),
      )
      .toBe(1);

    const joinPage = await contextB.newPage();
    await joinPage.goto("/devices");
    await joinPage.getByLabel("Pairing code").fill(code);
    await joinPage.getByRole("button", { name: "Review join" }).click();
    joinPage.once("dialog", (dialog) => dialog.accept());
    await joinPage.getByRole("button", { name: "Join and sync" }).click();
    await expect(joinPage.getByText("This device is now paired")).toBeVisible();

    await expect(staleEditor).toHaveURL("/");
    await expect(
      staleEditor.getByText("Shared replacement song"),
    ).toBeVisible();
    await expect(staleEditor.getByText("Discarded local song")).toHaveCount(0);
    await staleEditor.waitForTimeout(1_200);
    await expect
      .poll(() =>
        staleEditor.evaluate(
          () =>
            new Promise<number>((resolve, reject) => {
              const open = indexedDB.open("lyrics-dictation-recovery", 3);
              open.onerror = () => reject(open.error);
              open.onsuccess = () => {
                const transaction = open.result.transaction(
                  "drafts",
                  "readonly",
                );
                const count = transaction.objectStore("drafts").count();
                count.onsuccess = () => {
                  open.result.close();
                  resolve(count.result);
                };
                count.onerror = () => reject(count.error);
              };
            }),
        ),
      )
      .toBe(0);
    await joinPage.close();
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("reports recovery storage failures before joining a device", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const deviceA = await contextA.newPage();
  const deviceB = await contextB.newPage();
  try {
    await deviceA.goto("/devices");
    await deviceA.getByRole("button", { name: "Create pairing code" }).click();
    const code = await deviceA.locator(".pairing-code strong").innerText();

    await deviceB.goto("/devices");
    await deviceB.getByLabel("Pairing code").fill(code);
    await deviceB.getByRole("button", { name: "Review join" }).click();
    await expect(
      deviceB.getByRole("heading", {
        name: "This device's records will be replaced",
      }),
    ).toBeVisible();

    await deviceB.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = (() => {
        throw new DOMException("Recovery storage unavailable", "UnknownError");
      }) as typeof IDBDatabase.prototype.transaction;
      (
        globalThis as typeof globalThis & {
          restoreRecoveryTransaction?: () => void;
        }
      ).restoreRecoveryTransaction = () => {
        IDBDatabase.prototype.transaction = original;
      };
    });

    await deviceB.getByRole("button", { name: "Join and sync" }).click();
    await expect(deviceB.locator(".notice-error")).toBeVisible();
    await expect(
      deviceB.getByText("This device currently has a private library."),
    ).toBeVisible();
    await expect(deviceB.getByText("This device is now paired")).toHaveCount(0);

    await deviceB.evaluate(() => {
      (
        globalThis as typeof globalThis & {
          restoreRecoveryTransaction?: () => void;
        }
      ).restoreRecoveryTransaction?.();
    });
    await deviceB.getByRole("button", { name: "Join and sync" }).click();
    await expect(deviceB.getByText("This device is now paired")).toBeVisible();
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
      const bootstrap = (await (await fetch("/api/bootstrap")).json()) as {
        recoveryNamespace: string;
      };
      const response = await fetch("/api/devices/join", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          "X-Recovery-Namespace": bootstrap.recoveryNamespace,
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

test("reconciles pairing when both join responses are lost", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const deviceA = await contextA.newPage();
  const deviceB = await contextB.newPage();
  try {
    await importSong(deviceA, {
      title: "Ambiguous pairing destination",
      lyrics: "shared words",
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
              sessionId: "ambiguous-join-draft",
              songId: "old-song",
              draftText: "must be cleared",
              serverVersion: 1,
              updatedAt: Date.now(),
            });
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
          };
        }),
    );
    await deviceB.goto("/devices");
    await deviceB.getByLabel("Pairing code").fill(code);
    await deviceB.getByRole("button", { name: "Review join" }).click();
    deviceB.once("dialog", (dialog) => dialog.accept());
    let joinAttempts = 0;
    await deviceB.route("**/api/devices/join", async (route) => {
      joinAttempts += 1;
      await route.fetch();
      await route.abort("internetdisconnected");
    });

    await deviceB.getByRole("button", { name: "Join and sync" }).click();
    await expect(deviceB.getByText("This device is now paired")).toBeVisible();
    expect(joinAttempts).toBe(2);
    await deviceB.goto("/");
    await expect(
      deviceB.getByText("Ambiguous pairing destination"),
    ).toBeVisible();
    expect(
      await deviceB.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const open = indexedDB.open("lyrics-dictation-recovery", 3);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const count = open.result
                .transaction("drafts", "readonly")
                .objectStore("drafts")
                .count();
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

test("a deletion marker failure restores the usable app without deleting data", async ({
  page,
}) => {
  await importSong(page, {
    title: "Marker failure remains",
    lyrics: "still private",
  });
  await page.goto("/privacy");
  await page.evaluate(() => {
    const originalSetItem = Storage.prototype.setItem;
    const originalTransaction = IDBDatabase.prototype.transaction;
    Storage.prototype.setItem = function (key, value) {
      if (key === "lyrics-dictation:deletion-pending") {
        throw new DOMException("Storage unavailable", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    };
    IDBDatabase.prototype.transaction = function (...args) {
      if (
        this.name === "lyrics-dictation-deletion" &&
        args[1] === "readwrite"
      ) {
        throw new DOMException("IndexedDB unavailable", "UnknownError");
      }
      return originalTransaction.call(
        this,
        args[0] as string | string[],
        args[1],
        args[2],
      );
    };
    (
      globalThis as typeof globalThis & {
        restoreDeletionStorage?: () => void;
      }
    ).restoreDeletionStorage = () => {
      Storage.prototype.setItem = originalSetItem;
      IDBDatabase.prototype.transaction = originalTransaction;
    };
  });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete all my data" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete all my data" }),
  ).toBeEnabled();

  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & {
        restoreDeletionStorage?: () => void;
      }
    ).restoreDeletionStorage?.();
  });
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(page.getByText("Marker failure remains")).toBeVisible();
});

test("reports when neither the server nor local recovery can save a draft", async ({
  page,
}) => {
  await importSong(page, { title: "Unsafe draft", lyrics: "abcdef" });
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect(
    page.getByRole("textbox", { name: "Lyrics dictation editor" }),
  ).toBeVisible();
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.abort("internetdisconnected");
    } else {
      await route.continue();
    }
  });
  await page.evaluate(() => {
    const originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      if (
        this.name === "lyrics-dictation-recovery" &&
        args[1] === "readwrite"
      ) {
        throw new DOMException("Recovery unavailable", "UnknownError");
      }
      return originalTransaction.call(
        this,
        args[0] as string | string[],
        args[1],
        args[2],
      );
    };
  });

  await page
    .getByRole("textbox", { name: "Lyrics dictation editor" })
    .fill("abc");
  await expect(
    page.getByText(
      "This draft is not safely saved. Keep this page open and try saving again.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This draft is saved on this device, but syncing is temporarily unavailable.",
    ),
  ).toHaveCount(0);
});

test("keeps the unsafe warning visible and pagehide retries a hanging cloud save", async ({
  page,
}) => {
  await importSong(page, { title: "Hanging unsafe draft", lyrics: "abcdef" });
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect(
    page.getByRole("textbox", { name: "Lyrics dictation editor" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      if (
        this.name === "lyrics-dictation-recovery" &&
        args[1] === "readwrite"
      ) {
        throw new DOMException("Recovery unavailable", "UnknownError");
      }
      return originalTransaction.call(
        this,
        args[0] as string | string[],
        args[1],
        args[2],
      );
    };
  });
  let releaseFirst = () => {};
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markSecond!: () => void;
  const secondSeen = new Promise<void>((resolve) => {
    markSecond = resolve;
  });
  let saves = 0;
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    saves += 1;
    if (saves === 1) {
      await firstHeld;
      await route.abort("internetdisconnected");
      return;
    }
    markSecond();
    await route.continue();
  });

  try {
    await page
      .getByRole("textbox", { name: "Lyrics dictation editor" })
      .fill("abc");
    await expect(
      page.getByText(
        "This draft is not safely saved. Keep this page open and try saving again.",
      ),
    ).toBeVisible();
    await expect.poll(() => saves).toBe(1);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide")),
    );
    await secondSeen;
    expect(saves).toBe(2);
    releaseFirst();
    await expect.poll(() => saves).toBe(3);
  } finally {
    releaseFirst();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("requires a fresh pairing review when target data changes after preview", async ({
  browser,
}) => {
  const sourceContext = await browser.newContext();
  const targetContext = await browser.newContext();
  const source = await sourceContext.newPage();
  const joinPage = await targetContext.newPage();
  const targetWriter = await targetContext.newPage();
  try {
    await source.goto("/devices");
    await source.getByRole("button", { name: "Create pairing code" }).click();
    const code = await source.locator(".pairing-code strong").innerText();

    await joinPage.goto("/devices");
    await joinPage.getByLabel("Pairing code").fill(code);
    await joinPage.getByRole("button", { name: "Review join" }).click();
    await expect(
      joinPage.getByText(
        "Joining will load the paired library on this device. Local unsynced drafts, if any, will be cleared.",
      ),
    ).toBeVisible();

    await importSong(targetWriter, {
      title: "Arrived after preview",
      lyrics: "must confirm",
    });
    await joinPage.getByRole("button", { name: "Join and sync" }).click();
    await expect(joinPage.getByRole("alert")).toBeVisible();
    await expect(
      joinPage.getByRole("button", { name: "Join and sync" }),
    ).toHaveCount(0);
    await expect(
      joinPage.getByRole("button", { name: "Review join" }),
    ).toBeEnabled();
    await expect(joinPage.getByText("This device is now paired")).toHaveCount(
      0,
    );
  } finally {
    await sourceContext.close();
    await targetContext.close();
  }
});

test("a dirty edit keeps its original version and cannot overwrite another tab", async ({
  page,
}) => {
  await importSong(page, {
    title: "Concurrent edit baseline",
    lyrics: "original lyrics",
  });
  const detailUrl = page.url();
  const otherTab = await page.context().newPage();
  await page.getByRole("link", { name: "Edit song" }).click();
  await page.getByLabel("Song title").fill("Unsaved local title");

  await otherTab.goto(detailUrl);
  await otherTab.getByRole("link", { name: "Edit song" }).click();
  await otherTab.getByLabel("Song title").fill("Committed remote title");
  await otherTab.getByRole("button", { name: "Save song" }).click();
  await expect(
    otherTab.getByRole("heading", { name: "Committed remote title" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Save song" }).click();
  await expect(
    page.getByText("This record changed elsewhere. Reload and try again."),
  ).toBeVisible();
  await expect(page.getByLabel("Song title")).toHaveValue(
    "Unsaved local title",
  );
  await otherTab.reload();
  await expect(
    otherTab.getByRole("heading", { name: "Committed remote title" }),
  ).toBeVisible();
});

test("an older song refresh cannot replace a newer response", async ({
  page,
}) => {
  await importSong(page, {
    title: "Refresh race baseline",
    lyrics: "original lyrics",
  });
  const detailUrl = page.url();
  const writer = await page.context().newPage();
  let captureFirst!: () => void;
  let releaseFirst!: () => void;
  const firstCaptured = new Promise<void>((resolve) => {
    captureFirst = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let songReads = 0;
  await page.route("**/api/songs/*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    songReads += 1;
    if (songReads !== 1) {
      await route.continue();
      return;
    }
    const staleResponse = await route.fetch();
    captureFirst();
    await firstRelease;
    await route.fulfill({ response: staleResponse });
  });

  try {
    await writer.goto(detailUrl);
    await writer.getByRole("link", { name: "Edit song" }).click();
    await writer.getByLabel("Song title").fill("First remote title");
    await writer.getByRole("button", { name: "Save song" }).click();
    await firstCaptured;

    await writer.getByRole("link", { name: "Edit song" }).click();
    await writer.getByLabel("Song title").fill("Newest remote title");
    await writer.getByRole("button", { name: "Save song" }).click();
    await expect(
      page.getByRole("heading", { name: "Newest remote title" }),
    ).toBeVisible();
    releaseFirst();
    await page.waitForTimeout(300);
    await expect(
      page.getByRole("heading", { name: "Newest remote title" }),
    ).toBeVisible();
    await expect(page.getByText("First remote title")).toHaveCount(0);
  } finally {
    releaseFirst();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await writer.close();
  }
});

test("reconciles an edited song when both save responses are lost", async ({
  page,
}) => {
  await importSong(page, {
    title: "Edit response baseline",
    lyrics: "original lyrics",
  });
  await page.getByRole("link", { name: "Edit song" }).click();
  await page.getByLabel("Song title").fill("Saved despite lost responses");
  const keys: string[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route("**/api/songs/*", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    if (keys.length === 1) await firstHeld;
    await route.fetch();
    await route.abort("internetdisconnected");
  });

  try {
    await page.getByRole("button", { name: "Save song" }).click();
    await expect(page.getByLabel("Song title")).toBeDisabled();
  } finally {
    releaseFirst();
  }
  await expect(
    page.getByRole("heading", { name: "Saved despite lost responses" }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(1);
});

test("an edit started before pairing cannot write into the replacement library", async ({
  browser,
}) => {
  const sourceContext = await browser.newContext();
  const targetContext = await browser.newContext();
  const source = await sourceContext.newPage();
  const staleEdit = await targetContext.newPage();
  const joinPage = await targetContext.newPage();
  try {
    await importSong(source, {
      title: "Shared edit fence",
      lyrics: "source lyrics",
    });
    await source.goto("/devices");
    await source.getByRole("button", { name: "Create pairing code" }).click();
    const code = await source.locator(".pairing-code strong").innerText();

    await importSong(staleEdit, {
      title: "Discarded edit source",
      lyrics: "target lyrics",
    });
    await staleEdit.getByRole("link", { name: "Edit song" }).click();
    await staleEdit.getByLabel("Song title").fill("Must never cross spaces");

    let captureEdit!: () => void;
    let releaseEdit!: () => void;
    const editCaptured = new Promise<void>((resolve) => {
      captureEdit = resolve;
    });
    const editRelease = new Promise<void>((resolve) => {
      releaseEdit = resolve;
    });
    await staleEdit.route("**/api/songs/*", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      captureEdit();
      await editRelease;
      await route.continue().catch(() => undefined);
    });
    await staleEdit.getByRole("button", { name: "Save song" }).click();
    await editCaptured;

    await joinPage.goto("/devices");
    await joinPage.getByLabel("Pairing code").fill(code);
    await joinPage.getByRole("button", { name: "Review join" }).click();
    joinPage.once("dialog", (dialog) => dialog.accept());
    await joinPage.getByRole("button", { name: "Join and sync" }).click();
    await expect(joinPage.getByText("This device is now paired")).toBeVisible();
    releaseEdit();

    await expect(staleEdit).toHaveURL("/");
    await expect(staleEdit.getByText("Shared edit fence")).toBeVisible();
    await expect(staleEdit.getByText("Must never cross spaces")).toHaveCount(0);
  } finally {
    await sourceContext.close();
    await targetContext.close();
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
