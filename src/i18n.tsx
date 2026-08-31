import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Locale } from "./lib/constants";
import {
  PREFERENCES_CLEARED_EVENT,
  readPreference,
  subscribePreferenceChanges,
  writePreference,
} from "./preferences";

const en = {
  appName: "Lyrics Dictation",
  skipToContent: "Skip to content",
  library: "Library",
  importLyrics: "Import lyrics",
  privacy: "Privacy & data",
  language: "Language",
  english: "English",
  chinese: "简体中文",
  theme: "Theme",
  lightTheme: "Use light theme",
  darkTheme: "Use dark theme",
  loading: "Loading your library…",
  loadError: "We couldn’t load your library.",
  retry: "Try again",
  emptyTitle: "Your lyric shelf is ready",
  emptyBody:
    "Add lyrics you’re learning, then write the whole song from memory.",
  addFirstSong: "Add your first song",
  recentActivity: "Recent practice",
  songsCount: "{count} songs",
  songsCountOne: "{count} song",
  searchSongs: "Search songs or artists",
  sortLabel: "Sort library",
  sortRecent: "Recently updated",
  sortTitle: "Song title",
  viewMode: "Library layout",
  cardView: "Card view",
  listView: "List view",
  activeDraft: "Draft in progress",
  completedPractice: "{count} completed",
  completedPracticeShort: "{count} done",
  openSong: "Open {title}",
  untitledArtist: "Unknown artist",
  importTitle: "Bring in your lyrics",
  importIntro: "Paste plain text or LRC, or choose a local .txt or .lrc file.",
  chooseFile: "Choose a file",
  selectedFile: "Selected: {name}",
  lyricsSource: "Lyrics text",
  lyricsPlaceholder: "Paste plain lyrics or LRC here…",
  parseLyrics: "Review import",
  songTitle: "Song title",
  artist: "Artist",
  artistOptional: "Artist (optional)",
  sourceFormat: "Source format",
  plainText: "Plain text",
  lrc: "LRC",
  saveSong: "Save song",
  saving: "Saving…",
  cancel: "Cancel",
  back: "Back",
  study: "Study",
  startDictation: "Start dictation",
  resumeDictation: "Resume dictation",
  startOver: "Start over",
  startOverConfirm: "Abandon the current draft and start again?",
  editSong: "Edit song",
  deleteSong: "Delete song",
  deleteSongConfirm:
    "Delete this song and all of its practice history? This cannot be undone.",
  delete: "Delete",
  sourceUpdatedWarning:
    "Saving lyric changes will abandon any in-progress draft for this song.",
  lyricsHeading: "Lyrics",
  practiceHistory: "Practice history",
  noPractice: "No practice history yet.",
  viewResult: "View result",
  loadOlderResults: "Load older results",
  loadingOlderResults: "Loading…",
  dictationTitle: "Write from memory",
  dictationIntro:
    "Type the whole song freely. Spacing, line breaks, punctuation, and symbols do not affect correctness.",
  caseSensitive: "Match letter case",
  editorLabel: "Lyrics dictation editor",
  editorPlaceholder: "Begin writing from memory…",
  checking: "Checking…",
  synced: "Synced",
  savingDraft: "Saving…",
  notSynced: "Not yet synced",
  syncError: "Draft is safe on this device, but cloud sync failed.",
  retrySync: "Retry sync",
  versionConflict:
    "This draft changed elsewhere. Your local writing has been preserved.",
  useCloudDraft: "Use cloud draft",
  keepLocalDraft: "Keep mine and retry",
  correct: "Correct",
  incorrect: "Incorrect",
  extra: "Extra",
  missing: "Missing",
  missingHere: "Missing text here",
  progressLabel: "{percent}% of lyric content matched",
  gradingSummary:
    "{percent}% matched. {correct} correct, {incorrect} incorrect, {extra} extra, {missing} missing.",
  completedTitle: "You remembered the whole song",
  completedBody:
    "Every lyric character matches. Formatting differences were ignored.",
  resultPageTitle: "Dictation result",
  resultPageIntro:
    "Your formatting is preserved below. Green text was correct, yellow text was corrected or added, and struck text was extra.",
  resultEditorLabel: "Corrected dictation result",
  resultTitle: "Your result is ready",
  resultBody:
    "This attempt ended early and was saved. You can reopen it from practice history at any time.",
  practiceAgain: "Practice again",
  finishReveal: "End and reveal lyrics",
  revealConfirm:
    "End this attempt and reveal the lyrics? The session will be marked abandoned.",
  draftLimit: "This draft is at the maximum supported size.",
  dataTitle: "Your private lyric data",
  dataIntro:
    "Lyrics and progress are stored in Cloudflare D1 and linked only to an anonymous browser cookie.",
  identityWarningTitle: "This browser is your key",
  identityWarning:
    "Clearing cookies permanently loses access to this library. Data does not transfer to another browser or device.",
  retention:
    "Anonymous data is deleted after 365 days without a successful visit.",
  noAnalytics:
    "This app collects no analytics and does not fetch lyrics from third parties.",
  deleteAll: "Delete all my data",
  deleteAllConfirm:
    "Permanently delete every song, draft, practice record, and local recovery copy?",
  deleting: "Deleting…",
  dataDeleted: "All data was deleted from this browser and the cloud.",
  notFoundTitle: "This page is out of verse",
  notFoundBody: "The page may have moved or the record no longer exists.",
  goLibrary: "Return to library",
  statusCompleted: "Completed",
  statusAbandoned: "Ended early",
  startedAt: "Started {date}",
  duration: "{minutes} min",
  fileTypeError: "Choose a .txt or .lrc file.",
  fileDecodeError: "The file must be valid UTF-8 text.",
  error_TITLE_REQUIRED: "Enter a song title.",
  error_TITLE_TOO_LONG: "The song title is too long.",
  error_ARTIST_TOO_LONG: "The artist name is too long.",
  error_SOURCE_BYTES_EXCEEDED: "The lyrics file is larger than 256 KiB.",
  error_SOURCE_CHARS_EXCEEDED: "The lyrics contain too many characters.",
  error_SOURCE_LINES_EXCEEDED: "The lyrics contain more than 2,000 lines.",
  error_SOURCE_LINE_TOO_LONG: "One lyric line is longer than 2,000 characters.",
  error_LYRICS_CONTENT_REQUIRED: "Add at least one lyric letter or number.",
  error_STUDY_CONTENT_EXCEEDED:
    "Expanded LRC lyrics are too large for a dictation draft. Remove repeated timestamps or split the song.",
  error_UNSAFE_CONTROL_CHARACTER:
    "The text contains an unsupported invisible control character.",
  unsafePosition: "The first unsupported character is at position {position}.",
  error_DRAFT_BYTES_EXCEEDED: "The draft is larger than 256 KiB.",
  error_DRAFT_CHARS_EXCEEDED: "The draft contains too many characters.",
  error_REQUEST_BODY_TOO_LARGE: "The request body is too large.",
  error_UNSUPPORTED_MEDIA_TYPE: "This request must contain JSON.",
  error_INVALID_JSON: "The request contains invalid JSON.",
  error_VALIDATION_ERROR: "Some submitted fields are invalid.",
  error_ORIGIN_MISMATCH: "This change was blocked for security reasons.",
  error_IDEMPOTENCY_KEY_REQUIRED:
    "This change is missing its safe-retry identifier. Please try again.",
  error_IDEMPOTENCY_IN_PROGRESS:
    "This change is already being processed. Please try again shortly.",
  error_SESSION_NOT_ACTIVE: "This dictation is no longer active.",
  error_DICTATION_NOT_COMPLETE: "The dictation is not complete yet.",
  error_SONG_NOT_FOUND: "This song no longer exists.",
  error_SESSION_NOT_FOUND: "This dictation no longer exists.",
  error_IDENTITY_NOT_FOUND: "This browser identity is no longer available.",
  error_NOT_FOUND: "The requested resource was not found.",
  error_HTTP_ERROR: "The request could not be completed.",
  error_INTERNAL_ERROR: "The service encountered an error. Please try again.",
  error_VERSION_CONFLICT:
    "This record changed elsewhere. Reload and try again.",
  error_RATE_LIMITED:
    "Too many changes were sent. Wait a moment and try again.",
  error_NETWORK: "Check your connection and try again.",
  error_UNKNOWN: "Something went wrong. Please try again.",
} as const;

type MessageKey = keyof typeof en;
type Messages = Record<MessageKey, string>;

const zh: Messages = {
  appName: "歌词默写",
  skipToContent: "跳至正文",
  library: "歌词库",
  importLyrics: "导入歌词",
  privacy: "隐私与数据",
  language: "语言",
  english: "英文",
  chinese: "中文",
  theme: "主题",
  lightTheme: "切换到浅色模式",
  darkTheme: "切换到深色模式",
  loading: "正在加载歌词库…",
  loadError: "歌词库加载失败。",
  retry: "再试一次",
  emptyTitle: "还没有歌词",
  emptyBody: "导入一首想练习的歌，就可以开始整首默写。",
  addFirstSong: "导入歌词",
  recentActivity: "最近默写",
  songsCount: "{count} 首歌",
  songsCountOne: "{count} 首歌",
  searchSongs: "搜索歌名或歌手",
  sortLabel: "歌词排序",
  sortRecent: "最近修改",
  sortTitle: "按歌名排序",
  viewMode: "歌词库布局",
  cardView: "卡片视图",
  listView: "列表视图",
  activeDraft: "默写中",
  completedPractice: "已完成 {count} 次默写",
  completedPracticeShort: "{count} 次",
  openSong: "查看《{title}》",
  untitledArtist: "未填写歌手",
  importTitle: "导入歌词",
  importIntro: "粘贴纯文本或 LRC 歌词，或者上传本地 .txt / .lrc 文件。",
  chooseFile: "上传文件",
  selectedFile: "已选择 {name}",
  lyricsSource: "歌词内容",
  lyricsPlaceholder: "在这里粘贴纯文本或 LRC 歌词…",
  parseLyrics: "预览歌词",
  songTitle: "歌名",
  artist: "歌手",
  artistOptional: "歌手（可选）",
  sourceFormat: "歌词格式",
  plainText: "纯文本",
  lrc: "LRC",
  saveSong: "保存",
  saving: "正在保存…",
  cancel: "取消",
  back: "返回",
  study: "查看歌词",
  startDictation: "开始默写",
  resumeDictation: "继续默写",
  startOver: "重新默写",
  startOverConfirm: "当前默写还没完成，确定放弃并重新开始吗？",
  editSong: "编辑歌词",
  deleteSong: "删除这首歌",
  deleteSongConfirm: "确定删除这首歌和所有默写记录吗？删除后无法恢复。",
  delete: "删除",
  sourceUpdatedWarning: "保存修改后，当前未完成的默写将自动结束。",
  lyricsHeading: "歌词",
  practiceHistory: "默写记录",
  noPractice: "还没有默写记录。",
  viewResult: "查看结果",
  loadOlderResults: "查看更多记录",
  loadingOlderResults: "正在加载…",
  dictationTitle: "默写整首歌词",
  dictationIntro: "请凭记忆输入整首歌词。空格、换行、标点和符号不计入对错。",
  caseSensitive: "区分英文大小写",
  editorLabel: "歌词默写输入框",
  editorPlaceholder: "从记忆中写下歌词…",
  checking: "正在检查…",
  synced: "已同步到云端",
  savingDraft: "正在同步…",
  notSynced: "尚未同步",
  syncError: "草稿已保存在本机，但暂时无法同步到云端。",
  retrySync: "重新同步",
  versionConflict: "云端草稿已被修改。本机内容仍然保留，请选择要使用的版本。",
  useCloudDraft: "使用云端版本",
  keepLocalDraft: "保留本机版本",
  correct: "写对",
  incorrect: "写错",
  extra: "多写",
  missing: "漏写",
  missingHere: "这里有漏写",
  progressLabel: "已写对 {percent}%",
  gradingSummary:
    "已写对 {percent}%。写对 {correct}，写错 {incorrect}，多写 {extra}，漏写 {missing}。",
  completedTitle: "全部写对了",
  completedBody: "整首歌词都已写对；空格、换行、标点和符号不计入对错。",
  resultPageTitle: "默写结果",
  resultPageIntro:
    "下方保留了你的排版：绿色表示写对，黄色表示改正或补写，删除线表示多写。",
  resultEditorLabel: "已改正的默写结果",
  resultTitle: "本次默写已结束",
  resultBody: "结果已保存，之后可以随时从默写记录中打开查看。",
  practiceAgain: "再默写一次",
  finishReveal: "结束默写，查看歌词",
  revealConfirm: "确定结束并查看歌词吗？这次默写会记为“提前结束”。",
  draftLimit: "输入内容已达到长度上限。",
  dataTitle: "你的歌词数据",
  dataIntro:
    "歌词和默写进度会保存到 Cloudflare D1。应用使用浏览器中的匿名 Cookie 找回你的数据。",
  identityWarningTitle: "请不要清除这个浏览器的 Cookie",
  identityWarning:
    "Cookie 是访问歌词库的唯一凭据。清除后将无法找回数据，数据也不会自动同步到其他浏览器或设备。",
  retention: "连续 365 天未使用后，匿名数据会被自动删除。",
  noAnalytics: "本应用不收集分析数据，也不会从第三方获取歌词。",
  deleteAll: "删除所有数据",
  deleteAllConfirm:
    "确定永久删除所有歌词、草稿、默写记录和本机恢复数据吗？删除后无法恢复。",
  deleting: "正在删除…",
  dataDeleted: "本机和云端数据已全部删除。",
  notFoundTitle: "页面不存在",
  notFoundBody: "这个页面可能已被移动，或相关内容已被删除。",
  goLibrary: "返回歌词库",
  statusCompleted: "已完成",
  statusAbandoned: "提前结束",
  startedAt: "开始时间：{date}",
  duration: "{minutes} 分钟",
  fileTypeError: "请选择 .txt 或 .lrc 文件。",
  fileDecodeError: "无法读取文件，请确认它是 UTF-8 文本。",
  error_TITLE_REQUIRED: "请填写歌名。",
  error_TITLE_TOO_LONG: "歌名太长了。",
  error_ARTIST_TOO_LONG: "歌手名太长了。",
  error_SOURCE_BYTES_EXCEEDED: "歌词文件不能大于 256 KiB。",
  error_SOURCE_CHARS_EXCEEDED: "歌词内容太长了。",
  error_SOURCE_LINES_EXCEEDED: "歌词不能超过 2,000 行。",
  error_SOURCE_LINE_TOO_LONG: "单行歌词不能超过 2,000 个字符。",
  error_LYRICS_CONTENT_REQUIRED: "歌词中至少需要有一个文字或数字。",
  error_STUDY_CONTENT_EXCEEDED:
    "LRC 展开后过长。请删除重复时间标签，或把歌词拆成多首导入。",
  error_UNSAFE_CONTROL_CHARACTER: "歌词中含有不支持的隐藏控制字符。",
  unsafePosition: "第一个不支持的字符在第 {position} 位。",
  error_DRAFT_BYTES_EXCEEDED: "默写内容不能大于 256 KiB。",
  error_DRAFT_CHARS_EXCEEDED: "默写内容太长了。",
  error_REQUEST_BODY_TOO_LARGE: "提交的内容太大了。",
  error_UNSUPPORTED_MEDIA_TYPE: "请求格式不正确（需要 JSON）。",
  error_INVALID_JSON: "请求内容无法解析。",
  error_VALIDATION_ERROR: "部分内容填写有误。",
  error_ORIGIN_MISMATCH: "出于安全原因，这次操作已被拦截。",
  error_IDEMPOTENCY_KEY_REQUIRED: "本次操作缺少重试标识，请再试一次。",
  error_IDEMPOTENCY_IN_PROGRESS: "本次操作仍在处理中，请稍后再试。",
  error_SESSION_NOT_ACTIVE: "这次默写已经结束。",
  error_DICTATION_NOT_COMPLETE: "还有歌词没有写对。",
  error_SONG_NOT_FOUND: "这首歌已被删除或不存在。",
  error_SESSION_NOT_FOUND: "这次默写已被删除或不存在。",
  error_IDENTITY_NOT_FOUND: "这个浏览器的匿名凭据已失效。",
  error_NOT_FOUND: "找不到相关内容。",
  error_HTTP_ERROR: "暂时无法完成操作。",
  error_INTERNAL_ERROR: "服务暂时出错，请再试一次。",
  error_VERSION_CONFLICT: "内容已在其他标签页中修改，请刷新后再试。",
  error_RATE_LIMITED: "操作太频繁，请稍后再试。",
  error_NETWORK: "网络连接异常，请检查后再试。",
  error_UNKNOWN: "出了点问题，请再试一次。",
};

export const messageCatalogs: Record<Locale, Messages> = { en, "zh-CN": zh };

export const readLocalePreference = (): Locale | null => {
  const stored = readPreference("lyrics-dictation:locale");
  if (stored === "en" || stored === "zh-CN") return stored;
  return null;
};

export const detectBrowserLocale = (): Locale => {
  const preferences = navigator.languages.length
    ? navigator.languages
    : [navigator.language];
  for (const value of preferences) {
    const locale = value.toLowerCase();
    if (locale.split("-")[0] === "zh") return "zh-CN";
    if (locale === "en" || locale.startsWith("en-")) return "en";
  }
  return "en";
};

const detectLocale = (): Locale =>
  readLocalePreference() ?? detectBrowserLocale();

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  applyLocale: (locale: Locale) => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export const I18nProvider = ({ children }: { children: ReactNode }) => {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);
  const applyLocale = useCallback((next: Locale) => {
    setLocaleState(next);
  }, []);
  const setLocale = useCallback((next: Locale) => {
    writePreference("lyrics-dictation:locale", next);
    setLocaleState(next);
  }, []);
  useEffect(() => {
    const unsubscribe = subscribePreferenceChanges(({ key, value }) => {
      if (key !== "lyrics-dictation:locale") return;
      if (value === "en" || value === "zh-CN") {
        setLocaleState(value);
      } else {
        setLocaleState(detectBrowserLocale());
      }
    });
    // Close the render-to-effect race for changes made in another tab.
    setLocaleState(readLocalePreference() ?? detectBrowserLocale());
    const onCleared = () => setLocaleState(detectBrowserLocale());
    window.addEventListener(PREFERENCES_CLEARED_EVENT, onCleared);
    return () => {
      unsubscribe();
      window.removeEventListener(PREFERENCES_CLEARED_EVENT, onCleared);
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = messageCatalogs[locale].appName;
    const description = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    if (description) {
      description.content =
        locale === "zh-CN"
          ? "导入自己的歌词，在实时提示下练习整首默写。"
          : "Practice writing your own lyrics from memory with private, real-time feedback.";
    }
  }, [locale]);
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      applyLocale,
      t: (key, values = {}) =>
        Object.entries(values).reduce(
          (text, [name, replacement]) =>
            text.replaceAll(`{${name}}`, String(replacement)),
          messageCatalogs[locale][key],
        ),
    }),
    [applyLocale, locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useI18n = () => {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
};

export type { MessageKey };
