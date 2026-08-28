import { LIMITS, type SourceKind } from "./constants";
import { projectJudgedText } from "./grading";
import { findUnsafeControl } from "./text-policy";
import { ValidationError } from "./validation";

const METADATA_KEYS = new Set([
  "ar",
  "ti",
  "al",
  "by",
  "offset",
  "re",
  "ve",
  "length",
]);
const TIMESTAMP = /^\[(\d{1,3}):([0-5]?\d)(?:\.(\d{1,3}))?\]/;

export interface ParsedLyrics {
  title: string;
  artist: string;
  sourceText: string;
  studyText: string;
  sourceKind: SourceKind;
  studyLines: string[];
}

export const normalizeSource = (value: string): string =>
  value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");

const scalarLength = (value: string) => [...value].length;

const validateSourceShape = (sourceText: string) => {
  const unsafeAt = findUnsafeControl(sourceText);
  if (unsafeAt !== null) {
    throw new ValidationError("UNSAFE_CONTROL_CHARACTER", 400, {
      position: unsafeAt,
    });
  }
  const bytes = new TextEncoder().encode(sourceText).byteLength;
  if (bytes > LIMITS.uploadBytes)
    throw new ValidationError("SOURCE_BYTES_EXCEEDED");
  if (scalarLength(sourceText) > LIMITS.sourceScalars) {
    throw new ValidationError("SOURCE_CHARS_EXCEEDED");
  }
  const lines = sourceText.split("\n");
  if (lines.length > LIMITS.sourceLines)
    throw new ValidationError("SOURCE_LINES_EXCEEDED");
  const longLine = lines.findIndex(
    (line) => scalarLength(line) > LIMITS.lineScalars,
  );
  if (longLine >= 0) {
    throw new ValidationError("SOURCE_LINE_TOO_LONG", 400, {
      line: longLine + 1,
    });
  }
};

interface LyricCandidate {
  sourceIndex: number;
  text: string;
  timestamps: number[];
}

const consumeTimestamps = (
  line: string,
): { timestamps: number[]; text: string } => {
  const timestamps: number[] = [];
  let rest = line;
  while (true) {
    const match = TIMESTAMP.exec(rest);
    if (!match) break;
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const fractionText = match[3] ?? "";
    const fraction = fractionText ? Number(`0.${fractionText}`) : 0;
    timestamps.push(minutes * 60 + seconds + fraction);
    rest = rest.slice(match[0].length);
  }
  return { timestamps, text: rest };
};

export const parseLyrics = (
  raw: string,
  sourceKind: SourceKind,
): ParsedLyrics => {
  const sourceText = normalizeSource(raw);
  validateSourceShape(sourceText);

  if (sourceKind === "plain") {
    const studyLines = sourceText
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const studyText = studyLines.join("\n");
    if (projectJudgedText(studyText, true).count === 0) {
      throw new ValidationError("LYRICS_CONTENT_REQUIRED");
    }
    return {
      title: "",
      artist: "",
      sourceText,
      studyText,
      sourceKind,
      studyLines,
    };
  }

  let title = "";
  let artist = "";
  const candidates: LyricCandidate[] = [];

  sourceText.split("\n").forEach((line, sourceIndex) => {
    const metadata = /^\[([a-z]+):(.*)\]$/iu.exec(line.trim());
    if (metadata && METADATA_KEYS.has(metadata[1].toLowerCase())) {
      const key = metadata[1].toLowerCase();
      const value = metadata[2].trim();
      if (key === "ti" && !title) title = value;
      if (key === "ar" && !artist) artist = value;
      return;
    }
    if (line.trim().length === 0) return;
    const timed = consumeTimestamps(line);
    candidates.push({
      sourceIndex,
      text: timed.text,
      timestamps: timed.timestamps,
    });
  });

  const allTimed =
    candidates.length > 0 &&
    candidates.every((line) => line.timestamps.length > 0);
  let derivedScalars = 0;
  let derivedBytes = 0;
  let derivedOccurrences = 0;
  for (const candidate of candidates) {
    const occurrences = allTimed ? candidate.timestamps.length : 1;
    if (candidate.text.trim().length === 0) continue;
    derivedOccurrences += occurrences;
    derivedScalars += scalarLength(candidate.text) * occurrences;
    derivedBytes +=
      new TextEncoder().encode(candidate.text).byteLength * occurrences;
    if (
      derivedScalars > LIMITS.draftScalars ||
      derivedBytes > LIMITS.draftBytes
    ) {
      throw new ValidationError("STUDY_CONTENT_EXCEEDED");
    }
  }
  if (derivedOccurrences > 1) {
    derivedScalars += derivedOccurrences - 1;
    derivedBytes += derivedOccurrences - 1;
  }
  if (
    derivedScalars > LIMITS.draftScalars ||
    derivedBytes > LIMITS.draftBytes
  ) {
    throw new ValidationError("STUDY_CONTENT_EXCEEDED");
  }
  let studyLines: string[];
  if (allTimed) {
    studyLines = candidates
      .flatMap((candidate) =>
        candidate.timestamps.map((timestamp, timestampIndex) => ({
          timestamp,
          timestampIndex,
          sourceIndex: candidate.sourceIndex,
          text: candidate.text,
        })),
      )
      .sort(
        (a, b) =>
          a.timestamp - b.timestamp ||
          a.sourceIndex - b.sourceIndex ||
          a.timestampIndex - b.timestampIndex,
      )
      .map((entry) => entry.text);
  } else {
    studyLines = candidates
      .sort((a, b) => a.sourceIndex - b.sourceIndex)
      .map((entry) => entry.text);
  }

  studyLines = studyLines.filter((line) => line.trim().length > 0);
  const studyText = studyLines.join("\n");
  if (projectJudgedText(studyText, true).count === 0) {
    throw new ValidationError("LYRICS_CONTENT_REQUIRED");
  }

  return { title, artist, sourceText, studyText, sourceKind, studyLines };
};

export const inferSourceKind = (filename: string, text: string): SourceKind =>
  filename.toLowerCase().endsWith(".lrc") ||
  /^\s*\[(?:\d{1,3}:\d{1,2}|(?:ar|ti|al|by|offset|re|ve|length):)/imu.test(text)
    ? "lrc"
    : "plain";
