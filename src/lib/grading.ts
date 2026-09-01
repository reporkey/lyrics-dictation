import { caseFold } from "unicode-case-folding";

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const CONTENT_CODE_POINT = /[\p{L}\p{M}\p{N}]/u;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const isDefaultIgnorable = (codePoint: number): boolean =>
  codePoint === 0x00ad ||
  codePoint === 0x034f ||
  codePoint === 0x061c ||
  (codePoint >= 0x115f && codePoint <= 0x1160) ||
  (codePoint >= 0x17b4 && codePoint <= 0x17b5) ||
  (codePoint >= 0x180b && codePoint <= 0x180f) ||
  (codePoint >= 0x200b && codePoint <= 0x200f) ||
  (codePoint >= 0x202a && codePoint <= 0x202e) ||
  (codePoint >= 0x2060 && codePoint <= 0x206f) ||
  (codePoint >= 0x3164 && codePoint <= 0x3164) ||
  (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
  codePoint === 0xfeff ||
  (codePoint >= 0xffa0 && codePoint <= 0xffa0) ||
  (codePoint >= 0x1bca0 && codePoint <= 0x1bca3) ||
  (codePoint >= 0x1d173 && codePoint <= 0x1d17a) ||
  (codePoint >= 0xe0000 && codePoint <= 0xe0fff);

const isPresentationComponent = (codePoint: number): boolean =>
  codePoint === 0x200d ||
  codePoint === 0x20e3 ||
  (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff);

export interface OriginalGrapheme {
  text: string;
  from: number;
  to: number;
  projection: string;
}

export interface JudgedToken {
  value: string;
  origins: number[];
}

export interface ProjectedText {
  normalizedOriginal: string;
  originals: OriginalGrapheme[];
  tokens: JudgedToken[];
  text: string;
}

export interface JudgedProjection {
  text: string;
  count: number;
}

interface ProvenanceRecord {
  from: number;
  to: number;
  origins: number[];
}

interface ProvenanceText {
  text: string;
  records: ProvenanceRecord[];
}

const mapProvenanceToTarget = (
  targetText: string,
  { text, records }: ProvenanceText,
): ProvenanceText => {
  const byCharacter = new Map<
    string,
    { records: ProvenanceRecord[]; next: number }
  >();
  for (const record of records) {
    const character = text.slice(record.from, record.to);
    const queue = byCharacter.get(character) ?? { records: [], next: 0 };
    queue.records.push(record);
    byCharacter.set(character, queue);
  }

  let orderedText = "";
  const orderedRecords: ProvenanceRecord[] = [];
  for (const character of targetText) {
    const queue = byCharacter.get(character);
    if (!queue) throw new Error("Unable to preserve Unicode provenance");
    const source = queue.records[queue.next];
    if (!source) throw new Error("Unable to preserve Unicode provenance");
    queue.next += 1;
    const from = orderedText.length;
    orderedText += character;
    orderedRecords.push({
      from,
      to: orderedText.length,
      origins: source.origins,
    });
  }
  return { text: orderedText, records: orderedRecords };
};

const canonicallyOrder = (source: ProvenanceText): ProvenanceText =>
  mapProvenanceToTarget(source.text.normalize("NFD"), source);

const createOriginsReader = (records: ProvenanceRecord[]) => {
  let recordIndex = 0;
  return (from: number, to: number): number[] => {
    while (recordIndex < records.length && records[recordIndex].to <= from) {
      recordIndex += 1;
    }
    const origins = new Set<number>();
    for (
      let scan = recordIndex;
      scan < records.length && records[scan].from < to;
      scan += 1
    ) {
      records[scan].origins.forEach((origin) => origins.add(origin));
    }
    return [...origins].sort((left, right) => left - right);
  };
};

export const projectJudgedText = (
  value: string,
  caseSensitive: boolean,
): JudgedProjection => {
  let filtered = "";
  for (const character of value.replace(/\r\n?/gu, "\n")) {
    const codePoint = character.codePointAt(0)!;
    if (
      CONTENT_CODE_POINT.test(character) &&
      !isDefaultIgnorable(codePoint) &&
      !isPresentationComponent(codePoint) &&
      !BIDI_CONTROL.test(character)
    ) {
      filtered += character;
    }
  }
  const composed = filtered.normalize("NFC");
  const text = (caseSensitive ? composed : caseFold(composed)).normalize("NFC");
  let count = 0;
  for (const part of segmenter.segment(text)) {
    if (part.segment) count += 1;
  }
  return { text, count };
};

export const gradeCompletion = (
  expectedText: string,
  actualText: string,
  caseSensitive: boolean,
) => {
  const expected = projectJudgedText(expectedText, caseSensitive);
  const actual = projectJudgedText(actualText, caseSensitive);
  const complete = expected.text === actual.text;
  return {
    complete,
    correct: complete ? expected.count : 0,
    incorrect: 0,
    extra: 0,
    missing: complete ? 0 : expected.count,
    expectedCount: expected.count,
  };
};

// Abandonment needs useful final aggregate counts without risking an
// unbounded edit-distance matrix for a maximum-size document. Exact common
// prefix/suffix matches are retained; the remaining middle is classified
// deterministically as substitutions plus length-difference inserts/deletes.
export const gradeAbandonment = (
  expectedText: string,
  actualText: string,
  caseSensitive: boolean,
) => {
  const expected = [
    ...segmenter.segment(projectJudgedText(expectedText, caseSensitive).text),
  ].map((part) => part.segment);
  const actual = [
    ...segmenter.segment(projectJudgedText(actualText, caseSensitive).text),
  ].map((part) => part.segment);
  let prefix = 0;
  while (
    prefix < expected.length &&
    prefix < actual.length &&
    expected[prefix] === actual[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < expected.length - prefix &&
    suffix < actual.length - prefix &&
    expected[expected.length - 1 - suffix] ===
      actual[actual.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const expectedMiddle = expected.length - prefix - suffix;
  const actualMiddle = actual.length - prefix - suffix;
  const incorrect = Math.min(expectedMiddle, actualMiddle);
  return {
    complete: expectedMiddle === 0 && actualMiddle === 0,
    correct: prefix + suffix,
    incorrect,
    extra: actualMiddle - incorrect,
    missing: expectedMiddle - incorrect,
    expectedCount: expected.length,
  };
};

export const projectText = (
  value: string,
  caseSensitive: boolean,
): ProjectedText => {
  const renderOriginal = value.replace(/\r\n?/gu, "\n");
  const normalizedOriginal = renderOriginal.normalize("NFC");
  const originals: OriginalGrapheme[] = [];
  let filteredNfdText = "";
  const filteredRecords: ProvenanceRecord[] = [];

  for (const part of segmenter.segment(renderOriginal)) {
    const projection = [...part.segment]
      .filter((character) => {
        const codePoint = character.codePointAt(0)!;
        return (
          CONTENT_CODE_POINT.test(character) &&
          !isDefaultIgnorable(codePoint) &&
          !isPresentationComponent(codePoint) &&
          !BIDI_CONTROL.test(character)
        );
      })
      .join("");
    const origin = originals.length;
    originals.push({
      text: part.segment,
      from: part.index,
      to: part.index + part.segment.length,
      projection,
    });
    for (const character of projection.normalize("NFD")) {
      const from = filteredNfdText.length;
      filteredNfdText += character;
      filteredRecords.push({
        from,
        to: filteredNfdText.length,
        origins: [origin],
      });
    }
  }

  // Filtering formatting can bring combining marks from separate editor
  // graphemes together. Normalize the whole filtered stream so canonical
  // ordering happens across those former boundaries while offsets retain
  // their original provenance.
  const ordered = canonicallyOrder({
    text: filteredNfdText,
    records: filteredRecords,
  });
  let foldedNfdText = "";
  const foldedRecords: ProvenanceRecord[] = [];
  for (const record of ordered.records) {
    const character = ordered.text.slice(record.from, record.to);
    const folded = (caseSensitive ? character : caseFold(character)).normalize(
      "NFD",
    );
    for (const character of folded) {
      const from = foldedNfdText.length;
      foldedNfdText += character;
      foldedRecords.push({
        from,
        to: foldedNfdText.length,
        origins: record.origins,
      });
    }
  }

  // The judged value must use whole-stream NFC → case-fold → NFC semantics.
  // Precise per-code-point folding above provides provenance; mapping its
  // character multiset onto the authoritative whole-stream NFD preserves that
  // provenance even when case folding changes canonical mark order.
  const orderedComposed = ordered.text.normalize("NFC");
  const authoritativeNfd = (
    caseSensitive ? orderedComposed : caseFold(orderedComposed)
  ).normalize("NFD");
  const finalProjection = mapProvenanceToTarget(authoritativeNfd, {
    text: foldedNfdText,
    records: foldedRecords,
  });
  const tokens: JudgedToken[] = [];
  const readFinalOrigins = createOriginsReader(finalProjection.records);
  for (const cluster of segmenter.segment(finalProjection.text)) {
    const clusterEnd = cluster.index + cluster.segment.length;
    tokens.push({
      value: cluster.segment.normalize("NFC"),
      origins: readFinalOrigins(cluster.index, clusterEnd),
    });
  }

  return {
    normalizedOriginal,
    originals,
    tokens,
    text: tokens.map((token) => token.value).join(""),
  };
};

export type AlignmentOperationType =
  "match" | "substitute" | "insert" | "delete";

export interface AlignmentOperation {
  type: AlignmentOperationType;
  expectedIndex: number;
  actualIndex: number;
}

export interface AlignmentResult {
  operations: AlignmentOperation[];
  exact: boolean;
}

const alignWithLevenshteinBand = (
  expected: JudgedToken[],
  actual: JudgedToken[],
  expectedOffset: number,
  actualOffset: number,
  maxDistance: number,
): AlignmentResult | null => {
  if (Math.abs(expected.length - actual.length) > maxDistance) return null;
  const width = maxDistance * 2 + 1;
  const unreachable = 0x3fffffff;
  let previous = new Uint32Array(width).fill(unreachable);
  let current = new Uint32Array(width).fill(unreachable);
  const directions = new Uint8Array((expected.length + 1) * width).fill(255);
  for (
    let column = 0;
    column <= Math.min(actual.length, maxDistance);
    column += 1
  ) {
    const slot = column + maxDistance;
    previous[slot] = column;
    if (column > 0) directions[slot] = 2;
  }

  for (let row = 1; row <= expected.length; row += 1) {
    current.fill(unreachable);
    const firstColumn = Math.max(0, row - maxDistance);
    const lastColumn = Math.min(actual.length, row + maxDistance);
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const slot = column - row + maxDistance;
      const diagonal =
        column > 0
          ? previous[slot] +
            (expected[row - 1].value === actual[column - 1].value ? 0 : 1)
          : unreachable;
      const deletion = slot + 1 < width ? previous[slot + 1] + 1 : unreachable;
      const insertion =
        column > 0 && slot > 0 ? current[slot - 1] + 1 : unreachable;
      const directionIndex = row * width + slot;
      if (diagonal <= deletion && diagonal <= insertion) {
        current[slot] = diagonal;
        directions[directionIndex] = 0;
      } else if (deletion <= insertion) {
        current[slot] = deletion;
        directions[directionIndex] = 1;
      } else {
        current[slot] = insertion;
        directions[directionIndex] = 2;
      }
    }
    [previous, current] = [current, previous];
  }

  const finalSlot = actual.length - expected.length + maxDistance;
  if (previous[finalSlot] > maxDistance) return null;
  const reversed: AlignmentOperation[] = [];
  let row = expected.length;
  let column = actual.length;
  while (row > 0 || column > 0) {
    const slot = column - row + maxDistance;
    const direction = directions[row * width + slot];
    if (direction === 0 && row > 0 && column > 0) {
      reversed.push({
        type:
          expected[row - 1].value === actual[column - 1].value
            ? "match"
            : "substitute",
        expectedIndex: expectedOffset + row - 1,
        actualIndex: actualOffset + column - 1,
      });
      row -= 1;
      column -= 1;
    } else if (direction === 1 && row > 0) {
      reversed.push({
        type: "delete",
        expectedIndex: expectedOffset + row - 1,
        actualIndex: actualOffset + column,
      });
      row -= 1;
    } else if (direction === 2 && column > 0) {
      reversed.push({
        type: "insert",
        expectedIndex: expectedOffset + row,
        actualIndex: actualOffset + column - 1,
      });
      column -= 1;
    } else return null;
  }
  return { operations: reversed.reverse(), exact: true };
};

// For very long texts, a full edit-distance matrix is not safe. Myers' bounded
// search first discovers a small edit-distance ceiling. A Levenshtein band of
// that width then recovers the exact rewrite-aware path (substitutions cost 1)
// without allocating the full matrix.
const alignWithBoundedMyers = (
  expected: JudgedToken[],
  actual: JudgedToken[],
  expectedOffset: number,
  actualOffset: number,
  maxEdits = 64,
): AlignmentResult | null => {
  if (Math.abs(expected.length - actual.length) > maxEdits) return null;
  const diagonalOffset = maxEdits + 1;
  const diagonals = new Int32Array(maxEdits * 2 + 3).fill(-1);
  diagonals[diagonalOffset + 1] = 0;
  let finalDepth = -1;

  search: for (let depth = 0; depth <= maxEdits; depth += 1) {
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const index = diagonalOffset + diagonal;
      let expectedIndex: number;
      if (
        diagonal === -depth ||
        (diagonal !== depth && diagonals[index - 1] < diagonals[index + 1])
      ) {
        expectedIndex = diagonals[index + 1];
      } else {
        expectedIndex = diagonals[index - 1] + 1;
      }
      let actualIndex = expectedIndex - diagonal;
      while (
        expectedIndex < expected.length &&
        actualIndex < actual.length &&
        expectedIndex >= 0 &&
        actualIndex >= 0 &&
        expected[expectedIndex].value === actual[actualIndex].value
      ) {
        expectedIndex += 1;
        actualIndex += 1;
      }
      diagonals[index] = expectedIndex;
      if (expectedIndex >= expected.length && actualIndex >= actual.length) {
        finalDepth = depth;
        break search;
      }
    }
  }
  if (finalDepth < 0) return null;
  return alignWithLevenshteinBand(
    expected,
    actual,
    expectedOffset,
    actualOffset,
    finalDepth,
  );
};

const alignMiddle = (
  expected: JudgedToken[],
  actual: JudgedToken[],
  expectedOffset: number,
  actualOffset: number,
  cellBudget: number,
): AlignmentResult => {
  const rows = expected.length + 1;
  const columns = actual.length + 1;
  if (expected.length === 0) {
    return {
      exact: true,
      operations: actual.map((_, index) => ({
        type: "insert",
        expectedIndex: expectedOffset,
        actualIndex: actualOffset + index,
      })),
    };
  }
  if (actual.length === 0) {
    return {
      exact: true,
      operations: expected.map((_, index) => ({
        type: "delete",
        expectedIndex: expectedOffset + index,
        actualIndex: actualOffset,
      })),
    };
  }
  if (rows * columns > cellBudget) {
    const boundedExact = alignWithBoundedMyers(
      expected,
      actual,
      expectedOffset,
      actualOffset,
    );
    if (boundedExact) return boundedExact;
    // Unique common tokens provide deterministic, non-answer-revealing chunk
    // boundaries for progressive feedback. They are heuristic anchors, so a
    // result that uses them remains non-exact even if every smaller chunk fits
    // its matrix budget and therefore can never declare completion.
    const expectedOccurrences = new Map<
      string,
      { count: number; index: number }
    >();
    const actualOccurrences = new Map<
      string,
      { count: number; index: number }
    >();
    expected.forEach((token, index) => {
      const occurrence = expectedOccurrences.get(token.value);
      expectedOccurrences.set(token.value, {
        count: (occurrence?.count ?? 0) + 1,
        index,
      });
    });
    actual.forEach((token, index) => {
      const occurrence = actualOccurrences.get(token.value);
      actualOccurrences.set(token.value, {
        count: (occurrence?.count ?? 0) + 1,
        index,
      });
    });
    const candidates = expected.flatMap((token, expectedIndex) => {
      const expectedOccurrence = expectedOccurrences.get(token.value)!;
      const actualOccurrence = actualOccurrences.get(token.value);
      return expectedOccurrence.count === 1 && actualOccurrence?.count === 1
        ? [{ expectedIndex, actualIndex: actualOccurrence.index }]
        : [];
    });

    // Longest increasing subsequence in actual-token order produces a stable
    // non-crossing anchor chain in O(n log n).
    const tails: number[] = [];
    const previous = new Int32Array(candidates.length).fill(-1);
    const tailCandidate = new Int32Array(candidates.length).fill(-1);
    candidates.forEach((candidate, candidateIndex) => {
      let low = 0;
      let high = tails.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (tails[middle] < candidate.actualIndex) low = middle + 1;
        else high = middle;
      }
      if (low > 0) previous[candidateIndex] = tailCandidate[low - 1];
      tails[low] = candidate.actualIndex;
      tailCandidate[low] = candidateIndex;
    });
    const anchors: typeof candidates = [];
    let anchorIndex = tails.length > 0 ? tailCandidate[tails.length - 1] : -1;
    while (anchorIndex >= 0) {
      anchors.push(candidates[anchorIndex]);
      anchorIndex = previous[anchorIndex];
    }
    anchors.reverse();

    if (anchors.length > 0) {
      const operations: AlignmentOperation[] = [];
      let expectedStart = 0;
      let actualStart = 0;
      for (const anchor of anchors) {
        operations.push(
          ...alignMiddle(
            expected.slice(expectedStart, anchor.expectedIndex),
            actual.slice(actualStart, anchor.actualIndex),
            expectedOffset + expectedStart,
            actualOffset + actualStart,
            cellBudget,
          ).operations,
        );
        operations.push({
          type: "match",
          expectedIndex: expectedOffset + anchor.expectedIndex,
          actualIndex: actualOffset + anchor.actualIndex,
        });
        expectedStart = anchor.expectedIndex + 1;
        actualStart = anchor.actualIndex + 1;
      }
      operations.push(
        ...alignMiddle(
          expected.slice(expectedStart),
          actual.slice(actualStart),
          expectedOffset + expectedStart,
          actualOffset + actualStart,
          cellBudget,
        ).operations,
      );
      return { operations, exact: false };
    }

    const common = Math.min(expected.length, actual.length);
    const operations: AlignmentOperation[] = [];
    for (let index = 0; index < common; index += 1) {
      operations.push({
        type:
          expected[index].value === actual[index].value
            ? "match"
            : "substitute",
        expectedIndex: expectedOffset + index,
        actualIndex: actualOffset + index,
      });
    }
    for (let index = common; index < actual.length; index += 1) {
      operations.push({
        type: "insert",
        expectedIndex: expectedOffset + expected.length,
        actualIndex: actualOffset + index,
      });
    }
    for (let index = common; index < expected.length; index += 1) {
      operations.push({
        type: "delete",
        expectedIndex: expectedOffset + index,
        actualIndex: actualOffset + actual.length,
      });
    }
    return { operations, exact: false };
  }

  const directions = new Uint8Array(rows * columns);
  let previous = new Uint32Array(columns);
  let current = new Uint32Array(columns);
  for (let column = 0; column < columns; column += 1) previous[column] = column;

  for (let row = 1; row < rows; row += 1) {
    current[0] = row;
    directions[row * columns] = 1;
    for (let column = 1; column < columns; column += 1) {
      const isMatch = expected[row - 1].value === actual[column - 1].value;
      const diagonal = previous[column - 1] + (isMatch ? 0 : 1);
      const deletion = previous[column] + 1;
      const insertion = current[column - 1] + 1;
      if (diagonal <= deletion && diagonal <= insertion) {
        current[column] = diagonal;
        directions[row * columns + column] = 0;
      } else if (deletion <= insertion) {
        current[column] = deletion;
        directions[row * columns + column] = 1;
      } else {
        current[column] = insertion;
        directions[row * columns + column] = 2;
      }
    }
    [previous, current] = [current, previous];
  }

  const reversed: AlignmentOperation[] = [];
  let row = expected.length;
  let column = actual.length;
  while (row > 0 || column > 0) {
    const direction = directions[row * columns + column];
    if (row > 0 && column > 0 && direction === 0) {
      reversed.push({
        type:
          expected[row - 1].value === actual[column - 1].value
            ? "match"
            : "substitute",
        expectedIndex: expectedOffset + row - 1,
        actualIndex: actualOffset + column - 1,
      });
      row -= 1;
      column -= 1;
    } else if (row > 0 && (column === 0 || direction === 1)) {
      reversed.push({
        type: "delete",
        expectedIndex: expectedOffset + row - 1,
        actualIndex: actualOffset + column,
      });
      row -= 1;
    } else {
      reversed.push({
        type: "insert",
        expectedIndex: expectedOffset + row,
        actualIndex: actualOffset + column - 1,
      });
      column -= 1;
    }
  }
  return { operations: reversed.reverse(), exact: true };
};

export const alignTokens = (
  expected: JudgedToken[],
  actual: JudgedToken[],
  cellBudget = 2_000_000,
): AlignmentResult => {
  if (
    expected.length === actual.length &&
    expected.every((token, i) => token.value === actual[i].value)
  ) {
    return {
      exact: true,
      operations: expected.map((_, index) => ({
        type: "match",
        expectedIndex: index,
        actualIndex: index,
      })),
    };
  }

  let prefix = 0;
  while (
    prefix < expected.length &&
    prefix < actual.length &&
    expected[prefix].value === actual[prefix].value
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < expected.length - prefix &&
    suffix < actual.length - prefix &&
    expected[expected.length - 1 - suffix].value ===
      actual[actual.length - 1 - suffix].value
  ) {
    suffix += 1;
  }

  const leading: AlignmentOperation[] = Array.from(
    { length: prefix },
    (_, index) => ({
      type: "match" as const,
      expectedIndex: index,
      actualIndex: index,
    }),
  );
  const middle = alignMiddle(
    expected.slice(prefix, expected.length - suffix),
    actual.slice(prefix, actual.length - suffix),
    prefix,
    prefix,
    cellBudget,
  );
  const trailing: AlignmentOperation[] = Array.from(
    { length: suffix },
    (_, offset) => ({
      type: "match" as const,
      expectedIndex: expected.length - suffix + offset,
      actualIndex: actual.length - suffix + offset,
    }),
  );
  return {
    operations: [...leading, ...middle.operations, ...trailing],
    exact: middle.exact,
  };
};

export interface SubmissionGrade {
  exact: boolean;
  complete: boolean;
  correct: number;
  incorrect: number;
  extra: number;
  missing: number;
  expectedCount: number;
}

export const gradeSubmission = (
  expectedText: string,
  actualText: string,
  caseSensitive: boolean,
  cellBudget = 8_000_000,
): SubmissionGrade => {
  const tokensFor = (value: string): JudgedToken[] =>
    [...segmenter.segment(projectJudgedText(value, caseSensitive).text)].map(
      (part) => ({ value: part.segment, origins: [] }),
    );
  const expected = tokensFor(expectedText);
  const actual = tokensFor(actualText);
  const alignment = alignTokens(expected, actual, cellBudget);
  let correct = 0;
  let incorrect = 0;
  let extra = 0;
  let missing = 0;
  for (const operation of alignment.operations) {
    if (operation.type === "match") correct += 1;
    else if (operation.type === "substitute") incorrect += 1;
    else if (operation.type === "insert") extra += 1;
    else missing += 1;
  }
  return {
    exact: alignment.exact,
    complete:
      alignment.exact && incorrect === 0 && extra === 0 && missing === 0,
    correct,
    incorrect,
    extra,
    missing,
    expectedCount: expected.length,
  };
};

export type RenderState =
  | "correct"
  | "incorrect"
  | "extra"
  | "neutral"
  | "replacement"
  | "addition"
  | "removed";

export interface MissingMarker {
  position: number;
  count: number;
  boundary: number;
}

export interface GradeDecorationRange {
  from: number;
  to: number;
  state: Exclude<RenderState, "neutral">;
}

export interface GradeResult {
  exact: boolean;
  complete: boolean;
  correct: number;
  incorrect: number;
  extra: number;
  missing: number;
  expectedCount: number;
  progress: number;
  expected: ProjectedText;
  expectedStates: RenderState[];
  actual: ProjectedText;
  states: RenderState[];
  markers: MissingMarker[];
  revealedText: string;
  revealed: ProjectedText;
  revealedStates: RenderState[];
  decorationRanges?: GradeDecorationRange[];
}

export const collectDecorationRanges = (
  projection: ProjectedText,
  states: RenderState[],
): GradeDecorationRange[] => {
  const ranges: GradeDecorationRange[] = [];
  let run: GradeDecorationRange | null = null;
  const flush = () => {
    if (run) ranges.push(run);
    run = null;
  };
  projection.originals.forEach((original, index) => {
    const state = states[index];
    if (state !== "neutral" && original.to > original.from) {
      if (run?.state === state && run.to === original.from)
        run.to = original.to;
      else {
        flush();
        run = { state, from: original.from, to: original.to };
      }
    } else {
      flush();
    }
  });
  flush();
  return ranges;
};

interface MissingBoundary {
  count: number;
  firstExpectedToken: number;
  lastExpectedToken: number;
  firstExpectedOrigin: number | undefined;
  lastExpectedOrigin: number | undefined;
}

const neutralOriginalsBetween = (
  projection: ProjectedText,
  leftOrigin: number | undefined,
  rightOrigin: number | undefined,
) =>
  projection.originals
    .slice(
      leftOrigin === undefined ? 0 : leftOrigin + 1,
      rightOrigin ?? projection.originals.length,
    )
    .filter((original) => !original.projection);

const markerPosition = (
  expected: ProjectedText,
  actual: ProjectedText,
  boundary: number,
  missingBoundary: MissingBoundary,
): number => {
  const leftActualOrigin = actual.tokens[boundary - 1]?.origins.at(-1);
  const rightActualOrigin = actual.tokens[boundary]?.origins[0];
  const leftPosition =
    leftActualOrigin === undefined
      ? 0
      : (actual.originals[leftActualOrigin]?.to ?? 0);
  const rightPosition =
    rightActualOrigin === undefined
      ? (actual.originals.at(-1)?.to ?? 0)
      : (actual.originals[rightActualOrigin]?.from ?? leftPosition);
  if (rightPosition <= leftPosition) return leftPosition;

  const {
    firstExpectedToken,
    lastExpectedToken,
    firstExpectedOrigin,
    lastExpectedOrigin,
  } = missingBoundary;
  if (firstExpectedOrigin === undefined || lastExpectedOrigin === undefined)
    return leftPosition;
  const leftExpectedOrigin =
    expected.tokens[firstExpectedToken - 1]?.origins.at(-1);
  const rightExpectedOrigin =
    expected.tokens[lastExpectedToken + 1]?.origins[0];
  const expectedBefore = neutralOriginalsBetween(
    expected,
    leftExpectedOrigin,
    firstExpectedOrigin,
  );
  const expectedAfter = neutralOriginalsBetween(
    expected,
    lastExpectedOrigin,
    rightExpectedOrigin,
  );
  if (expectedBefore.length === 0 && expectedAfter.length === 0)
    return leftPosition;

  const actualGap = neutralOriginalsBetween(
    actual,
    leftActualOrigin,
    rightActualOrigin,
  ).filter(
    (original) => original.from >= leftPosition && original.to <= rightPosition,
  );
  if (actualGap.length === 0) return leftPosition;

  const formattingToken = (text: string): JudgedToken => ({
    value: text.normalize("NFC"),
    origins: [],
  });
  const expectedFormatting = [...expectedBefore, ...expectedAfter].map(
    (original) => formattingToken(original.text),
  );
  const actualFormatting = actualGap.map((original) =>
    formattingToken(original.text),
  );
  let actualSplit = actualGap.length;
  if (
    expectedFormatting.length !== actualFormatting.length ||
    expectedFormatting.some(
      (token, index) => token.value !== actualFormatting[index].value,
    )
  ) {
    const formattingAlignment = alignTokens(
      expectedFormatting,
      actualFormatting,
      250_000,
    );
    const firstAfterCut = formattingAlignment.operations.find(
      (operation) => operation.expectedIndex >= expectedBefore.length,
    );
    actualSplit = firstAfterCut?.actualIndex ?? actualGap.length;
  } else {
    actualSplit = expectedBefore.length;
  }

  return actualSplit === 0 ? leftPosition : actualGap[actualSplit - 1].to;
};

const mapTokenStatesToOriginals = (
  projection: ProjectedText,
  tokenStates: Array<"correct" | "incorrect" | "extra" | undefined>,
): RenderState[] => {
  const statesByOrigin: Array<Array<"correct" | "incorrect" | "extra">> =
    Array.from({ length: projection.originals.length }, () => []);
  projection.tokens.forEach((token, tokenIndex) => {
    const state = tokenStates[tokenIndex];
    if (!state) return;
    token.origins.forEach((origin) => statesByOrigin[origin].push(state));
  });
  return projection.originals.map((original, originIndex) => {
    if (!original.projection) return "neutral";
    const contributing = statesByOrigin[originIndex];
    if (contributing.length === 0) return "neutral";
    if (contributing.every((state) => state === "correct")) return "correct";
    return contributing.some((state) => state === "incorrect")
      ? "incorrect"
      : "extra";
  });
};

const buildRevealedText = (
  expected: ProjectedText,
  expectedStates: RenderState[],
  actual: ProjectedText,
  actualStates: RenderState[],
  alignment: AlignmentResult,
  caseSensitive: boolean,
) => {
  const expectedByActualOrigin = new Map<number, Set<number>>();
  const missingByActualBoundary = new Map<number, Set<number>>();

  const addOrigins = (
    target: Map<number, Set<number>>,
    key: number,
    origins: number[],
  ) => {
    const existing = target.get(key) ?? new Set<number>();
    origins.forEach((origin) => existing.add(origin));
    target.set(key, existing);
  };
  const originalBoundaryForToken = (tokenBoundary: number) => {
    const rightToken = actual.tokens[tokenBoundary];
    const rightOrigin = rightToken?.origins[0];
    return rightOrigin ?? actual.originals.length;
  };

  let mismatchRun: AlignmentOperation[] = [];
  const flushMismatchRun = () => {
    if (mismatchRun.length === 0) return;
    const expectedOrigins = [
      ...new Set(
        mismatchRun.flatMap((operation) =>
          operation.type === "insert"
            ? []
            : (expected.tokens[operation.expectedIndex]?.origins ?? []),
        ),
      ),
    ].sort((left, right) => left - right);
    const actualOrigins = [
      ...new Set(
        mismatchRun.flatMap((operation) =>
          operation.type === "delete"
            ? []
            : (actual.tokens[operation.actualIndex]?.origins ?? []),
        ),
      ),
    ].sort((left, right) => left - right);

    if (actualOrigins.length > 0 && expectedOrigins.length > 0) {
      addOrigins(
        expectedByActualOrigin,
        actualOrigins.at(-1)!,
        expectedOrigins,
      );
    } else if (expectedOrigins.length > 0) {
      addOrigins(
        missingByActualBoundary,
        originalBoundaryForToken(mismatchRun[0].actualIndex),
        expectedOrigins,
      );
    }
    mismatchRun = [];
  };

  for (const operation of alignment.operations) {
    if (operation.type === "match") {
      flushMismatchRun();
      const expectedOrigins =
        expected.tokens[operation.expectedIndex]?.origins ?? [];
      const actualOrigins = actual.tokens[operation.actualIndex]?.origins ?? [];
      actualOrigins.forEach((actualOrigin) =>
        addOrigins(expectedByActualOrigin, actualOrigin, expectedOrigins),
      );
    } else mismatchRun.push(operation);
  }
  flushMismatchRun();

  const emittedExpected = new Set<number>();
  const emittedExpectedFormatting = new Set<number>();
  const actualOriginsByExpected = new Map<number, number[]>();
  for (const [actualOrigin, expectedOrigins] of expectedByActualOrigin) {
    for (const expectedOrigin of expectedOrigins) {
      const linked = actualOriginsByExpected.get(expectedOrigin) ?? [];
      linked.push(actualOrigin);
      actualOriginsByExpected.set(expectedOrigin, linked);
    }
  }
  const pieces: Array<{
    state: RenderState;
    from: number;
    to: number;
  }> = [];
  let revealedText = "";
  const append = (text: string, state: RenderState) => {
    if (!text) return;
    const from = revealedText.length;
    revealedText += text;
    const last = pieces.at(-1);
    if (last?.state === state && last.to === from)
      last.to = revealedText.length;
    else pieces.push({ state, from, to: revealedText.length });
  };
  const appendExpectedOrigins = (
    origins: Iterable<number>,
    state: "replacement" | "addition",
    actualOrigin?: number,
  ) => {
    const requested = [...new Set(origins)].sort((left, right) => left - right);
    if (requested.length === 0) return;
    const requestedSet = new Set(requested);
    const first = requested[0];
    if (state === "replacement" && actualOrigin !== undefined) {
      let previousContent = first - 1;
      while (
        previousContent >= 0 &&
        !expected.originals[previousContent].projection
      ) {
        previousContent -= 1;
      }
      const previousActualOrigin = (
        actualOriginsByExpected.get(previousContent) ?? []
      )
        .filter((origin) => origin < actualOrigin)
        .at(-1);
      const submittedSeparator =
        previousActualOrigin !== undefined &&
        actual.originals
          .slice(previousActualOrigin + 1, actualOrigin)
          .some((original) => !original.projection);
      if (
        previousContent >= 0 &&
        emittedExpected.has(previousContent) &&
        !submittedSeparator
      ) {
        for (let origin = previousContent + 1; origin < first; origin += 1) {
          const original = expected.originals[origin];
          if (
            original &&
            !original.projection &&
            !emittedExpectedFormatting.has(origin)
          ) {
            emittedExpectedFormatting.add(origin);
            append(original.text, "neutral");
          }
        }
      }
    }
    for (let origin = requested[0]; origin <= requested.at(-1)!; origin += 1) {
      const original = expected.originals[origin];
      if (!original) continue;
      if (original.projection) {
        if (requestedSet.has(origin) && !emittedExpected.has(origin)) {
          emittedExpected.add(origin);
          append(original.text, state);
        }
      } else if (!emittedExpectedFormatting.has(origin)) {
        emittedExpectedFormatting.add(origin);
        append(original.text, "neutral");
      }
    }
    if (state === "replacement" && actualOrigin !== undefined) {
      const last = requested.at(-1)!;
      let nextContent = last + 1;
      while (
        nextContent < expected.originals.length &&
        !expected.originals[nextContent].projection
      ) {
        nextContent += 1;
      }
      const nextActualOrigin = (
        actualOriginsByExpected.get(nextContent) ?? []
      ).find((origin) => origin > actualOrigin);
      const submittedSeparator =
        nextActualOrigin !== undefined &&
        actual.originals
          .slice(actualOrigin + 1, nextActualOrigin)
          .some((original) => !original.projection);
      if (nextContent < expected.originals.length && !submittedSeparator) {
        for (let origin = last + 1; origin < nextContent; origin += 1) {
          const original = expected.originals[origin];
          if (
            original &&
            !original.projection &&
            !emittedExpectedFormatting.has(origin)
          ) {
            emittedExpectedFormatting.add(origin);
            append(original.text, "neutral");
          }
        }
      }
    }
  };
  const appendMissingExpectedOrigins = (
    origins: Iterable<number>,
    actualBoundary: number,
  ) => {
    const requested = [...new Set(origins)].sort((left, right) => left - right);
    if (requested.length === 0) return;
    const first = requested[0];
    const last = requested.at(-1)!;
    let previousContent = first - 1;
    while (
      previousContent >= 0 &&
      !expected.originals[previousContent].projection
    ) {
      previousContent -= 1;
    }
    let nextContent = last + 1;
    while (
      nextContent < expected.originals.length &&
      !expected.originals[nextContent].projection
    ) {
      nextContent += 1;
    }
    const hasSubmittedSeparator = Boolean(
      actualBoundary > 0 && !actual.originals[actualBoundary - 1]?.projection,
    );
    const requestedSet = new Set(requested);
    for (
      let index = hasSubmittedSeparator ? first : previousContent + 1;
      index < nextContent;
      index += 1
    ) {
      const original = expected.originals[index];
      if (original.projection) {
        if (requestedSet.has(index) && !emittedExpected.has(index)) {
          emittedExpected.add(index);
          append(original.text, "addition");
        }
      } else if (!emittedExpectedFormatting.has(index)) {
        emittedExpectedFormatting.add(index);
        append(original.text, "neutral");
      }
    }
  };

  for (let boundary = 0; boundary <= actual.originals.length; boundary += 1) {
    appendMissingExpectedOrigins(
      missingByActualBoundary.get(boundary) ?? [],
      boundary,
    );
    const original = actual.originals[boundary];
    if (!original) continue;
    const state = actualStates[boundary];
    if (!original.projection || state === "neutral") {
      append(original.text, "neutral");
      continue;
    }
    const linkedExpected =
      expectedByActualOrigin.get(boundary) ?? new Set<number>();
    const linkedExpectedNeedsCorrection = [...linkedExpected].some(
      (origin) => expectedStates[origin] !== "correct",
    );
    if (state === "correct" && !linkedExpectedNeedsCorrection) {
      linkedExpected.forEach((origin) => emittedExpected.add(origin));
      append(original.text, "correct");
      continue;
    }
    const pendingExpected = [...linkedExpected].filter(
      (origin) => !emittedExpected.has(origin),
    );
    append(original.text, "removed");
    if (pendingExpected.length > 0)
      appendExpectedOrigins(pendingExpected, "replacement", boundary);
  }

  appendExpectedOrigins(
    expected.originals.flatMap((original, index) =>
      original.projection && !emittedExpected.has(index) ? [index] : [],
    ),
    "addition",
  );

  // Segment each appended piece independently. Segmenting the concatenated
  // result would allow a correction that starts with a combining mark to join
  // the preceding struck-through grapheme and inherit the wrong decoration.
  const revealedOriginals: OriginalGrapheme[] = [];
  const revealedStates: RenderState[] = [];
  for (const piece of pieces) {
    const text = revealedText.slice(piece.from, piece.to);
    for (const part of segmenter.segment(text)) {
      const from = piece.from + part.index;
      revealedOriginals.push({
        text: part.segment,
        from,
        to: from + part.segment.length,
        projection: [...part.segment]
          .filter((character) => {
            const codePoint = character.codePointAt(0)!;
            return (
              CONTENT_CODE_POINT.test(character) &&
              !isDefaultIgnorable(codePoint) &&
              !isPresentationComponent(codePoint) &&
              !BIDI_CONTROL.test(character)
            );
          })
          .join(""),
      });
      revealedStates.push(piece.state);
    }
  }
  const revealed: ProjectedText = {
    normalizedOriginal: revealedText,
    originals: revealedOriginals,
    tokens: [],
    text: projectJudgedText(revealedText, caseSensitive).text,
  };
  return { revealedText, revealed, revealedStates };
};

export const gradeDraft = (
  expectedText: string,
  actualText: string,
  caseSensitive: boolean,
  cellBudget = 2_000_000,
): GradeResult => {
  const expected = projectText(expectedText, caseSensitive);
  const actual = projectText(actualText, caseSensitive);
  const alignment = alignTokens(expected.tokens, actual.tokens, cellBudget);
  const expectedTokenStates: Array<"correct" | "incorrect" | undefined> = Array(
    expected.tokens.length,
  );
  const tokenStates: Array<"correct" | "incorrect" | "extra" | undefined> =
    Array(actual.tokens.length);
  const missingByBoundary = new Map<number, MissingBoundary>();
  let correct = 0;
  let incorrect = 0;
  let extra = 0;
  let missing = 0;

  for (const operation of alignment.operations) {
    if (operation.type === "match") {
      correct += 1;
      expectedTokenStates[operation.expectedIndex] = "correct";
      tokenStates[operation.actualIndex] = "correct";
    } else if (operation.type === "substitute") {
      incorrect += 1;
      expectedTokenStates[operation.expectedIndex] = "incorrect";
      tokenStates[operation.actualIndex] = "incorrect";
    } else if (operation.type === "insert") {
      extra += 1;
      tokenStates[operation.actualIndex] = "extra";
    } else {
      missing += 1;
      expectedTokenStates[operation.expectedIndex] = "incorrect";
      const expectedOrigins =
        expected.tokens[operation.expectedIndex]?.origins ?? [];
      const boundary = missingByBoundary.get(operation.actualIndex) ?? {
        count: 0,
        firstExpectedToken: operation.expectedIndex,
        lastExpectedToken: operation.expectedIndex,
        firstExpectedOrigin: expectedOrigins[0],
        lastExpectedOrigin: expectedOrigins.at(-1),
      };
      boundary.count += 1;
      boundary.firstExpectedToken = Math.min(
        boundary.firstExpectedToken,
        operation.expectedIndex,
      );
      boundary.lastExpectedToken = Math.max(
        boundary.lastExpectedToken,
        operation.expectedIndex,
      );
      if (expectedOrigins[0] !== undefined) {
        boundary.firstExpectedOrigin =
          boundary.firstExpectedOrigin === undefined
            ? expectedOrigins[0]
            : Math.min(boundary.firstExpectedOrigin, expectedOrigins[0]);
      }
      if (expectedOrigins.at(-1) !== undefined) {
        boundary.lastExpectedOrigin =
          boundary.lastExpectedOrigin === undefined
            ? expectedOrigins.at(-1)
            : Math.max(boundary.lastExpectedOrigin, expectedOrigins.at(-1)!);
      }
      missingByBoundary.set(operation.actualIndex, boundary);
    }
  }

  const expectedStates = mapTokenStatesToOriginals(
    expected,
    expectedTokenStates,
  );
  const states = mapTokenStatesToOriginals(actual, tokenStates);
  const revealedResult = buildRevealedText(
    expected,
    expectedStates,
    actual,
    states,
    alignment,
    caseSensitive,
  );

  const markers = [...missingByBoundary.entries()].map(
    ([boundary, missingBoundary]) => ({
      boundary,
      count: missingBoundary.count,
      position: markerPosition(expected, actual, boundary, missingBoundary),
    }),
  );

  const expectedCount = expected.tokens.length;
  return {
    exact: alignment.exact,
    complete:
      alignment.exact && incorrect === 0 && extra === 0 && missing === 0,
    correct,
    incorrect,
    extra,
    missing,
    expectedCount,
    progress: expectedCount === 0 ? 1 : correct / expectedCount,
    expected,
    expectedStates,
    actual,
    states,
    markers,
    ...revealedResult,
  };
};
