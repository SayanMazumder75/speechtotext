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
  // TRANSLATE via Google free API
  // --------------------------------
  const translateToEnglish = async (txt) => {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(txt)}`;
      const res = await axios.get(url);
      const translated = res.data[0]
        .map(chunk => chunk[0])
        .join(" ")
        .trim();
      return translated;
    } catch (err) {
      console.error("Translation error:", err);
      return txt; // fallback: return original
    }
  };

  // --------------------------------
  // PUSH TEXT (translate first then push)
  // --------------------------------
  const pushText = async (txt, sid) => {
    if (!txt || !sid) return;
    try {
      const english = await translateToEnglish(txt);
      await axios.post(`${API}/push`, { session_id: sid, text: english });
    } catch (err) {
      console.error("Push error:", err);
    }
  };

  // --------------------------------
  // RECOGNITION FACTORY
  // label = "mic" or "system" for logging
  // onEndCallback = what to do on end
  // --------------------------------
  const makeRecognition = (sid, label, onEndCallback) => {
    if (!SpeechRecognition) return null;

    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "hi-IN";

    rec.onresult = (e) => {
      const transcript = Array.from(e.results)
        .filter(r => r.isFinal)
        .map(r => r[0].transcript)
        .join(" ");
      if (transcript) {
        console.log(`[${label}] ${transcript}`);
        pushText(transcript, sid);
      }
    };

    rec.onerror = (e) => {
      if (e.error === "not-allowed") {
        setErrorMsg("Mic permission denied. Allow mic in browser settings.");
        stopSession();
      }
      // other errors — onend will handle restart
    };

    rec.onend = () => {
      if (isRunningRef.current && sessionIdRef.current === sid) {
        setTimeout(onEndCallback, 200);
      }
    };

    return rec;
  };

  // --------------------------------
  // MIC RECOGNITION LOOP
  // --------------------------------
  const createAndStartRecognition = (sid) => {
    if (!isRunningRef.current || sessionIdRef.current !== sid) return;

    const rec = makeRecognition(sid, "mic", () => createAndStartRecognition(sid));
    if (!rec) return;

    try {
      rec.start();
      recognitionRef.current = rec;
    } catch (e) {
      setTimeout(() => createAndStartRecognition(sid), 500);
    }
  };

  // --------------------------------
  // SYSTEM AUDIO RECOGNITION LOOP
  // Uses AudioContext to pipe display
  // stream into a new MediaStream that
  // SpeechRecognition can consume
  // --------------------------------
  const sysRecognitionRef = useRef(null);
  const audioCtxRef = useRef(null);

  const createAndStartSysRecognition = (sid, displayStream) => {
    if (!isRunningRef.current || sessionIdRef.current !== sid) return;
    if (!SpeechRecognition) return;

    try {
      // Build audio pipeline: displayStream → AudioContext → dest → SpeechRecognition
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(displayStream);
      const dest = audioCtx.createMediaStreamDestination();
      source.connect(dest);

      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = "hi-IN";

      rec.onresult = (e) => {
        const transcript = Array.from(e.results)
          .filter(r => r.isFinal)
          .map(r => r[0].transcript)
          .join(" ");
        if (transcript) {
          console.log(`[system] ${transcript}`);
          pushText(transcript, sid);
        }
      };

      rec.onerror = (e) => {
        // system audio errors — just restart
        console.log("System rec error:", e.error);
      };

      rec.onend = () => {
        if (
          isRunningRef.current &&
          sessionIdRef.current === sid &&
          displayStream.active
        ) {
          setTimeout(() => createAndStartSysRecognition(sid, displayStream), 200);
        }
      };

      rec.start();
      sysRecognitionRef.current = rec;

    } catch (e) {
      console.error("System recognition setup failed:", e);
    }
  };

  // --------------------------------
  // START SESSION
  // --------------------------------
  const startSession = async () => {
    if (!SpeechRecognition) {
      setErrorMsg("Use Chrome on desktop. Web Speech API not supported here.");
      return;
    }

    setErrorMsg("");

    try {
      const res = await axios.post(`${API}/start-session`);
      const newSessionId = res.data.session_id;

      sessionIdRef.current = newSessionId;
      isRunningRef.current = true;

      setSessionId(newSessionId);
      setSelectedSession(newSessionId);
      setText("");
      setIsRunning(true);
      setAudioSources(["mic"]);

      // Start fresh recognition
      createAndStartRecognition(newSessionId);

      // Try system audio (optional)
      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,  // must be true for Chrome to allow audio
          audio: { echoCancellation: false, noiseSuppression: false }
        });

        // Stop video track immediately — only need audio
        displayStream.getVideoTracks().forEach(t => t.stop());

        displayStreamRef.current = displayStream;

        if (displayStream.getAudioTracks().length > 0) {
          setAudioSources(["mic", "system"]);

          // START system audio recognition
          createAndStartSysRecognition(newSessionId, displayStream);

          displayStream.getAudioTracks()[0].onended = () => {
            setAudioSources(prev => prev.filter(s => s !== "system"));
            displayStreamRef.current = null;
            // Stop system recognition cleanly
            if (sysRecognitionRef.current) {
              try { sysRecognitionRef.current.abort(); } catch(e) {}
              sysRecognitionRef.current = null;
            }
            if (audioCtxRef.current) {
              audioCtxRef.current.close();
              audioCtxRef.current = null;
            }
          };
        } else {
          displayStream.getTracks().forEach(t => t.stop());
          setErrorMsg("Tip: tick 'Share audio' when sharing screen for system audio. Mic still active.");
        }
      } catch {
        // User cancelled screen share — mic still works fine
      }

    } catch (err) {
      console.error(err);
      setErrorMsg("Failed to start session. Check server connection.");
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
      try { recognitionRef.current.abort(); } catch (e) {}
      recognitionRef.current = null;
    }

    if (sysRecognitionRef.current) {
      try { sysRecognitionRef.current.abort(); } catch (e) {}
      sysRecognitionRef.current = null;
    }

    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }

    if (displayStreamRef.current) {
      displayStreamRef.current.getTracks().forEach(t => t.stop());
      displayStreamRef.current = null;
    }

    setIsRunning(false);
    setAudioSources([]);
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
    if (!sid) return; // guard empty selection
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

      {errorMsg && (
        <div className="error-msg">⚠️ {errorMsg}</div>
      )}

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