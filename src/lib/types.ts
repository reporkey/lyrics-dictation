import type { Locale, SessionStatus, SourceKind } from "./constants";

export interface SongSummary {
  id: string;
  title: string;
  artist: string;
  sourceKind: SourceKind;
  version: number;
  createdAt: number;
  updatedAt: number;
  activeSessionId: string | null;
  practiceSessions: number;
  completedSessions: number;
  characterCount: number;
  /** Retained for compatibility with clients loaded before the history-tab UI. */
  latestAccuracy: number | null;
}

export interface Song extends SongSummary {
  sourceText: string;
  studyText: string;
}

export interface DictationSession {
  id: string;
  songId: string;
  status: SessionStatus;
  draftText: string;
  caseSensitive: boolean;
  correctCount: number;
  incorrectCount: number;
  extraCount: number;
  missingCount: number;
  version: number;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface RecentSession {
  id: string;
  songId: string;
  songTitle: string;
  status: SessionStatus;
  startedAt: number;
  completedAt: number | null;
  updatedAt: number;
  correctCount: number;
  incorrectCount: number;
  extraCount: number;
  missingCount: number;
}

export interface BootstrapPayload {
  locale: Locale;
  localeExplicit: boolean;
  settingsVersion: number;
  songs: SongSummary[];
  recentSessions: RecentSession[];
  devices: DeviceInfo[];
  paired: boolean;
  recoveryNamespace: string;
}

export interface DeviceInfo {
  id: string;
  label: string;
  platform: string | null;
  browser: string | null;
  browserMajorVersion: string | null;
  deviceType: "desktop" | "phone" | "tablet" | "unknown";
  isThisDevice: boolean;
  joinedAt: number;
  lastActiveAt: number;
}

export interface PairingPreview {
  destinationDeviceCount: number;
  replacement: {
    songs: number;
    activeDrafts: number;
    history: number;
  };
  requiresConfirmation: boolean;
}

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
