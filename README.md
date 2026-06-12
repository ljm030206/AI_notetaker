# AI Notetaker

긴 강의 영상, 오디오, PDF, 실시간 녹음을 전사하고 요약하는 AI 노트테이킹 워크스페이스입니다. 현재는 Firebase 기반 파일 저장/인증, FastAPI 백엔드, Next.js 프론트엔드로 구성되어 있으며, 영상/음성 전사 결과를 문장/문단 단위 타임스탬프와 함께 다룹니다.

## 현재 지원 기능

- 이메일 기반 로그인/회원가입
- PDF 업로드 및 슬라이드 뷰어
- 실시간 마이크/시스템 오디오 녹음
- 영상/음성 파일 전사
- 문장 단위 한국어 자막 표시
- 좌측 스크립트 카드와 미디어 재생 시간 동기화
- 영상/음성 batch 전사 job 처리
- 한 사용자가 실시간 녹음 중에도 영상/음성 파일을 백그라운드로 병렬 처리
- 전사 결과 문장/문단 관계 저장
- 영상 요약 및 timestamp 링크 이동

## 기술 스택

- Frontend: Next.js 16, React 19, TypeScript, Tailwind CSS, Firebase Web SDK
- Backend: FastAPI, Firebase Admin SDK, Firestore, Firebase Storage
- STT: WhisperX, Pyannote diarization, local realtime STT adapters
- AI/LLM: OpenAI-compatible LangChain client, translation fallback service
- Testing: Python `unittest`, Next.js lint/build

## 프로젝트 구조

```text
.
├── backend/
│   ├── api/
│   │   └── websocket.py
│   ├── core/
│   │   ├── whisperx_adapter.py
│   │   ├── llm_client.py
│   │   ├── fast_adapter.py
│   │   └── qwen_adapter.py
│   ├── schemas/
│   │   └── transcript.py
│   ├── services/
│   │   ├── stt_service.py
│   │   ├── transcription_job_service.py
│   │   ├── summary_service.py
│   │   └── translator.py
│   └── main.py
├── frontend/
│   ├── src/app/page.tsx
│   ├── src/hooks/useAudioRecorder.ts
│   └── src/lib/
│       ├── api.ts
│       ├── firebase.tsx
│       └── transcript.ts
├── tests/
│   └── test_transcript_schema.py
├── requirements.txt
└── todo.md
```

## 환경 변수와 로컬 파일

루트 `.env` 또는 실행 환경에 필요한 값을 설정합니다.

```bash
OPENAI_API_KEY=
HUGGINGFACE_TOKEN=

WHISPERX_MODEL=medium.en
WHISPERX_LANGUAGE=en
WHISPERX_BATCH_SIZE=16
WHISPERX_COMPUTE_TYPE=int8

TRANSCRIPTION_BATCH_MAX_CONCURRENT=2
```

프론트엔드는 `frontend/.env.local`에서 API 서버 위치를 설정할 수 있습니다.

```bash
NEXT_PUBLIC_API_URL=127.0.0.1
NEXT_PUBLIC_API_PORT=8000
```

백엔드 Firebase Admin SDK는 로컬에서 `backend/firebase-key.json`을 참조합니다. 이 파일은 민감 정보이므로 Git에 올리지 않습니다.

## 설치

백엔드 의존성:

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

프론트엔드 의존성:

```bash
cd frontend
npm install
```

## 실행

백엔드:

```bash
source venv/bin/activate
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

프론트엔드:

```bash
cd frontend
npm run dev -- -H 0.0.0.0
```

기본 접속 주소:

```text
Frontend: http://localhost:3000
Backend:  http://localhost:8000
```

## 주요 API

- `POST /api/transcribe-media`: 기존 호환용 단일 미디어 전사 API
- `POST /api/transcription-jobs`: 영상/음성 batch 전사 job 생성
- `GET /api/transcription-jobs/{job_id}`: 전사 job 상태 조회
- `POST /api/upload-pdf`: PDF 업로드
- `GET /api/files/{file_hash}`: 파일 상세, 전사, 문장, 문단, 요약 조회
- `POST /api/summarize-video`: 영상 전체 요약 생성
- `POST /api/summarize`: 문단 기반 요약 생성
- `WS /ws/record/{session_id}`: 실시간 녹음 전사 websocket

## 검증

백엔드 테스트:

```bash
python3 -m unittest discover -s tests
python3 -m compileall -q backend tests
```

프론트엔드 검증:

```bash
cd frontend
npm run lint
npm run build
```

## 현재 구현상 주의점

- batch 전사 job은 현재 in-process `asyncio.create_task` 기반입니다. API 서버가 재시작되면 실행 중인 job은 유실될 수 있습니다.
- 대용량 파일은 job 생성 시 API process 메모리에 올라갑니다. 제품화 전에는 Storage-first worker 구조로 바꾸는 것이 좋습니다.
- 여러 사용자 동시 실시간 녹음은 아직 완전한 목표 범위가 아닙니다.
- `frontend/src/app/page.tsx`가 아직 크기 때문에 컴포넌트 분리가 필요합니다.
- Firebase client config는 현재 프론트 코드에 직접 들어 있습니다. 공개 가능한 client config이지만, 배포 전 환경변수화하는 편이 좋습니다.

## 로드맵

상세 로드맵과 완료/미완료 작업은 [todo.md](./todo.md)를 기준으로 관리합니다.
