import asyncio
import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import inspect
import torch
import whisperx
from pyannote.audio import Pipeline

DEFAULT_MODEL = "medium.en"
DIARIZATION_MODEL = "pyannote/speaker-diarization"
DEFAULT_LANGUAGE = "en"
DEFAULT_BATCH_SIZE = 16
DEFAULT_COMPUTE_TYPE = "int8"


@dataclass
class WordTimestamp:
    text: str
    start: float
    end: float
    speaker: str
    confidence: float


def _read_int_env(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        print(f"⚠️ Invalid {name}={value!r}; using {default}")
        return default


class WhisperXAdapter:
    def __init__(self, model_name: Optional[str] = None):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model_name = model_name or os.environ.get("WHISPERX_MODEL", DEFAULT_MODEL)
        self.compute_type = os.environ.get("WHISPERX_COMPUTE_TYPE", DEFAULT_COMPUTE_TYPE)
        self.batch_size = _read_int_env("WHISPERX_BATCH_SIZE", DEFAULT_BATCH_SIZE)
        self.language = os.environ.get("WHISPERX_LANGUAGE", DEFAULT_LANGUAGE).strip() or None
        self.model = whisperx.load_model(self.model_name, device=self.device, compute_type=self.compute_type)
        self.align_cache: Dict[str, Tuple[object, object]] = {}
        self.diarization_pipeline: Optional[Pipeline] = None

        hf_token = os.environ.get("HUGGINGFACE_TOKEN")
        if hf_token:
            try:
                self.diarization_pipeline = Pipeline.from_pretrained(
                    DIARIZATION_MODEL,
                    use_auth_token=hf_token,
                    device=self.device
                )
            except Exception as exc:
                print(f"⚠️ Pyannote diarization load failed: {exc}")

    async def transcribe(self, audio_path: str, initial_prompt: Optional[str] = None) -> Dict[str, object]:
        return await asyncio.to_thread(self._transcribe_sync, audio_path, initial_prompt)

    def _transcribe_sync(self, audio_path: str, initial_prompt: Optional[str] = None) -> Dict[str, object]:
        result = self.model.transcribe(
            audio_path,
            batch_size=self.batch_size,
            verbose=False,
            **self._build_transcribe_kwargs(initial_prompt)
        )

        language = str(result.get("language", "en"))
        segments = result.get("segments", [])
        segments = self._align_segments(segments, audio_path, language)
        result["segments"] = segments

        diarization = self._run_diarization(audio_path)
        result = self._assign_speaker_labels(result, diarization)

        word_timestamps = self._extract_words(result.get("segments", []), diarization)

        return {
            "segments": result.get("segments", []),
            "language": language,
            "model": self.model_name,
            "compute_type": self.compute_type,
            "batch_size": self.batch_size,
            "language_hint": self.language,
            "word_timestamps": [word.__dict__ for word in word_timestamps]
        }

    def _get_align_model(self, language: str) -> Tuple[object, object]:
        if language in self.align_cache:
            return self.align_cache[language]

        align_model, align_metadata = whisperx.load_align_model(language, device=self.device)
        self.align_cache[language] = (align_model, align_metadata)
        return align_model, align_metadata

    def _run_diarization(self, audio_path: str):
        if not self.diarization_pipeline:
            return None

        try:
            return self.diarization_pipeline(audio_path)
        except Exception as exc:
            print(f"⚠️ Pyannote diarization step failed: {exc}")
            return None

    def _extract_words(self, segments: List[Dict], diarization) -> List[WordTimestamp]:
        speaker_map: Dict[str, str] = {}
        annotated: List[WordTimestamp] = []

        diarization_tracks = list(diarization.itertracks(yield_label=True)) if diarization else []

        def find_speaker(timestamp: float) -> str:
            if not diarization_tracks:
                return "Speaker 1"

            for segment, _, label in diarization_tracks:
                if segment.start <= timestamp <= segment.end:
                    if label not in speaker_map:
                        speaker_map[label] = f"Speaker {len(speaker_map) + 1}"
                    return speaker_map[label]
            return "Speaker 1"

        for segment in segments:
            for word in segment.get("words", []):
                if not word.get("text"):
                    continue

                midpoint = (word["start"] + word["end"]) / 2
                speaker_label = word.get("speaker") or find_speaker(midpoint)
                annotated.append(
                    WordTimestamp(
                        text=word["text"].strip(),
                        start=word["start"],
                        end=word["end"],
                        speaker=speaker_label,
                        confidence=word.get("confidence", 0.0)
                    )
                )

        return annotated

    def _align_segments(self, segments: List[Dict], audio_path: str, language: str) -> List[Dict]:
        try:
            align_model, align_metadata = self._get_align_model(language)
            aligned = whisperx.align(
                segments,
                align_model,
                align_metadata,
                audio_path,
                self.device
            )
            return aligned.get("segments", segments)
        except Exception as exc:
            print(f"⚠️ WhisperX align step failed ({language}): {exc}")
            return segments

    def _assign_speaker_labels(self, result: Dict[str, List[Dict]], diarization):
        if not diarization:
            return result
        try:
            return whisperx.assign_word_speakers(diarization, result)
        except Exception as exc:
            print(f"⚠️ WhisperX speaker assignment failed: {exc}")
            return result

    def _build_transcribe_kwargs(self, initial_prompt: Optional[str]) -> Dict[str, object]:
        kwargs: Dict[str, object] = {}
        signature = inspect.signature(self.model.transcribe)
        if self.language and "language" in signature.parameters:
            kwargs["language"] = self.language
        if not initial_prompt:
            return kwargs
        if "initial_prompt" in signature.parameters:
            kwargs["initial_prompt"] = initial_prompt
        elif "prompt" in signature.parameters:
            kwargs["prompt"] = initial_prompt
        return kwargs
