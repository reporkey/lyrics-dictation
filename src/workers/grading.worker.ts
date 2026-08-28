import {
  gradeDraft,
  projectJudgedText,
  type GradeResult,
} from "../lib/grading";

interface GradeRequest {
  requestId: number;
  expectedText: string;
  actualText: string;
  caseSensitive: boolean;
}

interface GradeResponse {
  requestId: number;
  grade: GradeResult;
  refining: boolean;
}

self.onmessage = (event: MessageEvent<GradeRequest>) => {
  const { requestId, expectedText, actualText, caseSensitive } = event.data;
  const exceedsInteractiveBudget = (value: string) => {
    let count = 0;
    for (const character of value) {
      if (character) count += 1;
      if (count > 50_000) return true;
    }
    return false;
  };
  if (
    exceedsInteractiveBudget(expectedText) ||
    exceedsInteractiveBudget(actualText)
  ) {
    const expectedProjection = projectJudgedText(expectedText, caseSensitive);
    const actualProjection = projectJudgedText(actualText, caseSensitive);
    const complete = expectedProjection.text === actualProjection.text;
    const prefixEnd = (value: string) => {
      let scalars = 0;
      let utf16 = 0;
      for (const character of value) {
        if (scalars >= 20_000) break;
        scalars += 1;
        utf16 += character.length;
      }
      return utf16;
    };
    const partial = gradeDraft(
      expectedText.slice(0, prefixEnd(expectedText)),
      actualText.slice(0, prefixEnd(actualText)),
      caseSensitive,
      750_000,
    );
    const grade: GradeResult = {
      exact: complete,
      complete,
      correct: complete ? expectedProjection.count : partial.correct,
      incorrect: complete ? 0 : partial.incorrect,
      extra: complete ? 0 : partial.extra,
      missing: complete ? 0 : partial.missing,
      expectedCount: expectedProjection.count,
      progress:
        complete || expectedProjection.count === 0
          ? 1
          : partial.correct / expectedProjection.count,
      actual: complete
        ? {
            normalizedOriginal: actualText,
            originals: [],
            tokens: [],
            text: actualProjection.text,
          }
        : partial.actual,
      states: complete ? [] : partial.states,
      markers: complete ? [] : partial.markers,
    };
    self.postMessage({
      requestId,
      grade,
      refining: !complete,
    } satisfies GradeResponse);
    return;
  }
  const initial = gradeDraft(expectedText, actualText, caseSensitive, 750_000);
  const response: GradeResponse = {
    requestId,
    grade: initial,
    refining: !initial.exact,
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
      refining: !refined.exact,
    } satisfies GradeResponse);
  }
};

export {};
