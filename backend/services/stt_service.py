import asyncio
import hashlib
import io
import os
import tempfile
from collections import Counter, deque
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import webrtcvad
from fastapi import UploadFile
from pydub import AudioSegment

from backend.core.llm_client import LLMClient
from backend.core.whisperx_adapter import WhisperXAdapter
from backend.services.translator import translate_text


@dataclass
class ParagraphChunk:
    id: int
    start: float
    end: float
    text: str
    speaker: str
    translation: str = ""


@dataclass
class Frame:
    bytes: bytes
    timestamp: float
    duration: float


class VADFilter:
    def __init__(self, frame_duration_ms: int = 30, padding_ms: int = 300, aggressiveness: int = 2):
        self.vad = webrtcvad.Vad(aggressiveness)
        self.frame_duration_ms = frame_duration_ms
        self.padding_ms = padding_ms

    def _frame_generator(self, audio_bytes: bytes, sample_rate: int) -> List[Frame]:
        frame_length = int(sample_rate * (self.frame_duration_ms / 1000.0) * 2)
        frames: List[Frame] = []
        timestamp = 0.0
        offset = 0
        duration = self.frame_duration_ms / 1000.0

        while offset + frame_length <= len(audio_bytes):
            frames.append(Frame(audio_bytes[offset : offset + frame_length], timestamp, duration))
            timestamp += duration
            offset += frame_length
        return frames

    def _vad_collector(self, frames: List[Frame], sample_rate: int) -> List[Tuple[float, float]]:
        if not frames:
            return []

        num_padding_frames = max(1, int(self.padding_ms / self.frame_duration_ms))
        ring_buffer = deque(maxlen=num_padding_frames)
        triggered = False
        voiced_start = 0.0
        segments: List[Tuple[float, float]] = []

        for frame in frames:
            is_speech = self.vad.is_speech(frame.bytes, sample_rate)
            if not triggered:
                ring_buffer.append((frame, is_speech))
                num_voiced = len([f for f, speech in ring_buffer if speech])
                if num_voiced > 0.9 * ring_buffer.maxlen:
                    triggered = True
                    voiced_start = ring_buffer[0][0].timestamp
                    ring_buffer.clear()
            else:
                if is_speech:
                    ring_buffer.clear()
                else:
                    ring_buffer.append((frame, is_speech))
                    num_unvoiced = len([f for f, speech in ring_buffer if not speech])
                    if num_unvoiced > 0.9 * ring_buffer.maxlen:
                        end = frame.timestamp + frame.duration
                        segments.append((voiced_start, end))
                        triggered = False
                        ring_buffer.clear()

        if triggered:
            last_frame = frames[-1]
            segments.append((voiced_start, last_frame.timestamp + last_frame.duration))

        return segments

    def get_speech_segments(self, audio_segment: AudioSegment) -> List[Tuple[float, float]]:
        raw_bytes = audio_segment.raw_data
        sample_rate = audio_segment.frame_rate
        frames = self._frame_generator(raw_bytes, sample_rate)
        return self._vad_collector(frames, sample_rate)


class STTService:
    MAX_SILENCE_GAP = 2.0
    CHUNK_MAX_DURATION = 20.0
    SENTENCE_BOUNDARIES = {".", "?", "!"}
    COURSE_CONTEXT_KEYWORDS = {
        "Programming Language": "compiler, syntax, type systems, data structures, algorithms, control flow, functions",
        "Introduction of Network": "protocols, packets, TCP/IP, routing, OSI layers, LAN, WAN, sockets",
        "Machine Learning": "models, datasets, training, inference, loss functions, neural networks, features"
    }
    DEFAULT_COURSE_PROMPT = "This is a lecture on technical subjects. Keywords: clarity, accuracy, core concepts."

    def __init__(
        self,
        db,
        bucket,
        whisper_adapter: Optional[WhisperXAdapter] = None,
        llm_client: Optional[LLMClient] = None
    ):
        self.db = db
        self.bucket = bucket
        self.whisper_adapter = whisper_adapter or WhisperXAdapter()
        self.llm_client = llm_client
        self.vad_filter = VADFilter()

    def _build_course_prompt(self, course_domain: str) -> str:
        domain = course_domain.strip() if course_domain else "General"
        keywords = self.COURSE_CONTEXT_KEYWORDS.get(domain)
        if keywords:
            return f"This is a lecture on {domain}. Keywords: {keywords}."
        return self.DEFAULT_COURSE_PROMPT

    async def transcribe_media(self, file: UploadFile, user_id: str, course_domain: str = "General") -> Dict:
        print(f"🎵 STTService: Transcribing media file '{file.filename}' for user '{user_id}'")
        file_bytes = await file.read()
        file_hash = self._hash_bytes(file_bytes)
        doc_ref = self.db.collection("files").document(file_hash)
        snapshot = doc_ref.get()
        if snapshot.exists:
            return self._cached_result(snapshot, doc_ref)

        normalized_audio = self._normalize_audio(file_bytes, file.content_type)
        speech_spans = self.vad_filter.get_speech_segments(normalized_audio)

        temp_path = self._dump_temp_wav(normalized_audio)
        try:
            initial_prompt = self._build_course_prompt(course_domain)
            transcription = await self.whisper_adapter.transcribe(temp_path, initial_prompt=initial_prompt)
        finally:
            os.remove(temp_path)

        raw_words = self._flatten_aligned_words(transcription.get("segments", []))
        filtered_words = self._filter_words_by_speech(raw_words, speech_spans)

        sentences = self._group_words_into_sentences(filtered_words)
        paragraphs = await self._build_paragraph_chunks(filtered_words, sentences)
        sentences = await self._translate_sentences(sentences, course_domain)
        paragraphs = await self._translate_paragraphs(paragraphs, course_domain)
        paragraph_dicts = [paragraph.__dict__ for paragraph in paragraphs]
        sentence_dicts = sentences

        storage_path = self._upload_blob(file_bytes, file_hash, file.filename, file.content_type or "audio/mpeg", user_id)
        metadata = {
            "fileName": file.filename,
            "fileType": file.content_type or "audio",
            "storage_path": storage_path,
            "uploadedAt": datetime.now().isoformat(),
            "hash": file_hash,
            "userId": user_id,
            "paragraph_count": len(paragraphs),
            "sentence_count": len(sentence_dicts),
            "word_timestamps": filtered_words,
            "summary": {},
            "video_summary": "",
            "courseDomain": course_domain
        }
        metadata["sentences"] = sentence_dicts

        doc_ref.set(metadata)
        for paragraph_dict in paragraph_dicts:
            doc_ref.collection("paragraphs").document(str(paragraph_dict["id"])).set(paragraph_dict)

        return {
            "paragraphs": paragraph_dicts,
            "scripts": paragraph_dicts,
            "sentences": sentence_dicts,
            "word_timestamps": filtered_words,
            "is_cached": False,
            "file_info": metadata
        }

    def _cached_result(self, snapshot, doc_ref):
        paragraphs = [
            doc.to_dict() for doc in doc_ref.collection("paragraphs").order_by("id").stream()
        ]
        return {
            "paragraphs": paragraphs,
            "scripts": paragraphs,
            "sentences": snapshot.get("sentences", []),
            "word_timestamps": snapshot.get("word_timestamps", []),
            "is_cached": True,
            "file_info": snapshot.to_dict()
        }

    def fetch_cached_response(self, file_hash: str):
        doc_ref = self.db.collection("files").document(file_hash)
        snapshot = doc_ref.get()
        if not snapshot.exists:
            return None
        return self._cached_result(snapshot, doc_ref)

    def _hash_bytes(self, content: bytes) -> str:
        return hashlib.sha256(content).hexdigest()

    def _normalize_audio(self, content: bytes, content_type: Optional[str]) -> AudioSegment:
        audio = AudioSegment.from_file(io.BytesIO(content))
        return (
            audio.set_frame_rate(16000)
            .set_channels(1)
            .set_sample_width(2)
        )

    def _dump_temp_wav(self, audio_segment: AudioSegment) -> str:
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        try:
            audio_segment.export(temp_file.name, format="wav")
            return temp_file.name
        except Exception:
            # 🚨 내보내기 실패 시 찌꺼기 파일 즉시 삭제
            os.unlink(temp_file.name)
            raise
        finally:
            temp_file.close()

    def _upload_blob(self, content: bytes, file_hash: str, filename: str, content_type: str, user_id: str) -> str:
        ext = os.path.splitext(filename)[1] or ".wav"
        storage_path = f"uploads/{file_hash}{ext}"

        blob = self.bucket.blob(storage_path)
        blob.metadata = {"userId": str(user_id)}
        blob.upload_from_string(content, content_type=content_type)
     
        return storage_path

    def _flatten_aligned_words(self, segments: List[Dict]) -> List[Dict]:
        flattened = []
        for segment in segments:
            segment_speaker = segment.get("speaker")

            for word in segment.get("words", []):
                text = word.get("word") or word.get("text")
                start = word.get("start")
                end = word.get("end")
                if not text or start is None or end is None:
                    continue

                flattened.append({
                    "text": text.strip(),
                    "start": start,
                    "end": end,
                    "speaker": word.get("speaker") or segment_speaker or "Speaker 1",
                    "confidence": word.get("confidence", 0.0)
                })

        return flattened

    def _filter_words_by_speech(self, words: List[Dict], speech_spans: List[Tuple[float, float]]) -> List[Dict]:
        if not speech_spans:
            return [word for word in words if word.get("text")]

        filtered: List[Dict] = []
        spans = sorted(speech_spans)
        span_index = 0

        for word in words:
            if not word.get("text"):
                continue

            start = word["start"]
            end = word["end"]
            while span_index < len(spans) and spans[span_index][1] < start:
                span_index += 1

            if span_index < len(spans):
                span_start, span_end = spans[span_index]
                if span_start <= end and span_end >= start:
                    filtered.append(word)

        return filtered

    async def _build_paragraph_chunks(
        self,
        words: List[Dict],
        sentences: Optional[List[Dict]] = None
    ) -> List[ParagraphChunk]:
        sentence_list = sentences if sentences is not None else self._group_words_into_sentences(words)
        if sentence_list and self.llm_client:
            try:
                chunk_ids = await self._semantic_chunk_sentences(sentence_list)
                if chunk_ids:
                    paragraphs = self._assemble_paragraphs_from_chunks(sentence_list, chunk_ids)
                    if paragraphs:
                        return paragraphs
            except Exception as exc:
                print(f"⚠️ Semantic chunking failed: {exc}")
        return self._fallback_chunking(words)

    def _group_words_into_sentences(self, words: List[Dict]) -> List[Dict]:
        sentences: List[Dict] = []
        current: Optional[Dict] = None
        sentence_id = 0

        for word in words:
            text = word["text"].strip()
            if not text:
                continue
            start = word["start"]
            end = word["end"]
            speaker = word.get("speaker", "Speaker 1")
            ends_sentence = self._ends_sentence(text)

            if current is None:
                current = {
                    "sentence_id": sentence_id,
                    "start": start,
                    "end": end,
                    "text": text,
                    "speaker_counts": {speaker: 1}
                }
            else:
                current["text"] += f" {text}"
                current["end"] = end
                current["speaker_counts"][speaker] = current["speaker_counts"].get(speaker, 0) + 1

            if ends_sentence:
                dominant = max(current["speaker_counts"].items(), key=lambda pair: pair[1])[0]
                sentences.append({
                    "sentence_id": current["sentence_id"],
                    "start": current["start"],
                    "end": current["end"],
                    "text": current["text"].strip(),
                    "speaker": dominant
                })
                sentence_id += 1
                current = None

        if current:
            dominant = max(current["speaker_counts"].items(), key=lambda pair: pair[1])[0]
            sentences.append({
                "sentence_id": current["sentence_id"],
                "start": current["start"],
                "end": current["end"],
                "text": current["text"].strip(),
                "speaker": dominant
            })

        return sentences

    async def _semantic_chunk_sentences(self, sentences: List[Dict]) -> List[List[int]]:
        if not self.llm_client or not sentences:
            return []

        chunk_ids: List[List[int]] = []
        batch_size = 35
        for i in range(0, len(sentences), batch_size):
            batch = sentences[i : i + batch_size]
            grouped = await self.llm_client.group_sentences_semantically(batch)
            if not grouped:
                raise ValueError("LLM returned no semantic chunks")
            chunk_ids.extend(grouped)
        return chunk_ids

    def _assemble_paragraphs_from_chunks(self, sentences: List[Dict], chunk_ids_list: List[List[int]]) -> List[ParagraphChunk]:
        sentence_map = {s["sentence_id"]: s for s in sentences}
        paragraphs: List[ParagraphChunk] = []
        paragraph_id = 1

        for chunk_ids in chunk_ids_list:
            chunk_sentences = [
                sentence_map[sid] for sid in chunk_ids if sid in sentence_map
            ]
            if not chunk_sentences:
                continue

            chunk_sentences.sort(key=lambda s: s["sentence_id"])
            text = " ".join(sentence["text"] for sentence in chunk_sentences).strip()
            start = chunk_sentences[0]["start"]
            end = chunk_sentences[-1]["end"]
            speaker_counts = Counter(
                sentence.get("speaker", "Speaker 1") for sentence in chunk_sentences
            )
            dominant_speaker = speaker_counts.most_common(1)[0][0] if speaker_counts else "Speaker 1"
            paragraphs.append(
                ParagraphChunk(
                    id=paragraph_id,
                    start=start,
                    end=end,
                    text=text,
                    speaker=dominant_speaker,
                    translation=""
                )
            )
            paragraph_id += 1

        return paragraphs

    def _fallback_chunking(self, words: List[Dict]) -> List[ParagraphChunk]:
        chunks: List[Dict] = []
        current: Optional[Dict] = None
        paragraph_id = 1

        for word in words:
            text = word["text"].strip()
            if not text:
                continue

            start = word["start"]
            end = word["end"]
            speaker = word.get("speaker", "Speaker 1")

            if current is None:
                current = self._start_chunk(paragraph_id, start, end, text, speaker)
                paragraph_id += 1
                continue

            gap = start - current["end"]
            speaker_changed = speaker != current.get("last_speaker")
            chunk_duration = current["end"] - current["start"]
            chunk_too_long = chunk_duration >= self.CHUNK_MAX_DURATION and self._ends_sentence(current["text"])

            if speaker_changed or gap > self.MAX_SILENCE_GAP or chunk_too_long:
                chunks.append(current)
                current = self._start_chunk(paragraph_id, start, end, text, speaker)
                paragraph_id += 1
            else:
                current["end"] = end
                current["text"] = f"{current['text']} {text}"
                current["speaker_counts"][speaker] = current["speaker_counts"].get(speaker, 0) + 1
                current["last_speaker"] = speaker

        if current:
            chunks.append(current)

        return [self._finalize_chunk(chunk) for chunk in chunks if chunk["text"].strip()]

    def _start_chunk(self, chunk_id: int, start: float, end: float, text: str, speaker: str) -> Dict:
        return {
            "id": chunk_id,
            "start": start,
            "end": end,
            "text": text,
            "speaker_counts": {speaker: 1},
            "last_speaker": speaker
        }

    def _finalize_chunk(self, chunk: Dict) -> ParagraphChunk:
        dominant = max(chunk["speaker_counts"].items(), key=lambda pair: pair[1])[0]
        return ParagraphChunk(
            id=chunk["id"],
            start=chunk["start"],
            end=chunk["end"],
            text=chunk["text"].strip(),
            speaker=dominant
        )

    async def _translate_sentences(self, sentences: List[Dict], course_domain: str) -> List[Dict]:
        translated: List[Dict] = []
        for sentence in sentences:
            translated_sentence = dict(sentence)
            translated_sentence["translation"] = await self._translate_text(sentence["text"], course_domain)
            translated.append(translated_sentence)
        return translated

    def _ends_sentence(self, text: str) -> bool:
        stripped = text.strip()
        return bool(stripped) and stripped[-1] in self.SENTENCE_BOUNDARIES

    async def _translate_paragraphs(self, paragraphs: List[ParagraphChunk], course_domain: str) -> List[ParagraphChunk]:
        translated = []
        for paragraph in paragraphs:
            paragraph.translation = await self._translate_text(paragraph.text, course_domain)
            translated.append(paragraph)
        return translated

    async def _translate_text(self, text: str, course_domain: str) -> str:
        if not text.strip():
            return ""
        if self.llm_client:
            try:
                return await self.llm_client.translate_text(text, target_lang="ko", course_domain=course_domain)
            except Exception as exc:
                print(f"⚠️ LLM translation failed: {exc}")
        return await translate_text(text, target_lang="ko", course_domain=course_domain)
