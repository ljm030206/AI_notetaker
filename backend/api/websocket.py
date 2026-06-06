# backend/api/websocket.py
import base64
import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import numpy as np

from backend.core.fast_adapter import fast_engine
from backend.core.qwen_adapter import qwen_offline_engine
from backend.services.translator import translate_text

router = APIRouter()

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []
        self.session_data = {}

    async def connect(self, websocket: WebSocket, session_id: str):
        await websocket.accept()
        self.active_connections.append(websocket)
        self.session_data[session_id] = {
            "current_slide": 1, 
            "transcriptions": {},
            # 🚨 [핵심 변경] 전체 오디오를 하나로 합치지 않고, 호흡(문장) 단위로 나누어 담을 리스트
            "current_sentence_audio": [], 
            "sentence_audio_list": []     
        }
        fast_engine.reset()
        print(f"🚀 세션 연결됨: {session_id}")

    def disconnect(self, websocket: WebSocket, session_id: str):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        if session_id in self.session_data:
            del self.session_data[session_id]
        print(f"🔌 세션 종료: {session_id}")

manager = ConnectionManager()

@router.websocket("/ws/record/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await manager.connect(websocket, session_id)
    
    try:
        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_json(), timeout=30.0)
            except asyncio.TimeoutError:
                try:
                    await websocket.send_json({"type": "ping"})
                except Exception:
                    break
                continue
            
            event_type = data.get("type")
            
            if event_type == "audio_chunk":
                audio_b64 = data.get("payload")
                if not audio_b64: continue
                
                audio_bytes = base64.b64decode(audio_b64)
                audio_int16 = np.frombuffer(audio_bytes, dtype=np.int16)
                
                # 1. 일단 현재 문장 바구니에 오디오를 계속 담습니다.
                manager.session_data[session_id]["current_sentence_audio"].append(audio_int16)
                
                # 2. 실시간 STT 엔진으로 즉시 전송
                result = await fast_engine.process_chunk(audio_bytes)
                
                if result:
                    transcribed_text, is_final = result
                    
                    if not transcribed_text.strip():
                        continue

                    # 번역 상태 관리
                    if "translation_state" not in manager.session_data[session_id]:
                        manager.session_data[session_id]["translation_state"] = {"last_len": 0, "last_text": ""}
                    
                    trans_state = manager.session_data[session_id]["translation_state"]
                    current_slide = manager.session_data[session_id]["current_slide"]
                    
                    # 실시간 전송 (Partial)
                    await websocket.send_json({
                        "type": "transcription",
                        "slide": current_slide,
                        "text": transcribed_text,
                        "translation": trans_state["last_text"], 
                        "is_final": is_final 
                    })

                    current_len = len(transcribed_text)
                    if is_final or (current_len - trans_state["last_len"] >= 30):
                        trans_state["last_len"] = current_len

                        async def background_translation(text_to_translate, slide_num, is_final_flag):
                            try:
                                translated_text = await translate_text(text_to_translate, target_lang="ko")
                                trans_state["last_text"] = translated_text
                                try:
                                    await websocket.send_json({
                                        "type": "transcription",
                                        "slide": slide_num,
                                        "text": text_to_translate,
                                        "translation": translated_text,
                                        "is_final": is_final_flag
                                    })
                                except Exception:
                                    pass 
                            except Exception as e:
                                print(f"⚠️ 백그라운드 번역 에러: {e}")

                        asyncio.create_task(background_translation(transcribed_text, current_slide, is_final))

                    # 🚨 [핵심 변경] 문장이 끝났을 때(is_final: True)의 처리
                    if is_final:
                        # 1) 지금까지 모은 오디오를 하나로 뭉쳐서 '완성된 오디오 조각' 리스트에 넣습니다.
                        sentence_audio = np.concatenate(manager.session_data[session_id]["current_sentence_audio"])
                        manager.session_data[session_id]["sentence_audio_list"].append({
                            "slide": current_slide,
                            "audio": sentence_audio
                        })
                        # 2) 다음 문장을 담기 위해 바구니를 비웁니다!
                        manager.session_data[session_id]["current_sentence_audio"] = []
                        
                        trans_state["last_len"] = 0
                        trans_state["last_text"] = ""

            elif event_type == "slide_change":
                manager.session_data[session_id]["current_slide"] = data.get("slide")
                
            elif event_type == "stop_recording":
                print("🛑 녹음 종료 수신! 1st-Pass 잔여물을 정리하고 2-Pass를 시작합니다.")
                current_slide = manager.session_data[session_id].get("current_slide", 1)
                
                # [안전장치 1] 프론트엔드 상태 확정 및 남은 오디오 싹쓸이
                try:
                    if fast_engine.accumulated_audio:
                        last_text = fast_engine._transcribe(fast_engine.accumulated_audio) 
                        if last_text:
                            await websocket.send_json({
                                "type": "transcription",
                                "slide": current_slide,
                                "text": last_text,
                                "translation": "정밀 보정 준비 중...",
                                "is_final": True 
                            })
                            
                            # 🚨 남아있던 마지막 자투리 오디오도 버리지 않고 챙깁니다.
                            if manager.session_data[session_id]["current_sentence_audio"]:
                                leftover_audio = np.concatenate(manager.session_data[session_id]["current_sentence_audio"])
                                manager.session_data[session_id]["sentence_audio_list"].append({
                                    "slide": current_slide,
                                    "audio": leftover_audio
                                })
                except Exception as e:
                    print(f"⚠️ 1st-Pass 잔여물 처리 에러: {e}")
                finally:
                    fast_engine.reset() 
                    manager.session_data[session_id]["current_sentence_audio"] = []

                # 🚨 [안전장치 2] 2-Pass: 잘라둔 오디오 조각들을 하나씩 꺼내서 정밀 보정
                try:
                    audio_segments = manager.session_data[session_id].get("sentence_audio_list", [])
                    total_segments = len(audio_segments) # ✅ 총 조각 개수 계산
                    
                    if total_segments > 0:
                        payload_data = []
                        
                        # ✅ 1단계: 정밀 전사 진행 상황 중계
                        for idx, segment in enumerate(audio_segments):
                            await websocket.send_json({
                                "type": "correction_progress", 
                                "status": "transcribing",
                                "current": idx,        # 현재 진행 중인 인덱스
                                "total": total_segments # 전체 개수
                            })
                            
                            slide_num = segment["slide"]
                            audio_np = segment["audio"]
                            
                            corrected_text = await qwen_offline_engine.transcribe_full(audio_np)
                            
                            if corrected_text and corrected_text not in ["...", "？", "."]:
                                payload_data.append({
                                    "slide": slide_num,
                                    "text": corrected_text,
                                    "translation": "", 
                                    "is_final": True
                                })
                        
                        if payload_data:
                            # ✅ 2단계: 번역 진행 상황 중계
                            for idx, item in enumerate(payload_data):
                                await websocket.send_json({
                                    "type": "correction_progress", 
                                    "status": "translating",
                                    "current": idx,
                                    "total": total_segments
                                })
                                
                                try:
                                    item["translation"] = await translate_text(item["text"], target_lang="ko")
                                except Exception as trans_e:
                                    item["translation"] = "번역 에러"

                            # 최종 데이터 전송
                            await websocket.send_json({
                                "type": "final_correction",
                                "payload": payload_data
                            })
                            print(f"✅ 2-Pass 보정 완료! (총 {len(payload_data)}개 카드)")
                    else:
                        print("⚠️ 저장된 오디오 버퍼가 없어 2-Pass를 건너뜁니다.")
                except Exception as e:
                    print(f"❌ 2-Pass 처리 에러: {e}")
                    
                break 
                
    except WebSocketDisconnect:
        print(f"🔌 클라이언트가 연결을 끊었습니다: {session_id}")
    except Exception as e:
        print(f"❌ 예상치 못한 웹소켓 에러: {e}")
    finally:
        manager.disconnect(websocket, session_id)
