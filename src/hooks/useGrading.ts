import { useEffect, useRef, useState } from "react";
import type { GradeResult } from "../lib/grading";

interface GradeResponse {
  requestId: number;
  grade: GradeResult;
  refining: boolean;
}

export const useGrading = (
  expectedText: string,
  actualText: string,
  caseSensitive: boolean,
) => {
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [gradeKey, setGradeKey] = useState("");
  const [checking, setChecking] = useState(true);
  const requestKeys = useRef(new Map<number, string>());
  const currentKey = JSON.stringify([expectedText, actualText, caseSensitive]);

  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/grading.worker.ts", import.meta.url),
      {
        type: "module",
      },
    );
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<GradeResponse>) => {
      if (event.data.requestId !== requestRef.current) return;
      setGrade(event.data.grade);
      setGradeKey(requestKeys.current.get(event.data.requestId) ?? "");
      setChecking(event.data.refining);
    };
    return () => worker.terminate();
  }, []);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    requestRef.current += 1;
    requestKeys.current.set(requestRef.current, currentKey);
    setChecking(true);
    worker.postMessage({
      requestId: requestRef.current,
      expectedText,
      actualText,
      caseSensitive,
    });
  }, [actualText, caseSensitive, currentKey, expectedText]);

  const isCurrent = gradeKey === currentKey;
  return { grade: isCurrent ? grade : null, checking: !isCurrent || checking };
};
