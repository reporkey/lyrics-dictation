import { useEffect, useRef, useState } from "react";
import type { GradeResult } from "../lib/grading";

interface GradeResponse {
  requestId: number;
  grade: GradeResult;
  refining: boolean;
  approximate: boolean;
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
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [gradeKey, setGradeKey] = useState("");
  const [checking, setChecking] = useState(true);
  const [approximate, setApproximate] = useState(false);
  const currentKey = JSON.stringify([
    expectedText,
    actualText,
    caseSensitive,
    reveal,
    enabled,
  ]);

  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setChecking(true);
    setApproximate(false);
    let worker: Worker | null = null;
    if (!enabled) {
      workerRef.current?.terminate();
      workerRef.current = null;
      setChecking(false);
      return;
    }
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
          setGrade(event.data.grade);
          setGradeKey(currentKey);
          setChecking(event.data.refining);
          setApproximate(event.data.approximate);
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
  }, [actualText, caseSensitive, currentKey, enabled, expectedText, reveal]);

  const isCurrent = gradeKey === currentKey;
  return {
    grade: isCurrent ? grade : null,
    checking: enabled && (!isCurrent || checking),
    approximate: isCurrent && approximate,
  };
};
