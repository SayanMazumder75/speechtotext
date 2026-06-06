import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { Moon, Sun, Play, Square, Download, Mic, Monitor } from "lucide-react";
import "./index.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

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

  // Mic — Web Speech API
  const recognitionRef = useRef(null);

  // System — MediaRecorder
  const systemMediaRecorderRef = useRef(null);
  const systemChunksRef = useRef([]);
  const displayStreamRef = useRef(null);

  // --------------------------------
  // SEND SYSTEM AUDIO CHUNK → Whisper
  // --------------------------------
  const sendAudioChunk = async (blob, sid) => {
    if (!blob || blob.size < 1000 || !sid) return;
    try {
      const formData = new FormData();
      formData.append("audio", blob, "audio.webm");
      formData.append("session_id", sid);
      formData.append("source", "system");
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
  // MIC — Web Speech API (instant response)
  // --------------------------------
  const startMicRecognition = (sid) => {
    if (!SpeechRecognition) {
      setErrorMsg("Use Chrome — Web Speech API not supported.");
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "hi-IN";

    rec.onresult = async (e) => {
      const transcript = Array.from(e.results)
        .filter(r => r.isFinal)
        .map(r => r[0].transcript)
        .join(" ").trim();

      if (!transcript) return;
      console.log("[mic]", transcript);

      // Translate
      let english = transcript;
      try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(transcript)}`;
        const res = await fetch(url);
        const data = await res.json();
        english = data[0].map(c => c[0]).join(" ").trim();
      } catch {}

      setLines(prev => [...prev, { source: "mic", text: english }]);

      // Save to server
      try {
        await axios.post(`${API}/push`, {
          session_id: sid,
          text: `[MIC] ${english}`
        });
      } catch {}
    };

    rec.onerror = (e) => {
      if (e.error === "not-allowed") {
        setErrorMsg("Mic permission denied.");
        stopSession();
      }
      // other errors — onend restarts
    };

    rec.onend = () => {
      if (isRunningRef.current && sessionIdRef.current === sid) {
        setTimeout(() => startMicRecognition(sid), 200);
      }
    };

    try { rec.start(); recognitionRef.current = rec; }
    catch { setTimeout(() => startMicRecognition(sid), 500); }
  };

  // --------------------------------
  // SYSTEM AUDIO — MediaRecorder
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
        await sendAudioChunk(blob, sid);
      }
      if (isRunningRef.current && sessionIdRef.current === sid && displayStream.active) {
        systemChunksRef.current = [];
        recorder.start();
        setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 5000);
      }
    };

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

      // Start mic via Web Speech API
      startMicRecognition(newSessionId);

      // Try system audio
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
            if (systemMediaRecorderRef.current?.state === "recording")
              systemMediaRecorderRef.current.stop();
            displayStreamRef.current = null;
          };
        } else {
          displayStream.getTracks().forEach(t => t.stop());
          setErrorMsg("Tip: tick 'Share tab audio' in screen share dialog.");
        }
      } catch { /* cancelled — mic still works */ }

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

    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch {}
      recognitionRef.current = null;
    }

    if (systemMediaRecorderRef.current?.state === "recording") {
      try { systemMediaRecorderRef.current.stop(); } catch {}
      systemMediaRecorderRef.current = null;
    }

    if (displayStreamRef.current) {
      displayStreamRef.current.getTracks().forEach(t => t.stop());
      displayStreamRef.current = null;
    }

    setIsRunning(false);
    setAudioSources([]);
  };

  // --------------------------------
  // SESSIONS LIST
  // --------------------------------
  useEffect(() => {
    const interval = setInterval(async () => {
      try { const res = await axios.get(`${API}/transcripts`); setSessions(res.data); } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // --------------------------------
  // LOAD OLD SESSION
  // --------------------------------
  const loadSession = async (sid) => {
    if (!sid) return;
    try {
      setSelectedSession(sid);
      const res = await axios.get(`${API}/transcript/${sid}`);
      const parsed = res.data.text.split("\n").filter(l => l.trim()).map(l => {
        if (l.startsWith("[MIC] ")) return { source: "mic", text: l.replace("[MIC] ", "") };
        if (l.startsWith("[SYSTEM] ")) return { source: "system", text: l.replace("[SYSTEM] ", "") };
        return { source: "system", text: l };
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
  // DOWNLOAD
  // --------------------------------
  const downloadPDF = async () => {
    const { default: jsPDF } = await import("jspdf");
    const doc = new jsPDF();
    const text = lines.map(l => `[${l.source.toUpperCase()}] ${l.text}`).join("\n");
    const split = doc.splitTextToSize(text, 170);
    doc.text(split, 15, 20);
    doc.save("transcript.pdf");
  };

  const downloadWord = async () => {
    const { Document, Packer, Paragraph } = await import("docx");
    const { saveAs } = await import("file-saver");
    const doc = new Document({
      sections: [{ children: lines.map(l => new Paragraph(`[${l.source.toUpperCase()}] ${l.text}`)) }]
    });
    const blob = await Packer.toBlob(doc);
    saveAs(blob, "transcript.docx");
  };

  // --------------------------------
  // PANELS
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
        <p className="empty-hint">All transcript appears here as flowing text...</p>
      </div>
    );

    const groups = [];
    lines.forEach(l => {
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
              {sessions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
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