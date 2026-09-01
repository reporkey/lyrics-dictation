import { useEffect, useLayoutEffect, useRef } from "react";
import {
  Annotation,
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  placeholder as placeholderExtension,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { collectDecorationRanges, type GradeResult } from "../lib/grading";
import { LIMITS } from "../lib/constants";
import { findUnsafeControl } from "../lib/text-policy";

interface GradeDecorationValue {
  grade: GradeResult | null;
  missingLabel: string;
}

const setGrade = StateEffect.define<GradeDecorationValue>();
const externalDocumentUpdate = Annotation.define<boolean>();

class MissingWidget extends WidgetType {
  constructor(
    private readonly count: number,
    private readonly label: string,
  ) {
    super();
  }

  eq(other: MissingWidget) {
    return other.count === this.count && other.label === this.label;
  }

  toDOM() {
    const marker = document.createElement("span");
    marker.className = "cm-missing-marker";
    marker.contentEditable = "false";
    marker.setAttribute("role", "img");
    marker.setAttribute("aria-label", `${this.label} (${this.count})`);
    marker.dataset.count = String(this.count);
    return marker;
  }

  ignoreEvent() {
    return true;
  }
}

const buildDecorations = ({
  grade,
  missingLabel,
}: GradeDecorationValue): DecorationSet => {
  if (!grade) return Decoration.none;
  const ranges: Array<ReturnType<Decoration["range"]>> = [];
  const decorationRanges =
    grade.decorationRanges ??
    collectDecorationRanges(grade.actual, grade.states);
  decorationRanges.forEach((run) => {
    const className =
      run.state === "correct"
        ? "cm-judged-correct"
        : run.state === "replacement"
          ? "cm-result-replacement"
          : run.state === "addition"
            ? "cm-result-addition"
            : run.state === "removed"
              ? "cm-result-removed"
              : run.state === "extra"
                ? "cm-judged-extra"
                : "cm-judged-incorrect";
    ranges.push(Decoration.mark({ class: className }).range(run.from, run.to));
  });
  grade.markers.forEach((marker) => {
    ranges.push(
      Decoration.widget({
        widget: new MissingWidget(marker.count, missingLabel),
        side: -1,
      }).range(marker.position),
    );
  });
  return Decoration.set(ranges, true);
};

const gradeField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setGrade)) next = buildDecorations(effect.value);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const byteLength = (value: string) =>
  new TextEncoder().encode(value).byteLength;

export const DictationEditor = ({
  value,
  grade,
  onChange,
  onLimit,
  onInvalid,
  label,
  placeholder,
  missingLabel,
  descriptionId,
  readOnly = false,
}: {
  value: string;
  grade: GradeResult | null;
  onChange: (value: string) => void;
  onLimit: () => void;
  onInvalid: (position: number) => void;
  label: string;
  placeholder: string;
  missingLabel: string;
  descriptionId?: string;
  readOnly?: boolean;
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartmentRef = useRef(new Compartment());
  const localizationCompartmentRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onLimitRef = useRef(onLimit);
  const onInvalidRef = useRef(onInvalid);
  onChangeRef.current = onChange;
  onLimitRef.current = onLimit;
  onInvalidRef.current = onInvalid;

  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        gradeField,
        history(),
        EditorView.lineWrapping,
        localizationCompartmentRef.current.of([
          placeholderExtension(placeholder),
          EditorView.contentAttributes.of({
            "aria-label": label,
            ...(descriptionId ? { "aria-describedby": descriptionId } : {}),
            spellcheck: "false",
            autocorrect: "off",
            autocapitalize: "off",
            autocomplete: "off",
            translate: "no",
          }),
        ]),
        readOnlyCompartmentRef.current.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        EditorState.transactionFilter.of((transaction) => {
          if (
            !transaction.docChanged ||
            transaction.annotation(externalDocumentUpdate)
          )
            return transaction;
          const next = transaction.newDoc.toString();
          if (
            [...next].length > LIMITS.draftScalars ||
            byteLength(next) > LIMITS.draftBytes
          ) {
            queueMicrotask(() => onLimitRef.current());
            return [];
          }
          const unsafePosition = findUnsafeControl(next);
          if (unsafePosition !== null) {
            queueMicrotask(() => onInvalidRef.current(unsafePosition + 1));
            return [];
          }
          return transaction;
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            update.view.dom.parentElement?.setAttribute(
              "data-document-length",
              String(update.state.doc.length),
            );
          }
          const external = update.transactions.some((transaction) =>
            transaction.annotation(externalDocumentUpdate),
          );
          if (update.docChanged && !update.view.composing && !external) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.domEventHandlers({
          compositionend: (_event, view) => {
            queueMicrotask(() =>
              onChangeRef.current(view.state.doc.toString()),
            );
            return false;
          },
          paste: (event) => {
            const html = event.clipboardData?.getData("text/html");
            if (html && !event.clipboardData?.getData("text/plain"))
              event.preventDefault();
            return false;
          },
        }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
      ],
    });
    hostRef.current.dataset.documentLength = String(state.doc.length);
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor lifetime is intentionally stable; changing props are dispatched below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || view.composing) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        annotations: [
          externalDocumentUpdate.of(true),
          Transaction.addToHistory.of(false),
        ],
      });
    }
  }, [value]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || view.composing) return;
    view.dispatch({ effects: setGrade.of({ grade, missingLabel }) });
  }, [grade, missingLabel]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: localizationCompartmentRef.current.reconfigure([
        placeholderExtension(placeholder),
        EditorView.contentAttributes.of({
          "aria-label": label,
          ...(descriptionId ? { "aria-describedby": descriptionId } : {}),
          spellcheck: "false",
          autocorrect: "off",
          autocapitalize: "off",
          autocomplete: "off",
          translate: "no",
        }),
      ]),
    });
  }, [descriptionId, label, placeholder]);

  return <div className="dictation-editor" ref={hostRef} />;
};
