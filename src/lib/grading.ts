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
  const byCharacter = new Map<string, ProvenanceRecord[]>();
  for (const record of records) {
    const character = text.slice(record.from, record.to);
    const queue = byCharacter.get(character) ?? [];
    queue.push(record);
    byCharacter.set(character, queue);
  }

  let orderedText = "";
  const orderedRecords: ProvenanceRecord[] = [];
  for (const character of targetText) {
    const source = byCharacter.get(character)?.shift();
    if (!source) throw new Error("Unable to preserve Unicode provenance");
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

// For very long texts, a full edit-distance matrix is not safe. Myers' bounded
// shortest-edit search still finds an exact alignment when the two lyrics are
// close (including repeated-text shifts) while keeping worst-case work capped.
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
  const trace: Int32Array[] = [];
  let finalDepth = -1;

  search: for (let depth = 0; depth <= maxEdits; depth += 1) {
    trace.push(diagonals.slice());
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

  const reversed: AlignmentOperation[] = [];
  let expectedIndex = expected.length;
  let actualIndex = actual.length;
  for (let depth = finalDepth; depth >= 0; depth -= 1) {
    const previous = trace[depth];
    const diagonal = expectedIndex - actualIndex;
    const index = diagonalOffset + diagonal;
    const previousDiagonal =
      diagonal === -depth ||
      (diagonal !== depth && previous[index - 1] < previous[index + 1])
        ? diagonal + 1
        : diagonal - 1;
    const previousExpected = Math.max(
      0,
      previous[diagonalOffset + previousDiagonal],
    );
    const previousActual = previousExpected - previousDiagonal;
    while (expectedIndex > previousExpected && actualIndex > previousActual) {
      reversed.push({
        type: "match",
        expectedIndex: expectedOffset + expectedIndex - 1,
        actualIndex: actualOffset + actualIndex - 1,
      });
      expectedIndex -= 1;
      actualIndex -= 1;
    }
    if (depth === 0) break;
    if (expectedIndex === previousExpected) {
      reversed.push({
        type: "insert",
        expectedIndex: expectedOffset + expectedIndex,
        actualIndex: actualOffset + actualIndex - 1,
      });
      actualIndex -= 1;
    } else {
      reversed.push({
        type: "delete",
        expectedIndex: expectedOffset + expectedIndex - 1,
        actualIndex: actualOffset + actualIndex,
      });
      expectedIndex -= 1;
    }
  }

  const operations = reversed.reverse();
  const coalesced: AlignmentOperation[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const current = operations[index];
    const next = operations[index + 1];
    if (
      next &&
      ((current.type === "delete" && next.type === "insert") ||
        (current.type === "insert" && next.type === "delete"))
    ) {
      const deletion = current.type === "delete" ? current : next;
      const insertion = current.type === "insert" ? current : next;
      coalesced.push({
        type: "substitute",
        expectedIndex: deletion.expectedIndex,
        actualIndex: insertion.actualIndex,
      });
      index += 1;
    } else {
      coalesced.push(current);
    }
  }
  return { operations: coalesced, exact: true };
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

export type RenderState = "correct" | "incorrect" | "extra" | "neutral";

export interface MissingMarker {
  position: number;
  count: number;
  boundary: number;
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
}

const mapTokenStatesToOriginals = (
  projection: ProjectedText,
  tokenStates: Array<"correct" | "incorrect" | undefined>,
): RenderState[] => {
  const statesByOrigin: Array<Array<"correct" | "incorrect">> = Array.from(
    { length: projection.originals.length },
    () => [],
  );
  projection.tokens.forEach((token, tokenIndex) => {
    const state = tokenStates[tokenIndex];
    if (!state) return;
    token.origins.forEach((origin) => statesByOrigin[origin].push(state));
  });
  return projection.originals.map((original, originIndex) => {
    if (!original.projection) return "neutral";
    const contributing = statesByOrigin[originIndex];
    if (contributing.length === 0) return "neutral";
    return contributing.every((state) => state === "correct")
      ? "correct"
      : "incorrect";
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

  for (const operation of alignment.operations) {
    if (operation.type === "match" || operation.type === "substitute") {
      const expectedOrigins =
        expected.tokens[operation.expectedIndex]?.origins ?? [];
      const actualOrigins = actual.tokens[operation.actualIndex]?.origins ?? [];
      actualOrigins.forEach((actualOrigin) =>
        addOrigins(expectedByActualOrigin, actualOrigin, expectedOrigins),
      );
    } else if (operation.type === "delete") {
      addOrigins(
        missingByActualBoundary,
        originalBoundaryForToken(operation.actualIndex),
        expected.tokens[operation.expectedIndex]?.origins ?? [],
      );
    }
  }

  const emittedExpected = new Set<number>();
  const emittedExpectedFormatting = new Set<number>();
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
  const appendExpectedOrigins = (origins: Iterable<number>) => {
    [...origins]
      .sort((left, right) => left - right)
      .forEach((origin) => {
        if (emittedExpected.has(origin)) return;
        emittedExpected.add(origin);
        append(expected.originals[origin]?.text ?? "", "incorrect");
      });
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
          append(original.text, "incorrect");
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
    if (pendingExpected.length > 0) appendExpectedOrigins(pendingExpected);
    else append(original.text, "extra");
  }

  appendExpectedOrigins(
    expected.originals.flatMap((original, index) =>
      original.projection && !emittedExpected.has(index) ? [index] : [],
    ),
  );

  const revealed = projectText(revealedText, caseSensitive);
  let pieceIndex = 0;
  const revealedStates = revealed.originals.map((original) => {
    while (pieces[pieceIndex]?.to <= original.from) pieceIndex += 1;
    const overlapping: RenderState[] = [];
    for (
      let scan = pieceIndex;
      scan < pieces.length && pieces[scan].from < original.to;
      scan += 1
    ) {
      if (pieces[scan].to > original.from) overlapping.push(pieces[scan].state);
    }
    if (overlapping.includes("incorrect")) return "incorrect";
    if (overlapping.includes("extra")) return "extra";
    if (overlapping.includes("correct")) return "correct";
    return "neutral";
  });
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
  const tokenStates: Array<"correct" | "incorrect" | undefined> = Array(
    actual.tokens.length,
  );
  const missingByBoundary = new Map<number, number>();
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
      tokenStates[operation.actualIndex] = "incorrect";
    } else {
      missing += 1;
      expectedTokenStates[operation.expectedIndex] = "incorrect";
      missingByBoundary.set(
        operation.actualIndex,
        (missingByBoundary.get(operation.actualIndex) ?? 0) + 1,
      );
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

  const markers = [...missingByBoundary.entries()].map(([boundary, count]) => {
    if (boundary === 0) return { boundary, count, position: 0 };
    const leftToken =
      actual.tokens[Math.min(boundary - 1, actual.tokens.length - 1)];
    const lastOrigin = leftToken?.origins.at(-1);
    return {
      boundary,
      count,
      position: lastOrigin === undefined ? 0 : actual.originals[lastOrigin].to,
    };
  });

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
