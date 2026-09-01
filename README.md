# Lyrics Dictation / 歌词默写

A bilingual web app for memorizing lyrics by writing the entire song from memory.

[Try it online](https://dictation.reporkey.com)

## English

### Import your own lyrics

- Paste plain text or LRC lyrics.
- Upload `.txt` or `.lrc` files.
- Add a song title and artist, then edit saved lyrics whenever needed.
- Manage your library with search, sorting, card view, or list view.

### Write freely with live check

- Type and add line breaks freely in one full-size editor.
- See correct, incorrect, extra, and missing content as you write.
- Turn live check on or off at any time.
- Spaces, line breaks, punctuation, and symbols do not affect correctness.
- Choose whether English letter case should matter.
- Missing answers are not revealed while dictation is in progress.

### Review results and progress

- Stay on the result page after submitting and review the corrected full text.
- Save the accuracy and elapsed time of every dictation.
- Reopen previous results from a dedicated practice history.

### Fits your preferences

- Use the interface in Chinese or English.
- Follow the browser language and system light or dark theme by default.
- Remember manual language, theme, and live-check choices for future visits.
- Save lyrics and dictation progress without creating an account.

### Sync selected devices

- Create a short-lived pairing code on one device and enter it on another.
- Share the lyric library, active drafts, and complete practice history across paired devices.
- Leave or remove a device without deleting its records: the departing device keeps a snapshot and stops receiving later updates.
- Joining replaces the joining device's existing records after an explicit second confirmation; records are never merged.

### Privacy and scope

- Imported lyrics and dictation text are not used for analytics, and lyrics are not fetched from third-party services.
- Delete all saved lyrics, progress, and dictation history after leaving any device group.
- No audio playback, online lyric search, or lyric scraping.
- Each browser remains an anonymous cookie credential. Pair another accessible device before clearing browser data; there is no account recovery.

---

## 中文

一款帮助你通过整首默写记忆歌词的中英文网页应用。

[在线体验](https://dictation.reporkey.com)

### 导入自己的歌词

- 粘贴纯文本或 LRC 歌词。
- 上传 `.txt` 或 `.lrc` 文件。
- 填写歌名和歌手，并随时编辑已保存的歌词。
- 通过搜索、排序、卡片或列表视图管理歌词库。

### 自由默写，实时检查

- 在一个完整的大输入框中自由输入和换行。
- 实时标出写对、写错、多写和漏写的内容。
- 可以随时开启或关闭实时检查。
- 空格、换行、标点和符号不影响正确与否。
- 可选择是否区分英文大小写。
- 不会在默写过程中直接显示遗漏的正确答案。

### 查看结果与进步

- 提交后留在结果页面，对照订正后的完整内容。
- 每次默写都会保存正确率和耗时。
- 在独立的默写记录中随时回看历次结果。

### 贴合你的使用习惯

- 支持中文和英文界面。
- 默认跟随浏览器语言与系统深浅色模式。
- 手动选择语言、主题或实时检查后，会记住你的偏好。
- 无需注册或登录即可保存歌词和默写进度。

### 同步指定设备

- 在一台设备生成短期配对码，再到另一台设备输入即可绑定。
- 绑定设备共享歌词库、未完成默写和全部默写记录。
- 自行退出或移出设备时不会丢失记录：离组设备保留当时的完整副本，之后不再接收更新。
- 加入端已有记录时，必须二次确认后才会被对方记录替换；不会自动合并。

### 隐私与产品边界

- 不会将导入的歌词或默写内容用于统计，也不会自动从其他网站获取歌词。
- 退出设备组后，可以删除本机的全部歌词、进度和默写记录。
- 不提供音频播放、在线歌词搜索或歌词抓取功能。
- 每个浏览器仍由匿名凭据识别；清除浏览器数据前请先配对另一台可访问设备，本应用不提供账号找回。

---

## Development

Requirements: Node.js 22 or later. The repository commits one npm lockfile.

```bash
npm ci
npm run db:migrate:local
npm run dev
```

Run the complete local quality gate with:

```bash
npm run check
```

The gate covers formatting, lint, generated Worker binding types, unit tests, the real Worker with a local D1 binding, Chromium E2E and accessibility flows, the production build, runtime dependency audit, and a Wrangler dry run. Tests use synthetic lyrics and do not require a deployed service.

### Architecture

- React, TypeScript, Vite, and CodeMirror provide the bilingual client and free-form editor.
- A Hono Cloudflare Worker serves the versioned JSON API and static assets.
- D1 stores anonymous device identities, shared data spaces, songs, drafts, and history. IndexedDB protects unsynced drafts on each device.
- An HttpOnly cookie authenticates one device. Pairing codes are short-lived single-use capabilities stored only as SHA-256 hashes. Clients never submit owner or data-space IDs.
- Device management keeps only a normalized platform, browser family, major version, and coarse device type for recognition. It does not store the full User-Agent or hardware identifiers.
- Leaving or removing a device uses an atomic D1 batch to clone the shared data into a private space while preserving opaque song/session IDs.

See [the device-sync decision](docs/device-sync-design.md) and [threat model](docs/threat-model.md).

### Production status

Device sync was deployed to [dictation.reporkey.com](https://dictation.reporkey.com) on 2026-09-01 after the complete local quality gate and an independent adversarial review passed. The production Worker, D1 migrations, anonymous-device bootstrap, security headers, and device-management screen were then verified remotely.

### Continuous deployment

Pushes to `main` run the complete GitHub Actions CI gate. After both the code-quality and Chromium jobs succeed, the production job:

1. verifies that the `lyrics-dictation` D1 database has no pending migrations;
2. builds and deploys the Worker and static assets without exposing deployment credentials to install or build scripts; and
3. verifies that production serves the exact Git commit, the D1-backed health check, and the SPA shell. A failed post-deploy check automatically rolls back to the preceding Worker version.

The job uses the GitHub `production` environment, which must allow only the `main` branch, and these environment secrets:

- `CLOUDFLARE_ACCOUNT_ID`: the target Cloudflare account ID shown by `npx wrangler whoami`;
- `CLOUDFLARE_API_TOKEN`: a dedicated token based on Cloudflare's **Edit Cloudflare Workers** template, extended with D1 access, and restricted to this account and the `reporkey.com` zone.

Create the token in Cloudflare, then add both secrets under **GitHub → Settings → Environments → production**. From an authenticated GitHub CLI, the equivalent commands are:

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID --env production
gh secret set CLOUDFLARE_API_TOKEN --env production
```

Never put the token in the repository or a local committed file. Production schema changes use a separately reviewed expand-contract rollout: first add and manually apply a backward-compatible migration, then deploy the Worker that uses it, and remove obsolete schema only in a later release after the old Worker is no longer running. CD refuses to deploy while migrations are pending. If post-deploy verification fails, the workflow runs `wrangler rollback` non-interactively and leaves the job red; verify the rollback at `/healthz` and the Cloudflare deployment history before retrying.
