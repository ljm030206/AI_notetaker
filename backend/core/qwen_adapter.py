# backend/core/qwen_adapter.py

import torch
import numpy as np
import asyncio
import transformers
transformers.logging.set_verbosity_error()
from qwen_asr import Qwen3ASRModel

class QwenOfflineAdapter:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(QwenOfflineAdapter, cls).__new__(cls)
            cls._instance._initialize_engine()
        return cls._instance

    def _initialize_engine(self):
        print("🚀 [2nd Pass] 사후 정밀 보정 엔진 (Qwen3-ASR) 로딩 중...")
        try:
            self.device = "mps" if torch.backends.mps.is_available() else "cpu"
            self.model = Qwen3ASRModel.from_pretrained(
                "Qwen/Qwen3-ASR-1.7B",
                dtype=torch.float32,
                device_map=self.device,
                max_new_tokens=4096 # 전체 오디오를 한 번에 뽑아야 하므로 토큰 수를 대폭 늘립니다.
            )
            print(f"✅ 정밀 보정 엔진 준비 완료! (디바이스: {self.device})")
        except Exception as e:
            print(f"❌ 정밀 모델 로딩 실패: {e}")
            self.model = None

    async def transcribe_full(self, full_audio_int16: np.ndarray) -> str:
        """녹음이 끝난 전체 오디오 배열을 한 번에 전사합니다."""
        if not self.model or len(full_audio_int16) == 0:
            return ""

        def run_sync():
            # int16 -> float32 변환
            audio_float32 = full_audio_int16.astype(np.float32) / 32768.0
            
            print("⏳ [2nd Pass] 딥러닝 정밀 분석 시작... (잠시만 기다려주세요)")
            results = self.model.transcribe(audio=(audio_float32, 16000), language="English")
            return results[0].text.strip()
            
        # 무거운 작업이므로 스레드 분리
        return await asyncio.to_thread(run_sync)

qwen_offline_engine = QwenOfflineAdapter()