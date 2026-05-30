import { useEffect, useRef, useState } from "react";
import axios from "axios";
import jsPDF from "jspdf";
import { saveAs } from "file-saver";
import { Document, Packer, Paragraph } from "docx";
import { Moon, Sun, Play, Square, Download, Mic, Monitor } from "lucide-react";
import "./index.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

function App() {
  const [text, setText] = useState("");
  const [darkMode, setDarkMode] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [audioSources, setAudioSources] = useState([]);
  const [errorMsg, setErrorMsg] = useState("");

  const textareaRef = useRef(null);
  const recognitionRef = useRef(null);
  const sessionIdRef = useRef("");
  const isRunningRef = useRef(false);
  const displayStreamRef = useRef(null);

  // --------------------------------
  // PUSH TEXT TO SERVER
  // --------------------------------
  const pushText = async (txt, sid) => {
    if (!txt || !sid) return;
    try {
      await axios.post(`${API}/push`, { session_id: sid, text: txt });
    } catch (err) {
      console.error("Push error:", err);
    }
  };

  // --------------------------------
  // START RECOGNITION
  // Uses mic only, or mixed mic+system
  // --------------------------------
  const startRecognition = (sid, stream) => {
    if (!SpeechRecognition) {
      setErrorMsg("Web Speech API not supported. Use Chrome on desktop.");
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "hi-IN";

    rec.onresult = (e) => {
      const transcript = Array.from(e.results)
        .filter(r => r.isFinal)
        .map(r => r[0].transcript)
        .join(" ");
      if (transcript) {
        pushText(transcript, sid);
      }
    };

    rec.onerror = (e) => {
      // Only log, don't restart on abort — prevents spam
      if (e.error !== "aborted" && e.error !== "no-speech") {
        console.error("Recognition error:", e.error);
        setErrorMsg(`Recognition error: ${e.error}`);
      }
    };

    rec.onend = () => {
      // Restart only if still running
      if (isRunningRef.current && sessionIdRef.current === sid) {
        setTimeout(() => {
          try { rec.start(); } catch(e) {}
        }, 300);
      }
    };

    try {
      rec.start();
      recognitionRef.current = rec;
    } catch(e) {
      console.error("Could not start recognition:", e);
    }
  };

  // --------------------------------
  // START SESSION
  // --------------------------------
  const startSession = async () => {
    if (!SpeechRecognition) {
      setErrorMsg("Use Chrome on desktop for Web Speech API.");
      return;
    }

    setErrorMsg("");

    try {
      const res = await axios.post(`${API}/start-session`);
      const newSessionId = res.data.session_id;

      setSessionId(newSessionId);
      sessionIdRef.current = newSessionId;
      setSelectedSession(newSessionId);
      setText("");
      setIsRunning(true);
      isRunningRef.current = true;

      // Step 1: Always start mic recognition
      setAudioSources(["mic"]);
      startRecognition(newSessionId, null);

      // Step 2: Try to get system audio via screen share
      // This is optional — if user cancels, mic still works
      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: false,  // audio-only request
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
          }
        });

        displayStreamRef.current = displayStream;

        const hasAudio = displayStream.getAudioTracks().length > 0;

        if (hasAudio) {
          setAudioSources(["mic", "system"]);

          // When user stops sharing
          displayStream.getAudioTracks()[0].onended = () => {
            setAudioSources(prev => prev.filter(s => s !== "system"));
            displayStreamRef.current = null;
          };
        } else {
          // No audio track — user didn't tick "Share audio"
          displayStream.getTracks().forEach(t => t.stop());
          setErrorMsg("No system audio captured. Tip: tick 'Share audio' when sharing. Mic still recording.");
        }

      } catch (err) {
        // User cancelled screen share — fine, mic still works
        console.log("Screen share cancelled or not available:", err.message);
      }

    } catch (err) {
      console.error(err);
      setErrorMsg("Failed to start session. Check server.");
      setIsRunning(false);
      isRunningRef.current = false;
    }
  };

  // --------------------------------
  // STOP SESSION
  // --------------------------------
  const stopSession = () => {
    isRunningRef.current = false;
    sessionIdRef.current = "";

    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch(e) {}
      recognitionRef.current = null;
    }

    if (displayStreamRef.current) {
      displayStreamRef.current.getTracks().forEach(t => t.stop());
      displayStreamRef.current = null;
    }

    setIsRunning(false);
    setAudioSources([]);
    setErrorMsg("");
  };

  // --------------------------------
  // LOAD SESSION LIST
  // --------------------------------
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await axios.get(`${API}/transcripts`);
        setSessions(res.data);
      } catch (err) {
        console.error(err);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // --------------------------------
  // LIVE FETCH TEXT
  // --------------------------------
  useEffect(() => {
    let interval;
    if (isRunning && sessionId) {
      interval = setInterval(async () => {
        try {
          const res = await axios.get(`${API}/transcript/${sessionId}`);
          setText(res.data.text);
        } catch (err) {
          console.error(err);
        }
      }, 2000);
    }
    return () => clearInterval(interval);
  }, [isRunning, sessionId]);

  // --------------------------------
  // AUTO SCROLL
  // --------------------------------
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
    }
  }, [text]);

  // --------------------------------
  // LOAD OLD SESSION
  // --------------------------------
  const loadSession = async (sid) => {
    try {
      setSelectedSession(sid);
      const res = await axios.get(`${API}/transcript/${sid}`);
      setText(res.data.text);
    } catch (err) {
      console.error(err);
    }
  };

  const downloadPDF = () => {
    const doc = new jsPDF();
    doc.text(text, 10, 10);
    doc.save("translation.pdf");
  };

  const downloadWord = async () => {
    const doc = new Document({
      sections: [{ properties: {}, children: [new Paragraph(text)] }]
    });
    const blob = await Packer.toBlob(doc);
    saveAs(blob, "translation.docx");
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
            <select
              value={selectedSession}
              onChange={(e) => loadSession(e.target.value)}
              className="dropdown"
            >
              <option value="">Previous Sessions</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* ERROR MESSAGE */}
      {errorMsg && (
        <div className="error-msg">⚠️ {errorMsg}</div>
      )}

      {/* STATUS */}
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

      <div className="transcript-container">
        <textarea
          ref={textareaRef}
          value={text}
          readOnly
          rows={22}
          placeholder="Click Start → allow mic → optionally share screen with audio..."
          className="transcript-box"
        />
      </div>

    </div>
  );
}

export default App;