"use client";

import { useState, useEffect, useRef, useMemo, useCallback, ReactNode } from "react";
import { Mic, Square, ChevronLeft, ChevronRight, Upload, FileText, MessageSquareText, Sparkles, Loader2, Film, Music, Headphones, LogOut, Plus, Folder, User, Lock, Mail, Trash2, Edit2 } from "lucide-react";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import dynamic from 'next/dynamic';
import ReactMarkdown from "react-markdown";
import { auth, db } from "@/lib/firebase";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, User as FirebaseUser } from "firebase/auth";
import { collection, query, where, getDocs } from "firebase/firestore";
import { getStorage, ref, getDownloadURL } from "firebase/storage";
import { buildApiUrl } from "@/lib/api";
import {
  normalizeParagraphList,
  normalizeSubtitleList,
  type TranscriptParagraph,
  type TranscriptPayload,
  type TranscriptSentence,
} from "@/lib/transcript";

const TIMESTAMP_REGEX = /\[?(\d{1,2}:\d{2})\]?/g;

const COURSE_OPTIONS = [
  "Programming Language",
  "Introduction of Network",
  "Machine Learning",
  "Others",
];

const SPEAKER_BADGE_STYLES: Record<string, string> = {
  "Speaker 1": "bg-indigo-50 text-indigo-700 border border-indigo-100",
  "Speaker 2": "bg-emerald-50 text-emerald-700 border border-emerald-100",
  "Speaker 3": "bg-amber-50 text-amber-700 border border-amber-100",
  "Speaker 4": "bg-pink-50 text-pink-700 border border-pink-100",
};

const getSpeakerBadgeClass = (speaker: string) =>
  SPEAKER_BADGE_STYLES[speaker] ?? "bg-gray-50 text-gray-600 border border-gray-200";

const formatSecondsLabel = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
};

const findLatestByStart = <T extends { start: number }>(
  items: T[],
  time: number,
  tolerance = 0
): T | undefined => {
  let low = 0;
  let high = items.length - 1;
  let candidate: T | undefined;
  const targetTime = Math.max(0, time) + tolerance;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (items[mid].start <= targetTime) {
      candidate = items[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return candidate;
};

const findActiveTimeRange = <T extends { start: number; end: number }>(
  items: T[],
  time: number,
  startTolerance = 0,
  endTolerance = 0
): T | undefined => {
  const candidate = findLatestByStart(items, time, startTolerance);
  return candidate && time <= candidate.end + endTolerance ? candidate : undefined;
};

const normalizeUploadedAt = (value: StoredFilePreview["uploadedAt"]) => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  if (value && typeof value === "object") {
    const timestampLike = value as {
      toDate?: () => Date;
      seconds?: number;
      nanoseconds?: number;
    };

    if (typeof timestampLike.toDate === "function") {
      return timestampLike.toDate().getTime();
    }

    if (typeof timestampLike.seconds === "number") {
      return timestampLike.seconds * 1000 + Math.floor((timestampLike.nanoseconds ?? 0) / 1_000_000);
    }
  }

  return 0;
};

const resolveStoragePath = (fileInfo: StoredFilePreview) =>
  fileInfo.storagePath ?? fileInfo.storage_path ?? "";

const formatUploadedAt = (value: StoredFilePreview["uploadedAt"]) => {
  const timestamp = normalizeUploadedAt(value);
  if (!timestamp) return "날짜 정보 없음";
  return new Date(timestamp).toLocaleDateString();
};

interface StoredFilePreview {
  id: string;
  fileName: string;
  fileType?: string;
  uploadedAt?: string | number | Date | { toDate?: () => Date; seconds?: number; nanoseconds?: number };
  fileUrl?: string;
  storagePath?: string;
  storage_path?: string;
  hash?: string;
  summary?: Record<string, string>;
  [key: string]: unknown;
}

type TranscriptionJobStatus = "queued" | "processing" | "completed" | "failed";

interface TranscriptionJobPreview {
  job_id: string;
  status: TranscriptionJobStatus;
  progress: number;
  file_hash: string;
  fileName: string;
  fileType?: string;
  result_file_hash?: string | null;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

const TERMINAL_JOB_STATUSES = new Set<TranscriptionJobStatus>(["completed", "failed"]);

const getJobStatusLabel = (status: TranscriptionJobStatus) => {
  switch (status) {
    case "queued":
      return "대기 중";
    case "processing":
      return "처리 중";
    case "completed":
      return "완료";
    case "failed":
      return "실패";
  }
};

const normalizeTranscriptionJob = (source: Record<string, unknown>): TranscriptionJobPreview => {
  const rawStatus = typeof source.status === "string" ? source.status : "queued";
  const status: TranscriptionJobStatus = ["queued", "processing", "completed", "failed"].includes(rawStatus)
    ? (rawStatus as TranscriptionJobStatus)
    : "queued";
  const progress = typeof source.progress === "number" ? source.progress : 0;

  return {
    job_id: typeof source.job_id === "string" ? source.job_id : "",
    status,
    progress: Math.max(0, Math.min(100, progress)),
    file_hash: typeof source.file_hash === "string" ? source.file_hash : "",
    fileName: typeof source.fileName === "string" ? source.fileName : "media",
    fileType: typeof source.fileType === "string" ? source.fileType : undefined,
    result_file_hash: typeof source.result_file_hash === "string" ? source.result_file_hash : null,
    error: typeof source.error === "string" ? source.error : null,
    createdAt: typeof source.createdAt === "string" ? source.createdAt : undefined,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : undefined,
  };
};

const PdfViewer = dynamic(() => import("@/components/PdfViewer"), {
  ssr: false,
  loading: () => (
    <div className="bg-white w-full h-full max-w-4xl rounded-xl shadow-lg flex items-center justify-center text-gray-400">
      <p>PDF 뷰어를 준비 중입니다...</p>
    </div>
  ),
});

const PdfThumbnails = dynamic(() => import("@/components/PdfThumbnails"), {
  ssr: false,
  loading: () => <div className="p-4 text-xs text-center text-gray-400 animate-pulse">썸네일 로딩 중...</div>,
});



export default function Home() {
  const [currentView, setCurrentView] = useState<"auth" | "lobby" | "workspace">("auth");
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [myFiles, setMyFiles] = useState<StoredFilePreview[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [currentSlide, setCurrentSlide] = useState(1);
  const [activeTab, setActiveTab] = useState<"transcription" | "summary">("transcription");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  
  const [isSummarizing, setIsSummarizing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mediaUrl, setmediaUrl] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<"video" | "audio" | null>(null);
  const [isVideoProcessing, setIsVideoProcessing] = useState(false);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [currentFileHash, setCurrentFileHash] = useState<string>("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const mediaPlayerRef = useRef<HTMLMediaElement | null>(null);
  const [paragraphs, setParagraphs] = useState<TranscriptParagraph[]>([]);
  const [subtitleSegments, setSubtitleSegments] = useState<TranscriptSentence[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [transcriptionJobs, setTranscriptionJobs] = useState<TranscriptionJobPreview[]>([]);
  const [batchMaxConcurrent, setBatchMaxConcurrent] = useState(2);
  const [isCourseModalOpen, setIsCourseModalOpen] = useState(false);
  const [selectedCourse, setSelectedCourse] = useState(COURSE_OPTIONS[0]);
  
  const { 
    isRecording, startRecording, stopRecording, notifySlideChange, 
    transcriptions, setTranscriptions,
    summaries, setSummaries, videoSummary, setVideoSummary,
    correctionProgress, isSystemRecording, startSystemRecording, stopSystemRecording,
  } = useAudioRecorder();
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeScriptRef = useRef<HTMLDivElement>(null); // ✅ 활성화된 스크립트 자동 스크롤 추적용
  const syncParagraphResponse = useCallback((data: TranscriptPayload) => {
    setParagraphs(normalizeParagraphList(data));
    setSubtitleSegments(normalizeSubtitleList(data));
  }, []);

  const resetWorkspaceContent = useCallback(() => {
    setPdfFile(null);
    setmediaUrl(null);
    setMediaType(null);
    setVideoSummary("");
    setTranscriptions([]);
    setSummaries({});
    setParagraphs([]);
    setSubtitleSegments([]);
    setCurrentSlide(1);
    setCurrentFileHash("");
    setActiveTab("transcription");
  }, [setSummaries, setTranscriptions, setVideoSummary]);

  const convertMmssToSeconds = useCallback((value: string) => {
    const cleaned = value.replace(/[^\d:]/g, "");
    if (!cleaned.includes(":")) {
      return NaN;
    }
    const [minutesRaw, secondsRaw] = cleaned.split(":");
    const minutes = Number(minutesRaw) || 0;
    const seconds = Number(secondsRaw) || 0;
    return minutes * 60 + seconds;
  }, []);

  const handleSeek = useCallback((value: string) => {
    const targetTime = convertMmssToSeconds(value);
    if (Number.isNaN(targetTime)) return;
    const player =
      mediaPlayerRef.current ?? (mediaType === "audio" ? audioRef.current : videoRef.current);
    if (!player) return;
    player.currentTime = targetTime;
    player.play().catch(() => {});
  }, [convertMmssToSeconds, mediaType]);

  const renderTimestampAwareChildren = useCallback((node: ReactNode): ReactNode => {
    if (typeof node === "string") {
      const regex = new RegExp(TIMESTAMP_REGEX);
      const fragments: ReactNode[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(node)) !== null) {
        if (match.index > lastIndex) {
          fragments.push(node.slice(lastIndex, match.index));
        }
        const timestampLabel = match[0];
        fragments.push(
          <button
            key={`ts-${timestampLabel}-${match.index}`}
            type="button"
            onClick={() => handleSeek(timestampLabel)}
            className="text-blue-600 underline text-sm font-semibold hover:text-blue-800 transition-colors"
          >
            {timestampLabel}
          </button>
        );
        lastIndex = match.index + timestampLabel.length;
      }
      if (lastIndex < node.length) {
        fragments.push(node.slice(lastIndex));
      }
      return fragments.length === 0 ? node : fragments;
    }
    if (Array.isArray(node)) {
      return node.map((child) => renderTimestampAwareChildren(child));
    }
    return node;
  }, [handleSeek]);

  const renderSummaryMarkdown = useCallback((text?: string, variant: "video" | "slide" = "video") => {
    if (!text) return null;
    const baseStyles = variant === "video"
      ? "prose prose-sm max-w-none text-gray-800 prose-headings:font-bold prose-headings:text-pink-700 prose-strong:text-pink-600"
      : "prose prose-sm max-w-none text-gray-800 prose-headings:font-bold prose-headings:text-indigo-700 prose-strong:text-indigo-600";

    return (
      <article className={baseStyles}>
        <ReactMarkdown
          components={{
            p: ({ children }) => (
              <p className="text-sm leading-relaxed text-gray-800">
                {renderTimestampAwareChildren(children)}
              </p>
            ),
            li: ({ children }) => (
              <li className="text-sm leading-relaxed text-gray-800">
                {renderTimestampAwareChildren(children)}
              </li>
            ),
            strong: ({ children }) => (
              <strong className="text-gray-900">
                {renderTimestampAwareChildren(children)}
              </strong>
            ),
            em: ({ children }) => (
              <em className="text-gray-600 italic">
                {renderTimestampAwareChildren(children)}
              </em>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </article>
    );
  }, [renderTimestampAwareChildren]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        setCurrentView("lobby"); // 로그인 성공 시 로비로 이동
        fetchMyFiles(currentUser.uid); // 내 파일 목록 불러오기
      } else {
        setUser(null);
        setCurrentView("auth");
      }
    });
    return () => unsubscribe();
  }, []);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const player = mediaType === "audio" ? audioRef.current : videoRef.current;
      if (!player || currentView !== "workspace") return;
      
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key.toLowerCase()) {
        case "j":
          player.currentTime = Math.max(0, player.currentTime - 5);
          break;
        case "l":
          player.currentTime = Math.min(player.duration || player.currentTime, player.currentTime + 5);
          break;
        case " ":
          e.preventDefault();
          if (player.paused) {
            player.play();
          } else {
            player.pause();
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentView, mediaType]);
  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    try {
      if (isLoginMode) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
    } catch (error) {
      console.error("Authentication error:", error);
      setAuthError("이메일이나 비밀번호를 확인해주세요.");
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    resetWorkspaceContent();
  };

  const fetchMyFiles = async (userId: string) => {
    setIsLoadingFiles(true);
    try {
      const q = query(collection(db, "files"), where("userId", "==", userId));
      const querySnapshot = await getDocs(q);
      const filesData = querySnapshot.docs.map((doc) => {
        const data = doc.data() as Omit<StoredFilePreview, "id">;
        return { id: doc.id, ...data } as StoredFilePreview;
      }).sort((a, b) => normalizeUploadedAt(b.uploadedAt) - normalizeUploadedAt(a.uploadedAt));
      setMyFiles(filesData);
    } catch (error) {
      console.error("파일 목록 로딩 에러:", error);
    } finally {
      setIsLoadingFiles(false);
    }
  };

  useEffect(() => {
    if (!user) return;

    const activeJobs = transcriptionJobs.filter((job) => !TERMINAL_JOB_STATUSES.has(job.status));
    if (activeJobs.length === 0) return;

    let cancelled = false;
    const pollJobs = async () => {
      try {
        const updates = await Promise.all(
          activeJobs.map(async (job) => {
            const response = await fetch(buildApiUrl(`/api/transcription-jobs/${job.job_id}`));
            if (!response.ok) return job;
            const data = await response.json();
            return normalizeTranscriptionJob(data as Record<string, unknown>);
          })
        );

        if (cancelled) return;

        const previousById = new Map(transcriptionJobs.map((job) => [job.job_id, job]));
        const updateById = new Map(updates.map((job) => [job.job_id, job]));
        const hasNewCompletion = updates.some((job) => {
          const previous = previousById.get(job.job_id);
          return previous?.status !== "completed" && job.status === "completed";
        });

        setTranscriptionJobs((prev) =>
          prev.map((job) => updateById.get(job.job_id) ?? job)
        );

        if (hasNewCompletion) {
          fetchMyFiles(user.uid);
        }
      } catch (error) {
        console.warn("전사 job 상태 갱신 실패:", error);
      }
    };

    pollJobs();
    const intervalId = window.setInterval(pollJobs, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [transcriptionJobs, user]);

  const uploadPdfFile = async (file: File, courseDomain: string, openAfterUpload: boolean) => {
    if (!user) return;

    const formData = new FormData();
    formData.append("file", file);
    formData.append("user_id", user.uid);
    formData.append("course_domain", courseDomain);

    if (openAfterUpload) {
      setCurrentView("workspace");
      resetWorkspaceContent();
      setPdfFile(file);
      setmediaUrl(null);
      setMediaType(null);
      setIsVideoProcessing(true);
    }

    try {
      const response = await fetch(buildApiUrl("/api/upload-pdf"), {
        method: "POST",
        body: formData,
      });
      if (!response.ok) throw new Error("PDF 업로드 실패");
      const data = await response.json();
      if (openAfterUpload) {
        syncParagraphResponse(data);
        setCurrentFileHash(data.file_info.hash);
      }
      fetchMyFiles(user.uid);
    } catch (error) {
      console.error("PDF 업로드 에러:", error);
      alert("파일을 등록하는 데 실패했습니다.");
      if (openAfterUpload) {
        setCurrentView("lobby");
      }
    } finally {
      if (openAfterUpload) {
        setIsVideoProcessing(false);
      }
    }
  };

  const createTranscriptionJobs = async (mediaFiles: File[], courseDomain: string) => {
    if (!user || mediaFiles.length === 0) return;

    const formData = new FormData();
    mediaFiles.forEach((file) => formData.append("files", file));
    formData.append("user_id", user.uid);
    formData.append("course_domain", courseDomain);

    try {
      const response = await fetch(buildApiUrl("/api/transcription-jobs"), {
        method: "POST",
        body: formData,
      });
      if (!response.ok) throw new Error("미디어 전사 job 생성 실패");
      const data = await response.json();
      if (typeof data.max_concurrent === "number") {
        setBatchMaxConcurrent(data.max_concurrent);
      }
      const jobs = Array.isArray(data.jobs)
        ? data.jobs.map((job: unknown) =>
            normalizeTranscriptionJob(
              typeof job === "object" && job !== null ? (job as Record<string, unknown>) : {}
            )
          ).filter((job: TranscriptionJobPreview) => job.job_id)
        : [];
      setTranscriptionJobs((prev) => {
        const knownIds = new Set(prev.map((job) => job.job_id));
        const freshJobs = jobs.filter((job: TranscriptionJobPreview) => !knownIds.has(job.job_id));
        return [...freshJobs, ...prev];
      });
    } catch (error) {
      console.error("업로드 에러:", error);
      alert("파일 분석 작업을 시작하지 못했습니다.");
    }
  };

  const processSelectedFiles = async (files: File[], courseDomain: string) => {
    if (!user || files.length === 0) return;

    const pdfFiles = files.filter((file) => file.type === "application/pdf");
    const mediaFiles = files.filter((file) => file.type !== "application/pdf");
    const shouldOpenSinglePdf = pdfFiles.length === 1 && mediaFiles.length === 0;

    if (shouldOpenSinglePdf) {
      await uploadPdfFile(pdfFiles[0], courseDomain, true);
      return;
    }

    await Promise.all(pdfFiles.map((file) => uploadPdfFile(file, courseDomain, false)));
    await createTranscriptionJobs(mediaFiles, courseDomain);

    if (currentView === "auth") {
      setCurrentView("lobby");
    }
  };

  const handleMediaUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0 || !user) return;
    setPendingFiles(files);
    setSelectedCourse(COURSE_OPTIONS[0]);
    setIsCourseModalOpen(true);
  };

  const handleStartCourseProcessing = async () => {
    if (pendingFiles.length === 0) return;
    setIsCourseModalOpen(false);
    await processSelectedFiles(pendingFiles, selectedCourse);
    setPendingFiles([]);
  };

  const handleCourseModalCancel = () => {
    setPendingFiles([]);
    setIsCourseModalOpen(false);
    setSelectedCourse(COURSE_OPTIONS[0]);
  };

  const renderCourseSelectionModal = () => {
    if (!isCourseModalOpen) return null;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
        <div className="w-full max-w-lg rounded-3xl bg-white dark:bg-gray-900 p-6 shadow-2xl border border-gray-200 dark:border-gray-800">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Which course is this lecture for?</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {pendingFiles.length}개 파일에 같은 course 설정을 적용합니다.
                영상/음성은 백그라운드에서 병렬 처리됩니다.
              </p>
            </div>
            <button
              type="button"
              onClick={handleCourseModalCancel}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            >
              ✕
            </button>
          </div>
          <div className="space-y-3 mb-6">
            {COURSE_OPTIONS.map((option) => (
              <label
                key={option}
                className="flex items-center gap-3 rounded-2xl border border-gray-200 dark:border-gray-700 px-4 py-3 hover:border-indigo-400 transition-all cursor-pointer"
              >
                <input
                  type="radio"
                  name="courseDomain"
                  value={option}
                  checked={selectedCourse === option}
                  onChange={() => setSelectedCourse(option)}
                  className="focus:ring-indigo-500 text-indigo-600 border-gray-300"
                />
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                  {option}
                </span>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={handleCourseModalCancel}
              className="px-4 py-2 rounded-xl border border-gray-300 dark:border-gray-700 text-sm font-semibold text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleStartCourseProcessing}
              className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm transition"
            >
              Start Processing
            </button>
          </div>
        </div>
      </div>
    );
  };

  const handleLoadPastFile = async (fileData: StoredFilePreview) => {
    setIsVideoProcessing(true);
    try {
      const response = await fetch(buildApiUrl(`/api/files/${fileData.id}`));
      if (!response.ok) throw new Error("파일을 불러오는데 실패했습니다.");
      const data = await response.json();
      const fileInfo = {
        ...fileData,
        ...(data.file_info ?? {}),
      } as StoredFilePreview;
      const storagePath = resolveStoragePath(fileInfo);
      const resolvedHash = fileInfo.hash ?? fileData.id;

      resetWorkspaceContent();

      try {
        syncParagraphResponse(data);
      } catch (syncErr) {
        console.warn("스크립트/요약 데이터 동기화 중 파싱 오류:", syncErr);
        setParagraphs(normalizeParagraphList(data));
        setSubtitleSegments(normalizeSubtitleList(data));
      }

      setCurrentView("workspace");
      setCurrentFileHash(resolvedHash);
      setActiveTab("transcription");

      let secureUrl = fileInfo.fileUrl ?? "";

      if (storagePath) {
        try {
          const storage = getStorage();
          const storageRef = ref(storage, storagePath);
          secureUrl = await getDownloadURL(storageRef);
        } catch (urlError) {
          console.warn("Storage 파일 접근 권한이 없거나 파일이 없습니다:", urlError);
          secureUrl = "";
        }
      }

      const isPdf = (fileInfo.fileType ?? "").toLowerCase() === "pdf";

      if (isPdf) {
        if (!secureUrl) {
          throw new Error("PDF 파일 다운로드 URL을 생성할 수 없습니다.");
        }
        const pdfResponse = await fetch(secureUrl);
        const blob = await pdfResponse.blob();
        const file = new File([blob], fileInfo.fileName, { type: "application/pdf" });

        setPdfFile(file);
        setmediaUrl(null);
        setMediaType(null);
        setSummaries(data.summary || {});
        
        // 기존 녹음(전사) 기록이 있다면 복구
        if (data.scripts && data.scripts.length > 0) {
          setTranscriptions(data.scripts);
        } else {
          setTranscriptions([]);
        }
      } else {
        setSummaries(data.summary || {});
        setVideoSummary(data.video_summary || "");
        
        const isAudio = (fileInfo.fileType ?? "").includes("audio");
        setMediaType(isAudio ? "audio" : "video");
        
        if (!secureUrl) {
          throw new Error("미디어 파일 다운로드 URL을 생성할 수 없습니다.");
        }
        setmediaUrl(secureUrl);
        setPdfFile(null);
      }

    } catch (error) {
      console.error("파일 로드 에러:", error);
      alert("데이터를 가져오는 중 오류가 발생하거나 파일 접근 권한이 없습니다.");
    } finally {
      setIsVideoProcessing(false);
    }
  };

  const handleOpenCompletedJob = async (job: TranscriptionJobPreview) => {
    const fileId = job.result_file_hash || job.file_hash;
    if (!fileId || job.status !== "completed") return;
    const existingFile = myFiles.find((file) => file.id === fileId || file.hash === fileId);
    await handleLoadPastFile(existingFile ?? {
      id: fileId,
      hash: fileId,
      fileName: job.fileName,
      fileType: job.fileType,
    });
  };

  const handleDeleteFile = async (e: React.MouseEvent, fileId: string) => {
    e.stopPropagation(); // 카드 클릭(불러오기) 이벤트 방지
    
    if (!confirm("정말로 이 파일을 삭제하시겠습니까? 관련된 모든 데이터가 영구적으로 삭제됩니다.")) return;

    // 낙관적 업데이트: 화면에서 먼저 지움
    const previousFiles = [...myFiles];
    setMyFiles(prev => prev.filter(f => f.id !== fileId));

    try {
    const response = await fetch(buildApiUrl(`/api/files/${fileId}`), {
      method: 'DELETE'
    });
      
      if (!response.ok) throw new Error("삭제 실패");
      
    } catch (error) {
      console.error("삭제 에러:", error);
      alert("파일 삭제 중 오류가 발생했습니다.");
      setMyFiles(previousFiles); // 실패 시 원래대로 복구
    }
  };

  // ✅ 파일 이름 수정 핸들러
  const handleRenameFile = async (e: React.MouseEvent, fileId: string, currentName: string) => {
    e.stopPropagation(); // 카드 클릭 방지
    
    const newName = prompt("새로운 파일 이름을 입력하세요:", currentName);
    if (!newName || newName.trim() === "" || newName === currentName) return;

    // 낙관적 업데이트
    const previousFiles = [...myFiles];
    setMyFiles(prev => prev.map(f => f.id === fileId ? { ...f, fileName: newName } : f));

    try {
    const response = await fetch(buildApiUrl(`/api/files/${fileId}/rename`), {
        method: 'PATCH',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_name: newName })
      });

      if (!response.ok) throw new Error("이름 변경 실패");

    } catch (error) {
      console.error("이름 변경 에러:", error);
      alert("파일 이름 변경 중 오류가 발생했습니다.");
      setMyFiles(previousFiles); // 실패 시 원래대로 복구
    }
  };
  
  // (기존) 실시간 녹음 슬라이드 동기화
  useEffect(() => {
    if (isRecording || isSystemRecording) {
      notifySlideChange(currentSlide);
    }
  }, [currentSlide, isRecording, isSystemRecording, notifySlideChange]);

  // (기존) 전사 데이터 업데이트 시 스크롤 맨 아래로
  useEffect(() => {
    if (scrollRef.current && !mediaUrl) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcriptions, summaries, isSummarizing, correctionProgress, mediaUrl]);

  const handleSummarize = async () => {
  setIsSummarizing(true);
  try {
    if (mediaUrl) {
      // 🎬 [비디오/음성 모드]
      const fullText = sortedParagraphs.map((paragraph) => paragraph.text).join(" ");
      if (!fullText.trim()) {
        alert("요약할 비디오 스크립트가 없습니다.");
        return;
      }

      setVideoSummary(""); 
      const response = await fetch(buildApiUrl("/api/summarize-video"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // ✅ currentFileHash가 상태값으로 잘 관리되고 있는지 확인해 주세요!
        body: JSON.stringify({ 
          file_hash: currentFileHash, 
          text: fullText 
        }),
      });
      if (!response.ok) throw new Error("비디오 요약 API 실패");
      const data = await response.json();
      setVideoSummary(data.summary);

    } else {
      // 📄 [PDF 모드]
      const groupedData: Record<string, string> = {};
      transcriptions.forEach(t => {
        const slideStr = t.slide.toString();
        if (!groupedData[slideStr]) groupedData[slideStr] = "";
        groupedData[slideStr] += t.text + " ";
      });

      if (Object.keys(groupedData).length === 0) {
        alert("요약할 전사 내용이 없습니다.");
        return;
      }

      setSummaries({}); 
      const response = await fetch(buildApiUrl("/api/summarize"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 🚨 [수정] PDF 모드에서도 file_hash를 반드시 포함해야 DB 저장이 됩니다!
        body: JSON.stringify({ 
          file_hash: currentFileHash, 
          transcriptions_data: groupedData 
        }),
      });

      if (!response.ok) throw new Error("PDF 요약 API 실패");
      const data = await response.json();
      
      // 🚨 [수정] 백엔드 응답 키가 'summary'이므로 data.summary에서 꺼내야 합니다.
      const newSummaries: Record<number, string> = {};
      const receivedSummaries = data.summary; // data.summaries 아님!
      
      for (const key in receivedSummaries) {
        newSummaries[Number(key)] = receivedSummaries[key];
      }
      setSummaries(newSummaries);
    }
  } catch (error) {
    console.error("요약 에러:", error);
    alert("요약 처리 중 문제가 발생했습니다.");
  } finally {
    setIsSummarizing(false);
  }
};

  const currentTranscriptions = useMemo(
    () => transcriptions.filter((t) => t.slide === currentSlide),
    [transcriptions, currentSlide]
  );
  const currentSummary = useMemo(() => summaries[currentSlide], [summaries, currentSlide]);
  const activeBatchJobCount = useMemo(
    () => transcriptionJobs.filter((job) => !TERMINAL_JOB_STATUSES.has(job.status)).length,
    [transcriptionJobs]
  );
  const sortedParagraphs = useMemo(
    () => [...paragraphs].sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id),
    [paragraphs]
  );
  const sortedSubtitleSegments = useMemo(
    () => [...subtitleSegments].sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id),
    [subtitleSegments]
  );
  const activeParagraph = useMemo(
    () => {
      if (sortedParagraphs.length === 0) {
        return undefined;
      }

      const tolerance = 0.15;
      return findLatestByStart(sortedParagraphs, videoCurrentTime, tolerance) ?? sortedParagraphs[0];
    },
    [sortedParagraphs, videoCurrentTime]
  );

  const activeSubtitleParagraph = useMemo(() => {
    if (mediaType !== "video" || sortedSubtitleSegments.length === 0) {
      return undefined;
    }

    const playhead = Math.max(0, videoCurrentTime);
    const startTolerance = 0.15;
    const endTolerance = 0.35;

    return findActiveTimeRange(sortedSubtitleSegments, playhead, startTolerance, endTolerance);
  }, [mediaType, sortedSubtitleSegments, videoCurrentTime]);

  const activeSubtitleText =
    activeSubtitleParagraph?.translation?.trim() ||
    activeSubtitleParagraph?.text?.trim() ||
    "";

  // ✅ 비디오 재생 시간에 맞춰 활성화된 카드로 자동 스크롤
  useEffect(() => {
    if (activeScriptRef.current && mediaUrl && activeParagraph) {
      activeScriptRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [activeParagraph, mediaUrl]);
  if (currentView === "auth") {
    return (
      <>
        {renderCourseSelectionModal()}
        <div className="h-screen bg-gray-50 flex items-center justify-center p-4">
          <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md border border-gray-100">
            <div className="flex flex-col items-center mb-8">
              <div className="w-16 h-16 bg-indigo-100 text-indigo-600 rounded-2xl flex items-center justify-center mb-4 shadow-inner">
                <FileText size={32} />
              </div>
              <h1 className="text-2xl font-extrabold text-gray-800">AI Notetaker</h1>
              <p className="text-sm text-gray-500 mt-2">나만의 지식 아카이브에 로그인하세요</p>
            </div>

            <form onSubmit={handleAuth} className="space-y-4">
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                <input type="email" placeholder="이메일 주소" value={email} onChange={(e) => setEmail(e.target.value)} required
                  className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all" />
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                <input type="password" placeholder="비밀번호" value={password} onChange={(e) => setPassword(e.target.value)} required
                  className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all" />
              </div>
              {authError && <p className="text-red-500 text-sm text-center font-bold">{authError}</p>}
              <button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl transition-all shadow-md hover:shadow-lg">
                {isLoginMode ? "로그인" : "회원가입"}
              </button>
            </form>

            <div className="mt-6 text-center">
              <button onClick={() => setIsLoginMode(!isLoginMode)} className="text-sm text-indigo-600 hover:underline font-semibold">
                {isLoginMode ? "계정이 없으신가요? 회원가입하기" : "이미 계정이 있으신가요? 로그인하기"}
              </button>
            </div>
          </div>
        </div>
    </>
  );
}

  // 2️⃣ 로비(대시보드) 화면
  if (currentView === "lobby") {
    return (
      <>
        {renderCourseSelectionModal()}
        <div className="h-screen bg-gray-50 flex flex-col">
        <header className="h-16 bg-white border-b px-6 flex items-center justify-between shrink-0 shadow-sm">
          <div className="flex items-center gap-2 text-indigo-600">
            <FileText size={24} />
            <h1 className="text-xl font-bold">AI Notetaker</h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm font-semibold text-gray-600 flex items-center gap-2">
              <User size={16} className="text-gray-400" /> {user?.email}
            </span>
            <button onClick={handleLogout} className="p-2 text-gray-400 hover:bg-red-50 hover:text-red-500 rounded-lg transition-colors">
              <LogOut size={20} />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-8 max-w-6xl mx-auto w-full">
          <div className="flex justify-between items-end mb-8">
            <div>
              <h2 className="text-3xl font-extrabold text-gray-800">내 작업실</h2>
              <p className="text-gray-500 mt-2">업로드한 모든 강의와 녹음 기록이 안전하게 보관됩니다.</p>
            </div>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-xl cursor-pointer transition-all shadow-md hover:shadow-lg">
                <Plus size={20} />
                <span className="font-bold">새 파일 업로드</span>
                <input type="file" accept="video/*, audio/*, .pdf" multiple className="hidden" onChange={handleMediaUpload} />
              </label>
            </div>
          </div>

          {transcriptionJobs.length > 0 && (
            <section className="mb-8 rounded-3xl border border-indigo-100 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-base font-extrabold text-gray-800">백그라운드 전사 작업</h3>
                  <p className="text-xs text-gray-500 mt-1">
                    실시간 녹음과 별개로 영상/음성 파일을 최대 {batchMaxConcurrent}개씩 처리합니다.
                  </p>
                </div>
                <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-600">
                  진행 중 {activeBatchJobCount}개
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {transcriptionJobs.map((job) => {
                  const isCompleted = job.status === "completed";
                  const isFailed = job.status === "failed";
                  return (
                    <div key={job.job_id} className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-gray-800">{job.fileName}</p>
                          <p className={`mt-1 text-xs font-bold ${
                            isFailed ? "text-red-500" : isCompleted ? "text-emerald-600" : "text-indigo-600"
                          }`}>
                            {getJobStatusLabel(job.status)}
                          </p>
                        </div>
                        {isCompleted ? (
                          <button
                            type="button"
                            onClick={() => handleOpenCompletedJob(job)}
                            className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 transition"
                          >
                            열기
                          </button>
                        ) : (
                          <Loader2
                            size={18}
                            className={isFailed ? "text-red-400" : "animate-spin text-indigo-500"}
                          />
                        )}
                      </div>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
                        <div
                          className={`h-full rounded-full transition-all ${
                            isFailed ? "bg-red-400" : isCompleted ? "bg-emerald-500" : "bg-indigo-500"
                          }`}
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                      {job.error && (
                        <p className="mt-2 line-clamp-2 text-xs text-red-500">{job.error}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {isLoadingFiles ? (
            <div className="flex flex-col items-center justify-center py-32 text-indigo-400">
              <Loader2 size={40} className="animate-spin mb-4" />
              <p className="font-bold">파일 목록을 불러오는 중...</p>
            </div>
          ) : myFiles.length === 0 ? (
            <div className="bg-white rounded-3xl border border-dashed border-gray-300 flex flex-col items-center justify-center py-32 text-gray-400">
              <Folder size={64} className="mb-4 text-gray-300" />
              <h3 className="text-lg font-bold text-gray-600 mb-2">아직 업로드한 파일이 없습니다.</h3>
              <p className="text-sm">우측 상단의 버튼을 눌러 첫 번째 AI 노트를 만들어보세요!</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {myFiles.map((file) => (
                <div 
                  key={file.id} 
                  onClick={() => handleLoadPastFile(file)}
                  className="bg-white p-5 rounded-2xl border border-gray-100 shadow-sm hover:shadow-md hover:border-indigo-300 cursor-pointer transition-all group relative"
                >
                  <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                      onClick={(e) => handleRenameFile(e, file.id, file.fileName)}
                      className="p-1.5 bg-gray-100 text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors"
                      title="이름 변경"
                    >
                      <Edit2 size={16} />
                    </button>
                    <button 
                      onClick={(e) => handleDeleteFile(e, file.id)}
                      className="p-1.5 bg-gray-100 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                      title="삭제"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center group-hover:bg-indigo-50 transition-colors">
                      {file.fileType?.includes("video") ? <Film size={20} className="text-pink-500" /> : <Headphones size={20} className="text-purple-500" />}
                    </div>
                    <div className="flex-1 overflow-hidden">
                      <h4 className="font-bold text-gray-800 truncate">{file.fileName}</h4>
                      <p className="text-xs text-gray-400">{formatUploadedAt(file.uploadedAt)}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-[10px] px-2 py-1 bg-gray-100 text-gray-600 rounded-md font-bold">전사 완료</span>
                    <span className="text-[10px] px-2 py-1 bg-indigo-50 text-indigo-600 rounded-md font-bold">AI 노트 저장됨</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </>
    );
  }

  // 3️⃣ 워크스페이스(기존 화면)
  return (
    <>
      {renderCourseSelectionModal()}
      <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">
      <header className="h-16 bg-white border-b px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <button onClick={() => setCurrentView("lobby")} className="p-2 text-gray-400 hover:bg-gray-100 rounded-lg transition-colors flex items-center gap-2">
            <ChevronLeft size={20} /> <span className="text-sm font-bold">로비로 돌아가기</span>
          </button>
          <div className="w-px h-6 bg-gray-200"></div>
          <h1 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            {mediaUrl ? (mediaType === "audio" ? <Headphones size={18} className="text-purple-500"/> : <Film size={18} className="text-pink-500"/>) : <FileText size={18} className="text-indigo-500"/>}
            작업실
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {activeBatchJobCount > 0 && (
            <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-600">
              백그라운드 처리 {activeBatchJobCount}개
            </span>
          )}
          <label className="flex items-center gap-2 rounded-xl bg-gray-900 px-4 py-2 text-sm font-bold text-white cursor-pointer hover:bg-gray-800 transition">
            <Upload size={16} />
            파일 추가 처리
            <input type="file" accept="video/*, audio/*, .pdf" multiple className="hidden" onChange={handleMediaUpload} />
          </label>
        </div>
      </header>

      {/* --- 이하 기존 <main> 뷰어 및 우측 스크립트 영역 코드 복붙 (수정 없음) --- */}
      <main className="flex-1 flex overflow-hidden">
        <section className="flex-[6] bg-gray-200 border-r flex relative overflow-hidden">
          
          {pdfFile && numPages > 0 && !mediaUrl && (
            <div className="w-28 lg:w-36 bg-gray-100 border-r overflow-y-auto flex flex-col py-6 z-10 shrink-0 shadow-[4px_0_15px_rgba(0,0,0,0.03)] scroll-smooth">
              <PdfThumbnails 
                file={pdfFile} numPages={numPages} 
                currentSlide={currentSlide} onSlideClick={setCurrentSlide} 
              />
            </div>
          )}

          <div className={`flex-1 flex flex-col relative overflow-hidden ${mediaUrl ? "bg-black" : ""}`}>
            {mediaUrl ? (
              <div className="flex-1 flex items-center justify-center p-4">
                {mediaType === "audio" ? (
                  // ✅ 오디오 플레이어 UI (음악 아이콘과 함께 예쁘게 렌더링)
                  <div className="w-full max-w-md bg-white p-8 rounded-3xl shadow-xl flex flex-col items-center gap-6 border border-gray-100">
                    <div className="w-32 h-32 bg-pink-50 text-pink-500 rounded-full flex items-center justify-center shadow-inner">
                      <Music size={56} className="animate-pulse" />
                    </div>
                    <div className="w-full text-center mb-2">
                      <h3 className="font-bold text-gray-800 text-lg">음성 기록 재생 중</h3>
                      <p className="text-sm text-gray-500 mt-1">우측에서 스크립트를 확인하세요</p>
                    </div>
                    {/* 오디오 태그: onTimeUpdate로 똑같이 시간 연동! */}
                    <audio 
                      ref={(el) => {
                        audioRef.current = el;
                        mediaPlayerRef.current = el;
                      }}
                      src={mediaUrl} 
                      controls 
                      className="w-full h-12"
                      onTimeUpdate={(e) => setVideoCurrentTime(e.currentTarget.currentTime)}
                    />
                  </div>
                ) : (
                  // ✅ 비디오 플레이어 UI
                  <div className="relative w-full max-w-5xl">
                    <video 
                      ref={(el) => {
                        videoRef.current = el;
                        mediaPlayerRef.current = el;
                      }}
                      src={mediaUrl} 
                      controls 
                      className="w-full h-auto max-h-[80vh] object-contain"
                      onTimeUpdate={(e) => setVideoCurrentTime(e.currentTarget.currentTime)}
                    />
                    {activeSubtitleText && (
                      <div
                        aria-live="polite"
                        className="pointer-events-none absolute left-1/2 bottom-16 w-[min(92%,48rem)] -translate-x-1/2 rounded-2xl bg-black/70 px-5 py-3 text-center text-white shadow-2xl backdrop-blur-sm ring-1 ring-white/10"
                      >
                        <p className="text-sm md:text-base font-semibold leading-relaxed whitespace-pre-wrap break-words">
                          {activeSubtitleText}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : pdfFile ? (
              <div className="flex-1 overflow-auto flex items-center justify-center p-4">
                <PdfViewer file={pdfFile} pageNumber={currentSlide} onLoadSuccess={setNumPages} />
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-gray-400 font-medium">
                우측 상단에서 PDF나 영상 파일을 업로드해주세요.
              </div>
            )}

            {pdfFile && !mediaUrl && (
              <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur px-6 py-3 rounded-full shadow-lg flex items-center gap-6 border border-gray-100">
                <button 
                  onClick={() => setCurrentSlide(prev => Math.max(1, prev - 1))}
                  disabled={currentSlide <= 1}
                  className="p-1 hover:bg-gray-100 rounded-full text-gray-600 disabled:opacity-30 transition-all"
                >
                  <ChevronLeft size={28} />
                </button>
                <span className="font-bold text-gray-700 min-w-[4rem] text-center text-lg">
                  {currentSlide} / {numPages > 0 ? numPages : "?"}
                </span>
                <button 
                  onClick={() => setCurrentSlide(prev => Math.min(numPages || 1, prev + 1))}
                  disabled={currentSlide >= numPages}
                  className="p-1 hover:bg-gray-100 rounded-full text-gray-600 disabled:opacity-30 transition-all"
                >
                  <ChevronRight size={28} />
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="flex-[4] bg-white flex flex-col border-l overflow-hidden min-w-[400px]">
          <div className="flex border-b shrink-0 bg-white z-10">
            <button onClick={() => setActiveTab("transcription")} className={`flex-1 py-4 text-sm font-bold flex items-center justify-center gap-2 ${activeTab === "transcription" ? "text-indigo-600 border-b-2 border-indigo-600 bg-indigo-50/30" : "text-gray-500 hover:bg-gray-50"}`}>
              <MessageSquareText size={18} /> 실시간 전사 및 번역
            </button>
            <button onClick={() => setActiveTab("summary")} className={`flex-1 py-4 text-sm font-bold flex items-center justify-center gap-2 ${activeTab === "summary" ? "text-indigo-600 border-b-2 border-indigo-600 bg-indigo-50/30" : "text-gray-500 hover:bg-gray-50"}`}>
              <FileText size={18} /> AI 요약 노트
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 bg-gray-50/50 scroll-smooth relative">
            {activeTab === "transcription" ? (
              <div className="flex flex-col gap-4">
                
                {/* 🎬 비디오 모드 렌더링 */}
                {mediaUrl ? (
                  isVideoProcessing ? (
                    <div className="flex flex-col items-center justify-center py-32 text-purple-500 space-y-4">
                      <Loader2 size={48} className="animate-spin" />
                      <p className="font-bold animate-pulse text-lg">AI가 영상을 분석하여 스크립트를 추출 중입니다...</p>
                      <p className="text-sm text-gray-500">영상의 길이에 따라 1~3분 정도 소요될 수 있습니다.</p>
                    </div>
                  ) : sortedParagraphs.length > 0 ? (
                    <div className="flex flex-col gap-4">
                      {sortedParagraphs.map((paragraph) => {
                        const isActive = activeParagraph?.id === paragraph.id;
                        return (
                          <div
                            key={`paragraph-${paragraph.id}-${paragraph.start}`}
                            ref={isActive ? activeScriptRef : null}
                            className={`rounded-2xl p-5 shadow-sm transition-all duration-200 border ${
                              isActive
                                ? "bg-purple-50 border-purple-200 scale-[1.01] shadow-md ring-2 ring-purple-200"
                                : "bg-white border-gray-100 hover:shadow-md"
                            }`}
                          >
                            <div className="flex items-center justify-between mb-3">
                              <span className={`text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full ${getSpeakerBadgeClass(paragraph.speaker)}`}>
                                {paragraph.speaker}
                              </span>
                              <button
                                type="button"
                                onClick={() => handleSeek(`[${formatSecondsLabel(paragraph.start)}]`)}
                                className="text-xs font-semibold text-blue-600 underline hover:text-blue-800 transition-colors"
                              >
                                [{formatSecondsLabel(paragraph.start)}]
                              </button>
                            </div>
                            <p className="text-sm leading-relaxed text-gray-900">{paragraph.text}</p>
                            {paragraph.translation && (
                              <p className="text-sm mt-4 pt-3 border-t border-gray-100 text-gray-600">
                                {paragraph.translation}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                      <Film size={40} className="mb-3 opacity-20" />
                      <p className="text-sm">업로드된 영상의 스크립트가 없습니다.</p>
                    </div>
                  )
                ) : (
                  // 📄 PDF 모드 렌더링
                  currentTranscriptions.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                      <MessageSquareText size={40} className="mb-3 opacity-20" />
                      <p className="text-sm">{currentSlide}번 슬라이드에 대한 녹음 기록이 없습니다.</p>
                    </div>
                  ) : (
                    currentTranscriptions.map((t, index) => (
                      <div 
                        key={index} 
                        className={`p-4 rounded-xl border transition-all duration-300 ${
                          t.is_final ? "bg-white border-gray-100 shadow-sm" : "bg-indigo-50/50 border-indigo-200 border-dashed animate-pulse"
                        }`}
                      >
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-[10px] font-black text-indigo-500 uppercase tracking-widest">
                            Slide {t.slide}
                          </span>
                          {!t.is_final && (
                            <span className="flex items-center gap-1">
                              <span className="text-[10px] text-indigo-400 font-bold">입력 중...</span>
                              <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
                              </span>
                            </span>
                          )}
                        </div>
                        <p className={`text-sm leading-relaxed ${t.is_final ? "text-gray-800 font-medium" : "text-gray-500 italic"}`}>
                          {t.text}
                          {!t.is_final && <span className="inline-block w-1 h-4 ml-1 bg-indigo-500 animate-bounce" />}
                        </p>
                        {t.translation && (
                          <p className={`text-sm mt-2 pt-2 border-t border-indigo-50 font-semibold ${t.is_final ? "text-indigo-600" : "text-indigo-400 italic"}`}>
                            {t.translation}
                          </p>
                        )}
                      </div>
                    ))
                  )
                )}

                {/* 정밀 보정 진행률 UI */}
                {!mediaUrl && correctionProgress.status !== "idle" && (
                  <div className="p-6 rounded-xl border border-purple-200 bg-purple-50 shadow-md flex flex-col items-center justify-center gap-4 mt-4 transition-all">
                    <div className="flex items-center gap-3">
                      <Loader2 size={28} className="animate-spin text-purple-600" />
                      <h3 className="font-extrabold text-purple-800 text-lg">
                        {correctionProgress.status === "transcribing" 
                          ? "✨ AI가 전체 문맥을 파악하며 정밀 전사 중입니다..." 
                          : "🌍 완벽한 문장으로 번역을 다듬는 중입니다..."}
                      </h3>
                    </div>
                    
                    {correctionProgress.total > 0 && (
                      <div className="w-full max-w-md mt-2">
                        <div className="flex justify-between text-xs text-purple-600 mb-1 font-bold">
                          <span>
                            {correctionProgress.status === "transcribing" ? "오디오 분석 중" : "문장 번역 중"}
                          </span>
                          <span>{correctionProgress.current} / {correctionProgress.total} 완료</span>
                        </div>
                        <div className="w-full bg-purple-200 rounded-full h-2.5 overflow-hidden">
                          <div 
                            className="bg-purple-600 h-2.5 rounded-full transition-all duration-500 ease-out" 
                            style={{ width: `${(correctionProgress.current / correctionProgress.total) * 100}%` }}
                          ></div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 min-h-full flex flex-col">
                <div className="flex justify-between items-center mb-6 pb-4 border-b border-gray-100">
                  <h3 className="font-bold text-gray-800">
                    {/* 모드에 따라 제목 변경 */}
                    {mediaUrl ? (
                       <span><span className="text-pink-600">Video</span> 통합 요약 노트</span>
                    ) : (
                       <span><span className="text-purple-600">Slide {currentSlide}</span> 요약 노트</span>
                    )}
                  </h3>
                  <button
                    onClick={handleSummarize}
                    disabled={isSummarizing || (mediaUrl ? sortedParagraphs.length === 0 : transcriptions.length === 0)}
                    className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSummarizing ? (
                      <><Loader2 size={16} className="animate-spin" /> {mediaUrl ? "영상 요약 중..." : "전체 요약 중..."}</>
                    ) : (
                      <><Sparkles size={16} /> {mediaUrl ? "영상 전체 요약 생성" : "전체 슬라이드 요약 생성"}</>
                    )}
                  </button>
                </div>

                {/* 🚨 비디오 모드 렌더링 */}
                {mediaUrl ? (
                  !videoSummary && !isSummarizing ? (
                    <div className="flex-1 flex flex-col items-center justify-center py-20 text-gray-400">
                      <Film size={48} className="mb-4 opacity-20" />
                      <p className="text-sm">영상의 전체 흐름을 파악하여 하나의 마크다운 노트로 정리해 드립니다.</p>
                      <p className="text-sm font-bold mt-1 text-pink-500">우측 상단의 버튼을 눌러보세요.</p>
                    </div>
                  ) : isSummarizing ? (
                    <div className="flex-1 flex flex-col items-center justify-center py-20 text-gray-400 space-y-4">
                      <Loader2 size={40} className="animate-spin text-pink-500" />
                      <p className="text-sm font-bold text-pink-600 animate-pulse">
                        영상의 문맥을 완벽하게 분석하고 있습니다...
                      </p>
                    </div>
                  ) : (
                    renderSummaryMarkdown(videoSummary, "video")
                  )
                ) : (
                  /* 📄 기존 PDF 모드 렌더링 (currentSummary 렌더링 그대로 유지) */
                  !currentSummary && !isSummarizing ? (
                  <div className="flex-1 flex flex-col items-center justify-center py-20 text-gray-400">
                    <FileText size={48} className="mb-4 opacity-20" />
                    <p className="text-sm">전체 강의 맥락을 파악하여 각 슬라이드별 요약을 제공합니다.</p>
                    <p className="text-sm font-bold mt-1 text-purple-500">우측 상단의 버튼을 눌러보세요.</p>
                  </div>
                ) : isSummarizing ? (
                  <div className="flex-1 flex flex-col items-center justify-center py-20 text-gray-400 space-y-4">
                    <Loader2 size={40} className="animate-spin text-purple-500" />
                    <p className="text-sm font-bold text-purple-600 animate-pulse">
                      전체 맥락을 파악하며 슬라이드별 노트를 작성하고 있습니다...
                    </p>
                  </div>
                ) : (
                  renderSummaryMarkdown(currentSummary, "slide")
                ))}
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="h-20 bg-white border-t flex items-center justify-center gap-4 shrink-0">
        {!isSystemRecording && (
          !isRecording ? (
            <button onClick={startRecording} className="flex items-center gap-2 bg-red-500 hover:bg-red-600 text-white px-6 py-3 rounded-full font-bold shadow-lg transition-all">
              <Mic size={20} /> 마이크 녹음 시작
            </button>
          ) : (
            <button onClick={stopRecording} className="flex items-center gap-2 bg-gray-800 text-white px-6 py-3 rounded-full font-bold shadow-lg animate-pulse">
              <Square size={20} /> 마이크 녹음 종료
            </button>
          )
        )}

        {!isRecording && (
          !isSystemRecording ? (
            <button onClick={startSystemRecording} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-full font-bold shadow-lg transition-all">
              <Upload size={20} /> 시스템 소리 녹음
            </button>
          ) : (
            <button onClick={stopSystemRecording} className="flex items-center gap-2 bg-gray-800 text-white px-6 py-3 rounded-full font-bold shadow-lg animate-pulse">
              <Square size={20} /> 시스템 녹음 종료
            </button>
          )
        )}
      </footer>
    </div>
    </>
  );
}
