import { useEffect, useRef, useState, useCallback } from "react";
import axios from "axios";
import { getToken } from "./auth";
import {
  Moon,
  Sun,
  Play,
  Square,
  Download,
  Mic,
  Monitor,
  Sparkles,
} from "lucide-react";
import { createReportData } from "./utils/transcriptFormatter";
import { exportPDF } from "./utils/exportPdf";
import { exportWord } from "./utils/exportWord";
import InsightsPanel from "./InsightsPanel";
import "./index.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

// ── Client-side VAD: decode WebM → PCM → RMS ─────────────────────────────────
// This is the correct way. Raw webm bytes → garbage RMS. Decoded PCM → real RMS.
async function getAudioRMS(blob) {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    // OfflineAudioContext decodes the container properly to raw PCM
    const audioCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    const data = decoded.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / data.length);
  } catch {
    // If decode fails (too short, corrupt) → treat as silence
    return 0;
  }
}

// RMS threshold: Wispr Flow uses ~0.01 for speech detection
// Values below this = silence / near-silence = skip Whisper entirely
const RMS_THRESHOLD = 0.008;

function App() {
  const [lines, setLines] = useState([]);
  const [darkMode, setDarkMode] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [audioSources, setAudioSources] = useState([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [systemAudioTip, setSystemAudioTip] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [inputLang, setInputLang] = useState("bn-IN");
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [insights, setInsights] = useState(null);

  // PTT state
  const [isPTTActive, setIsPTTActive] = useState(false);
  const [pttStatus, setPTTStatus] = useState(""); // "recording" | "processing" | "vad_skip" | ""

  // Audio recording state (full session backup for Cloudinary)
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const [audioDuration, setAudioDuration] = useState(0);

  const combinedRef = useRef(null);
  const micRef = useRef(null);
  const sysRef = useRef(null);
  const sessionIdRef = useRef("");
  const isRunningRef = useRef(false);
  const inputLangRef = useRef("bn-IN");
  const sessionStartAtRef = useRef(0);

  // PTT refs
  const pttRecorderRef = useRef(null);
  const pttChunksRef = useRef([]);
  const pttActiveRef = useRef(false);
  const micStreamRef = useRef(null);
  const pttMimeTypeRef = useRef("audio/webm");
  const sessionRecordingChunksRef = useRef([]);
  const pttStartTimeRef = useRef(0); // track hold duration

  // System audio refs
  const systemMediaRecorderRef = useRef(null);
  const displayStreamRef = useRef(null);

  const captureModeLabel = !isRunning
    ? "Idle"
    : audioSources.includes("mic") && audioSources.includes("system")
      ? "PTT Mic + System Audio"
      : audioSources.includes("mic")
        ? "PTT Mic Only"
        : "System Audio Only";

  const formatTime = (timestamp) =>
    timestamp.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

  const formatDuration = (seconds) => {
    const safeSeconds = Math.max(0, seconds);
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const remainingSeconds = safeSeconds % 60;
    const parts = [minutes, remainingSeconds].map((v) => String(v).padStart(2, "0"));
    return hours > 0 ? `${hours}:${parts[0]}:${parts[1]}` : `${parts[0]}:${parts[1]}`;
  };

  const parseTranscriptLine = (line) => {
    const timestampedMatch = line.match(/^\[(MIC|SYSTEM)\]\s+\[(.*?)\]\s*(.*)$/);
    if (timestampedMatch) {
      return {
        source: timestampedMatch[1].toLowerCase(),
        timestamp: timestampedMatch[2],
        text: timestampedMatch[3] || "",
      };
    }
    if (line.startsWith("[MIC] "))
      return { source: "mic", timestamp: "", text: line.replace("[MIC] ", "") };
    if (line.startsWith("[SYSTEM] "))
      return { source: "system", timestamp: "", text: line.replace("[SYSTEM] ", "") };
    return { source: "system", timestamp: "", text: line };
  };

  const formatTranscriptLine = (line) =>
    line.timestamp
      ? `[${line.source.toUpperCase()}] [${line.timestamp}] ${line.text}`
      : `[${line.source.toUpperCase()}] ${line.text}`;

  const filteredSessions = sessions.filter(
    (s) =>
      s.label.toLowerCase().includes(sessionQuery.toLowerCase()) ||
      s.id.toLowerCase().includes(sessionQuery.toLowerCase()),
  );

  useEffect(() => { inputLangRef.current = inputLang; }, [inputLang]);

  useEffect(() => {
    if (!isRunning) {
      sessionSeconds && setSessionSeconds(0);
      sessionStartAtRef.current = 0;
      return;
    }
    sessionStartAtRef.current = Date.now();
    setSessionSeconds(0);
    const timer = setInterval(() => {
      setSessionSeconds(Math.floor((Date.now() - sessionStartAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  // ── Send audio blob to /transcribe ────────────────────────────────────────
  const sendAudioChunk = async (blob, sid, source = "system") => {
    if (!blob || blob.size < 1000 || !sid) return;
    try {
      const formData = new FormData();
      formData.append("audio", blob, "audio.webm");
      formData.append("session_id", sid);
      formData.append("source", source);
      formData.append("language", inputLangRef.current);

      const token = getToken();
      const res = await axios.post(`${API}/transcribe`, formData, {
        headers: {
          "Content-Type": "multipart/form-data",
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.data.text) {
        setLines((prev) => [
          ...prev,
          {
            source,
            text: res.data.text,
            timestamp: res.data.timestamp || formatTime(new Date()),
          },
        ]);
      }
    } catch (err) {
      console.error(`${source} transcribe error:`, err);
    }
  };

  // ── PTT: start recording ──────────────────────────────────────────────────
  const startPTT = useCallback(() => {
    if (!isRunningRef.current) return;
    if (pttActiveRef.current) return;
    if (!micStreamRef.current) return;

    pttActiveRef.current = true;
    pttStartTimeRef.current = Date.now();
    setIsPTTActive(true);
    setPTTStatus("recording");

    pttChunksRef.current = [];

    const mimeType = pttMimeTypeRef.current;
    const recorder = new MediaRecorder(micStreamRef.current, { mimeType });
    pttRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) pttChunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      pttActiveRef.current = false;
      setIsPTTActive(false);

      const holdDuration = Date.now() - pttStartTimeRef.current;
      const chunks = [...pttChunksRef.current];
      pttChunksRef.current = [];

      // Too short = accidental tap (< 300ms)
      if (chunks.length === 0 || holdDuration < 300) {
        setPTTStatus("");
        return;
      }

      const blob = new Blob(chunks, { type: mimeType });

      // Blob too small = silence
      if (blob.size < 3000) {
        setPTTStatus("");
        return;
      }

      // ── CLIENT-SIDE VAD: decode PCM and check RMS ──────────────────────
      // This is the key fix. We decode the WebM to actual PCM samples,
      // then compute RMS. Raw webm bytes give garbage RMS values.
      setPTTStatus("processing");
      const rms = await getAudioRMS(blob);
      console.log(`[PTT VAD] RMS=${rms.toFixed(4)}, holdMs=${holdDuration}, size=${blob.size}`);

      if (rms < RMS_THRESHOLD) {
        console.log(`[PTT VAD] Silence detected (RMS=${rms.toFixed(4)} < ${RMS_THRESHOLD}), skipping Whisper`);
        setPTTStatus("");
        return;
      }

      // Collect for full-session Cloudinary backup
      sessionRecordingChunksRef.current.push(blob);

      const sid = sessionIdRef.current;
      if (sid) {
        await sendAudioChunk(blob, sid, "mic");
      }
      setPTTStatus("");
    };

    recorder.start();
  }, []);

  // ── PTT: stop recording ───────────────────────────────────────────────────
  const stopPTT = useCallback(() => {
    if (!pttActiveRef.current) return;
    if (pttRecorderRef.current?.state === "recording") {
      pttRecorderRef.current.stop();
    }
  }, []);

  // ── Keyboard PTT: Space bar ───────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e) => {
      if (
        e.target.tagName === "INPUT" ||
        e.target.tagName === "TEXTAREA" ||
        e.target.tagName === "SELECT"
      ) return;
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        startPTT();
      }
    };
    const onKeyUp = (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        stopPTT();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [startPTT, stopPTT]);

  // ── Init mic stream ───────────────────────────────────────────────────────
  const initMicStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      pttMimeTypeRef.current = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      return true;
    } catch (err) {
      setErrorMsg(err.name === "NotAllowedError" ? "Mic permission denied." : "Could not access microphone.");
      return false;
    }
  };

  // ── System audio: continuous 10s loop with OVERLAPPING recorders ─────────
  // Same shape as the mic PTT path (record → onstop → VAD → /transcribe),
  // except instead of stop-on-release it auto-cycles every 10 seconds.
  //
  // Key property: audio capture is NEVER paused. Every 10s we spin up a
  // fresh MediaRecorder *before* stopping the previous one. The previous
  // recorder's onstop then fires asynchronously and ships its 10s blob to
  // /transcribe, while the new recorder is already capturing the next 10s.
  // Result: the user can keep talking through the upload/transcription —
  // nothing is dropped between windows.
  const SYSTEM_LOOP_MS = 10000;

  const startSystemAudio = (sid, displayStream) => {
    if (!displayStream || displayStream.getAudioTracks().length === 0) return;

    const audioStream = new MediaStream(displayStream.getAudioTracks());
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    const stillActive = () =>
      isRunningRef.current &&
      sessionIdRef.current === sid &&
      displayStream.active;

    // Build one recorder for one 10s window. Each recorder owns its OWN
    // chunks array via closure, so two overlapping recorders never share state.
    const buildWindowRecorder = () => {
      const chunks = [];
      const recorder = new MediaRecorder(audioStream, { mimeType });

      recorder.ondataavailable = (e) => {
        if (e.data?.size > 0) chunks.push(e.data);
      };

      // Fires AFTER we've already started the next recorder, so this work
      // (RMS decode + network upload) happens with no impact on capture.
      recorder.onstop = async () => {
        if (chunks.length === 0) return;
        const blob = new Blob(chunks, { type: mimeType });

        // Same client-side VAD used by the mic PTT path
        const rms = await getAudioRMS(blob);
        console.log(`[SYS VAD] RMS=${rms.toFixed(4)}, size=${blob.size}`);
        if (rms < RMS_THRESHOLD) {
          console.log(`[SYS VAD] Silent 10s chunk skipped (RMS=${rms.toFixed(4)})`);
          return;
        }
        await sendAudioChunk(blob, sid, "system");
      };

      return recorder;
    };

    const cycle = () => {
      if (!stillActive()) return;

      // 1. Start the NEW recorder first → audio capture stays continuous.
      const next = buildWindowRecorder();
      next.start();

      // 2. Stop the previous recorder → its onstop ships the just-finished
      //    10s chunk asynchronously while `next` keeps recording.
      const prev = systemMediaRecorderRef.current;
      systemMediaRecorderRef.current = next;
      if (prev && prev.state === "recording") {
        try { prev.stop(); } catch {}
      }

      // 3. Schedule the next rollover.
      setTimeout(cycle, SYSTEM_LOOP_MS);
    };

    // Kick the loop off with the first window.
    const first = buildWindowRecorder();
    systemMediaRecorderRef.current = first;
    first.start();
    setTimeout(cycle, SYSTEM_LOOP_MS);
  };

  // ── Upload all PTT blobs as one session recording ─────────────────────────
  const uploadSessionRecording = async (sid) => {
    const allChunks = sessionRecordingChunksRef.current;
    if (allChunks.length === 0) return;

    const mimeType = pttMimeTypeRef.current || "audio/webm";
    const blob = new Blob(allChunks, { type: mimeType });
    sessionRecordingChunksRef.current = [];

    const formData = new FormData();
    formData.append("audio", blob, "recording.webm");
    formData.append("session_id", sid);
    try {
      const token = getToken();
      const res = await axios.post(`${API}/upload-audio`, formData, {
        headers: {
          "Content-Type": "multipart/form-data",
          Authorization: `Bearer ${token}`,
        },
      });
      setAudioUrl(res.data.audioUrl);
      setAudioDuration(res.data.audioDuration);
    } catch (err) {
      console.error("Upload failed:", err);
      setErrorMsg("Failed to save recording.");
    }
  };

  const downloadAudio = async () => {
    if (!audioUrl) return;
    try {
      const response = await fetch(audioUrl);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `recording_${selectedSession || sessionId}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setErrorMsg("Failed to download recording.");
    }
  };

  const regenerateInsightsFromTranscript = async () => {
    if (!selectedSession) { setErrorMsg("No session selected."); return; }
    try {
      const token = getToken();
      const transcriptRes = await axios.get(`${API}/transcript/${selectedSession}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const transcriptText = transcriptRes.data.text;
      if (!transcriptText.trim()) { setErrorMsg("Transcript is empty."); return; }

      const prompt = `You are an AI Meeting Intelligence engine. Analyze this meeting transcript and return ONLY valid JSON (no markdown, no preamble).

TRANSCRIPT:
${transcriptText.slice(0, 6000)}

Return this exact JSON shape:
{
  "summary": "2-3 sentence meeting summary",
  "keyPoints": ["point 1", "point 2", "point 3", "point 4", "point 5"],
  "actionItems": [
    { "task": "task description", "owner": "inferred owner or Team", "priority": "High|Medium|Low" }
  ],
  "flashcards": [
    { "front": "term or concept", "back": "definition or explanation" }
  ],
  "quiz": [
    {
      "question": "question text",
      "options": ["A", "B", "C", "D"],
      "answer": "correct option text"
    }
  ]
}

Generate 5 key points, 3-5 action items, 4-6 flashcards, 4 quiz questions. Ensure quiz options array has exactly 4 items and answer matches one option exactly.`;

      const res = await axios.post(`${API}/ai-insights`, { prompt }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setInsights(res.data);
    } catch (err) {
      setErrorMsg("Failed to regenerate insights.");
    }
  };

  // ── Start session ─────────────────────────────────────────────────────────
  const startSession = async () => {
    setErrorMsg("");
    setSystemAudioTip("");
    setCopyStatus("");
    setLines([]);
    setAudioUrl("");
    setAudioDuration(0);
    setIsRecordingAudio(false);
    setPTTStatus("");
    sessionRecordingChunksRef.current = [];

    const micOk = await initMicStream();
    if (!micOk) return;

    try {
      const token = getToken();
      const res = await axios.post(
        `${API}/start-session`,
        { language: inputLangRef.current },
        { headers: { Authorization: `Bearer ${token}` } },
      );

      const newSessionId = res.data.session_id;
      sessionIdRef.current = newSessionId;
      isRunningRef.current = true;
      setSessionId(newSessionId);
      setSelectedSession(newSessionId);
      setIsRunning(true);
      setAudioSources(["mic"]);
      setIsRecordingAudio(true);

      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false },
        });
        displayStream.getVideoTracks().forEach((t) => t.stop());
        displayStreamRef.current = displayStream;

        if (displayStream.getAudioTracks().length > 0) {
          setSystemAudioTip("");
          setAudioSources(["mic", "system"]);
          startSystemAudio(newSessionId, displayStream);

          displayStream.getAudioTracks()[0].onended = () => {
            setAudioSources((prev) => prev.filter((s) => s !== "system"));
            if (systemMediaRecorderRef.current?.state === "recording") {
              systemMediaRecorderRef.current.stop();
            }
            displayStreamRef.current = null;
          };
        } else {
          displayStream.getTracks().forEach((t) => t.stop());
          setSystemAudioTip("Tip: tick 'Share tab audio' in the screen share dialog.");
        }
      } catch {
        console.warn("No screen share, mic PTT only");
      }
    } catch (err) {
      console.error(err);
      setErrorMsg("Failed to start. Check server.");
      isRunningRef.current = false;
      setIsRunning(false);
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
      }
    }
  };

  // ── Stop session ──────────────────────────────────────────────────────────
  const stopSession = async () => {
    const sid = sessionIdRef.current;
    isRunningRef.current = false;
    sessionIdRef.current = "";

    pttActiveRef.current = false;
    if (pttRecorderRef.current?.state === "recording") {
      try { pttRecorderRef.current.stop(); } catch {}
    }
    pttRecorderRef.current = null;
    pttChunksRef.current = [];
    setIsPTTActive(false);
    setPTTStatus("");

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }

    if (systemMediaRecorderRef.current?.state === "recording") {
      try { systemMediaRecorderRef.current.stop(); } catch {}
      systemMediaRecorderRef.current = null;
    }
    if (displayStreamRef.current) {
      displayStreamRef.current.getTracks().forEach((t) => t.stop());
      displayStreamRef.current = null;
    }

    if (sid) await uploadSessionRecording(sid);

    setIsRecordingAudio(false);
    setIsRunning(false);
    setAudioSources([]);
    setSystemAudioTip("");
  };

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const token = getToken();
        const res = await axios.get(`${API}/transcripts`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setSessions(res.data);
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const loadSession = async (sid) => {
    if (!sid) return;
    try {
      setSelectedSession(sid);
      setSessionQuery("");
      const token = getToken();
      const res = await axios.get(`${API}/transcript/${sid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const parsed = res.data.text
        .split("\n")
        .filter((l) => l.trim())
        .map(parseTranscriptLine);
      setLines(parsed);
      const audioRes = await axios.get(`${API}/audio/${sid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setAudioUrl(audioRes.data.audioUrl || "");
      setAudioDuration(audioRes.data.audioDuration || 0);
    } catch {}
  };

  useEffect(() => {
    [combinedRef, micRef, sysRef].forEach((r) => {
      if (r.current) r.current.scrollTop = r.current.scrollHeight;
    });
  }, [lines]);

  const downloadPDF = async () => {
    const sessionName = selectedSession || sessionId || "Current Session";
    const report = createReportData(lines, sessionName);
    if (insights) {
      report.summary = insights.summary || "";
      report.keyPoints = insights.keyPoints || [];
      report.flashcards = insights.flashcards || [];
      report.quiz = insights.quiz || [];
    } else {
      report.summary = "";
      report.keyPoints = [];
      report.flashcards = [];
      report.quiz = [];
    }
    exportPDF(report);
  };

  const copyTranscript = async () => {
    const text = lines.map(formatTranscriptLine).join("\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("Transcript copied to clipboard.");
      setTimeout(() => setCopyStatus(""), 2000);
    } catch {
      setCopyStatus("Copy failed. Please try again.");
      setTimeout(() => setCopyStatus(""), 2000);
    }
  };

  const downloadWord = async () => {
    const sessionName = selectedSession || sessionId || "Current Session";
    const report = createReportData(lines, sessionName);
    if (insights) {
      report.summary = insights.summary || "";
      report.keyPoints = insights.keyPoints || [];
      report.flashcards = insights.flashcards || [];
      report.quiz = insights.quiz || [];
    } else {
      report.summary = "";
      report.keyPoints = [];
      report.flashcards = [];
      report.quiz = [];
    }
    exportWord(report);
  };

  const renderTagged = (filterFn, ref, emptyMessage) => (
    <div className="transcript-scroll" ref={ref}>
      {lines.filter(filterFn).map((l, i) => (
        <div key={i} className={`transcript-line ${l.source}`}>
          <div className="line-meta">
            <span className={`tag tag-${l.source}`}>
              {l.source === "mic" ? "🎤 MIC" : "🖥 SYS"}
            </span>
            <span className="line-time">{l.timestamp || "--:--:--"}</span>
          </div>
          <span className="line-text">{l.text}</span>
        </div>
      ))}
      {lines.filter(filterFn).length === 0 && (
        <p className="empty-hint">{emptyMessage}</p>
      )}
    </div>
  );

  const renderProse = (ref) => {
    if (lines.length === 0) {
      return (
        <div className="transcript-scroll" ref={ref}>
          <p className="empty-hint">
            {isRunning
              ? "Live transcript will appear here as soon as audio is captured."
              : "Start a session to see the combined transcript here."}
          </p>
        </div>
      );
    }
    const groups = [];
    lines.forEach((l) => {
      if (l.source === "mic") {
        groups.push({ type: "mic", text: l.text });
      } else {
        const last = groups[groups.length - 1];
        if (last && last.type === "system") last.text += " " + l.text;
        else groups.push({ type: "system", text: l.text });
      }
    });
    return (
      <div className="transcript-scroll prose-scroll" ref={ref}>
        {groups.map((g, i) =>
          g.type === "system" ? (
            <span key={i} className="prose-sys-text">{g.text} </span>
          ) : (
            <div key={i} className="prose-mic-text">{g.text}</div>
          ),
        )}
      </div>
    );
  };

  const pttLabel = !isRunning
    ? "Start session first"
    : isPTTActive
      ? "🔴 Recording... (release to send)"
      : pttStatus === "processing"
        ? "⏳ Processing..."
        : "🎤 Hold to Speak  [Space]";

  return (
    <div className={darkMode ? "app dark" : "app"}>
      <div className="header">
        <div>
          <h1>AI Live Translator</h1>
          <p className="subtitle">Real-time multilingual subtitle system</p>
        </div>
        <button onClick={() => setDarkMode(!darkMode)} className="theme-btn">
          {darkMode ? <Sun size={20} /> : <Moon size={20} />}
        </button>
      </div>

      <div className="controls">
        <div className="left-controls">
          <button onClick={startSession} className="main-btn start-btn" disabled={isRunning}>
            <Play size={18} /> Start
          </button>
          <button onClick={stopSession} className="main-btn stop-btn" disabled={!isRunning}>
            <Square size={18} /> Stop
          </button>
          <button onClick={downloadPDF} className="main-btn" disabled={isRunning}>
            <Download size={18} /> PDF
          </button>
          <button onClick={downloadWord} className="main-btn" disabled={isRunning}>
            <Download size={18} /> Word
          </button>
          <button onClick={copyTranscript} className="main-btn copy-btn" disabled={isRunning}>
            Copy Transcript
          </button>
        </div>

        <div className="right-controls">
          <div className="dropdown-group">
            <div className="dropdown-label">Mic audio language</div>
            <select
              value={inputLang}
              onChange={(e) => setInputLang(e.target.value)}
              className="dropdown"
              disabled={isRunning}
            >
              <option value="bn-IN">Bengali</option>
              <option value="hi-IN">Hindi</option>
              <option value="en-IN">English</option>
            </select>
          </div>
          <div className="dropdown-hint">Affects microphone transcription only.</div>

          {!isRunning && (
            <>
              <div className="dropdown-group">
                <div className="dropdown-label">Search sessions</div>
                <input
                  type="search"
                  value={sessionQuery}
                  onChange={(e) => setSessionQuery(e.target.value)}
                  className="dropdown search-input"
                  placeholder="Type to filter sessions"
                />
              </div>
              <select
                value={selectedSession}
                onChange={(e) => loadSession(e.target.value)}
                className="dropdown"
              >
                <option value="">Previous Sessions</option>
                {filteredSessions.length > 0 ? (
                  filteredSessions.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))
                ) : (
                  <option value="" disabled>No matching sessions</option>
                )}
              </select>
            </>
          )}
        </div>
      </div>

      {/* ── PTT Button ─────────────────────────────────────────────────────── */}
      {isRunning && (
        <div className="ptt-container">
          <button
            className={`ptt-btn ${isPTTActive ? "ptt-active" : ""} ${pttStatus === "processing" ? "ptt-processing" : ""}`}
            onMouseDown={startPTT}
            onMouseUp={stopPTT}
            onMouseLeave={stopPTT}
            onTouchStart={(e) => { e.preventDefault(); startPTT(); }}
            onTouchEnd={(e) => { e.preventDefault(); stopPTT(); }}
            disabled={pttStatus === "processing"}
          >
            <Mic size={20} />
            <span>{pttLabel}</span>
          </button>
          <div className="ptt-hint">
            System audio (device) is always-on. Hold button or Space bar to speak.
          </div>
        </div>
      )}

      {errorMsg && <div className="error-msg">⚠️ {errorMsg}</div>}
      {systemAudioTip && <div className="tip-msg">{systemAudioTip}</div>}
      {copyStatus && <div className="copy-msg">{copyStatus}</div>}

      <div className="status">
        <div className={isRunning ? "status-dot active" : "status-dot"} />
        <span>{isRunning ? "Translation Running" : "Translation Stopped"}</span>
        <div className="status-badge">Mode: {captureModeLabel}</div>
        <div className="status-badge timer-badge">Timer: {formatDuration(sessionSeconds)}</div>
        <div className={isPTTActive ? "audio-dot active ptt-pulse" : "audio-dot"} />
        <Mic size={14} style={{ opacity: audioSources.includes("mic") ? 1 : 0.4 }} />
        <span style={{ opacity: audioSources.includes("mic") ? 1 : 0.4 }}>
          {isPTTActive ? "Speaking" : "Mic (PTT)"}
        </span>
        <div className={audioSources.includes("system") ? "audio-dot system active-system" : "audio-dot system"} />
        <Monitor size={14} style={{ opacity: audioSources.includes("system") ? 1 : 0.4 }} />
        <span style={{ opacity: audioSources.includes("system") ? 1 : 0.4 }}>System</span>
        <span className="lang-pill">
          {inputLang === "bn-IN" ? "Bengali" : inputLang === "hi-IN" ? "Hindi" : "English"}
        </span>
      </div>

      <div className="status-legend">
        <span className="legend-item"><span className="legend-dot legend-running" /> Running</span>
        <span className="legend-item"><span className="legend-dot legend-mic" /> Mic (PTT)</span>
        <span className="legend-item"><span className="legend-dot legend-system" /> System (always-on)</span>
      </div>

      {audioUrl && !isRunning && (
        <div className="recording-card">
          <div className="recording-header"><Mic size={16} /> Meeting Recording</div>
          <div className="recording-content">
            <audio controls src={audioUrl} className="audio-player" />
            <div className="recording-actions">
              <button onClick={downloadAudio} className="recording-btn">
                <Download size={14} /> Download
              </button>
              <button onClick={regenerateInsightsFromTranscript} className="recording-btn">
                <Sparkles size={14} /> Regenerate AI Insights
              </button>
            </div>
            <div className="recording-duration">Duration: {formatDuration(audioDuration)}</div>
          </div>
        </div>
      )}

      {isRunning && isRecordingAudio && (
        <div className="recording-card">
          <div className="recording-header"><Mic size={16} /> Session Active</div>
          <div className="recording-content">
            <div className="recording-indicator">
              {isPTTActive
                ? "🔴 Mic recording..."
                : "⚪ Hold Space / button to speak. System audio always-on."}
            </div>
          </div>
        </div>
      )}

      <div className="panels">
        <div className="panel">
          <div className="panel-header combined-header">📋 All</div>
          {renderProse(combinedRef)}
        </div>
        <div className="panel">
          <div className="panel-header mic-header"><Mic size={14} /> Microphone (PTT)</div>
          {renderTagged(
            (l) => l.source === "mic",
            micRef,
            isRunning ? "Hold Space or the button to speak..." : "Start a session to capture microphone text here.",
          )}
        </div>
        <div className="panel">
          <div className="panel-header sys-header"><Monitor size={14} /> System Audio</div>
          {renderTagged(
            (l) => l.source === "system",
            sysRef,
            isRunning
              ? audioSources.includes("system")
                ? "Waiting for system audio text..."
                : "Share tab audio to populate this panel."
              : "Start a session and share tab audio to capture system text here.",
          )}
        </div>
      </div>

      <InsightsPanel
        lines={lines}
        darkMode={darkMode}
        insights={insights}
        setInsights={setInsights}
      />
    </div>
  );
}

export default App;