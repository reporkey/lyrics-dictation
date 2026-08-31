export interface SessionCounts {
  correctCount: number;
  incorrectCount: number;
  extraCount: number;
  missingCount: number;
}

export const sessionAccuracy = (counts: SessionCounts): number => {
  const total =
    counts.correctCount +
    counts.incorrectCount +
    counts.extraCount +
    counts.missingCount;
  return total > 0 ? Math.round((counts.correctCount / total) * 100) : 0;
};

export const formatElapsedTime = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
};
