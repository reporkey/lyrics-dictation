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
  searchSongs: "Search songs or artists",
  sortLabel: "Sort library",
  sortRecent: "Recently updated",
  sortTitle: "Song title",
  activeDraft: "Draft in progress",
  completedPractice: "{count} completed",
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
  noPractice: "No completed practice yet.",
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
  skipToContent: "跳到主要内容",
  library: "歌词库",
  importLyrics: "导入歌词",
  privacy: "隐私与数据",
  language: "语言",
  english: "English",
  chinese: "简体中文",
  theme: "主题",
  lightTheme: "使用浅色主题",
  darkTheme: "使用深色主题",
  loading: "正在加载歌词库…",
  loadError: "暂时无法加载歌词库。",
  retry: "重试",
  emptyTitle: "你的歌词架准备好了",
  emptyBody: "添加正在学习的歌词，然后凭记忆默写整首歌。",
  addFirstSong: "添加第一首歌",
  recentActivity: "最近练习",
  songsCount: "{count} 首歌",
  searchSongs: "搜索歌名或歌手",
  sortLabel: "歌词库排序",
  sortRecent: "最近更新",
  sortTitle: "按歌名",
  activeDraft: "有未完成的草稿",
  completedPractice: "已完成 {count} 次",
  openSong: "打开《{title}》",
  untitledArtist: "未知歌手",
  importTitle: "导入你的歌词",
  importIntro: "粘贴纯文本或 LRC，也可以选择本地 .txt 或 .lrc 文件。",
  chooseFile: "选择文件",
  selectedFile: "已选择：{name}",
  lyricsSource: "歌词文本",
  lyricsPlaceholder: "在这里粘贴纯歌词或 LRC…",
  parseLyrics: "检查导入内容",
  songTitle: "歌名",
  artist: "歌手",
  artistOptional: "歌手（可选）",
  sourceFormat: "源格式",
  plainText: "纯文本",
  lrc: "LRC",
  saveSong: "保存歌曲",
  saving: "正在保存…",
  cancel: "取消",
  back: "返回",
  study: "学习",
  startDictation: "开始默写",
  resumeDictation: "继续默写",
  startOver: "重新开始",
  startOverConfirm: "放弃当前草稿并重新开始吗？",
  editSong: "编辑歌曲",
  deleteSong: "删除歌曲",
  deleteSongConfirm: "删除这首歌及其全部练习记录？此操作无法撤销。",
  delete: "删除",
  sourceUpdatedWarning: "保存歌词修改会结束这首歌尚未完成的草稿。",
  lyricsHeading: "歌词",
  practiceHistory: "练习记录",
  noPractice: "还没有完成过练习。",
  dictationTitle: "凭记忆写下整首歌",
  dictationIntro: "自由输入整首歌词。空格、换行、标点和符号都不会影响正确性。",
  caseSensitive: "区分大小写",
  editorLabel: "歌词默写编辑器",
  editorPlaceholder: "开始凭记忆输入…",
  checking: "正在核对…",
  synced: "已同步",
  savingDraft: "正在保存…",
  notSynced: "尚未同步",
  syncError: "草稿已安全保存在本设备，但云端同步失败。",
  retrySync: "重试同步",
  versionConflict: "这份草稿已在别处变化，你的本地输入仍然保留。",
  useCloudDraft: "使用云端草稿",
  keepLocalDraft: "保留本地并重试",
  correct: "正确",
  incorrect: "错误",
  extra: "多余",
  missing: "遗漏",
  missingHere: "此处有遗漏",
  progressLabel: "已匹配 {percent}% 的歌词内容",
  gradingSummary:
    "已匹配 {percent}%。正确 {correct}，错误 {incorrect}，多余 {extra}，遗漏 {missing}。",
  completedTitle: "你完整记住了这首歌",
  completedBody: "所有歌词内容都已匹配，排版差异已自动忽略。",
  practiceAgain: "再练一次",
  finishReveal: "结束并查看歌词",
  revealConfirm: "结束本次默写并查看歌词吗？本次记录会标记为提前结束。",
  draftLimit: "草稿已达到支持的最大长度。",
  dataTitle: "你的私人歌词数据",
  dataIntro:
    "歌词和进度保存在 Cloudflare D1 中，仅通过匿名浏览器 Cookie 关联。",
  identityWarningTitle: "这个浏览器就是你的钥匙",
  identityWarning:
    "清除 Cookie 后将永久失去对歌词库的访问权，数据不会自动转移到其他浏览器或设备。",
  retention: "连续 365 天没有成功访问后，匿名数据会被删除。",
  noAnalytics: "本应用不收集分析数据，也不会从第三方获取歌词。",
  deleteAll: "删除我的全部数据",
  deleteAllConfirm: "永久删除所有歌曲、草稿、练习记录和本地恢复副本？",
  deleting: "正在删除…",
  dataDeleted: "本浏览器和云端的全部数据均已删除。",
  notFoundTitle: "这一页不在歌词里",
  notFoundBody: "页面可能已经移动，或者记录已不存在。",
  goLibrary: "返回歌词库",
  statusCompleted: "已完成",
  statusAbandoned: "提前结束",
  startedAt: "开始于 {date}",
  duration: "{minutes} 分钟",
  fileTypeError: "请选择 .txt 或 .lrc 文件。",
  fileDecodeError: "文件必须是有效的 UTF-8 文本。",
  error_TITLE_REQUIRED: "请输入歌名。",
  error_TITLE_TOO_LONG: "歌名过长。",
  error_ARTIST_TOO_LONG: "歌手名称过长。",
  error_SOURCE_BYTES_EXCEEDED: "歌词文件不能超过 256 KiB。",
  error_SOURCE_CHARS_EXCEEDED: "歌词字符数过多。",
  error_SOURCE_LINES_EXCEEDED: "歌词不能超过 2,000 行。",
  error_SOURCE_LINE_TOO_LONG: "某一行歌词超过了 2,000 个字符。",
  error_LYRICS_CONTENT_REQUIRED: "请至少添加一个歌词文字或数字。",
  error_STUDY_CONTENT_EXCEEDED:
    "LRC 展开后超出默写草稿容量，请减少重复时间戳或拆分歌曲。",
  error_UNSAFE_CONTROL_CHARACTER: "文本包含不受支持的不可见控制字符。",
  unsafePosition: "第一个不受支持的字符位于位置 {position}。",
  error_DRAFT_BYTES_EXCEEDED: "草稿不能超过 256 KiB。",
  error_DRAFT_CHARS_EXCEEDED: "草稿字符数过多。",
  error_REQUEST_BODY_TOO_LARGE: "请求内容过大。",
  error_UNSUPPORTED_MEDIA_TYPE: "此请求必须使用 JSON。",
  error_INVALID_JSON: "请求中的 JSON 无效。",
  error_VALIDATION_ERROR: "部分提交字段无效。",
  error_ORIGIN_MISMATCH: "出于安全原因，此更改已被阻止。",
  error_IDEMPOTENCY_KEY_REQUIRED: "此次更改缺少安全重试标识，请重试。",
  error_IDEMPOTENCY_IN_PROGRESS: "此次更改正在处理中，请稍后重试。",
  error_SESSION_NOT_ACTIVE: "这次默写已不再进行中。",
  error_DICTATION_NOT_COMPLETE: "默写尚未完成。",
  error_SONG_NOT_FOUND: "这首歌已不存在。",
  error_SESSION_NOT_FOUND: "这次默写已不存在。",
  error_IDENTITY_NOT_FOUND: "当前浏览器身份已不可用。",
  error_NOT_FOUND: "未找到请求的资源。",
  error_HTTP_ERROR: "无法完成该请求。",
  error_INTERNAL_ERROR: "服务发生错误，请重试。",
  error_VERSION_CONFLICT: "这条记录已在别处发生变化，请重新加载后再试。",
  error_RATE_LIMITED: "操作过于频繁，请稍等后重试。",
  error_NETWORK: "请检查网络连接后重试。",
  error_UNKNOWN: "出现了问题，请重试。",
};

export const messageCatalogs: Record<Locale, Messages> = { en, "zh-CN": zh };

const detectLocale = (): Locale => {
  const stored = localStorage.getItem("lyrics-dictation:locale");
  if (stored === "en" || stored === "zh-CN") return stored;
  const preferences = navigator.languages.length
    ? navigator.languages
    : [navigator.language];
  for (const value of preferences) {
    const locale = value.toLowerCase();
    if (
      locale === "zh" ||
      locale.startsWith("zh-cn") ||
      locale.startsWith("zh-sg") ||
      locale.startsWith("zh-hans")
    ) {
      return "zh-CN";
    }
    if (locale === "en" || locale.startsWith("en-")) return "en";
  }
  return "en";
};

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export const I18nProvider = ({ children }: { children: ReactNode }) => {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);
  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem("lyrics-dictation:locale", next);
    setLocaleState(next);
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
          ? "用实时反馈默写你自己导入的歌词。"
          : "Practice writing your own lyrics from memory with private, real-time feedback.";
    }
  }, [locale]);
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, values = {}) =>
        Object.entries(values).reduce(
          (text, [name, replacement]) =>
            text.replaceAll(`{${name}}`, String(replacement)),
          messageCatalogs[locale][key],
        ),
    }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useI18n = () => {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
};

export type { MessageKey };
