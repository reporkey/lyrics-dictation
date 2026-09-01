import type {
  DictationSession,
  RecentSession,
  Song,
  SongSummary,
} from "../src/lib/types";
import { projectJudgedText } from "../src/lib/grading";

export interface SongRow {
  id: string;
  title: string;
  artist: string;
  source_text: string;
  study_text: string;
  character_count?: number | null;
  source_kind: "plain" | "lrc";
  version: number;
  created_at: number;
  updated_at: number;
  active_session_id?: string | null;
  practice_sessions?: number;
  completed_sessions?: number;
  latest_accuracy?: number | null;
}

export type SongSummaryRow = Omit<SongRow, "source_text" | "study_text"> & {
  study_text?: string;
};

export interface SessionRow {
  id: string;
  song_id: string;
  status: "in_progress" | "completed" | "abandoned";
  draft_text: string;
  case_sensitive: number;
  correct_count: number;
  incorrect_count: number;
  extra_count: number;
  missing_count: number;
  version: number;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
  study_text?: string;
  session_study_text?: string;
  song_title?: string;
}

export const toSongSummary = (row: SongSummaryRow): SongSummary => ({
  id: row.id,
  title: row.title,
  artist: row.artist,
  sourceKind: row.source_kind,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  activeSessionId: row.active_session_id ?? null,
  practiceSessions: Number(row.practice_sessions ?? 0),
  completedSessions: Number(row.completed_sessions ?? 0),
  characterCount:
    row.character_count ?? projectJudgedText(row.study_text ?? "", true).count,
  latestAccuracy:
    row.latest_accuracy === null || row.latest_accuracy === undefined
      ? null
      : Number(row.latest_accuracy),
});

export const toSong = (row: SongRow): Song => ({
  ...toSongSummary(row),
  sourceText: row.source_text,
  studyText: row.study_text,
});

export const toSession = (row: SessionRow): DictationSession => ({
  id: row.id,
  songId: row.song_id,
  status: row.status,
  draftText: row.draft_text,
  caseSensitive: Boolean(row.case_sensitive),
  correctCount: row.correct_count,
  incorrectCount: row.incorrect_count,
  extraCount: row.extra_count,
  missingCount: row.missing_count,
  version: row.version,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

export const toRecent = (row: SessionRow): RecentSession => ({
  id: row.id,
  songId: row.song_id,
  songTitle: row.song_title ?? "",
  status: row.status,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  updatedAt: row.updated_at,
  correctCount: row.correct_count,
  incorrectCount: row.incorrect_count,
  extraCount: row.extra_count,
  missingCount: row.missing_count,
});
