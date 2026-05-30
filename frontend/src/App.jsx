import { useEffect, useRef, useState } from "react";
import axios from "axios";
import jsPDF from "jspdf";
import { saveAs } from "file-saver";
import { Document, Packer, Paragraph } from "docx";
import { Moon, Sun, Play, Square, Download, Mic, Monitor } from "lucide-react";
import "./index.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

// --------------------------------
// Web Speech Recognition setup
// --------------------------------
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

function App() {
  const [text, setText] = useState("");
  const [darkMode, setDarkMode] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [status, setStatus] = useState("idle"); // idle | running | error
  const [audioSources, setAudioSources] = useState([]); // ["mic","system"]

  const textareaRef = useRef(null);
  const recognitionMicRef = useRef(null);
  const recognitionSysRef = useRef(null);
  const sessionIdRef = useRef("");

  // --------------------------------
  // START SESSION
  // --------------------------------
  const startSession = async () => {
    if (!SpeechRecognition) {
      alert("Your browser does not support Web Speech API. Use Chrome.");
      return;
    }

    try {
      const res = await axios.post(`${API}/start-session`);
      const newSessionId = res.data.session_id;
      setSessionId(newSessionId);
      sessionIdRef.current = newSessionId;
      setSelectedSession(newSessionId);
      setText("");
      setIsRunning(true);
      setStatus("running");

      // Start both audio sources
      startMicRecognition(newSessionId);
      startSystemRecognition(newSessionId);

    } catch (err) {
      console.error(err);
      setStatus("error");
    }
  };

  // --------------------------------
  // PUSH TEXT TO SERVER
  // --------------------------------
  const pushText = async (text, sid) => {
    if (!text || !sid) return;
    try {
      await axios.post(`${API}/push`, {
        session_id: sid,
        text
      });
    } catch (err) {
      console.error("Push error:", err);
    }
  };

  // --------------------------------
  // MIC RECOGNITION
  // --------------------------------
  const startMicRecognition = (sid) => {
    if (!SpeechRecognition) return;

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "hi-IN"; // auto-detects Hindi/Bengali/English

    rec.onresult = (e) => {
      const transcript = Array.from(e.results)
        .filter(r => r.isFinal)
        .map(r => r[0].transcript)
        .join(" ");

      if (transcript) {
        pushText(`[Mic] ${transcript}`, sid);
      }
    };

    rec.onerror = (e) => console.error("Mic recognition error:", e.error);

    rec.onend = () => {
      // Auto restart if still running
      if (sessionIdRef.current === sid) {
        rec.start();
      }
    };

    rec.start();
    recognitionMicRef.current = rec;
    setAudioSources(prev => [...new Set([...prev, "mic"])]);
  };

  // --------------------------------
  // SYSTEM / TAB AUDIO RECOGNITION
  // --------------------------------
  const startSystemRecognition = async (sid) => {
    try {
      // Ask user to share screen/tab — this gives system audio
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true, // required by browser even if we don't use video
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: 44100
        }
      });

      // Check if audio track exists
      const audioTracks = displayStream.getAudioTracks();
      if (audioTracks.length === 0) {
        console.warn("No system audio track. User may not have checked 'Share audio'.");
        // Stop video track we don't need
        displayStream.getVideoTracks().forEach(t => t.stop());
        return;
      }

      // Stop video — only need audio
      displayStream.getVideoTracks().forEach(t => t.stop());

      // Pipe system audio into Web Speech via AudioContext
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(displayStream);
      const dest = audioCtx.createMediaStreamDestination();
      source.connect(dest);

      const rec = new SpeechRecognition();
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = "hi-IN";

      // Attach the processed stream
      rec.onresult = (e) => {
        const transcript = Array.from(e.results)
          .filter(r => r.isFinal)
          .map(r => r[0].transcript)
          .join(" ");

        if (transcript) {
          pushText(`[System] ${transcript}`, sid);
        }
      };

      rec.onerror = (e) => console.error("System recognition error:", e.error);

      rec.onend = () => {
        if (sessionIdRef.current === sid) {
          rec.start();
        }
      };

      rec.start();
      recognitionSysRef.current = rec;
      setAudioSources(prev => [...new Set([...prev, "system"])]);

      // If user stops screen share, stop recognition
      displayStream.getAudioTracks()[0].onended = () => {
        rec.stop();
        setAudioSources(prev => prev.filter(s => s !== "system"));
      };

    } catch (err) {
      console.warn("System audio not available:", err.message);
      // Not fatal — mic still works
    }
  };

  // --------------------------------
  // STOP SESSION
  // --------------------------------
  const stopSession = () => {
    sessionIdRef.current = "";

    if (recognitionMicRef.current) {
      recognitionMicRef.current.stop();
      recognitionMicRef.current = null;
    }

    if (recognitionSysRef.current) {
      recognitionSysRef.current.stop();
      recognitionSysRef.current = null;
    }

    setIsRunning(false);
    setStatus("idle");
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
  // LIVE FETCH CURRENT SESSION TEXT
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

  // --------------------------------
  // PDF
  // --------------------------------
  const downloadPDF = () => {
    const doc = new jsPDF();
    doc.text(text, 10, 10);
    doc.save("translation.pdf");
  };

  // --------------------------------
  // WORD
  // --------------------------------
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

      {/* HEADER */}
      <div className="header">
        <div>
          <h1>AI Live Translator</h1>
          <p className="subtitle">Real-time multilingual subtitle system</p>
        </div>
        <button onClick={() => setDarkMode(!darkMode)} className="theme-btn">
          {darkMode ? <Sun size={20} /> : <Moon size={20} />}
        </button>
      </div>

      {/* CONTROLS */}
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

      {/* STATUS */}
      <div className="status">

        <div className={isRunning ? "status-dot active" : "status-dot"} />
        <span>{isRunning ? "Translation Running" : "Translation Stopped"}</span>

        {/* Mic indicator */}
        <div className={audioSources.includes("mic") ? "audio-dot active" : "audio-dot"} />
        <Mic size={14} style={{ opacity: audioSources.includes("mic") ? 1 : 0.4 }} />
        <span style={{ opacity: audioSources.includes("mic") ? 1 : 0.4 }}>Mic</span>

        {/* System audio indicator */}
        <div className={audioSources.includes("system") ? "audio-dot system active-system" : "audio-dot system"} />
        <Monitor size={14} style={{ opacity: audioSources.includes("system") ? 1 : 0.4 }} />
        <span style={{ opacity: audioSources.includes("system") ? 1 : 0.4 }}>System</span>

      </div>

      {/* TRANSCRIPT */}
      <div className="transcript-container">
        <textarea
          ref={textareaRef}
          value={text}
          readOnly
          rows={22}
          placeholder="Click Start → allow mic → share screen with audio to begin..."
          className="transcript-box"
        />
      </div>

    </div>
  );
}

export default App;