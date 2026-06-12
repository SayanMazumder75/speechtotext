import { useEffect, useRef, useState } from "react";
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

// ── VAD: RMS energy gate ──────────────────────────────────────────────────────
async function hasVoiceActivity(blob) {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const data = new Int16Array(arrayBuffer);
    if (data.length === 0) return false;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    return rms > 300; // tune: raise to 500 if too sensitive
  } catch {
    return true; // on error, let Whisper decide
  }
}

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

  // Audio recording state
  const [audioRecorder, setAudioRecorder] = useState(null);
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

  // Mic Whisper loop refs (replaces Web Speech API)
  const micMediaRecorderRef = useRef(null);
  const micChunksRef = useRef([]);
  const micRunningRef = useRef(false);

  // System audio refs
  const systemMediaRecorderRef = useRef(null);
  const systemChunksRef = useRef([]);
  const displayStreamRef = useRef(null);

  const captureModeLabel = !isRunning
    ? "Idle"
    : audioSources.includes("mic") && audioSources.includes("system")
      ? "Mic + system audio"
      : audioSources.includes("mic")
        ? "Mic only"
        : "Starting...";

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
    const parts = [minutes, remainingSeconds].map((value) =>
      String(value).padStart(2, "0"),
    );
    return hours > 0
      ? `${hours}:${parts[0]}:${parts[1]}`
      : `${parts[0]}:${parts[1]}`;
  };

  const parseTranscriptLine = (line) => {
    const timestampedMatch = line.match(
      /^\[(MIC|SYSTEM)\]\s+\[(.*?)\]\s*(.*)$/,
    );
    if (timestampedMatch) {
      return {
        source: timestampedMatch[1].toLowerCase(),
        timestamp: timestampedMatch[2],
        text: timestampedMatch[3] || "",
      };
    }

    if (line.startsWith("[MIC] ")) {
      return { source: "mic", timestamp: "", text: line.replace("[MIC] ", "") };
    }

    if (line.startsWith("[SYSTEM] ")) {
      return {
        source: "system",
        timestamp: "",
        text: line.replace("[SYSTEM] ", ""),
      };
    }

    return { source: "system", timestamp: "", text: line };
  };

  const formatTranscriptLine = (line) =>
    line.timestamp
      ? `[${line.source.toUpperCase()}] [${line.timestamp}] ${line.text}`
      : `[${line.source.toUpperCase()}] ${line.text}`;

  const filteredSessions = sessions.filter(
    (session) =>
      session.label.toLowerCase().includes(sessionQuery.toLowerCase()) ||
      session.id.toLowerCase().includes(sessionQuery.toLowerCase()),
  );

  useEffect(() => {
    inputLangRef.current = inputLang;
  }, [inputLang]);

  useEffect(() => {
    if (!isRunning) {
      sessionSeconds && setSessionSeconds(0);
      sessionStartAtRef.current = 0;
      return;
    }

    sessionStartAtRef.current = Date.now();
    setSessionSeconds(0);

    const timer = setInterval(() => {
      setSessionSeconds(
        Math.floor((Date.now() - sessionStartAtRef.current) / 1000),
      );
    }, 1000);

    return () => clearInterval(timer);
  }, [isRunning]);

  // ── Shared: send audio chunk to /transcribe via Whisper ───────────────────
  const sendAudioChunk = async (blob, sid, source = "system") => {
    if (!blob || blob.size < 1000 || !sid) return;

    // VAD gate — skip silent chunks
    const hasVoice = await hasVoiceActivity(blob);
    if (!hasVoice) {
      console.log(`[${source}] VAD: silent chunk skipped`);
      return;
    }

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

  // ── Mic: MediaRecorder loop → Whisper (replaces Web Speech API) ──────────
  const startMicWhisper = async (sid) => {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micRunningRef.current = true;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const loop = () => {
        if (!micRunningRef.current || sessionIdRef.current !== sid) {
          micStream.getTracks().forEach((t) => t.stop());
          return;
        }

        micChunksRef.current = [];
        const recorder = new MediaRecorder(micStream, { mimeType });
        micMediaRecorderRef.current = recorder;

        recorder.ondataavailable = (e) => {
          if (e.data?.size > 0) micChunksRef.current.push(e.data);
        };

        recorder.onstop = async () => {
          const chunks = [...micChunksRef.current];
          micChunksRef.current = [];
          if (chunks.length > 0) {
            const blob = new Blob(chunks, { type: mimeType });
            await sendAudioChunk(blob, sid, "mic");
          }
          loop(); // restart immediately
        };

        recorder.start();
        setTimeout(() => {
          if (recorder.state === "recording") recorder.stop();
        }, 8000); // 8s chunks for better sentence context
      };

      loop();
    } catch (err) {
      if (err.name === "NotAllowedError") {
        setErrorMsg("Mic permission denied.");
        stopSession();
      } else {
        console.error("Mic recorder error:", err);
        setErrorMsg("Could not access microphone.");
      }
    }
  };

  // ── System audio: separate stream → Whisper ───────────────────────────────
  const startSystemAudio = (sid, displayStream) => {
    if (!displayStream || displayStream.getAudioTracks().length === 0) return;

    systemChunksRef.current = [];
    const audioStream = new MediaStream(displayStream.getAudioTracks());
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    const recorder = new MediaRecorder(audioStream, { mimeType });
    systemMediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) systemChunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      if (systemChunksRef.current.length > 0) {
        const blob = new Blob(systemChunksRef.current, { type: mimeType });
        systemChunksRef.current = [];
        await sendAudioChunk(blob, sid, "system");
      }

      if (
        isRunningRef.current &&
        sessionIdRef.current === sid &&
        displayStream.active
      ) {
        systemChunksRef.current = [];
        recorder.start();
        setTimeout(() => {
          if (recorder.state === "recording") recorder.stop();
        }, 8000); // 8s chunks
      }
    };

    recorder.start();
    setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, 8000); // 8s chunks
  };

  // ── Full session recording (mic only, for Cloudinary audio backup) ────────
  const startMicrophoneRecording = async (sid) => {
    // NOTE: transcription is handled by startMicWhisper separately.
    // This records mic-only audio for the downloadable session recording.
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const recorder = new MediaRecorder(micStream, { mimeType });
      const chunks = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: mimeType });
        await uploadAudioRecording(sid, blob);
        micStream.getTracks().forEach((t) => t.stop());
      };

      recorder.start(1000);
      setAudioRecorder(recorder);
      setIsRecordingAudio(true);
    } catch (err) {
      console.error("Session recording error:", err);
    }
  };

  const uploadAudioRecording = async (sessionId, blob) => {
    const formData = new FormData();
    formData.append("audio", blob, "recording.webm");
    formData.append("session_id", sessionId);
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
      console.error("Download failed:", err);
      setErrorMsg("Failed to download recording.");
    }
  };

  const regenerateInsightsFromTranscript = async () => {
    if (!selectedSession) {
      setErrorMsg("No session selected.");
      return;
    }
    try {
      const token = getToken();
      const transcriptRes = await axios.get(
        `${API}/transcript/${selectedSession}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const transcriptText = transcriptRes.data.text;
      if (!transcriptText.trim()) {
        setErrorMsg("Transcript is empty.");
        return;
      }

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

      const res = await axios.post(
        `${API}/ai-insights`,
        { prompt },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setInsights(res.data);
    } catch (err) {
      setErrorMsg("Failed to regenerate insights.");
      console.error(err);
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

      // Start mic transcription via Whisper (no Web Speech API)
      startMicWhisper(newSessionId);

      // Start mic-only session recording (for Cloudinary backup)
      startMicrophoneRecording(newSessionId);

      // Try to get system audio
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
          setSystemAudioTip(
            "Tip: tick 'Share tab audio' in the screen share dialog.",
          );
        }
      } catch {
        // User denied screen share — mic-only mode, already running
        console.warn("No screen share, mic-only mode");
      }
    } catch (err) {
      console.error(err);
      setErrorMsg("Failed to start. Check server.");
      setSystemAudioTip("");
      isRunningRef.current = false;
      setIsRunning(false);
    }
  };

  // ── Stop session ──────────────────────────────────────────────────────────
  const stopSession = () => {
    isRunningRef.current = false;
    sessionIdRef.current = "";

    // Stop mic Whisper loop
    micRunningRef.current = false;
    if (micMediaRecorderRef.current?.state === "recording") {
      try { micMediaRecorderRef.current.stop(); } catch {}
      micMediaRecorderRef.current = null;
    }
    micChunksRef.current = [];

    // Stop system audio recorder
    if (systemMediaRecorderRef.current?.state === "recording") {
      try { systemMediaRecorderRef.current.stop(); } catch {}
      systemMediaRecorderRef.current = null;
    }

    // Stop display stream
    if (displayStreamRef.current) {
      displayStreamRef.current.getTracks().forEach((t) => t.stop());
      displayStreamRef.current = null;
    }

    // Stop session recording
    if (audioRecorder && audioRecorder.state === "recording") {
      audioRecorder.stop();
      setIsRecordingAudio(false);
    }

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
            <span key={i} className="prose-sys-text">
              {g.text}{" "}
            </span>
          ) : (
            <div key={i} className="prose-mic-text">
              {g.text}
            </div>
          ),
        )}
      </div>
    );
  };

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
          <button
            onClick={startSession}
            className="main-btn start-btn"
            disabled={isRunning}
          >
            <Play size={18} /> Start
          </button>

          <button
            onClick={stopSession}
            className="main-btn stop-btn"
            disabled={!isRunning}
          >
            <Square size={18} /> Stop
          </button>

          <button
            onClick={downloadPDF}
            className="main-btn"
            disabled={isRunning}
          >
            <Download size={18} /> PDF
          </button>

          <button
            onClick={downloadWord}
            className="main-btn"
            disabled={isRunning}
          >
            <Download size={18} /> Word
          </button>

          <button
            onClick={copyTranscript}
            className="main-btn copy-btn"
            disabled={isRunning}
          >
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

          <div className="dropdown-hint">
            Affects microphone transcription only.
          </div>

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
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))
                ) : (
                  <option value="" disabled>
                    No matching sessions
                  </option>
                )}
              </select>
            </>
          )}
        </div>
      </div>

      {errorMsg && <div className="error-msg">⚠️ {errorMsg}</div>}

      {systemAudioTip && <div className="tip-msg">{systemAudioTip}</div>}

      {copyStatus && <div className="copy-msg">{copyStatus}</div>}

      <div className="status">
        <div className={isRunning ? "status-dot active" : "status-dot"} />
        <span>{isRunning ? "Translation Running" : "Translation Stopped"}</span>

        <div className="status-badge">Mode: {captureModeLabel}</div>

        <div className="status-badge timer-badge">
          Timer: {formatDuration(sessionSeconds)}
        </div>

        <div
          className={
            audioSources.includes("mic") ? "audio-dot active" : "audio-dot"
          }
        />
        <Mic
          size={14}
          style={{ opacity: audioSources.includes("mic") ? 1 : 0.4 }}
        />
        <span style={{ opacity: audioSources.includes("mic") ? 1 : 0.4 }}>
          Mic
        </span>

        <div
          className={
            audioSources.includes("system")
              ? "audio-dot system active-system"
              : "audio-dot system"
          }
        />
        <Monitor
          size={14}
          style={{ opacity: audioSources.includes("system") ? 1 : 0.4 }}
        />
        <span style={{ opacity: audioSources.includes("system") ? 1 : 0.4 }}>
          System
        </span>

        <span className="lang-pill">
          {inputLang === "bn-IN"
            ? "Bengali"
            : inputLang === "hi-IN"
              ? "Hindi"
              : "English"}
        </span>
      </div>

      <div className="status-legend">
        <span className="legend-item">
          <span className="legend-dot legend-running" /> Running
        </span>
        <span className="legend-item">
          <span className="legend-dot legend-mic" /> Mic
        </span>
        <span className="legend-item">
          <span className="legend-dot legend-system" /> System
        </span>
      </div>

      {/* Meeting Recording Card */}
      {(audioUrl || isRecordingAudio) && (
        <div className="recording-card">
          <div className="recording-header">
            <Mic size={16} /> Meeting Recording
          </div>
          <div className="recording-content">
            {isRecordingAudio ? (
              <div className="recording-indicator">
                🔴 Recording in progress...
              </div>
            ) : (
              <>
                <audio controls src={audioUrl} className="audio-player" />
                <div className="recording-actions">
                  <button onClick={downloadAudio} className="recording-btn">
                    <Download size={14} /> Download
                  </button>
                  <button
                    onClick={regenerateInsightsFromTranscript}
                    className="recording-btn"
                  >
                    <Sparkles size={14} /> Regenerate AI Insights
                  </button>
                </div>
                <div className="recording-duration">
                  Duration: {formatDuration(audioDuration)}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="panels">
        <div className="panel">
          <div className="panel-header combined-header">📋 All</div>
          {renderProse(combinedRef)}
        </div>

        <div className="panel">
          <div className="panel-header mic-header">
            <Mic size={14} /> Microphone
          </div>
          {renderTagged(
            (l) => l.source === "mic",
            micRef,
            isRunning
              ? "Waiting for microphone input..."
              : "Start a session to capture microphone text here.",
          )}
        </div>

        <div className="panel">
          <div className="panel-header sys-header">
            <Monitor size={14} /> System Audio
          </div>
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