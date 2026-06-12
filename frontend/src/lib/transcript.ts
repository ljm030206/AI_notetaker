export interface TranscriptParagraph {
  id: number;
  start: number;
  end: number;
  text: string;
  translation: string;
  speaker: string;
  sentence_ids: number[];
  word_start_index?: number | null;
  word_end_index?: number | null;
}

export interface TranscriptSentence {
  id: number;
  sentence_id: number;
  paragraph_id?: number | null;
  start: number;
  end: number;
  text: string;
  translation: string;
  speaker: string;
  word_start_index?: number | null;
  word_end_index?: number | null;
}

export interface TranscriptPayload {
  paragraphs?: unknown;
  scripts?: unknown;
  sentences?: unknown;
}

const splitSentenceText = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const pieces = trimmed.match(/[^.!?。！？]+[.!?。！？]?/g);
  if (!pieces) return [trimmed];

  return pieces.map((piece) => piece.trim()).filter(Boolean);
};

const coerceNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const coerceOptionalIndex = (value: unknown): number | null => {
  const parsed = coerceNumber(value);
  return parsed === null ? null : parsed;
};

const coerceId = (source: Record<string, unknown>, fallback: number, primaryKey = "id") => {
  const primary = coerceNumber(source[primaryKey]);
  if (primary !== null) return primary;

  const sentenceId = coerceNumber(source.sentence_id);
  if (sentenceId !== null) return sentenceId;

  return fallback;
};

const coerceIdList = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => coerceNumber(item))
    .filter((item): item is number => item !== null);
};

export const normalizeParagraphList = (data: TranscriptPayload): TranscriptParagraph[] => {
  const rawParagraphs = Array.isArray(data.paragraphs) && data.paragraphs.length > 0
    ? data.paragraphs
    : Array.isArray(data.scripts) && data.scripts.length > 0
      ? data.scripts
      : [];

  const paragraphs: TranscriptParagraph[] = [];
  rawParagraphs.forEach((script, idx: number) => {
    const source = script as Record<string, unknown>;
    const start = coerceNumber(source.start);
    const end = coerceNumber(source.end);

    if (start === null) {
      return;
    }

    paragraphs.push({
      id: coerceId(source, idx),
      start,
      end: end === null ? start : Math.max(start, end),
      text: typeof source.text === "string" ? source.text : "",
      translation: typeof source.translation === "string" ? source.translation : "",
      speaker: typeof source.speaker === "string" ? source.speaker : "Speaker 1",
      sentence_ids: coerceIdList(source.sentence_ids),
      word_start_index: coerceOptionalIndex(source.word_start_index),
      word_end_index: coerceOptionalIndex(source.word_end_index),
    });
  });

  return paragraphs;
};

export const normalizeSubtitleList = (data: TranscriptPayload): TranscriptSentence[] => {
  if (Array.isArray(data.sentences) && data.sentences.length > 0) {
    const sentences: TranscriptSentence[] = [];
    data.sentences.forEach((sentence, idx: number) => {
      const source = sentence as Record<string, unknown>;
      const start = coerceNumber(source.start);
      const end = coerceNumber(source.end);

      if (start === null) {
        return;
      }

      const text = typeof source.text === "string" ? source.text : "";
      const translation = typeof source.translation === "string" ? source.translation : text;

      sentences.push({
        id: coerceId(source, idx),
        sentence_id: coerceId(source, idx, "sentence_id"),
        paragraph_id: coerceOptionalIndex(source.paragraph_id),
        start,
        end: end === null ? start : Math.max(start, end),
        text,
        translation,
        speaker: typeof source.speaker === "string" ? source.speaker : "Speaker 1",
        word_start_index: coerceOptionalIndex(source.word_start_index),
        word_end_index: coerceOptionalIndex(source.word_end_index),
      });
    });

    return sentences;
  }

  const paragraphFallbacks = normalizeParagraphList(data);
  return paragraphFallbacks.flatMap((paragraph, paragraphIndex) => {
    const sourceText = paragraph.translation.trim() || paragraph.text.trim();
    const sentenceTexts = splitSentenceText(sourceText);
    if (sentenceTexts.length <= 1) {
      return [{
        id: paragraph.id * 1000 + paragraphIndex,
        sentence_id: paragraph.id * 1000 + paragraphIndex,
        paragraph_id: paragraph.id,
        start: paragraph.start,
        end: paragraph.end,
        text: paragraph.text,
        translation: sourceText,
        speaker: paragraph.speaker,
        word_start_index: paragraph.word_start_index,
        word_end_index: paragraph.word_end_index,
      }];
    }

    const totalDuration = Math.max(0.1, paragraph.end - paragraph.start);
    const lengths = sentenceTexts.map((sentence) => Math.max(1, sentence.length));
    const totalLength = lengths.reduce((sum, length) => sum + length, 0);
    let cursor = paragraph.start;

    return sentenceTexts.map((sentenceText, sentenceIndex) => {
      const ratio = lengths[sentenceIndex] / totalLength;
      const segmentEnd = sentenceIndex === sentenceTexts.length - 1
        ? paragraph.end
        : Math.min(paragraph.end, cursor + totalDuration * ratio);
      const id = paragraph.id * 1000 + sentenceIndex;

      const segment = {
        id,
        sentence_id: id,
        paragraph_id: paragraph.id,
        start: cursor,
        end: Math.max(cursor, segmentEnd),
        text: sentenceText,
        translation: sentenceText,
        speaker: paragraph.speaker,
        word_start_index: paragraph.word_start_index,
        word_end_index: paragraph.word_end_index,
      };
      cursor = segment.end;
      return segment;
    });
  });
};
