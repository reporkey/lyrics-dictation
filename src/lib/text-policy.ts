import emojiRegex from "emoji-regex";

const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const DISALLOWED_CONTROL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/u;
const UNPAIRED_SURROGATE = /[\ud800-\udfff]/u;
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const FORMAT_CONTROL = /\p{Cf}/u;
const EMOJI_MODIFIER = /\p{Emoji_Modifier}/u;
const RGI_EMOJI = emojiRegex();

const hasPresentationComponent = (grapheme: string) =>
  [...grapheme].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint === 0x200d ||
      codePoint === 0x20e3 ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      EMOJI_MODIFIER.test(character)
    );
  });

const isAllowedPresentationSequence = (grapheme: string) => {
  RGI_EMOJI.lastIndex = 0;
  const match = RGI_EMOJI.exec(grapheme);
  RGI_EMOJI.lastIndex = 0;
  return Boolean(match && match.index === 0 && match[0] === grapheme);
};

const firstPresentationComponentOffset = (grapheme: string) => {
  let offset = 0;
  for (const character of grapheme) {
    if (
      DEFAULT_IGNORABLE.test(character) ||
      FORMAT_CONTROL.test(character) ||
      hasPresentationComponent(character)
    ) {
      return offset;
    }
    offset += character.length;
  }
  return 0;
};

export const findUnsafeControl = (value: string): number | null => {
  const directIndexes = [BIDI_CONTROL, DISALLOWED_CONTROL, UNPAIRED_SURROGATE]
    .map((pattern) => pattern.exec(value)?.index)
    .filter((index): index is number => index !== undefined);
  let earliest = directIndexes.length ? Math.min(...directIndexes) : null;
  for (const part of segmenter.segment(value)) {
    if (
      (DEFAULT_IGNORABLE.test(part.segment) ||
        FORMAT_CONTROL.test(part.segment) ||
        hasPresentationComponent(part.segment)) &&
      !isAllowedPresentationSequence(part.segment)
    ) {
      const componentIndex =
        part.index + firstPresentationComponentOffset(part.segment);
      earliest =
        earliest === null ? componentIndex : Math.min(earliest, componentIndex);
      break;
    }
  }
  if (earliest === null) return null;
  return [...value.slice(0, earliest)].length;
};
