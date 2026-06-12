# AI Notetaker Product Roadmap Todo

이 문서는 현재 앱을 LilysAI, 다글로처럼 "콘텐츠 수집 -> 전사/요약 -> 출처 기반 질의응답 -> 공유 가능한 산출물"까지 이어지는 AI 학습/업무 워크스페이스로 발전시키기 위한 작업 기록이다.

## Product North Star

사용자가 긴 강의, 회의, 인터뷰, 영상, PDF, 웹 문서를 업로드하면 앱이 자동으로 내용을 구조화하고, 필요한 순간에 근거와 함께 다시 찾고, 바로 공유 가능한 노트/문서/퀴즈/자막으로 바꿔주는 것이 목표다.

핵심 방향성:

- 원본 파일은 항상 source of truth로 유지한다.
- 전사, 번역, 요약, 채팅 답변은 반드시 원본의 시간대/페이지/문장 출처와 연결한다.
- 기능을 많이 붙이기보다 "긴 콘텐츠를 빠르게 이해하고 다시 쓰는 속도"를 높인다.
- 데이터 모델을 먼저 안정화하고, 그 위에 AI 기능을 얹는다.
- 실패 가능한 긴 작업은 비동기 작업 큐와 상태 추적으로 처리한다.

## Phase 1. Core Data Model Stabilization

목표: 이후 모든 기능이 같은 데이터 구조를 보도록 `project`, `source`, `sentence`, `paragraph`, `summary` 모델을 정리한다.

작업:

- [ ] Firestore 구조를 설계한다.
  - `projects/{projectId}`: 사용자별 작업 공간, 제목, 컬렉션, 생성일, 최근 수정일.
  - `projects/{projectId}/sources/{sourceId}`: PDF, 영상, 오디오, YouTube, 웹페이지 등 원본 단위.
  - `sources/{sourceId}/sentences/{sentenceId}` 또는 프로젝트 하위 컬렉션: 문장 단위 타임스탬프, 원문, 번역, 화자, confidence.
  - `sources/{sourceId}/paragraphs/{paragraphId}`: 문단 단위 원문/번역/요약용 chunk.
  - `sources/{sourceId}/summaries/{summaryId}`: 템플릿별 요약 결과.
- [ ] 현재 `files` 중심 모델을 `projects + sources` 모델로 마이그레이션할 계획을 세운다.
- [x] 백엔드 응답 타입 baseline을 통일한다.
  - 미디어 업로드 응답, 파일 상세 응답, 캐시 응답이 같은 transcript normalization 경로를 사용한다.
  - `scripts` 같은 과거 호환 필드는 유지하되 `paragraphs`, `sentences`를 함께 반환한다.
  - 후속: `scripts` 호환 필드를 점진적으로 제거한다.
- [x] 프론트 transcript 타입을 API 응답 기준으로 분리한다.
  - `TranscriptParagraph`, `TranscriptSentence`와 transcript normalization을 `frontend/src/lib/transcript.ts`로 이동한다.
  - 후속: `StoredFilePreview`와 화면별 UI 상태 타입도 별도 파일로 이동한다.

완료 기준:

- 새 업로드와 과거 파일 로드가 같은 normalization 경로를 사용한다.
- 자막, 스크립트 카드, 요약, 채팅이 모두 같은 sentence/paragraph ID를 참조할 수 있다.
- `page.tsx`에서 API 응답 파싱 로직이 크게 줄어든다.

## Phase 2. Transcription Pipeline Reliability

목표: 긴 파일도 안정적으로 처리하고, 실패해도 복구 가능하게 만든다.

작업:

- [x] 처리 상태 모델 baseline을 추가한다.
  - 현재 구현: `queued`, `processing`, `completed`, `failed`.
  - 후속: `uploading`, `transcribing`, `diarizing`, `translating`, `summarizing`처럼 단계별 상태를 세분화한다.
- [x] 긴 작업을 HTTP 요청 안에서 끝내지 않고 작업 큐 baseline으로 분리한다.
  - 초기에는 단순 Firestore job polling으로 시작한다.
  - 현재 구현: in-process `asyncio.create_task` + Firestore polling.
  - 후속: Celery/RQ/Cloud Tasks 같은 durable queue로 확장한다.
- [x] 업로드 직후 프론트는 job ID를 받고 polling으로 진행 상태를 조회한다.
- [ ] STT 실패, 번역 실패, 요약 실패를 각각 독립적으로 재시도할 수 있게 한다.
- [ ] 긴 영상 chunk 처리 전략을 만든다.
  - 오디오를 일정 길이로 나누고, chunk별 word timestamp를 전체 시간 기준으로 보정한다.
  - chunk 경계에서 문장이 끊기는 경우를 후처리한다.
- [ ] 캐시 정책을 명확히 한다.
  - 파일 hash가 같으면 원본 STT는 재사용한다.
  - course domain, 번역 언어, 요약 템플릿이 다르면 파생 결과만 다시 생성한다.

완료 기준:

- 30분 이상 영상도 브라우저 요청 timeout 없이 처리된다.
- 실패한 작업을 UI에서 다시 실행할 수 있다.
- 사용자가 처리 상태를 명확하게 볼 수 있다.

## Phase 2B. Concurrent Workload Pipeline

목표: 한 사용자가 실시간 녹음 1개를 유지하면서, 영상/음성 파일 batch 작업을 동시에 여러 개 처리할 수 있게 한다.

이번 baseline 구현으로 완료한 것:

- [x] 영상/음성 파일 전사를 HTTP 요청-응답 흐름에서 분리하기 위한 `transcription_jobs` API를 추가했다.
- [x] `queued`, `processing`, `completed`, `failed` 상태를 Firestore에 저장하고 polling으로 조회할 수 있게 했다.
- [x] `TRANSCRIPTION_BATCH_MAX_CONCURRENT` 환경 변수로 batch 동시 처리 개수를 제한할 수 있게 했다.
- [x] 기본 batch 동시 처리 개수를 2개로 두었다.
- [x] 기존 실시간 녹음 websocket 경로는 유지하고, batch 영상 job이 `fast_engine` 상태를 건드리지 않게 분리했다.
- [x] 프론트에서 여러 영상/음성 파일을 선택해 백그라운드 job으로 등록할 수 있게 했다.
- [x] 워크스페이스에서도 파일 추가 처리 버튼을 제공해, 실시간 녹음 중에도 영상/음성 batch job을 시작할 수 있게 했다.
- [x] 완료된 job은 기존 파일 상세 로딩 흐름으로 열 수 있게 했다.

추후 제품화 전에 해야 할 작업:

- [ ] in-process `asyncio.create_task` 기반 job runner를 외부 durable queue로 교체한다.
  - 후보: Celery/RQ, Cloud Tasks, Pub/Sub, Firebase Extensions, 또는 별도 worker process.
  - API 서버가 재시작되어도 queued/processing job이 유실되지 않아야 한다.
- [ ] 업로드 파일 bytes를 API process 메모리에 오래 들고 있지 않게 바꾼다.
  - job 생성 시 원본 파일을 Storage에 먼저 저장한다.
  - worker는 Storage path를 받아 처리한다.
  - 대용량 파일 여러 개를 동시에 올려도 API 메모리가 폭증하지 않아야 한다.
- [ ] stale job recovery를 구현한다.
  - 서버 재시작 등으로 `processing` 상태에 멈춘 job을 감지한다.
  - 일정 시간 heartbeat가 없으면 `failed` 또는 `queued`로 되돌린다.
- [ ] job 취소 API를 추가한다.
  - 사용자가 잘못 올린 긴 영상을 중단할 수 있어야 한다.
  - 취소된 job의 임시 파일/Storage object 정리 정책을 만든다.
- [ ] job 재시도 API를 추가한다.
  - STT 실패, 번역 실패, 요약 실패를 단계별로 재시도한다.
  - 같은 파일 hash는 원본 전사 캐시를 재사용한다.
- [ ] chunk-level progress를 추가한다.
  - 현재는 `queued -> processing -> completed` 중심이다.
  - 긴 영상은 chunk 수 기준으로 실제 진행률을 보여줘야 한다.
- [ ] batch job과 realtime correction의 리소스 우선순위 정책을 만든다.
  - 실시간 녹음 종료 후 2-pass correction은 사용자 체감 지연이 크므로 batch보다 우선할지 결정한다.
  - GPU/CPU/LLM 호출량을 기준으로 workload별 semaphore를 분리한다.
- [ ] 여러 사용자 동시 실시간 녹음까지 확장하기 전에 `fast_engine` 전역 상태를 session 단위로 분리한다.
  - 이번 Phase는 한 사용자 동시 작업만 목표로 했다.
  - 다중 사용자 실시간 세션에서는 현재 `fast_engine.reset()` 전역 호출이 위험할 수 있다.
- [ ] 사용자별 동시 job quota와 rate limit을 추가한다.
  - 무료/유료 플랜별 batch 동시 처리 수와 대기열 제한을 둔다.

## Phase 2A. Transcription Accuracy And Time Alignment Hardening

목표: 전사 문장의 정확도를 높이고, 문장/단어/자막/스크립트 카드의 시간 매칭이 원본 영상과 안정적으로 맞도록 STT 파이프라인을 재설계한다.

현재 관찰된 위험 지점:

- `backend/core/whisperx_adapter.py`의 기본 모델이 `medium.en`으로 고정되어 있어 한국어, 혼합 언어, 억양이 섞인 강의에서 정확도가 떨어질 수 있다.
- `backend/services/stt_service.py`에서 WhisperX alignment 이후 별도 VAD 필터가 word timestamp를 다시 걸러낸다. VAD가 공격적으로 작동하면 실제 말한 단어가 빠지고, 문장 start/end가 뒤틀릴 수 있다.
- 문장 분리 기준이 `.` `?` `!`에만 의존한다. Whisper 결과에 문장부호가 없거나 한국어 문장부호/무문장부호 구간이 있으면 긴 문장으로 뭉치거나 잘못 끊길 수 있다.
- `sentences`와 `paragraphs`가 같은 단어 타임라인에서 만들어지지만, 문단은 semantic chunking/LLM 결과에 따라 묶이므로 sentence IDs와 paragraph IDs의 연결 정보가 아직 명시적으로 저장되지 않는다.
- `confidence`가 저장되지만 품질 판단, 재처리, UI 경고에 활용되지 않는다.
- 문장별 번역이 순차 호출이라 긴 영상에서 느리고, 번역 실패가 특정 문장 자막 누락으로 이어질 수 있다.

작업:

- [x] 영어 STT 모델 선택 정책 baseline을 만든다.
  - 영어 전용 파일에는 `medium.en` 또는 더 가벼운 `.en` 모델을 허용한다.
  - `WhisperXAdapter(DEFAULT_MODEL)`를 환경 변수로 설정 가능하게 만든다.
  - language hint와 detected language, 사용 모델 정보를 debug metadata로 저장한다.
  - 후속: 한국어/혼합 언어 지원이 필요해지면 multilingual 모델 정책을 별도 설계한다.
- [ ] 전처리 오디오 품질을 개선한다.
  - 원본 audio loudness normalization을 추가한다.
  - 너무 조용한 파일, clipping이 많은 파일, 긴 silence 비율을 metadata로 기록한다.
  - STT 전에 sample rate/channel 변환만 하지 말고 볼륨/무음/노이즈 상태를 측정한다.
- [x] VAD 필터가 alignment 이후 단어를 과도하게 삭제하지 않도록 완화한다.
  - WhisperX word timestamp를 먼저 정규화하고, VAD drop ratio가 높으면 raw words를 보존한다.
  - VAD filter 적용 여부, matched word 수, drop ratio를 debug metadata로 저장한다.
  - 후속: VAD aggressiveness, padding 값을 환경 변수로 설정 가능하게 만든다.
- [ ] word timestamp 원본을 보존한다.
  - `raw_word_timestamps`: WhisperX alignment 결과 그대로 저장한다.
  - `filtered_word_timestamps`: 후처리된 결과를 별도 저장한다.
  - UI/디버깅에서 두 타임라인을 비교할 수 있게 한다.
- [x] 영어 문장 분리 알고리즘 baseline을 개선한다.
  - 문장부호뿐 아니라 pause gap, 최대 문장 길이, 최대 단어 수를 함께 사용한다.
  - 후속: 화자 변경, filler 병합, 언어별 종결 표현을 함께 사용한다.
  - 문장 길이가 너무 길어지면 pause gap 기준으로 안전하게 분리한다.
- [x] sentence와 paragraph 연결 정보를 명시적으로 저장한다.
  - 각 paragraph에 `sentence_ids`를 저장한다.
  - 각 sentence에 `paragraph_id`를 저장한다.
  - 프론트는 paragraph 카드 안에서 연결된 sentence를 펼칠 수 있게 한다.
- [x] 시간 보정 규칙 baseline을 만든다.
  - sentence start는 첫 단어 start, sentence end는 마지막 단어 end로 고정한다.
  - word timeline의 start/end 역전과 비정상 duration을 후처리에서 정리한다.
  - 후속: 최소 자막 표시 시간과 caption display range를 transcript source range와 분리해 저장한다.
- [ ] confidence 기반 품질 표시를 만든다.
  - sentence confidence를 단어 confidence 평균/최솟값으로 계산한다.
  - 낮은 confidence 문장은 UI에서 "확인 필요" 상태를 표시한다.
  - 낮은 confidence 구간만 재전사할 수 있는 API를 설계한다.
- [ ] STT 평가용 fixture를 만든다.
  - 30초 내외 영어 샘플.
  - 30초 내외 한국어 샘플.
  - 강의식 긴 문장 샘플.
  - 무음/잡음 포함 샘플.
  - 각 샘플에 기대 sentence start/end와 일부 기대 텍스트를 기록한다.
- [x] STT/timeline 후처리 회귀 테스트 baseline을 추가한다.
  - timeline 후처리가 start/end 역전 없이 monotonic range를 만드는지 테스트한다.
  - VAD 필터가 단어를 과도하게 제거하지 않는지 테스트한다.
  - LLM semantic chunk가 sentence ID를 누락/재정렬하면 reject되는지 테스트한다.
  - 후속: `_group_words_into_sentences`가 pause gap, 문장부호, 화자 변경을 올바르게 처리하는지 직접 테스트한다.
- [ ] 번역을 batch 처리한다.
  - 문장별 순차 호출 대신 여러 문장을 한번에 번역하고 sentence ID로 다시 매핑한다.
  - 실패한 문장만 재시도한다.
  - 번역 실패 시 원문 자막 fallback을 유지한다.
- [x] 전사 디버깅 metadata baseline을 만든다.
  - model, language, raw word count, filtered word count, VAD drop ratio, sentence/paragraph count를 저장한다.
  - 후속: 특정 source의 raw words, filtered words, sentences, paragraphs를 JSON으로 내려주는 admin/debug endpoint를 만든다.
  - 후속: 프론트 개발 모드에서 word/sentence boundary를 영상 타임라인 위에 표시하는 debug overlay를 만든다.

완료 기준:

- 같은 샘플 파일을 재처리했을 때 sentence start/end가 안정적으로 재현된다.
- 한국어/혼합 언어 파일에서 `.en` 모델 사용으로 인한 전사 누락이 사라진다.
- 문장 자막이 실제 발화보다 크게 앞서거나 뒤처지는 구간이 줄어든다.
- 낮은 confidence 구간을 사용자가 식별하고 부분 재처리할 수 있다.
- raw word timeline, sentence timeline, paragraph timeline을 비교해 문제 원인을 추적할 수 있다.

## Phase 3. Timeline Sync And Caption Quality

목표: 영상, 자막, 왼쪽/오른쪽 스크립트, 요약 타임스탬프가 항상 같은 위치를 가리키게 한다.

작업:

- [x] 문장 단위 자막을 기본 단위로 고정한다.
  - 자막은 `sentences`를 사용한다.
  - 문단 카드는 `paragraphs`를 사용한다.
  - 둘은 sentence IDs로 연결한다.
- [ ] 활성 항목 탐색을 공통 유틸로 분리한다.
  - 현재 `page.tsx`에 있는 시간 탐색 헬퍼를 `frontend/src/lib/timeline.ts`로 이동한다.
  - 단위 테스트를 추가한다.
- [ ] 자동 스크롤 정책을 개선한다.
  - 사용자가 스크립트 패널을 직접 스크롤하면 자동 스크롤을 잠시 멈춘다.
  - "현재 위치 따라가기" 토글을 추가한다.
- [ ] 자막 UX를 개선한다.
  - 자막 켜기/끄기.
  - 원문/번역/둘 다 표시 옵션.
  - 자막 위치가 영상 컨트롤과 겹치지 않게 반응형 처리.
- [ ] summary 안의 `[MM:SS]` 링크가 sentence/paragraph ID와 연결되도록 개선한다.

완료 기준:

- 특정 자막을 클릭하면 영상이 정확히 해당 문장으로 이동한다.
- 영상 재생 중 카드와 자막이 서로 다른 내용을 가리키지 않는다.
- 자동 스크롤 때문에 사용자가 읽던 위치를 잃지 않는다.

## Phase 4. Summary Templates

목표: 단일 요약이 아니라 목적별 산출물을 생성한다.

작업:

- [ ] 요약 템플릿을 추가한다.
  - 강의 노트.
  - 회의록.
  - 인터뷰 정리.
  - 시험 대비 핵심 개념.
  - 예상 문제.
  - 액션 아이템.
  - 키워드/용어집.
- [ ] Summary API를 템플릿 기반으로 변경한다.
  - `template_id`, `source_id`, `project_id`, `language`를 받는다.
- [ ] 요약 결과에 출처를 포함한다.
  - 각 bullet 또는 문단에 sentence/paragraph ID와 timestamp를 저장한다.
- [ ] 프론트 요약 탭을 템플릿 선택형으로 바꾼다.
- [ ] 생성된 요약을 편집 가능하게 한다.

완료 기준:

- 같은 영상에서 여러 종류의 요약을 생성하고 저장할 수 있다.
- 요약 문장마다 원본 위치로 돌아갈 수 있다.
- 요약을 사용자가 수정해도 원본 출처 연결은 유지된다.

## Phase 5. Multi-Source Projects

목표: 하나의 프로젝트 안에 여러 원본을 넣고 함께 다룰 수 있게 한다.

작업:

- [ ] 로비를 파일 목록이 아니라 프로젝트 목록으로 바꾼다.
- [ ] 프로젝트 상세 화면에 source list를 추가한다.
- [ ] 하나의 프로젝트 안에 여러 PDF/영상/오디오를 추가할 수 있게 한다.
- [ ] 소스별 처리 상태와 요약 상태를 보여준다.
- [ ] 프로젝트 단위 통합 요약을 생성한다.
- [ ] 컬렉션/폴더 구조를 추가한다.

완료 기준:

- 한 강의 주차나 한 회의 주제에 여러 파일을 묶을 수 있다.
- 프로젝트 단위로 검색, 요약, 질문하기가 가능하다.

## Phase 6. Source Import Expansion

목표: 사용자가 다양한 콘텐츠를 쉽게 가져오게 한다.

작업:

- [ ] YouTube URL import.
  - 영상 메타데이터 가져오기.
  - 자막이 있으면 우선 사용하고, 없으면 STT 수행.
- [ ] 웹페이지 URL import.
  - 본문 추출.
  - 제목, 출처 URL, 캡처 시간 저장.
- [ ] DOCX/TXT/Markdown 업로드.
- [ ] PDF 텍스트 추출 개선.
  - 현재 PDF 뷰어 중심 구조에서 텍스트 추출/페이지별 chunk 저장으로 확장한다.
- [ ] 크롬 확장 또는 모바일 공유 sheet는 후순위로 검토한다.

완료 기준:

- YouTube, PDF, 오디오/비디오 파일, 웹페이지가 같은 `source` 모델로 저장된다.
- 소스 타입이 달라도 요약/채팅/검색 흐름은 동일하게 작동한다.

## Phase 7. Source-Grounded AI Chat

목표: 업로드한 자료에 대해 질문하면 근거와 함께 답변하는 기능을 만든다.

작업:

- [ ] sentence/paragraph chunk를 임베딩한다.
- [ ] vector DB를 선택한다.
  - 초기에는 Firestore + 간단 검색 또는 로컬 벡터 저장으로 시작 가능.
  - 제품화 단계에서는 Pinecone, Weaviate, pgvector, Qdrant 중 선택한다.
- [ ] RAG 검색 API를 만든다.
  - `project_id`, `query`, `source_filter`, `top_k`.
- [ ] 답변 생성 시 반드시 근거를 포함한다.
  - source ID.
  - timestamp 또는 page number.
  - 원문 snippet.
- [ ] 프론트에 "자료에 질문하기" 패널을 추가한다.
- [ ] 출처 없는 답변은 제한한다.

완료 기준:

- 질문 답변에서 근거 문장을 클릭하면 영상 시간대나 PDF 페이지로 이동한다.
- 프로젝트 안 여러 소스를 동시에 참조할 수 있다.
- 모르는 내용은 모른다고 답한다.

## Phase 8. Export, Sharing, And Study Outputs

목표: 사용자가 결과물을 밖으로 가져가거나 공유할 수 있게 한다.

작업:

- [ ] Export 형식 추가.
  - Markdown.
  - PDF.
  - DOCX.
  - TXT transcript.
  - SRT/VTT 자막.
- [ ] 공유 링크 기능.
  - 읽기 전용 링크.
  - 공개/비공개.
  - 만료일.
- [ ] 플래시카드 생성.
- [ ] 예상 문제 생성.
- [ ] Notion/Google Docs 연동은 후순위로 검토한다.

완료 기준:

- 사용자가 요약 노트를 외부 문서로 가져갈 수 있다.
- 링크만으로 다른 사람이 결과물을 볼 수 있다.
- 학습용 퀴즈와 플래시카드를 생성할 수 있다.

## Phase 9. SaaS And Operations

목표: 실제 사용자에게 안전하게 제공할 수 있는 서비스 기반을 만든다.

작업:

- [ ] 인증/권한 강화.
  - Storage 보안 규칙.
  - source/project 단위 access control.
- [ ] Firebase service account key를 안전하게 배포 환경 변수로 이동한다.
- [ ] 결제/플랜 모델 설계.
  - 무료 월 처리 시간.
  - 저장공간 제한.
  - 고급 모델 사용 제한.
- [ ] 처리 비용 추적.
  - STT 시간.
  - LLM token.
  - Storage 사용량.
- [ ] 관리자 대시보드.
  - 사용자 수.
  - 작업 성공/실패율.
  - 비용.
  - 신고/삭제 요청.
- [ ] 개인정보/데이터 정책.
  - 파일 삭제.
  - 데이터 보관 기간.
  - 모델 학습 미사용 고지.

완료 기준:

- 사용자별 비용과 사용량을 추적할 수 있다.
- 민감 파일이 repo에 들어가지 않는다.
- public repo와 배포 환경 모두에서 secret 관리가 분리되어 있다.

## Phase 10. UX Polish And Mobile

목표: 기능이 많아져도 반복 사용이 편한 워크스페이스로 다듬는다.

작업:

- [ ] 페이지 구조를 정리한다.
  - 로비: 프로젝트/컬렉션.
  - 프로젝트: 소스 목록 + 작업 상태.
  - 워크스페이스: 뷰어 + 스크립트 + 요약/chat.
- [ ] 모바일 레이아웃.
  - 탭 기반 화면 전환.
  - 자막/스크립트/요약을 작은 화면에서 읽기 좋게 구성.
- [ ] 키보드 단축키.
  - 재생/정지.
  - 5초 이동.
  - 다음/이전 문장.
  - 검색.
- [ ] 빈 상태와 실패 상태를 정리한다.
- [ ] 로딩 상태를 세분화한다.
- [ ] 접근성.
  - 버튼 aria-label.
  - 자막 aria-live 정책.
  - 키보드 포커스.

완료 기준:

- 업로드부터 요약/질문/공유까지 사용자가 막히는 지점이 없다.
- 모바일에서도 핵심 플로우가 가능하다.
- 화면이 기능 설명문에 의존하지 않고, 조작 가능한 UI 중심으로 구성된다.

## Near-Term Engineering Tasks

바로 이어서 하면 좋은 작업 순서:

- [x] `frontend`를 루트 모노레포에 완전히 합친다.
- [ ] `frontend/src/app/page.tsx`를 컴포넌트 단위로 분리한다.
  - `AuthView`.
  - `LobbyView`.
  - `WorkspaceView`.
  - `MediaPlayer`.
  - `TranscriptPanel`.
  - `SummaryPanel`.
  - `CourseSelectionModal`.
- [x] transcript API 응답 normalization을 `frontend/src/lib/transcript.ts`로 이동한다.
- [ ] timeline helper를 `frontend/src/lib/timeline.ts`로 이동하고 테스트를 만든다.
- [ ] `backend/services/stt_service.py`에서 sentence/paragraph 생성과 번역을 별도 서비스로 분리한다.
- [x] WhisperX 모델 선택을 환경 변수화한다.
- [x] VAD 후처리가 단어를 삭제해 시간 매칭을 흔드는지 확인하는 테스트를 추가한다.
- [x] sentence/word timeline 후처리 유틸 baseline을 만든다.
  - start/end 역전 방지.
  - 최소 자막 표시 시간 보장.
  - 문장 간 겹침 정리.
- [x] paragraph에 `sentence_ids`, sentence에 `paragraph_id`를 저장하도록 데이터 구조를 수정한다.
- [ ] STT debug endpoint를 추가해 raw words, filtered words, sentences, paragraphs를 비교할 수 있게 한다.
- [ ] `backend/main.py`의 route handler를 `backend/api/routes.py`로 이동해 책임을 나눈다.
- [ ] 민감 정보 정리.
  - `backend/firebase-key.json`이 repo에 들어가지 않는지 확인.
  - `.env.example` 작성.
- [x] 최소 테스트 추가.
  - transcript schema normalization.
  - VAD 과삭제 fallback.
  - word timeline 보정.
  - LLM semantic chunk 검증.
  - 후속: timeline active item 탐색, API 응답 normalization, STT sentence grouping 직접 테스트를 추가한다.

## Technical Principles

- 먼저 데이터 모델을 안정화하고 UI를 붙인다.
- 가능한 한 같은 정보를 두 상태에 중복 저장하지 않는다.
- 긴 작업은 request/response 안에서 끝내려 하지 않는다.
- AI 결과는 항상 source ID, sentence ID, timestamp/page와 연결한다.
- 제품 기능을 추가할 때마다 export/share/chat에서 재사용 가능한 형태로 저장한다.
- public repo에 올릴 수 있는 코드와 배포 secret을 명확히 분리한다.
