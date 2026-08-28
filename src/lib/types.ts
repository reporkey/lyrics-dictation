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
  completedSessions: number;
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
  settingsVersion: number;
  songs: SongSummary[];
  recentSessions: RecentSession[];
}

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
