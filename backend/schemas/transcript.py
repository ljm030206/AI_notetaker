from dataclasses import asdict, is_dataclass
from typing import Any, Dict, List, MutableMapping, Optional, Sequence, Tuple


TRANSCRIPT_SCHEMA_VERSION = 1
MIN_WORD_DURATION_SECONDS = 0.02


def to_plain_dict(item: Any) -> Dict[str, Any]:
    if is_dataclass(item):
        return asdict(item)
    if isinstance(item, dict):
        return dict(item)
    return dict(getattr(item, "__dict__", {}))


def normalize_word_timeline(words: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized_words: List[Dict[str, Any]] = []
    last_start = 0.0

    for fallback_index, word in enumerate(words):
        text = str(word.get("text") or word.get("word") or "").strip()
        if not text:
            continue

        start = max(0.0, _coerce_float(word.get("start"), last_start))
        start = max(start, last_start)
        end = _coerce_float(word.get("end"), start + MIN_WORD_DURATION_SECONDS)
        if end <= start:
            end = start + MIN_WORD_DURATION_SECONDS

        normalized_word = dict(word)
        normalized_word.update({
            "text": text,
            "start": start,
            "end": end,
            "index": _coerce_int(word.get("index"), fallback_index),
        })
        normalized_words.append(normalized_word)
        last_start = start

    return normalized_words


def select_words_by_speech(
    words: Sequence[Dict[str, Any]],
    speech_spans: Sequence[Tuple[float, float]],
    *,
    margin_seconds: float = 0.25,
    max_drop_ratio: float = 0.35,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    normalized_words = normalize_word_timeline(words)
    raw_count = len(normalized_words)
    diagnostics: Dict[str, Any] = {
        "raw_word_count": raw_count,
        "vad_span_count": len(speech_spans),
        "vad_matched_word_count": raw_count,
        "vad_dropped_word_count": 0,
        "vad_dropped_word_ratio": 0.0,
        "filtered_word_count": raw_count,
        "dropped_word_count": 0,
        "dropped_word_ratio": 0.0,
        "vad_filter_applied": False,
        "vad_filter_reason": "no_speech_spans",
    }

    if raw_count == 0:
        diagnostics["vad_filter_reason"] = "no_words"
        return [], diagnostics

    if not speech_spans:
        return normalized_words, diagnostics

    matched_words = _filter_words_by_speech_span(normalized_words, speech_spans, margin_seconds)
    matched_count = len(matched_words)
    matched_drop_count = raw_count - matched_count
    matched_drop_ratio = matched_drop_count / raw_count if raw_count else 0.0

    diagnostics.update({
        "vad_matched_word_count": matched_count,
        "vad_dropped_word_count": matched_drop_count,
        "vad_dropped_word_ratio": matched_drop_ratio,
    })

    if matched_count == 0:
        diagnostics["vad_filter_reason"] = "fallback_all_words_no_vad_overlap"
        return normalized_words, diagnostics

    if matched_drop_ratio > max_drop_ratio:
        diagnostics["vad_filter_reason"] = "fallback_all_words_excessive_vad_drop"
        return normalized_words, diagnostics

    diagnostics.update({
        "filtered_word_count": matched_count,
        "dropped_word_count": matched_drop_count,
        "dropped_word_ratio": matched_drop_ratio,
        "vad_filter_applied": True,
        "vad_filter_reason": "matched_words_within_drop_threshold",
    })
    return matched_words, diagnostics


def validate_ordered_chunks(
    expected_sentence_ids: Sequence[int],
    chunk_ids_list: Sequence[Sequence[Any]],
) -> Optional[List[List[int]]]:
    expected_ids = [_coerce_int(sentence_id, -1) for sentence_id in expected_sentence_ids]
    if not expected_ids:
        return []

    expected_set = set(expected_ids)
    normalized_chunks: List[List[int]] = []
    flattened: List[int] = []

    for chunk_ids in chunk_ids_list:
        if not chunk_ids:
            return None

        normalized_chunk: List[int] = []
        for chunk_id in chunk_ids:
            sentence_id = _coerce_int(chunk_id, -1)
            if sentence_id not in expected_set:
                return None
            normalized_chunk.append(sentence_id)

        normalized_chunks.append(normalized_chunk)
        flattened.extend(normalized_chunk)

    if flattened != expected_ids:
        return None

    return normalized_chunks


def normalize_transcript_payload(
    paragraphs: Sequence[Any],
    sentences: Sequence[Dict[str, Any]],
    words: Sequence[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    normalized_words = normalize_word_timeline(words)
    normalized_paragraphs = [_normalize_paragraph(to_plain_dict(paragraph), index) for index, paragraph in enumerate(paragraphs)]
    normalized_sentences = [_normalize_sentence(sentence, index) for index, sentence in enumerate(sentences)]
    assign_sentence_paragraph_links(normalized_paragraphs, normalized_sentences)
    return normalized_paragraphs, normalized_sentences, normalized_words


def assign_sentence_paragraph_links(paragraphs: Sequence[Any], sentences: Sequence[MutableMapping[str, Any]]) -> None:
    paragraph_dicts = [to_plain_dict(paragraph) for paragraph in paragraphs]
    sentence_ids_by_paragraph: Dict[int, List[int]] = {
        _coerce_int(paragraph.get("id"), index + 1): []
        for index, paragraph in enumerate(paragraph_dicts)
    }

    for index, sentence in enumerate(sentences):
        sentence_id = _coerce_int(sentence.get("sentence_id", sentence.get("id")), index)
        sentence["id"] = _coerce_int(sentence.get("id"), sentence_id)
        sentence["sentence_id"] = sentence_id
        paragraph_id = _find_best_paragraph_id(sentence, paragraph_dicts)
        sentence["paragraph_id"] = paragraph_id
        if paragraph_id is not None:
            sentence_ids_by_paragraph.setdefault(paragraph_id, []).append(sentence_id)

    for index, paragraph in enumerate(paragraphs):
        paragraph_id = _coerce_int(_read_value(paragraph, "id"), index + 1)
        sentence_ids = sentence_ids_by_paragraph.get(paragraph_id, [])
        _write_value(paragraph, "sentence_ids", sentence_ids)

        linked_sentences = [
            sentence for sentence in sentences if sentence.get("paragraph_id") == paragraph_id
        ]
        if linked_sentences:
            _write_value(paragraph, "word_start_index", linked_sentences[0].get("word_start_index"))
            _write_value(paragraph, "word_end_index", linked_sentences[-1].get("word_end_index"))


def _normalize_paragraph(paragraph: Dict[str, Any], fallback_index: int) -> Dict[str, Any]:
    paragraph_id = _coerce_int(paragraph.get("id"), fallback_index + 1)
    start = _coerce_float(paragraph.get("start"), 0.0)
    end = max(start, _coerce_float(paragraph.get("end"), start))
    return {
        **paragraph,
        "id": paragraph_id,
        "start": start,
        "end": end,
        "text": str(paragraph.get("text") or ""),
        "translation": str(paragraph.get("translation") or ""),
        "speaker": str(paragraph.get("speaker") or "Speaker 1"),
        "sentence_ids": _coerce_int_list(paragraph.get("sentence_ids")),
        "word_start_index": _coerce_optional_int(paragraph.get("word_start_index")),
        "word_end_index": _coerce_optional_int(paragraph.get("word_end_index")),
    }


def _normalize_sentence(sentence: Dict[str, Any], fallback_index: int) -> Dict[str, Any]:
    sentence_id = _coerce_int(sentence.get("sentence_id", sentence.get("id")), fallback_index)
    start = _coerce_float(sentence.get("start"), 0.0)
    end = max(start, _coerce_float(sentence.get("end"), start))
    return {
        **sentence,
        "id": _coerce_int(sentence.get("id"), sentence_id),
        "sentence_id": sentence_id,
        "paragraph_id": _coerce_optional_int(sentence.get("paragraph_id")),
        "start": start,
        "end": end,
        "text": str(sentence.get("text") or ""),
        "translation": str(sentence.get("translation") or ""),
        "speaker": str(sentence.get("speaker") or "Speaker 1"),
        "word_start_index": _coerce_optional_int(sentence.get("word_start_index")),
        "word_end_index": _coerce_optional_int(sentence.get("word_end_index")),
    }


def _find_best_paragraph_id(sentence: MutableMapping[str, Any], paragraphs: Sequence[Dict[str, Any]]) -> Optional[int]:
    if not paragraphs:
        return None

    sentence_range = (_coerce_float(sentence.get("start"), 0.0), _coerce_float(sentence.get("end"), 0.0))
    best_id: Optional[int] = None
    best_overlap = -1.0

    for index, paragraph in enumerate(paragraphs):
        paragraph_id = _coerce_int(paragraph.get("id"), index + 1)
        paragraph_range = (_coerce_float(paragraph.get("start"), 0.0), _coerce_float(paragraph.get("end"), 0.0))
        overlap = _range_overlap(sentence_range, paragraph_range)
        if overlap > best_overlap:
            best_id = paragraph_id
            best_overlap = overlap

    if best_overlap <= 0:
        sentence_midpoint = (sentence_range[0] + sentence_range[1]) / 2
        for index, paragraph in enumerate(paragraphs):
            start = _coerce_float(paragraph.get("start"), 0.0)
            end = _coerce_float(paragraph.get("end"), start)
            if start <= sentence_midpoint <= end:
                return _coerce_int(paragraph.get("id"), index + 1)
        return None

    return best_id


def _range_overlap(first: Tuple[float, float], second: Tuple[float, float]) -> float:
    start = max(first[0], second[0])
    end = min(first[1], second[1])
    return max(0.0, end - start)


def _filter_words_by_speech_span(
    words: Sequence[Dict[str, Any]],
    speech_spans: Sequence[Tuple[float, float]],
    margin_seconds: float,
) -> List[Dict[str, Any]]:
    filtered: List[Dict[str, Any]] = []
    spans = sorted(
        (
            max(0.0, _coerce_float(start, 0.0) - margin_seconds),
            max(0.0, _coerce_float(end, 0.0) + margin_seconds),
        )
        for start, end in speech_spans
    )
    span_index = 0

    for word in words:
        start = _coerce_float(word.get("start"), 0.0)
        end = _coerce_float(word.get("end"), start)
        while span_index < len(spans) and spans[span_index][1] < start:
            span_index += 1

        if span_index < len(spans):
            span_start, span_end = spans[span_index]
            if span_start <= end and span_end >= start:
                filtered.append(dict(word))

    return filtered


def _read_value(item: Any, key: str) -> Any:
    if isinstance(item, dict):
        return item.get(key)
    return getattr(item, key, None)


def _write_value(item: Any, key: str, value: Any) -> None:
    if isinstance(item, dict):
        item[key] = value
    else:
        setattr(item, key, value)


def _coerce_int(value: Any, fallback: int) -> int:
    try:
        if value is None:
            return fallback
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _coerce_optional_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_int_list(value: Any) -> List[int]:
    if not isinstance(value, list):
        return []
    return [_coerce_int(item, -1) for item in value if _coerce_int(item, -1) >= 0]


def _coerce_float(value: Any, fallback: float) -> float:
    try:
        if value is None:
            return fallback
        return float(value)
    except (TypeError, ValueError):
        return fallback
