import { useState, useRef, useCallback, useEffect } from 'react';
import useWebSocket from 'react-use-websocket';
import { buildWsUrl } from '@/lib/api';

const SESSION_ID = Math.random().toString(36).substring(7);
const WS_URL = buildWsUrl(`/ws/record/${SESSION_ID}`);

export interface TranscriptionData {
  slide: number;
  text: string;
  translation: string;
  is_final: boolean; 
}

export interface CorrectionProgress {
  status: "idle" | "transcribing" | "translating";
  current: number;
  total: number;
}

const normalizeTranscriptionData = (source: Record<string, unknown>): TranscriptionData => ({
  slide: typeof source.slide === "number" ? source.slide : 1,
  text: typeof source.text === "string" ? source.text : "",
  translation: typeof source.translation === "string" ? source.translation : "",
  is_final: source.is_final === true,
});

const cleanTranscriptionText = (value: string) => value.replace(/[.,!?]+$/, "").trim();

export function useAudioRecorder() {
  const [transcriptions, setTranscriptions] = useState<TranscriptionData[]>([]);
  const [summaries, setSummaries] = useState<Record<number, string>>({});
  const [videoSummary, setVideoSummary] = useState<string>("");
  const [isRecording, setIsRecording] = useState(false);
  const [isSystemRecording, setIsSystemRecording] = useState(false);
  const [correctionProgress, setCorrectionProgress] = useState<CorrectionProgress>({
    status: "idle",
    current: 0,
    total: 0
  });
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  
  // 🚨 [방어막 1을 위한 Ref] 상태 업데이트가 지연되는 것을 막기 위해 Ref로 실시간 추적
  const correctionStatusRef = useRef(correctionProgress.status);

  useEffect(() => {
    correctionStatusRef.current = correctionProgress.status;
  }, [correctionProgress.status]);

  const { sendMessage, lastMessage, readyState } = useWebSocket(WS_URL, {
    shouldReconnect: () => true,
    reconnectInterval: 3000,
  });

  useEffect(() => {
    if (lastMessage !== null) {
      try {
        const parsed = JSON.parse(lastMessage.data as string) as Record<string, unknown>;
        const eventType = typeof parsed.type === "string" ? parsed.type : undefined;
        
        if (eventType === "transcription") {
          const incomingTranscription = normalizeTranscriptionData(parsed);
          
          if (correctionStatusRef.current !== "idle" && !incomingTranscription.is_final) {
            return; 
          }

          // eslint-disable-next-line react-hooks/set-state-in-effect
          setTranscriptions(prev => {
            if (!prev || prev.length === 0) return [incomingTranscription];
            
            const incomingClean = cleanTranscriptionText(incomingTranscription.text);
            const existingIndex = prev.findIndex(item => cleanTranscriptionText(item.text) === incomingClean);
            
            if (existingIndex !== -1) {
              const updated = [...prev];
              updated[existingIndex] = { 
                ...updated[existingIndex], 
                translation: incomingTranscription.translation, 
                is_final: updated[existingIndex].is_final || incomingTranscription.is_final 
              };
              return updated;
            }
            
            const lastItem = prev[prev.length - 1];

            if (lastItem && lastItem.is_final && !incomingTranscription.is_final) {
               if (incomingClean.length > 0 && cleanTranscriptionText(lastItem.text).includes(incomingClean)) {
                  return prev;
               }
            }
            
            if (lastItem && !lastItem.is_final) {
              const updated = [...prev];
              updated[prev.length - 1] = incomingTranscription;
              return updated;
            }
            
            return [...prev, incomingTranscription];
          });
        } else if (eventType === "correction_progress") {
          const status = typeof parsed.status === "string" && ["idle", "transcribing", "translating"].includes(parsed.status as string)
            ? (parsed.status as CorrectionProgress["status"])
            : "idle";
          const current = typeof parsed.current === "number" ? parsed.current : 0;
          const total = typeof parsed.total === "number" ? parsed.total : 0;
          setCorrectionProgress({
            status,
            current,
            total,
          });
          
        } else if (eventType === "final_correction") {
          const rawPayload = Array.isArray(parsed.payload) ? (parsed.payload as unknown[]) : [];
          const payload = rawPayload.map((item) =>
            normalizeTranscriptionData(
              typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {}
            )
          );
          setTranscriptions(payload);
          setCorrectionProgress({ status: "idle", current: 0, total: 0 }); 
          
        } else if (eventType === "final_summary") {
          const content =
            typeof parsed.content === "object" && parsed.content !== null
              ? parsed.content
              : {};
          setSummaries(content as Record<number, string>);
        }
      } catch (e) {
        console.error("웹소켓 데이터 파싱 에러:", e);
      }
    }
  }, [lastMessage]);

  const float32ToInt16Base64 = (float32Array: Float32Array) => {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    const uint8Array = new Uint8Array(int16Array.buffer);
    let binary = '';
    for (let i = 0; i < uint8Array.byteLength; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary);
  };

  const processAudioStream = useCallback((stream: MediaStream) => {
    mediaStreamRef.current = stream;

    const windowWithVendorAudio = window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    };
    const AudioContextConstructor: typeof AudioContext | undefined =
      window.AudioContext ?? windowWithVendorAudio.webkitAudioContext;

    if (!AudioContextConstructor) {
      throw new Error("AudioContext를 생성할 수 없습니다.");
    }

    const audioContext = new AudioContextConstructor({
      sampleRate: 16000,
    });
    audioContextRef.current = audioContext;

    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (readyState === 1) {
        const float32Audio = e.inputBuffer.getChannelData(0);
        const base64Audio = float32ToInt16Base64(float32Audio);
        sendMessage(JSON.stringify({ type: "audio_chunk", payload: base64Audio }));
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
  }, [sendMessage, readyState]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { channelCount: 1, sampleRate: 16000 } 
      });
      processAudioStream(stream);
      setIsRecording(true);
    } catch (err) {
      console.error("마이크 접근 에러:", err);
    }
  }, [processAudioStream]);

  const stopAll = useCallback(() => {
    if (processorRef.current && audioContextRef.current) {
      processorRef.current.disconnect();
      audioContextRef.current.close();
      processorRef.current = null;
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    
    setIsRecording(false);
    setIsSystemRecording(false);
    
    if (readyState === 1) {
      sendMessage(JSON.stringify({ type: "stop_recording" }));
    }
  }, [sendMessage, readyState]);

  const startSystemRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        alert("시스템 오디오 공유를 체크해야 합니다.");
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      processAudioStream(stream);
      setIsSystemRecording(true);

      audioTrack.onended = () => {
        stopAll();
      };
    } catch (err) {
      console.error("시스템 소리 캡처 실패:", err);
    }
  }, [processAudioStream, stopAll]);

  const notifySlideChange = useCallback((slideNum: number) => {
    if (readyState === 1) {
      sendMessage(JSON.stringify({ type: "slide_change", slide: slideNum }));
    }
  }, [sendMessage, readyState]);

  return { 
    isRecording, 
    transcriptions, 
    setTranscriptions, 
    summaries, 
    setSummaries,
    correctionProgress,
    readyState, 
    lastMessage,
    startRecording, 
    stopRecording: stopAll, 
    notifySlideChange, 
    isSystemRecording, 
    startSystemRecording, 
    stopSystemRecording: stopAll,
    videoSummary, setVideoSummary,
  };
}
