import { gradeDraft, type GradeResult } from "../lib/grading";

interface GradeRequest {
  requestId: number;
  expectedText: string;
  actualText: string;
  caseSensitive: boolean;
  reveal: boolean;
}

interface GradeResponse {
  requestId: number;
  grade: GradeResult;
  refining: boolean;
  approximate: boolean;
}

self.onmessage = (event: MessageEvent<GradeRequest>) => {
  const { requestId, expectedText, actualText, caseSensitive } = event.data;
  const initial = gradeDraft(expectedText, actualText, caseSensitive, 750_000);
  const response: GradeResponse = {
    requestId,
    grade: initial,
    refining: !initial.exact,
    approximate: false,
  };
  self.postMessage(response);
  if (!initial.exact) {
    const refined = gradeDraft(
      expectedText,
      actualText,
      caseSensitive,
      8_000_000,
    );
    self.postMessage({
      requestId,
      grade: refined,
      refining: false,
      approximate: false,
    } satisfies GradeResponse);
  }
};

export {};
