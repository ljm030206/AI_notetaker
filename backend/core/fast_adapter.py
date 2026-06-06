# backend/core/fast_adapter.py

import numpy as np
from faster_whisper import WhisperModel

class FastWhisperAdapter:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(FastWhisperAdapter, cls).__new__(cls)
            cls._instance._initialize_engine()
        return cls._instance

    def _initialize_engine(self):
        print("🚀 [1st Pass] 초고속 실시간 엔진 (Faster-Whisper base.en) 로딩 중...")
        try:
            # 💡 Apple Silicon에서는 CPU + int8 조합이 CTranslate2 최적화로 인해 압도적으로 빠릅니다.
            self.model = WhisperModel("base.en", device="cpu", compute_type="int8")
            self.reset()
            print("✅ 초고속 실시간 엔진 준비 완료!")
        except Exception as e:
            print(f"❌ 모델 로딩 실패: {e}")
            self.model = None

    def reset(self):
        self.accumulated_audio = []
        self.silence_chunks = 0
        self.is_speaking = False

    async def process_chunk(self, audio_bytes: bytes) -> tuple[str, bool]:
        if not self.model: return "", False

        try:
            audio_int16 = np.frombuffer(audio_bytes, dtype=np.int16)
            if len(audio_int16) == 0: return "", False
                
            audio_float32 = audio_int16.astype(np.float32) / 32768.0
            max_vol = np.max(np.abs(audio_float32))

            # VAD (음성 감지)
            if max_vol < 0.005:
                self.silence_chunks += 1
            else:
                self.silence_chunks = 0
                self.is_speaking = True

            if self.is_speaking or self.silence_chunks < 10:
                self.accumulated_audio.extend(audio_float32.tolist())

            # 💡 1. 문장 확정 (Final): 약 1.5초(6청크) 침묵 시
            if self.silence_chunks > 6 and self.is_speaking:
                if len(self.accumulated_audio) > 8000:
                    text = self._transcribe(self.accumulated_audio)
                    self.reset()
                    if text: return text, True
                self.reset()
                return "", False

            # 💡 2. 실시간 전송 (Partial): 말하는 도중 즉각적으로 번역
            # Faster-Whisper는 연산이 매우 가벼워 매 청크(0.25초)마다 던져도 맥 미니가 버팁니다!
            if self.is_speaking and len(self.accumulated_audio) > 8000:
                text = self._transcribe(self.accumulated_audio)
                if text: return text, False

            return "", False

        except Exception as e:
            print(f"❌ 오디오 처리 에러: {e}")
            self.reset()
            return "", False

    def _transcribe(self, audio_array: list) -> str:
        audio_np = np.array(audio_array, dtype=np.float32)
        audio_np += np.random.normal(0, 1e-6, audio_np.shape).astype(np.float32)
        
        segments, _ = self.model.transcribe(
            audio_np, 
            beam_size=1, 
            without_timestamps=True,
            condition_on_previous_text=False 
        )
        return " ".join([segment.text for segment in segments]).strip()

fast_engine = FastWhisperAdapter()