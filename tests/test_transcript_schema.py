import unittest
from dataclasses import dataclass, field
from typing import List, Optional

from backend.schemas.transcript import (
    assign_sentence_paragraph_links,
    normalize_word_timeline,
    normalize_transcript_payload,
    select_words_by_speech,
    validate_ordered_chunks,
)


@dataclass
class ParagraphLike:
    id: int
    start: float
    end: float
    text: str
    speaker: str
    sentence_ids: List[int] = field(default_factory=list)
    word_start_index: Optional[int] = None
    word_end_index: Optional[int] = None


class TranscriptSchemaTest(unittest.TestCase):
    def test_normalize_payload_links_legacy_sentences_to_paragraphs(self):
        paragraphs = [
            {"id": 1, "start": 0, "end": 5, "text": "First paragraph", "speaker": "Speaker 1"},
            {"id": 2, "start": 5.1, "end": 9, "text": "Second paragraph", "speaker": "Speaker 2"},
        ]
        sentences = [
            {"sentence_id": 0, "start": 0.2, "end": 2.5, "text": "First sentence", "speaker": "Speaker 1"},
            {"sentence_id": 1, "start": 5.3, "end": 7.5, "text": "Second sentence", "speaker": "Speaker 2"},
        ]
        words = [
            {"text": "First", "start": 0.2, "end": 0.6, "speaker": "Speaker 1"},
            {"text": "sentence", "start": 0.6, "end": 1.1, "speaker": "Speaker 1"},
        ]

        normalized_paragraphs, normalized_sentences, normalized_words = normalize_transcript_payload(
            paragraphs,
            sentences,
            words,
        )

        self.assertEqual(normalized_words[0]["index"], 0)
        self.assertEqual(normalized_words[1]["index"], 1)
        self.assertEqual(normalized_sentences[0]["id"], 0)
        self.assertEqual(normalized_sentences[0]["paragraph_id"], 1)
        self.assertEqual(normalized_sentences[1]["paragraph_id"], 2)
        self.assertEqual(normalized_paragraphs[0]["sentence_ids"], [0])
        self.assertEqual(normalized_paragraphs[1]["sentence_ids"], [1])

    def test_assign_sentence_links_updates_dataclass_paragraphs_in_place(self):
        paragraphs = [
            ParagraphLike(id=1, start=0, end=3, text="Alpha", speaker="Speaker 1"),
            ParagraphLike(id=2, start=3, end=6, text="Beta", speaker="Speaker 1"),
        ]
        sentences = [
            {
                "id": 10,
                "sentence_id": 10,
                "start": 0.4,
                "end": 1.5,
                "text": "Alpha sentence",
                "word_start_index": 2,
                "word_end_index": 4,
            },
            {
                "id": 11,
                "sentence_id": 11,
                "start": 3.2,
                "end": 4.2,
                "text": "Beta sentence",
                "word_start_index": 5,
                "word_end_index": 8,
            },
        ]

        assign_sentence_paragraph_links(paragraphs, sentences)

        self.assertEqual(paragraphs[0].sentence_ids, [10])
        self.assertEqual(paragraphs[0].word_start_index, 2)
        self.assertEqual(paragraphs[0].word_end_index, 4)
        self.assertEqual(paragraphs[1].sentence_ids, [11])
        self.assertEqual(sentences[0]["paragraph_id"], 1)
        self.assertEqual(sentences[1]["paragraph_id"], 2)

    def test_normalize_word_timeline_repairs_reversed_and_regressing_times(self):
        words = [
            {"text": "one", "start": 1.0, "end": 0.8},
            {"text": "two", "start": 0.5, "end": 0.7},
            {"text": "three", "start": 2.0, "end": 2.5},
        ]

        normalized = normalize_word_timeline(words)

        self.assertGreater(normalized[0]["end"], normalized[0]["start"])
        self.assertGreaterEqual(normalized[1]["start"], normalized[0]["start"])
        self.assertEqual(normalized[0]["index"], 0)
        self.assertEqual(normalized[2]["index"], 2)

    def test_select_words_by_speech_falls_back_when_vad_drops_too_much(self):
        words = [
            {"text": "word0", "start": 0.0, "end": 0.2},
            {"text": "word1", "start": 0.3, "end": 0.5},
            {"text": "word2", "start": 0.6, "end": 0.8},
            {"text": "word3", "start": 0.9, "end": 1.1},
            {"text": "word4", "start": 1.2, "end": 1.4},
        ]

        selected, diagnostics = select_words_by_speech(
            words,
            [(0.0, 0.25)],
            margin_seconds=0.0,
            max_drop_ratio=0.35,
        )

        self.assertEqual(len(selected), len(words))
        self.assertFalse(diagnostics["vad_filter_applied"])
        self.assertEqual(diagnostics["vad_filter_reason"], "fallback_all_words_excessive_vad_drop")

    def test_select_words_by_speech_filters_when_drop_ratio_is_safe(self):
        words = [
            {"text": "word0", "start": 0.0, "end": 0.2},
            {"text": "word1", "start": 0.3, "end": 0.5},
            {"text": "word2", "start": 0.6, "end": 0.8},
        ]

        selected, diagnostics = select_words_by_speech(
            words,
            [(0.0, 0.55)],
            margin_seconds=0.0,
            max_drop_ratio=0.35,
        )

        self.assertEqual([word["text"] for word in selected], ["word0", "word1"])
        self.assertTrue(diagnostics["vad_filter_applied"])
        self.assertEqual(diagnostics["filtered_word_count"], 2)

    def test_validate_ordered_chunks_rejects_missing_or_reordered_sentence_ids(self):
        self.assertEqual(validate_ordered_chunks([0, 1, 2], [[0, 1], [2]]), [[0, 1], [2]])
        self.assertIsNone(validate_ordered_chunks([0, 1, 2], [[0, 2], [1]]))
        self.assertIsNone(validate_ordered_chunks([0, 1, 2], [[0], [2]]))
        self.assertIsNone(validate_ordered_chunks([0, 1, 2], [[0, 1, 99], [2]]))


if __name__ == "__main__":
    unittest.main()
