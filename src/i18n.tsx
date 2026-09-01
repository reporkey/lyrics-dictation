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
  libraryIntro:
    "Add lyrics you love, choose a song, and write it from memory at your own pace. Spaces, line breaks, and punctuation do not affect scoring, and you can review feedback and past results as you practice.",
  importLyrics: "Import lyrics",
  privacy: "Privacy & data",
  historyNav: "History",
  importNav: "Import",
  privacyNav: "Privacy",
  devices: "Devices",
  devicesNav: "Devices",
  language: "Language",
  english: "English",
  chinese: "简体中文",
  theme: "Theme",
  lightTheme: "Use light theme",
  darkTheme: "Use dark theme",
  githubRepository: "View source on GitHub (opens in a new tab)",
  loading: "Loading…",
  loadError: "We couldn’t load your data.",
  retry: "Try again",
  emptyTitle: "Your lyric shelf is ready",
  emptyBody:
    "Add lyrics you’re learning, then write the whole song from memory.",
  addFirstSong: "Add your first song",
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
  practiceCount: "{count} attempts",
  practiceCountOne: "{count} attempt",
  characterCount: "{count} characters",
  characterCountOne: "{count} character",
  accuracyValue: "Accuracy {percent}%",
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
  plainTextHint: "Lyrics without timestamps.",
  lrc: "LRC",
  lrcHint:
    "Lyrics with timestamps such as [00:12.34]; dictation uses only the lyric text.",
  saveSong: "Save song",
  saving: "Saving…",
  cancel: "Cancel",
  back: "Back",
  study: "Study",
  startDictation: "Start dictation",
  resumeDictation: "Resume dictation",
  startOver: "Start over",
  startOverConfirm:
    "Starting over will save the current text to your dictation history. Continue?",
  editSong: "Edit song",
  deleteSong: "Delete song",
  deleteSongConfirm:
    "Delete this song and all of its practice history? This cannot be undone.",
  delete: "Delete",
  sourceUpdatedWarning:
    "Saving these lyric changes will add the current dictation to your history.",
  lyricsHeading: "Lyrics",
  practiceHistory: "Practice history",
  historyIntro: "The result of every dictation is saved here.",
  historyEmptyBody: "Submit a dictation to see its accuracy and elapsed time.",
  noPractice: "No practice history yet.",
  viewResult: "View result",
  loadOlderResults: "Load older results",
  loadingOlderResults: "Loading…",
  dictationTitle: "Write from memory",
  dictationIntro:
    "Type the whole song freely. Spacing, line breaks, punctuation, and symbols do not affect correctness.",
  caseSensitive: "Match letter case",
  realtimeFeedback: "Live check",
  realtimeFeedbackOff: "Live check is off",
  partialFeedback: "Long lyric: showing a partial preview",
  editorLabel: "Lyrics dictation editor",
  editorPlaceholder: "Begin writing from memory…",
  checking: "Checking…",
  synced: "Saved",
  savingDraft: "Saving…",
  notSynced: "Not saved yet",
  syncError:
    "This draft is saved on this device, but syncing is temporarily unavailable.",
  retrySync: "Try saving again",
  versionConflict:
    "This dictation changed in another tab. Your text on this page has been kept. Choose which version to use.",
  useCloudDraft: "Use saved version",
  keepLocalDraft: "Keep this version",
  correct: "Correct",
  incorrect: "Incorrect",
  extra: "Extra",
  missing: "Missing",
  missingHere: "Missing text here",
  progressLabel: "Accuracy {percent}%",
  gradingSummary:
    "Accuracy {percent}%. {correct} correct, {incorrect} incorrect, {extra} extra, {missing} missing.",
  completedTitle: "You remembered the whole song",
  completedBody:
    "Every lyric character matches. Formatting differences were ignored.",
  resultPageTitle: "Dictation result",
  resultEditorLabel: "Reviewed dictation result",
  resultRemovedLegend: "Red strikethrough: what you wrote",
  resultReplacementLegend: "Yellow underline: corrected text",
  resultAdditionLegend: "Green double underline: added omission",
  correctedAnswerLabel: "Correct lyrics without revision marks",
  practiceAgain: "Back to song",
  submitDictation: "Submit dictation",
  submitConfirm:
    "Submit this dictation and view the corrected result? You cannot edit it afterward.",
  draftLimit: "This draft is at the maximum supported size.",
  dataTitle: "Your data",
  dataIntro:
    "Your lyrics, unfinished dictations, and results are saved automatically so you can continue next time.",
  identityWarningTitle: "Keep using this browser",
  identityWarning:
    "There is no account sign-in. Pair another device before clearing this browser's cookie if you want to keep access elsewhere.",
  retentionTitle: "How long data is kept",
  retention:
    "If this device does not open the app for 365 days, its access expires. Shared records remain available to other active paired devices; a private or last-member library is deleted automatically.",
  noAnalyticsTitle: "Basic usage analytics",
  noAnalytics:
    "Imported lyrics and dictation text are not used for analytics, and lyrics are never fetched from third-party services.",
  deleteAll: "Delete all my data",
  deleteAllConfirm:
    "Permanently delete every song, unfinished dictation, and dictation result? This cannot be undone.",
  deleting: "Deleting…",
  dataDeleted:
    "All lyrics, unfinished dictations, and dictation results have been deleted.",
  devicesTitle: "Sync across devices",
  devicesIntro:
    "Pair another browser with a short-lived code. Paired devices share lyrics, drafts, and practice history.",
  deviceInfoPrivacy:
    "Only a general device and browser description is kept; the full browser identifier is not stored.",
  privateDeviceStatus: "This device currently has a private library.",
  pairedDeviceStatus: "{count} devices currently share this library.",
  thisDevice: "This device",
  deviceName: "Device {label}",
  deviceInfoPending: "Device details update the next time it is used",
  androidPhone: "Android phone",
  androidTablet: "Android tablet",
  lastActive: "Last active {date}",
  createPairingCode: "Create pairing code",
  creatingPairingCode: "Creating…",
  pairingCodeTitle: "Pairing code",
  pairingCodeHint:
    "Enter this code on the other device within 10 minutes. It works once; treat it as private.",
  joinDeviceTitle: "Join another device",
  joinDeviceHint:
    "Enter the code from a device whose library you want to use. Libraries are replaced, never merged.",
  pairingCodeLabel: "Pairing code",
  pairingCodePlaceholder: "XXXX-XXXX-XXXX",
  previewPairing: "Review join",
  reviewingPairing: "Checking…",
  joinDevice: "Join and sync",
  joiningDevice: "Joining…",
  replaceWarningTitle: "This device's records will be replaced",
  replaceWarning:
    "Joining will erase {songs} songs, {drafts} active drafts, and {history} history records from this device, then load the paired library.",
  emptyReplaceWarning:
    "Joining will load the paired library on this device. Local unsynced drafts, if any, will be cleared.",
  joinReplaceConfirm:
    "Replace this device's current records with the paired device's records? This cannot be undone.",
  pairingJoined: "This device is now paired and showing the shared library.",
  leaveGroup: "Leave device group",
  leaveGroupConfirm:
    "Leave this group? This device keeps a snapshot of all current records, but future changes will no longer sync.",
  removeDevice: "Remove device",
  removeDeviceConfirm:
    "Remove {device}? It keeps a snapshot of current records, but future changes will no longer sync.",
  groupDeleteBlocked:
    "To delete all data on this device, leave the device group first. The remaining devices keep their own shared copy.",
  notFoundTitle: "This page is out of verse",
  notFoundBody: "The page may have moved or the record no longer exists.",
  goLibrary: "Return to library",
  startedAt: "Started {date}",
  completedAt: "Completed {date}",
  elapsedTime: "Elapsed {duration}",
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
  error_PAIRING_CODE_INVALID:
    "This pairing code is invalid, expired, or already used.",
  error_PAIRING_CODE_OWN_GROUP: "This code belongs to this device group.",
  error_PAIRING_CONFIRMATION_REQUIRED:
    "Review and confirm replacement before joining.",
  error_PAIRING_EXIT_REQUIRED:
    "Leave the current device group before doing this.",
  error_PAIRING_NOT_PAIRED: "This device is not currently paired.",
  error_DEVICE_NOT_FOUND: "This device is no longer in the group.",
  error_NETWORK: "Check your connection and try again.",
  error_UNKNOWN: "Something went wrong. Please try again.",
} as const;

type MessageKey = keyof typeof en;
type Messages = Record<MessageKey, string>;

const zh: Messages = {
  appName: "歌词默写",
  skipToContent: "跳至正文",
  library: "歌词库",
  libraryIntro:
    "把喜欢的歌词加入歌词库，选一首凭记忆自由默写。空格、换行和标点不会影响判断，你可以随时查看提示与结果，在一次次练习中记住整首歌。",
  importLyrics: "导入歌词",
  privacy: "隐私与数据",
  historyNav: "记录",
  importNav: "导入",
  privacyNav: "隐私",
  devices: "设备同步",
  devicesNav: "设备",
  language: "语言",
  english: "英文",
  chinese: "中文",
  theme: "主题",
  lightTheme: "切换到浅色模式",
  darkTheme: "切换到深色模式",
  githubRepository: "在 GitHub 查看源码（新标签页打开）",
  loading: "正在加载…",
  loadError: "加载失败。",
  retry: "再试一次",
  emptyTitle: "还没有歌词",
  emptyBody: "导入一首想练习的歌，就可以开始整首默写。",
  addFirstSong: "导入歌词",
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
  practiceCount: "已默写 {count} 次",
  practiceCountOne: "已默写 {count} 次",
  characterCount: "{count} 字",
  characterCountOne: "{count} 字",
  accuracyValue: "正确率 {percent}%",
  openSong: "查看《{title}》",
  untitledArtist: "歌手未知",
  importTitle: "导入歌词",
  importIntro: "粘贴纯文本或 LRC 歌词，也可以上传 .txt 或 .lrc 文件。",
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
  plainTextHint: "普通歌词，不含时间标签。",
  lrc: "LRC",
  lrcHint: "带有 [00:12.34] 这类时间标签；默写时只使用歌词正文。",
  saveSong: "保存",
  saving: "正在保存…",
  cancel: "取消",
  back: "返回",
  study: "查看歌词",
  startDictation: "开始默写",
  resumeDictation: "继续默写",
  startOver: "重新默写",
  startOverConfirm: "重新开始后，当前内容会保存到默写记录。确定继续吗？",
  editSong: "编辑歌词",
  deleteSong: "删除这首歌",
  deleteSongConfirm: "确定删除这首歌和所有默写记录吗？删除后无法恢复。",
  delete: "删除",
  sourceUpdatedWarning: "保存歌词修改后，当前默写内容会直接保存到默写记录。",
  lyricsHeading: "歌词",
  practiceHistory: "默写记录",
  historyIntro: "每次默写的结果都会保存在这里。",
  historyEmptyBody: "提交一次默写后，就能在这里查看正确率和耗时。",
  noPractice: "还没有默写记录。",
  viewResult: "查看结果",
  loadOlderResults: "查看更多记录",
  loadingOlderResults: "正在加载…",
  dictationTitle: "默写整首歌词",
  dictationIntro: "请凭记忆输入整首歌词。空格、换行、标点和符号不计入对错。",
  caseSensitive: "区分英文大小写",
  realtimeFeedback: "实时检查",
  realtimeFeedbackOff: "实时检查已关闭",
  partialFeedback: "歌词较长，当前显示局部提示",
  editorLabel: "歌词默写输入框",
  editorPlaceholder: "从记忆中写下歌词…",
  checking: "正在检查…",
  synced: "已保存",
  savingDraft: "正在保存…",
  notSynced: "尚未保存",
  syncError: "内容已保存在当前设备，但暂时无法完成同步。",
  retrySync: "重新保存",
  versionConflict:
    "这份默写已在其他页面修改。当前页面的内容仍然保留，请选择要使用的版本。",
  useCloudDraft: "使用已保存的版本",
  keepLocalDraft: "保留当前版本",
  correct: "写对",
  incorrect: "写错",
  extra: "多写",
  missing: "漏写",
  missingHere: "这里有漏写",
  progressLabel: "正确率 {percent}%",
  gradingSummary:
    "正确率 {percent}%。写对 {correct}，写错 {incorrect}，多写 {extra}，漏写 {missing}。",
  completedTitle: "全部写对了",
  completedBody: "整首歌词都已写对；空格、换行、标点和符号不计入对错。",
  resultPageTitle: "默写结果",
  resultEditorLabel: "订正后的默写结果",
  resultRemovedLegend: "红色删除线：原默写内容",
  resultReplacementLegend: "黄色下划线：改写内容",
  resultAdditionLegend: "绿色双下划线：补上的遗漏",
  correctedAnswerLabel: "不带订正标记的正确歌词",
  practiceAgain: "返回歌曲",
  submitDictation: "提交默写",
  submitConfirm: "确定提交这次默写并查看订正结果吗？提交后不能继续修改。",
  draftLimit: "输入内容已达到长度上限。",
  dataTitle: "你的数据",
  dataIntro: "歌词、未完成的默写和默写记录会自动保存，方便你下次继续。",
  identityWarningTitle: "请使用同一个浏览器",
  identityWarning:
    "本应用不提供账号登录。如需在其他设备保留访问，请在清除本浏览器数据前先完成设备配对。",
  retentionTitle: "数据保留期限",
  retention:
    "当前设备连续 365 天未打开本应用后会失去访问权。若还有其他活跃绑定设备，共享记录会继续保留；私有或最后一台设备的数据会自动删除。",
  noAnalyticsTitle: "基础使用统计",
  noAnalytics:
    "不会将导入的歌词或默写内容用于统计，也不会自动从其他网站获取歌词。",
  deleteAll: "删除所有数据",
  deleteAllConfirm:
    "确定永久删除所有歌词、未完成的默写和默写记录吗？删除后无法恢复。",
  deleting: "正在删除…",
  dataDeleted: "所有歌词、未完成的默写和默写记录均已删除。",
  devicesTitle: "多设备同步",
  devicesIntro:
    "用一个短期配对码绑定另一个浏览器。绑定后，歌词库、未完成默写和默写记录会在设备间共享。",
  deviceInfoPrivacy: "只记录大致设备和浏览器，不保存完整浏览器标识。",
  privateDeviceStatus: "当前设备使用独立的歌词库。",
  pairedDeviceStatus: "当前有 {count} 台设备共享这个歌词库。",
  thisDevice: "本机",
  deviceName: "设备 {label}",
  deviceInfoPending: "下次使用时更新设备信息",
  androidPhone: "Android 手机",
  androidTablet: "Android 平板",
  lastActive: "最近使用：{date}",
  createPairingCode: "生成配对码",
  creatingPairingCode: "正在生成…",
  pairingCodeTitle: "配对码",
  pairingCodeHint:
    "请在 10 分钟内到另一台设备输入。配对码只能使用一次，请勿泄露。",
  joinDeviceTitle: "加入其他设备",
  joinDeviceHint:
    "输入另一台设备生成的配对码。本机记录会被替换，不会与对方合并。",
  pairingCodeLabel: "配对码",
  pairingCodePlaceholder: "XXXX-XXXX-XXXX",
  previewPairing: "配对",
  reviewingPairing: "正在检查…",
  joinDevice: "确认加入并同步",
  joiningDevice: "正在加入…",
  replaceWarningTitle: "本机记录将被替换",
  replaceWarning:
    "加入后，本机的 {songs} 首歌词、{drafts} 份未完成默写和 {history} 条默写记录会被清除，再载入配对设备的数据。",
  emptyReplaceWarning:
    "加入后会在本机载入配对设备的数据；本机尚未同步的草稿也会被清除。",
  joinReplaceConfirm:
    "确定用配对设备的记录替换本机现有记录吗？此操作无法撤销。",
  pairingJoined: "配对完成，本机正在使用共享歌词库。",
  leaveGroup: "退出设备组",
  leaveGroupConfirm:
    "确定退出吗？本机会保留当前全部记录的副本，但之后不再与其他设备同步。",
  removeDevice: "移出设备",
  removeDeviceConfirm:
    "确定移出{device}吗？它会保留当前记录的副本，但之后不再同步。",
  groupDeleteBlocked:
    "如需删除本机全部数据，请先退出设备组；其他设备会继续保留各自的共享副本。",
  notFoundTitle: "页面不存在",
  notFoundBody: "这个页面可能已被移动，或相关内容已被删除。",
  goLibrary: "返回歌词库",
  startedAt: "开始时间：{date}",
  completedAt: "完成时间：{date}",
  elapsedTime: "耗时 {duration}",
  fileTypeError: "请选择 .txt 或 .lrc 文件。",
  fileDecodeError: "无法读取这个文件，请尝试另存为纯文本后再上传。",
  error_TITLE_REQUIRED: "请填写歌名。",
  error_TITLE_TOO_LONG: "歌名太长了。",
  error_ARTIST_TOO_LONG: "歌手名太长了。",
  error_SOURCE_BYTES_EXCEEDED: "歌词文件太大，不能超过 256 KB。",
  error_SOURCE_CHARS_EXCEEDED: "歌词内容太长了。",
  error_SOURCE_LINES_EXCEEDED: "歌词不能超过 2,000 行。",
  error_SOURCE_LINE_TOO_LONG: "单行歌词不能超过 2,000 个字符。",
  error_LYRICS_CONTENT_REQUIRED: "歌词中至少需要有一个文字或数字。",
  error_STUDY_CONTENT_EXCEEDED:
    "这份 LRC 歌词转换后太长。请删除重复时间标签，或分成多首导入。",
  error_UNSAFE_CONTROL_CHARACTER:
    "内容中含有无法显示或可能影响文字顺序的特殊字符，请删除后再试。",
  unsafePosition: "问题字符位于第 {position} 个位置附近。",
  error_DRAFT_BYTES_EXCEEDED: "默写内容太长，不能超过 256 KB。",
  error_DRAFT_CHARS_EXCEEDED: "默写内容太长了。",
  error_REQUEST_BODY_TOO_LARGE: "提交内容太多，请适当删减后再试。",
  error_UNSUPPORTED_MEDIA_TYPE: "提交格式有误，请刷新页面后再试。",
  error_INVALID_JSON: "提交内容无法读取，请刷新页面后再试。",
  error_VALIDATION_ERROR: "有些内容填写不正确，请检查后再试。",
  error_ORIGIN_MISMATCH: "为保护你的数据，本次操作已取消。请刷新页面后再试。",
  error_IDEMPOTENCY_KEY_REQUIRED: "操作未能完成，请再试一次。",
  error_IDEMPOTENCY_IN_PROGRESS: "正在处理这次操作，请稍后再试。",
  error_SESSION_NOT_ACTIVE: "这次默写已经提交，不能再修改。",
  error_DICTATION_NOT_COMPLETE: "还有歌词没有写对。",
  error_SONG_NOT_FOUND: "这首歌已被删除或不存在。",
  error_SESSION_NOT_FOUND: "这次默写已被删除或不存在。",
  error_IDENTITY_NOT_FOUND: "无法找到与当前浏览器关联的数据。",
  error_NOT_FOUND: "找不到相关内容。",
  error_HTTP_ERROR: "暂时无法完成操作。",
  error_INTERNAL_ERROR: "服务暂时出错，请再试一次。",
  error_VERSION_CONFLICT: "内容已在其他标签页中修改，请刷新后再试。",
  error_RATE_LIMITED: "操作太频繁，请稍后再试。",
  error_PAIRING_CODE_INVALID: "配对码无效、已过期或已被使用。",
  error_PAIRING_CODE_OWN_GROUP: "这个配对码属于当前设备组。",
  error_PAIRING_CONFIRMATION_REQUIRED: "请先查看并确认替换本机记录。",
  error_PAIRING_EXIT_REQUIRED: "请先退出当前设备组。",
  error_PAIRING_NOT_PAIRED: "当前设备尚未配对。",
  error_DEVICE_NOT_FOUND: "这台设备已不在当前设备组中。",
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
          ? "导入自己的歌词，在实时检查下练习整首默写。"
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
