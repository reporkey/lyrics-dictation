import {
  collectDecorationRanges,
  gradeDraft,
  type GradeResult,
  type ProjectedText,
} from "../lib/grading";

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

const compactGrade = (grade: GradeResult, reveal: boolean): GradeResult => {
  const projection = reveal ? grade.revealed : grade.actual;
  const states = reveal ? grade.revealedStates : grade.states;
  const emptyProjection: ProjectedText = {
    normalizedOriginal: "",
    originals: [],
    tokens: [],
    text: "",
  };
  return {
    ...grade,
    expected: emptyProjection,
    expectedStates: [],
    actual: emptyProjection,
    states: [],
    markers: reveal ? [] : grade.markers,
    revealedText: reveal ? grade.revealedText : "",
    revealed: emptyProjection,
    revealedStates: [],
    decorationRanges: collectDecorationRanges(projection, states),
  };
};

self.onmessage = (event: MessageEvent<GradeRequest>) => {
  const { requestId, expectedText, actualText, caseSensitive, reveal } =
    event.data;
  const initial = gradeDraft(expectedText, actualText, caseSensitive, 750_000);
  const response: GradeResponse = {
    requestId,
    grade: compactGrade(initial, reveal),
    refining: !initial.exact,
    approximate: false,
  };
  if (!reveal || initial.exact) self.postMessage(response);
  if (!initial.exact) {
    const refined = gradeDraft(
      expectedText,
      actualText,
      caseSensitive,
      8_000_000,
    );
    self.postMessage({
      requestId,
      grade: compactGrade(refined, reveal),
      refining: false,
      approximate: !refined.exact,
    } satisfies GradeResponse);
  }
};

export {};
