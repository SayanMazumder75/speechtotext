import { useEffect, useRef, useState } from "react";
import axios from "axios";
import jsPDF from "jspdf";
import { saveAs } from "file-saver";
import { Document, Packer, Paragraph } from "docx";
import { Moon, Sun, Play, Square, Download, Mic, Monitor } from "lucide-react";
import "./index.css";
import {
  createReportData
} from "./utils/transcriptFormatter";

import {
  exportPDF
} from "./utils/exportPdf";

import {
  exportWord
} from "./utils/exportWord";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function App() {
  const [lines, setLines] = useState([]); // { source: "mic"|"system", text: "..." }
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
  const recognitionRef = useRef(null);
  const displayStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  // --------------------------------
  // TRANSLATE
  // --------------------------------
  const translateToEnglish = async (txt) => {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(txt)}`;
      const res = await axios.get(url);
      return res.data[0].map(c => c[0]).join(" ").trim();
    } catch { return txt; }
  };

  // --------------------------------
  // ADD LINE locally + push to server
  // --------------------------------
  const addLine = async (txt, source, sid) => {
    if (!txt || !sid) return;
    const english = source === "mic" ? await translateToEnglish(txt) : txt;
    const tagged = `[${source.toUpperCase()}] ${english}`;

    // Update local UI immediately
    setLines(prev => [...prev, { source, text: english }]);

    // Push to server
    try {
      await axios.post(`${API}/push`, { session_id: sid, text: tagged });
    } catch (err) {
      console.error("Push error:", err);
    }
  };

  // --------------------------------
  // SEND AUDIO CHUNK → Whisper
  // --------------------------------
  const sendAudioChunk = async (blob, sid) => {
    if (!blob || blob.size < 1000 || !sid) return;
    try {
      const formData = new FormData();
      formData.append("audio", blob, "audio.webm");
      formData.append("session_id", sid);
      const res = await axios.post(`${API}/transcribe`, formData, {
        headers: { "Content-Type": "multipart/form-data" }
      });
      if (res.data.text) {
        setLines(prev => [...prev, { source: "system", text: res.data.text }]);
      }
    } catch (err) {
      console.error("Transcribe error:", err);
    }
  };

  // --------------------------------
  // MIC RECOGNITION LOOP
  // --------------------------------
  const createAndStartRecognition = (sid) => {
    if (!isRunningRef.current || sessionIdRef.current !== sid) return;
    if (!SpeechRecognition) return;

    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "hi-IN";

    rec.onresult = (e) => {
      const transcript = Array.from(e.results)
        .filter(r => r.isFinal)
        .map(r => r[0].transcript)
        .join(" ");
      if (transcript) addLine(transcript, "mic", sid);
    };

    rec.onerror = (e) => {
      if (e.error === "not-allowed") { setErrorMsg("Mic permission denied."); stopSession(); }
    };

    rec.onend = () => {
      if (isRunningRef.current && sessionIdRef.current === sid)
        setTimeout(() => createAndStartRecognition(sid), 200);
    };

    try { rec.start(); recognitionRef.current = rec; }
    catch { setTimeout(() => createAndStartRecognition(sid), 500); }
  };

  // --------------------------------
  // SYSTEM AUDIO → MediaRecorder
  // --------------------------------
  const startSystemAudio = (sid, displayStream) => {
    if (!displayStream || displayStream.getAudioTracks().length === 0) return;

    audioChunksRef.current = [];
    const audioStream = new MediaStream(displayStream.getAudioTracks());
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "audio/webm";

    const recorder = new MediaRecorder(audioStream, { mimeType });

    recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) audioChunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      if (audioChunksRef.current.length > 0) {
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];
        await sendAudioChunk(blob, sid);
      }
      if (isRunningRef.current && sessionIdRef.current === sid && displayStream.active) {
        audioChunksRef.current = [];
        recorder.start();
        setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 5000);
      }
    };

    mediaRecorderRef.current = recorder;
    recorder.start();
    setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 5000);
  };

  // --------------------------------
  // START SESSION
  // --------------------------------
  const startSession = async () => {
    if (!SpeechRecognition) { setErrorMsg("Use Chrome on desktop."); return; }
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

      createAndStartRecognition(newSessionId);

      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false }
        });
        displayStream.getVideoTracks().forEach(t => t.stop());
        displayStreamRef.current = displayStream;

        if (displayStream.getAudioTracks().length > 0) {
          setAudioSources(["mic", "system"]);
          startSystemAudio(newSessionId, displayStream);
          displayStream.getAudioTracks()[0].onended = () => {
            setAudioSources(prev => prev.filter(s => s !== "system"));
            displayStreamRef.current = null;
            if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
          };
        } else {
          displayStream.getTracks().forEach(t => t.stop());
          setErrorMsg("Tip: tick 'Share tab audio' in screen share dialog.");
        }
      } catch { /* user cancelled — mic still works */ }

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
    if (recognitionRef.current) { try { recognitionRef.current.abort(); } catch {} recognitionRef.current = null; }
    if (mediaRecorderRef.current?.state === "recording") { try { mediaRecorderRef.current.stop(); } catch {} mediaRecorderRef.current = null; }
    if (displayStreamRef.current) { displayStreamRef.current.getTracks().forEach(t => t.stop()); displayStreamRef.current = null; }
    setIsRunning(false);
    setAudioSources([]);
  };

  // --------------------------------
  // LOAD SESSION LIST
  // --------------------------------
  useEffect(() => {
    const interval = setInterval(async () => {
      try { const res = await axios.get(`${API}/transcripts`); setSessions(res.data); } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // --------------------------------
  // LOAD OLD SESSION TEXT
  // --------------------------------
  const loadSession = async (sid) => {
    if (!sid) return;
    try {
      setSelectedSession(sid);
      const res = await axios.get(`${API}/transcript/${sid}`);
      // Parse tagged lines from stored text
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

  // --------------------------------
  // AUTO SCROLL all panels
  // --------------------------------
  useEffect(() => {
    [combinedRef, micRef, sysRef].forEach(r => {
      if (r.current) r.current.scrollTop = r.current.scrollHeight;
    });
  }, [lines]);

  // --------------------------------
  // DOWNLOAD helpers (updated to include summary)
  // --------------------------------
  const fullText = lines.map(l => `[${l.source.toUpperCase()}] ${l.text}`).join("\n");

  const downloadPDF = async () => {
    let summary = "";
    try {
      const fullTextForSummary = lines.map(l => l.text).join(" ");
      const res = await axios.post(`${API}/summarise`, { text: fullTextForSummary });
      summary = res.data.summary;
    } catch(e) { console.warn("Summary failed", e); }

    const report = createReportData(lines, selectedSession);
    report.summary = summary;
    exportPDF(report);
  };

  const downloadWord = async () => {
    let summary = "";
    try {
      const fullTextForSummary = lines.map(l => l.text).join(" ");
      const res = await axios.post(`${API}/summarise`, { text: fullTextForSummary });
      summary = res.data.summary;
    } catch(e) { console.warn("Summary failed", e); }

    const report = createReportData(lines, selectedSession);
    report.summary = summary;
    await exportWord(report);
  };

  // --------------------------------
  // PANEL RENDERER — tagged (mic/system)
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

  // --------------------------------
  // ALL PANEL — prose view
  // system lines = flowing paragraph
  // mic lines = new line, amber color
  // --------------------------------
  const renderProse = (ref) => {
    if (lines.length === 0) return (
      <div className="transcript-scroll" ref={ref}>
        <p className="empty-hint">All transcript will appear here as flowing text...</p>
      </div>
    );

    // Group consecutive system lines into paragraphs
    const groups = [];
    lines.forEach((l) => {
      if (l.source === "mic") {
        groups.push({ type: "mic", text: l.text });
      } else {
        // append to last system group or create new one
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

      {/* THREE PANELS */}
      <div className="panels">

        {/* COMBINED — prose */}
        <div className="panel">
          <div className="panel-header combined-header">📋 All</div>
          {renderProse(combinedRef)}
        </div>

        {/* MIC ONLY */}
        <div className="panel">
          <div className="panel-header mic-header"><Mic size={14} /> Microphone</div>
          {renderTagged(l => l.source === "mic", micRef)}
        </div>

        {/* SYSTEM ONLY */}
        <div className="panel">
          <div className="panel-header sys-header"><Monitor size={14} /> System Audio</div>
          {renderTagged(l => l.source === "system", sysRef)}
        </div>

      </div>

    </div>
  );
}

export default App;