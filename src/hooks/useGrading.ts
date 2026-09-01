import { useEffect, useMemo, useRef, useState } from "react";
import { gradeDraft, type GradeResult } from "../lib/grading";

interface GradeResponse {
  requestId: number;
  grade: GradeResult;
  refining: boolean;
  approximate: boolean;
}

interface GradingKey {
  expectedText: string;
  actualText: string;
  caseSensitive: boolean;
  reveal: boolean;
  enabled: boolean;
}

interface KeyedGradeResponse extends GradeResponse {
  sourceKey: GradingKey;
}

// The existing maximum-scale first-paint regression covers a raw near-match
// just above 120k combined code units. Keep only that measured band
// synchronous; every still-larger input crosses an unconditional worker
// boundary, even when the full documents are equal or differ by one token.
const SOFT_SYNCHRONOUS_GRADING_CODE_UNIT_BUDGET = 120_000;
const HARD_SYNCHRONOUS_GRADING_CODE_UNIT_BUDGET = 140_000;
const LARGE_EXPECTED_TEXT = 60_000;

const hasSmallRawEdit = (expectedText: string, actualText: string) => {
  if (Math.abs(expectedText.length - actualText.length) > 64) return false;
  const shorterLength = Math.min(expectedText.length, actualText.length);
  let prefix = 0;
  while (
    prefix < shorterLength &&
    expectedText.charCodeAt(prefix) === actualText.charCodeAt(prefix)
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < shorterLength - prefix &&
    expectedText.charCodeAt(expectedText.length - 1 - suffix) ===
      actualText.charCodeAt(actualText.length - 1 - suffix)
  )
    suffix += 1;
  return shorterLength - prefix - suffix <= 64;
};

export const useGrading = (
  expectedText: string,
  actualText: string,
  caseSensitive: boolean,
  reveal = false,
  enabled = true,
) => {
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);
  const [backgroundResult, setBackgroundResult] =
    useState<KeyedGradeResponse | null>(null);
  const gradingKey = useMemo<GradingKey>(
    () => ({ expectedText, actualText, caseSensitive, reveal, enabled }),
    [actualText, caseSensitive, enabled, expectedText, reveal],
  );
  const deferImmediate =
    enabled &&
    (expectedText.length + actualText.length >=
      HARD_SYNCHRONOUS_GRADING_CODE_UNIT_BUDGET ||
      (expectedText.length + actualText.length >=
        SOFT_SYNCHRONOUS_GRADING_CODE_UNIT_BUDGET &&
        !hasSmallRawEdit(expectedText, actualText)) ||
      (expectedText.length >= LARGE_EXPECTED_TEXT &&
        actualText.length * 2 <= expectedText.length));
  // Produce a bounded whole-document result during the same render as the
  // edit. DictationEditor applies it in a layout effect, before the browser
  // can paint the newly entered text with the editor's default ink colour.
  // Expensive exact refinement remains isolated in the worker below.
  const immediateGrade = useMemo(
    () =>
      enabled && !deferImmediate
        ? gradeDraft(expectedText, actualText, caseSensitive, 750_000)
        : null,
    [actualText, caseSensitive, deferImmediate, enabled, expectedText],
  );

  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    let worker: Worker | null = null;
    if (!enabled || (!deferImmediate && immediateGrade?.exact)) {
      workerRef.current?.terminate();
      workerRef.current = null;
      return;
    }
    const sourceKey = gradingKey;
    const timer = window.setTimeout(
      () => {
        workerRef.current?.terminate();
        worker = new Worker(
          new URL("../workers/grading.worker.ts", import.meta.url),
          { type: "module" },
        );
        workerRef.current = worker;
        worker.onmessage = (event: MessageEvent<GradeResponse>) => {
          if (event.data.requestId !== requestRef.current) return;
          setBackgroundResult({ ...event.data, sourceKey });
        };
        worker.postMessage({
          requestId,
          expectedText,
          actualText,
          caseSensitive,
          reveal,
        });
      },
      reveal ? 0 : 120,
    );
    return () => {
      window.clearTimeout(timer);
      if (workerRef.current === worker) {
        worker?.terminate();
        workerRef.current = null;
      }
    };
  }, [
    actualText,
    caseSensitive,
    deferImmediate,
    enabled,
    expectedText,
    gradingKey,
    immediateGrade,
    immediateGrade?.exact,
    reveal,
  ]);

  const currentBackground =
    backgroundResult?.sourceKey === gradingKey ? backgroundResult : null;
  return {
    grade: currentBackground?.grade ?? immediateGrade,
    checking:
      enabled &&
      (deferImmediate || !immediateGrade?.exact) &&
      (currentBackground === null || currentBackground.refining),
    approximate: currentBackground?.approximate ?? false,
  };
};
