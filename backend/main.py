# backend/main.py
from typing import Dict, List, Optional
import warnings

from fastapi import FastAPI, HTTPException, File, Request, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from backend.api import websocket
import os
import hashlib
import firebase_admin
from firebase_admin import credentials, firestore, storage
from datetime import datetime

from backend.core.llm_client import LLMClient
from backend.core.whisperx_adapter import WhisperXAdapter
from backend.services.stt_service import STTService
from backend.services.summarizer import generate_video_summary  # ✅ 임포트 추가
from backend.services.summary_service import SummaryService

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

key_path = os.path.join(BASE_DIR, "firebase-key.json")

cred = credentials.Certificate(key_path)
if not firebase_admin._apps:
    firebase_admin.initialize_app(cred, {
        'storageBucket': 'ainotetaker-ad8c4.firebasestorage.app'
    })

db = firestore.client(database_id='main')
bucket = storage.bucket()

whisper_adapter = WhisperXAdapter()
try:
    llm_client = LLMClient()
except EnvironmentError as exc:
    print(f"⚠️ LLM client disabled: {exc}")
    llm_client = None

stt_service = STTService(db, bucket, whisper_adapter=whisper_adapter, llm_client=llm_client)
summary_service = SummaryService(llm_client=llm_client) if llm_client else None


class ParagraphItem(BaseModel):
    id: int
    start: float
    end: float
    text: str
    translation: str
    speaker: str


class SummaryRequest(BaseModel):
    file_hash: str
    paragraphs: List[ParagraphItem]


class VideoSummaryRequest(BaseModel):
    file_hash: str
    text: str

app = FastAPI(title="AI Notetaker API")

def get_file_hash(file_bytes: bytes) -> str:
    return hashlib.sha256(file_bytes).hexdigest()

@app.post("/api/transcribe-media")
async def transcribe_media(
    file: UploadFile = File(...),
    user_id: str = Form(...),
    course_domain: str = Form("General")
):
    print(f"🎵 미디어 파일 수신: {file.filename} (User: {user_id})")
    warnings.filterwarnings("ignore", category=RuntimeWarning)

    file_bytes = await file.read()
    file_hash = get_file_hash(file_bytes)

    try:
        cached = stt_service.fetch_cached_response(file_hash)
        if cached:
            print(f"🔁 기존 파일 {file_hash} 발견 - 캐시된 결과 반환")
            return cached

        await file.seek(0)
        return await stt_service.transcribe_media(file, user_id, course_domain)
    except HTTPException:
        print("⚠️ HTTPException 발생 - 클라이언트 오류")
        raise
    except Exception as exc:
        print(f"❌ 미디어 처리 에러: {exc}")
        raise HTTPException(status_code=500, detail="미디어 처리 중 에러가 발생했습니다.")
    finally:
        await file.close()

@app.post("/api/upload-pdf")
async def upload_pdf(file: UploadFile = File(...), user_id: str = Form(...)):
    try:
        # 1. 파일 해시 생성 (고유 ID 역할)
        contents = await file.read()
        file_hash = hashlib.md5(contents).hexdigest()

        storage_path = f"uploads/{file_hash}.pdf"
        # 2. Firebase Storage에 PDF 업로드
        # (확장자가 pdf인지 한 번 더 체크)
        blob = bucket.blob(storage_path)
        blob.metadata = {"userId": str(user_id)}
        blob.upload_from_string(contents, content_type="application/pdf")

        
        # 3. Firestore 문서 생성
        doc_ref = db.collection('files').document(file_hash)
        doc_ref.set({
            "fileName": file.filename,
            "fileType": "pdf",
            "storage_path": storage_path,
            "userId": user_id,
            "uploadedAt": firestore.SERVER_TIMESTAMP,
            "summary": {}, # PDF는 슬라이드별 요약 딕셔너리가 들어감
        })

        return {
            "message": "PDF 업로드 성공",
            "file_info": {
                "hash": file_hash,
                "storage_path": storage_path,
                "fileName": file.filename,
                "fileType": "pdf"
            }
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await file.close()

@app.get("/api/files/{file_hash}")
async def get_file_detail(file_hash: str):
    print(f"📂 파일 데이터 불러오기 시도: {file_hash}")
    
    # 1. 파일 기본 정보(메타데이터) 가져오기
    doc_ref = db.collection('files').document(file_hash)
    doc = doc_ref.get()

    if not doc.exists:
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")

    file_data = doc.to_dict()

    # 2. 해당 파일에 속한 모든 전사 스크립트 가져오기 (ID 순서대로)
    paragraphs_ref = doc_ref.collection('paragraphs').order_by('id').stream()
    paragraphs = [paragraph.to_dict() for paragraph in paragraphs_ref]

    print(f"✅ {len(paragraphs)}개의 스크립트 조각 로드 완료")
    
    return {
        "file_info": file_data,
        "scripts": paragraphs,
        "paragraphs": paragraphs,
        "sentences": file_data.get("sentences", []),
        "word_timestamps": file_data.get("word_timestamps", []),
        "summary": file_data.get("summary", {}),
        "video_summary": file_data.get("video_summary", "")
    }

@app.post("/api/summarize")
async def summarize_transcription(request: SummaryRequest):
    if summary_service is None:
        raise HTTPException(status_code=503, detail="Summarization service unavailable without an LLM key.")

    if not request.paragraphs:
        raise HTTPException(status_code=400, detail="문단 데이터를 제공해 주세요.")

    try:
        paragraph_dicts = [paragraph.dict() for paragraph in request.paragraphs]
        summary_payload = await summary_service.summarize_paragraphs(paragraph_dicts)
        doc_ref = db.collection('files').document(request.file_hash)
        if not doc_ref.get().exists:
            raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
        doc_ref.update({
            "summary": summary_payload,
            "updatedAt": firestore.SERVER_TIMESTAMP
        })
        return summary_payload
    except HTTPException:
        raise
    except Exception as exc:
        print(f"❌ 요약 에러: {exc}")
        raise HTTPException(status_code=500, detail="서버 에러")

@app.post("/api/summarize-video")
async def summarize_video_endpoint(request: VideoSummaryRequest):
    file_hash = request.file_hash
    
    try:
        print("⏳ 비디오 전체 요약 시작...")
        summary_result = await generate_video_summary(request.text)
        doc_ref = db.collection('files').document(file_hash)
        doc_ref.update({
            "video_summary": summary_result, # 문자열(String) 형태로 저장됨
            "updatedAt": firestore.SERVER_TIMESTAMP
        })
        
        return {"summary": summary_result}
    except Exception as e:
        print(f"❌ 비디오 요약 에러: {e}")
        raise HTTPException(status_code=500, detail="서버 에러")

@app.delete("/api/files/{file_hash}")
async def delete_file(file_hash: str):
    try:
        # 1. Firestore 문서 참조
        doc_ref = db.collection('files').document(file_hash)
        doc = doc_ref.get()
        
        if not doc.exists:
            raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
        
        file_data = doc.to_dict()
        
        # 🚨 [수정된 부분] DB에 저장된 카멜 케이스(storagePath)로 가져옵니다.
        storage_path = file_data.get("storagePath")
        
        # 💡 [안전장치] 만약 예전에 올린 파일이라 storagePath가 없다면?
        if not storage_path:
            # 파일 타입에 따라 확장자를 유추해서 경로를 강제로 만들어줍니다.
            ext = ".pdf" if file_data.get("fileType") == "pdf" else ".wav"
            # 참고: 영상 파일의 경우 원본 확장자가 다를 수 있지만,
            # 현재 stt_service의 _upload_blob 로직을 보면 기본적으로 .wav로 저장되거나 원본 확장자를 따릅니다.
            # 정확성을 위해 fileUrl에서 파일명을 파싱하는 것도 방법이지만, 가장 확실한 해시 기반으로 접근합니다.
            storage_path = f"uploads/{file_hash}{ext}"

        # 2. Storage 파일 삭제
        if storage_path:
            try:
                # 버킷에서 해당 경로의 blob을 찾아 삭제
                blob = bucket.blob(storage_path)
                if blob.exists():
                    blob.delete()
            except Exception as e:
                print(f"⚠️ Storage 삭제 중 오류 (무시하고 계속): {e}")

        # 3. Firestore 하위 컬렉션(paragraphs) 삭제
        paragraphs_ref = doc_ref.collection('paragraphs').stream()
        for p in paragraphs_ref:
            p.reference.delete()

        # 4. Firestore 메인 문서 삭제
        doc_ref.delete()

        return {"message": "파일이 완전히 삭제되었습니다."}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.patch("/api/files/{file_hash}/rename")
async def rename_file(file_hash: str, request: Request):
    data = await request.json()
    new_name = data.get("new_name")
    
    if not new_name:
        raise HTTPException(status_code=400, detail="새 이름을 입력해주세요.")
        
    doc_ref = db.collection('files').document(file_hash)
    doc_ref.update({"fileName": new_name})
    
    return {"message": "이름이 변경되었습니다.", "new_name": new_name}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 개발 중에는 모두 허용. 실제 서비스 시 프론트엔드 도메인으로 변경하세요.
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# WebSocket 라우터 등록
app.include_router(websocket.router)

@app.get("/")
def read_root():
    return {"status": "ok", "message": "AI Notetaker API is running!"}
