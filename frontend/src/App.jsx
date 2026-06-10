import { useEffect, useRef, useState } from "react";
import axios from "axios";
import {
  Moon,
  Sun,
  Play,
  Square,
  Download,
  Mic,
  Monitor
} from "lucide-react";
import { createReportData } from "./utils/transcriptFormatter";
import { exportPDF } from "./utils/exportPdf";
import { exportWord } from "./utils/exportWord";
import InsightsPanel from "./InsightsPanel";
import "./index.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

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

  const combinedRef = useRef(null);
  const micRef = useRef(null);
  const sysRef = useRef(null);
  const sessionIdRef = useRef("");
  const isRunningRef = useRef(false);
  const inputLangRef = useRef("bn-IN");
  const sessionStartAtRef = useRef(0);

  const recognitionRef = useRef(null);

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
      hour12: false
    });

  const formatDuration = (seconds) => {
    const safeSeconds = Math.max(0, seconds);
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const remainingSeconds = safeSeconds % 60;
    const parts = [minutes, remainingSeconds].map((value) => String(value).padStart(2, "0"));
    return hours > 0 ? `${hours}:${parts[0]}:${parts[1]}` : `${parts[0]}:${parts[1]}`;
  };

  const parseTranscriptLine = (line) => {
    const timestampedMatch = line.match(/^\[(MIC|SYSTEM)\]\s+\[(.*?)\]\s*(.*)$/);
    if (timestampedMatch) {
      return {
        source: timestampedMatch[1].toLowerCase(),
        timestamp: timestampedMatch[2],
        text: timestampedMatch[3] || ""
      };
    }

    if (line.startsWith("[MIC] ")) {
      return { source: "mic", timestamp: "", text: line.replace("[MIC] ", "") };
    }

    if (line.startsWith("[SYSTEM] ")) {
      return { source: "system", timestamp: "", text: line.replace("[SYSTEM] ", "") };
    }

    return { source: "system", timestamp: "", text: line };
  };

  const formatTranscriptLine = (line) =>
    line.timestamp
      ? `[${line.source.toUpperCase()}] [${line.timestamp}] ${line.text}`
      : `[${line.source.toUpperCase()}] ${line.text}`;

  const filteredSessions = sessions.filter((session) =>
    session.label.toLowerCase().includes(sessionQuery.toLowerCase()) ||
    session.id.toLowerCase().includes(sessionQuery.toLowerCase())
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
        Math.floor((Date.now() - sessionStartAtRef.current) / 1000)
      );
    }, 1000);

    return () => clearInterval(timer);
  }, [isRunning]);

  const translateToEnglish = async (text, sourceLang) => {
    if (!text) return "";

    if (sourceLang.startsWith("en")) return text;

    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(
        text
      )}`;
      const res = await fetch(url);
      const data = await res.json();
      return data[0].map((c) => c[0]).join(" ").trim() || text;
    } catch {
      return text;
    }
  };

  const sendAudioChunk = async (blob, sid) => {
    if (!blob || blob.size < 1000 || !sid) return;
    try {
      const formData = new FormData();
      formData.append("audio", blob, "audio.webm");
      formData.append("session_id", sid);
      formData.append("source", "system");
      formData.append("language", inputLangRef.current);

      const res = await axios.post(`${API}/transcribe`, formData, {
        headers: { "Content-Type": "multipart/form-data" }
      });

      if (res.data.text) {
        setLines((prev) => [
          ...prev,
          {
            source: "system",
            text: res.data.text,
            timestamp: res.data.timestamp || formatTime(new Date())
          }
        ]);
      }
    } catch (err) {
      console.error("Transcribe error:", err);
    }
  };

  const startMicRecognition = (sid) => {
    if (!SpeechRecognition) {
      setErrorMsg("Use Chrome — Web Speech API not supported.");
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = inputLangRef.current;

    rec.onresult = async (e) => {
      const transcript = Array.from(e.results)
        .filter((r) => r.isFinal)
        .map((r) => r[0].transcript)
        .join(" ")
        .trim();

      if (!transcript) return;

      const english = await translateToEnglish(transcript, inputLangRef.current);

      const timestamp = formatTime(new Date());

      setLines((prev) => [...prev, { source: "mic", text: english, timestamp }]);

      try {
        await axios.post(`${API}/push`, {
          session_id: sid,
          text: `[MIC] [${timestamp}] ${english}`
        });
      } catch {}
    };

    rec.onerror = (e) => {
      if (e.error === "not-allowed") {
        setErrorMsg("Mic permission denied.");
        stopSession();
      }
    };

    rec.onend = () => {
      if (isRunningRef.current && sessionIdRef.current === sid) {
        setTimeout(() => startMicRecognition(sid), 200);
      }
    };

    try {
      rec.start();
      recognitionRef.current = rec;
    } catch {
      setTimeout(() => startMicRecognition(sid), 500);
    }
  };

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
        await sendAudioChunk(blob, sid);
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
        }, 5000);
      }
    };

    recorder.start();
    setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, 5000);
  };

  const startSession = async () => {
    if (!SpeechRecognition) {
      setErrorMsg("Use Chrome on desktop.");
      return;
    }

    setErrorMsg("");
    setSystemAudioTip("");
    setCopyStatus("");
    setLines([]);

    try {
      const res = await axios.post(`${API}/start-session`, {
        language: inputLangRef.current
      });

      const newSessionId = res.data.session_id;

      sessionIdRef.current = newSessionId;
      isRunningRef.current = true;
      setSessionId(newSessionId);
      setSelectedSession(newSessionId);
      setIsRunning(true);
      setAudioSources(["mic"]);

      startMicRecognition(newSessionId);

      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false }
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
      }
    } catch (err) {
      console.error(err);
      setErrorMsg("Failed to start. Check server.");
      setSystemAudioTip("");
      isRunningRef.current = false;
      setIsRunning(false);
    }
  };

  const stopSession = () => {
    isRunningRef.current = false;
    sessionIdRef.current = "";

    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {}
      recognitionRef.current = null;
    }

    if (systemMediaRecorderRef.current?.state === "recording") {
      try {
        systemMediaRecorderRef.current.stop();
      } catch {}
      systemMediaRecorderRef.current = null;
    }

    if (displayStreamRef.current) {
      displayStreamRef.current.getTracks().forEach((t) => t.stop());
      displayStreamRef.current = null;
    }

    setIsRunning(false);
    setAudioSources([]);
    setSystemAudioTip("");
  };

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await axios.get(`${API}/transcripts`);
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
      const res = await axios.get(`${API}/transcript/${sid}`);
      const parsed = res.data.text
        .split("\n")
        .filter((l) => l.trim())
        .map(parseTranscriptLine);

      setLines(parsed);
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
      report.summary    = insights.summary    || "";
      report.keyPoints  = insights.keyPoints  || [];
      report.flashcards = insights.flashcards || [];
      report.quiz       = insights.quiz       || [];
    } else {
      report.summary    = "";
      report.keyPoints  = [];
      report.flashcards = [];
      report.quiz       = [];
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
      report.summary    = insights.summary    || "";
      report.keyPoints  = insights.keyPoints  || [];
      report.flashcards = insights.flashcards || [];
      report.quiz       = insights.quiz       || [];
    } else {
      report.summary    = "";
      report.keyPoints  = [];
      report.flashcards = [];
      report.quiz       = [];
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
          )
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

          <button onClick={downloadPDF} className="main-btn" disabled={isRunning}>
            <Download size={18} /> PDF
          </button>

          <button onClick={downloadWord} className="main-btn" disabled={isRunning}>
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

        <div className="status-badge timer-badge">Timer: {formatDuration(sessionSeconds)}</div>

        <div
          className={audioSources.includes("mic") ? "audio-dot active" : "audio-dot"}
        />
        <Mic size={14} style={{ opacity: audioSources.includes("mic") ? 1 : 0.4 }} />
        <span style={{ opacity: audioSources.includes("mic") ? 1 : 0.4 }}>Mic</span>

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
              : "Start a session to capture microphone text here."
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
              : "Start a session and share tab audio to capture system text here."
          )}
        </div>
      </div>

      {/* ── AI INTELLIGENCE PIPELINE ── */}
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