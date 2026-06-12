import asyncio
import hashlib
import os
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from backend.services.stt_service import STTService


JOB_STATUS_QUEUED = "queued"
JOB_STATUS_PROCESSING = "processing"
JOB_STATUS_COMPLETED = "completed"
JOB_STATUS_FAILED = "failed"
DEFAULT_MAX_CONCURRENT_JOBS = 2


def _utc_now_iso() -> str:
    return datetime.utcnow().isoformat()


def _read_positive_int_env(name: str, default: int) -> int:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
        return value if value > 0 else default
    except ValueError:
        print(f"⚠️ Invalid {name}={raw_value!r}; using {default}")
        return default


class TranscriptionJobService:
    """Small in-process job runner for local/dev batch media transcription.

    Jobs are persisted in Firestore for polling, while the actual execution is
    driven by asyncio tasks in the current API process.
    """

    def __init__(self, db, stt_service: STTService, max_concurrent: Optional[int] = None):
        self.db = db
        self.stt_service = stt_service
        self.max_concurrent = max_concurrent or _read_positive_int_env(
            "TRANSCRIPTION_BATCH_MAX_CONCURRENT",
            DEFAULT_MAX_CONCURRENT_JOBS,
        )
        self.semaphore = asyncio.Semaphore(self.max_concurrent)
        self.tasks: Dict[str, asyncio.Task] = {}

    async def create_job(
        self,
        *,
        file_bytes: bytes,
        filename: str,
        content_type: Optional[str],
        user_id: str,
        course_domain: str,
    ) -> Dict[str, Any]:
        file_hash = hashlib.sha256(file_bytes).hexdigest()
        job_id = uuid.uuid4().hex
        now = _utc_now_iso()
        job = {
            "job_id": job_id,
            "status": JOB_STATUS_QUEUED,
            "progress": 0,
            "file_hash": file_hash,
            "fileName": filename,
            "fileType": content_type or "audio",
            "userId": user_id,
            "courseDomain": course_domain,
            "result_file_hash": None,
            "error": None,
            "createdAt": now,
            "updatedAt": now,
            "max_concurrent": self.max_concurrent,
        }
        await self._set_job(job_id, job)
        task = asyncio.create_task(
            self._run_job(
                job_id=job_id,
                file_bytes=file_bytes,
                filename=filename,
                content_type=content_type,
                user_id=user_id,
                course_domain=course_domain,
            )
        )
        self.tasks[job_id] = task
        task.add_done_callback(lambda _task: self.tasks.pop(job_id, None))
        return job

    async def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        snapshot = await asyncio.to_thread(self._job_ref(job_id).get)
        if not snapshot.exists:
            return None
        return snapshot.to_dict()

    async def _run_job(
        self,
        *,
        job_id: str,
        file_bytes: bytes,
        filename: str,
        content_type: Optional[str],
        user_id: str,
        course_domain: str,
    ) -> None:
        try:
            async with self.semaphore:
                await self._set_job(job_id, {
                    "status": JOB_STATUS_PROCESSING,
                    "progress": 10,
                    "startedAt": _utc_now_iso(),
                    "updatedAt": _utc_now_iso(),
                })
                result = await self.stt_service.transcribe_bytes(
                    file_bytes=file_bytes,
                    filename=filename,
                    content_type=content_type,
                    user_id=user_id,
                    course_domain=course_domain,
                )
                file_info = result.get("file_info", {})
                result_file_hash = file_info.get("hash") or result.get("file_hash")
                await self._set_job(job_id, {
                    "status": JOB_STATUS_COMPLETED,
                    "progress": 100,
                    "result_file_hash": result_file_hash,
                    "is_cached": result.get("is_cached", False),
                    "completedAt": _utc_now_iso(),
                    "updatedAt": _utc_now_iso(),
                    "error": None,
                })
        except Exception as exc:
            print(f"❌ Transcription job failed ({job_id}): {exc}")
            await self._set_job(job_id, {
                "status": JOB_STATUS_FAILED,
                "progress": 100,
                "error": str(exc),
                "failedAt": _utc_now_iso(),
                "updatedAt": _utc_now_iso(),
            })

    async def _set_job(self, job_id: str, data: Dict[str, Any]) -> None:
        await asyncio.to_thread(self._job_ref(job_id).set, data, merge=True)

    def _job_ref(self, job_id: str):
        return self.db.collection("transcription_jobs").document(job_id)
