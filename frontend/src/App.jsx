import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { Moon, Sun, Play, Square, Download, Mic, Monitor } from "lucide-react";
import "./index.css";
import { createReportData } from "./utils/transcriptFormatter";
import { exportPDF } from "./utils/exportPdf";
import { exportWord } from "./utils/exportWord";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

function App() {
  const [lines, setLines] = useState([]);
  const [darkMode, setDarkMode] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [audioSources, setAudioSources] = useState([]);
  const [errorMsg, setErrorMsg] = useState("");

  const combinedRef = useRef(null);
  const micRef = useRef(null);
  const sysRef = useRef(null);
  const sessionIdRef = useRef("");
  const isRunningRef = useRef(false);

  // MediaRecorder references
  const micMediaRecorderRef = useRef(null);
  const systemMediaRecorderRef = useRef(null);
  const micChunksRef = useRef([]);
  const systemChunksRef = useRef([]);
  const micStreamRef = useRef(null);
  const displayStreamRef = useRef(null);

  // --------------------------------
  // SEND AUDIO CHUNK to Whisper
  // --------------------------------
  const sendAudioChunk = async (blob, sid, source) => {
    if (!blob || blob.size < 1000 || !sid) return;
    try {
      const formData = new FormData();
      formData.append("audio", blob, "audio.webm");
      formData.append("session_id", sid);
      formData.append("source", source);
      const res = await axios.post(`${API}/transcribe`, formData, {
        headers: { "Content-Type": "multipart/form-data" }
      });
      if (res.data.text) {
        setLines(prev => [...prev, { source, text: res.data.text }]);
      }
    } catch (err) {
      console.error(`Transcribe error (${source}):`, err);
    }
  };

  // --------------------------------
  // MICROPHONE CAPTURE (continuous)
  // --------------------------------
  const startMicrophoneAudio = async (sid) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus" : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      micMediaRecorderRef.current = recorder;
      micChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data?.size > 0) micChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        if (micChunksRef.current.length > 0) {
          const blob = new Blob(micChunksRef.current, { type: mimeType });
          micChunksRef.current = [];
          await sendAudioChunk(blob, sid, "mic");
        }
        if (isRunningRef.current && sessionIdRef.current === sid) {
          micChunksRef.current = [];
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
    } catch (err) {
      console.error("Microphone error:", err);
      setErrorMsg("Could not access microphone. Please allow permissions.");
    }
  };

  // --------------------------------
  // SYSTEM AUDIO CAPTURE
  // --------------------------------
  const startSystemAudio = (sid, displayStream) => {
    if (!displayStream || displayStream.getAudioTracks().length === 0) return;

    systemChunksRef.current = [];
    const audioStream = new MediaStream(displayStream.getAudioTracks());
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "audio/webm";

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
      if (isRunningRef.current && sessionIdRef.current === sid && displayStream.active) {
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

  // --------------------------------
  // START SESSION
  // --------------------------------
  const startSession = async () => {
    setErrorMsg("");
    setLines([]);

    try {
      const res = await axios.post(`${API}/start-session`);
      const newSessionId = res.data.session_id;

      sessionIdRef.current = newSessionId;
      isRunningRef.current = true;
      setSessionId(newSessionId);
      setSelectedSession(newSessionId);
      setIsRunning(true);
      setAudioSources(["mic"]);

      // Start microphone capture
      await startMicrophoneAudio(newSessionId);

      // Start system audio capture (screen share)
      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false }
        });
        displayStream.getVideoTracks().forEach(t => t.stop());
        displayStreamRef.current = displayStream;

        if (displayStream.getAudioTracks().length > 0) {
          setAudioSources(prev => [...prev, "system"]);
          startSystemAudio(newSessionId, displayStream);
          displayStream.getAudioTracks()[0].onended = () => {
            setAudioSources(prev => prev.filter(s => s !== "system"));
            if (systemMediaRecorderRef.current?.state === "recording")
              systemMediaRecorderRef.current.stop();
            displayStreamRef.current = null;
          };
        } else {
          displayStream.getTracks().forEach(t => t.stop());
          setErrorMsg("Tip: tick 'Share tab audio' in screen share dialog.");
        }
      } catch (err) {
        console.log("Screen share cancelled or failed");
      }
    } catch (err) {
      console.error(err);
      setErrorMsg("Failed to start. Check server.");
      isRunningRef.current = false;
      setIsRunning(false);
    }
  };

  // --------------------------------
  // STOP SESSION
  // --------------------------------
  const stopSession = () => {
    isRunningRef.current = false;
    sessionIdRef.current = "";

    if (micMediaRecorderRef.current?.state === "recording") {
      micMediaRecorderRef.current.stop();
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }

    if (systemMediaRecorderRef.current?.state === "recording") {
      systemMediaRecorderRef.current.stop();
    }
    if (displayStreamRef.current) {
      displayStreamRef.current.getTracks().forEach(t => t.stop());
      displayStreamRef.current = null;
    }

    setIsRunning(false);
    setAudioSources([]);
  };

  // --------------------------------
  // LOAD SESSIONS
  // --------------------------------
  useEffect(() => {
    const interval = setInterval(async () => {
      try { const res = await axios.get(`${API}/transcripts`); setSessions(res.data); } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const loadSession = async (sid) => {
    if (!sid) return;
    try {
      setSelectedSession(sid);
      const res = await axios.get(`${API}/transcript/${sid}`);
      const parsed = res.data.text
        .split("\n")
        .filter(l => l.trim())
        .map(l => {
          if (l.startsWith("[MIC] ")) return { source: "mic", text: l.replace("[MIC] ", "") };
          if (l.startsWith("[SYSTEM] ")) return { source: "system", text: l.replace("[SYSTEM] ", "") };
          return { source: "mic", text: l };
        });
      setLines(parsed);
    } catch {}
  };

  // Auto-scroll
  useEffect(() => {
    [combinedRef, micRef, sysRef].forEach(r => {
      if (r.current) r.current.scrollTop = r.current.scrollHeight;
    });
  }, [lines]);

  // --------------------------------
  // DOWNLOAD PDF / WORD
  // --------------------------------
  const downloadPDF = async () => {
    let summary = "";
    try {
      const fullText = lines.map(l => l.text).join(" ");
      const res = await axios.post(`${API}/summarise`, { text: fullText });
      summary = res.data.summary;
    } catch(e) { console.warn("Summary failed", e); }
    const report = createReportData(lines, selectedSession);
    report.summary = summary;
    exportPDF(report);
  };

  const downloadWord = async () => {
    let summary = "";
    try {
      const fullText = lines.map(l => l.text).join(" ");
      const res = await axios.post(`${API}/summarise`, { text: fullText });
      summary = res.data.summary;
    } catch(e) { console.warn("Summary failed", e); }
    const report = createReportData(lines, selectedSession);
    report.summary = summary;
    await exportWord(report);
  };

  // --------------------------------
  // RENDER PANELS (tagged and prose)
  // --------------------------------
  const renderTagged = (filterFn, ref) => (
    <div className="transcript-scroll" ref={ref}>
      {lines.filter(filterFn).map((l, i) => (
        <div key={i} className={`transcript-line ${l.source}`}>
          <span className={`tag tag-${l.source}`}>{l.source === "mic" ? "🎤 MIC" : "🖥 SYS"}</span>
          <span className="line-text">{l.text}</span>
        </div>
      ))}
      {lines.filter(filterFn).length === 0 && (
        <p className="empty-hint">Transcript will appear here...</p>
      )}
    </div>
  );

  const renderProse = (ref) => {
    if (lines.length === 0) return (
      <div className="transcript-scroll" ref={ref}>
        <p className="empty-hint">All transcript will appear here as flowing text...</p>
      </div>
    );

    const groups = [];
    lines.forEach((l) => {
      if (l.source === "mic") {
        groups.push({ type: "mic", text: l.text });
      } else {
        const last = groups[groups.length - 1];
        if (last && last.type === "system") {
          last.text += " " + l.text;
        } else {
          groups.push({ type: "system", text: l.text });
        }
      }
    });

    return (
      <div className="transcript-scroll prose-scroll" ref={ref}>
        {groups.map((g, i) =>
          g.type === "system"
            ? <span key={i} className="prose-sys-text">{g.text} </span>
            : <div key={i} className="prose-mic-text">{g.text}</div>
        )}
      </div>
    );
  };

  // --------------------------------
  // UI
  // --------------------------------
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
          <button onClick={downloadPDF} className="main-btn">
            <Download size={18} /> PDF
          </button>
          <button onClick={downloadWord} className="main-btn">
            <Download size={18} /> Word
          </button>
        </div>
        <div className="right-controls">
          {!isRunning && (
            <select value={selectedSession} onChange={(e) => loadSession(e.target.value)} className="dropdown">
              <option value="">Previous Sessions</option>
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          )}
        </div>
      </div>

      {errorMsg && <div className="error-msg">⚠️ {errorMsg}</div>}

      <div className="status">
        <div className={isRunning ? "status-dot active" : "status-dot"} />
        <span>{isRunning ? "Translation Running" : "Translation Stopped"}</span>
        <div className={audioSources.includes("mic") ? "audio-dot active" : "audio-dot"} />
        <Mic size={14} style={{ opacity: audioSources.includes("mic") ? 1 : 0.4 }} />
        <span style={{ opacity: audioSources.includes("mic") ? 1 : 0.4 }}>Mic</span>
        <div className={audioSources.includes("system") ? "audio-dot system active-system" : "audio-dot system"} />
        <Monitor size={14} style={{ opacity: audioSources.includes("system") ? 1 : 0.4 }} />
        <span style={{ opacity: audioSources.includes("system") ? 1 : 0.4 }}>System</span>
      </div>

      <div className="panels">
        <div className="panel">
          <div className="panel-header combined-header">📋 All</div>
          {renderProse(combinedRef)}
        </div>
        <div className="panel">
          <div className="panel-header mic-header"><Mic size={14} /> Microphone</div>
          {renderTagged(l => l.source === "mic", micRef)}
        </div>
        <div className="panel">
          <div className="panel-header sys-header"><Monitor size={14} /> System Audio</div>
          {renderTagged(l => l.source === "system", sysRef)}
        </div>
      </div>
    </div>
  );
}

export default App;