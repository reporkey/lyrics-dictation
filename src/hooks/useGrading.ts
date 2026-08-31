import { useEffect, useMemo, useRef, useState } from "react";
import { gradeDraft, type GradeResult } from "../lib/grading";

interface GradeResponse {
  requestId: number;
  grade: GradeResult;
  refining: boolean;
  approximate: boolean;
}

interface KeyedGradeResponse extends GradeResponse {
  source: GradeResult;
}

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
  // Produce a bounded whole-document result during the same render as the
  // edit. DictationEditor applies it in a layout effect, before the browser
  // can paint the newly entered text with the editor's default ink colour.
  // Expensive exact refinement remains isolated in the worker below.
  const immediateGrade = useMemo(
    () =>
      enabled
        ? gradeDraft(expectedText, actualText, caseSensitive, 750_000)
        : null,
    [actualText, caseSensitive, enabled, expectedText],
  );

  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    let worker: Worker | null = null;
    if (!enabled || !immediateGrade || immediateGrade.exact) {
      workerRef.current?.terminate();
      workerRef.current = null;
      return;
    }
    const sourceGrade = immediateGrade;
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
          setBackgroundResult({ ...event.data, source: sourceGrade });
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
    enabled,
    expectedText,
    immediateGrade,
    immediateGrade?.exact,
    reveal,
  ]);

  const currentBackground =
    backgroundResult?.source === immediateGrade ? backgroundResult : null;
  return {
    grade: currentBackground?.grade ?? immediateGrade,
    checking:
      enabled &&
      !immediateGrade?.exact &&
      (currentBackground === null || currentBackground.refining),
    approximate: currentBackground?.approximate ?? false,
  };
};
