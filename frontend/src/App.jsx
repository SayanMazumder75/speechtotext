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
  const sessionIdRef = useRef("");
  const isRunningRef = useRef(false);

  // Mic recognition refs
  const recognitionRef = useRef(null);

  // System audio refs
  const displayStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  // --------------------------------
  // TRANSLATE via Google free API
  // --------------------------------
  const translateToEnglish = async (txt) => {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(txt)}`;
      const res = await axios.get(url);
      const translated = res.data[0].map(chunk => chunk[0]).join(" ").trim();
      return translated;
    } catch {
      return txt;
    }
  };

  // --------------------------------
  // PUSH TEXT (mic — translate first)
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
  // SEND AUDIO CHUNK TO WHISPER
  // System audio path — no translation
  // needed, Whisper task=translate does it
  // --------------------------------
  const sendAudioChunk = async (blob, sid) => {
    if (!blob || blob.size < 1000 || !sid) return; // skip tiny/empty chunks
    try {
      const formData = new FormData();
      formData.append("audio", blob, "audio.webm");
      formData.append("session_id", sid);
      await axios.post(`${API}/transcribe`, formData, {
        headers: { "Content-Type": "multipart/form-data" }
      });
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
      if (transcript) {
        console.log("[mic]", transcript);
        pushText(transcript, sid);
      }
    };

    rec.onerror = (e) => {
      if (e.error === "not-allowed") {
        setErrorMsg("Mic permission denied.");
        stopSession();
      }
    };

    rec.onend = () => {
      if (isRunningRef.current && sessionIdRef.current === sid) {
        setTimeout(() => createAndStartRecognition(sid), 200);
      }
    };

    try {
      rec.start();
      recognitionRef.current = rec;
    } catch {
      setTimeout(() => createAndStartRecognition(sid), 500);
    }
  };

  // --------------------------------
  // SYSTEM AUDIO via MediaRecorder
  // Sends chunks to Whisper every 5s
  // --------------------------------
  const startSystemAudio = (sid, displayStream) => {
    if (!displayStream || displayStream.getAudioTracks().length === 0) return;

    audioChunksRef.current = [];

    // Use audio-only stream for recording
    const audioStream = new MediaStream(displayStream.getAudioTracks());

    // Pick best supported format
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    const recorder = new MediaRecorder(audioStream, { mimeType });

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        audioChunksRef.current.push(e.data);
      }
    };

    recorder.onstop = async () => {
      if (audioChunksRef.current.length > 0) {
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];
        await sendAudioChunk(blob, sid);
      }

      // Restart if still running
      if (isRunningRef.current && sessionIdRef.current === sid && displayStream.active) {
        audioChunksRef.current = [];
        recorder.start();
        setTimeout(() => {
          if (recorder.state === "recording") recorder.stop();
        }, 5000);
      }
    };

    mediaRecorderRef.current = recorder;
    recorder.start();

    // Stop every 5s to send chunk
    setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, 5000);

    console.log("[system] MediaRecorder started");
  };

  // --------------------------------
  // START SESSION
  // --------------------------------
  const startSession = async () => {
    if (!SpeechRecognition) {
      setErrorMsg("Use Chrome on desktop.");
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

      // Start mic recognition
      createAndStartRecognition(newSessionId);

      // Try system audio
      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false }
        });

        // Stop video immediately — only need audio
        displayStream.getVideoTracks().forEach(t => t.stop());

        displayStreamRef.current = displayStream;

        if (displayStream.getAudioTracks().length > 0) {
          setAudioSources(["mic", "system"]);
          startSystemAudio(newSessionId, displayStream);

          displayStream.getAudioTracks()[0].onended = () => {
            setAudioSources(prev => prev.filter(s => s !== "system"));
            displayStreamRef.current = null;
            if (mediaRecorderRef.current?.state === "recording") {
              mediaRecorderRef.current.stop();
            }
          };
        } else {
          displayStream.getTracks().forEach(t => t.stop());
          setErrorMsg("Tip: tick 'Share tab audio' in screen share dialog.");
        }
      } catch {
        // User cancelled — mic still works
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

    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch {}
      recognitionRef.current = null;
    }

    if (mediaRecorderRef.current?.state === "recording") {
      try { mediaRecorderRef.current.stop(); } catch {}
      mediaRecorderRef.current = null;
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
      } catch {}
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
        } catch {}
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
    if (!sid) return;
    try {
      setSelectedSession(sid);
      const res = await axios.get(`${API}/transcript/${sid}`);
      setText(res.data.text);
    } catch {}
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

      <div className="transcript-container">
        <textarea
          ref={textareaRef}
          value={text}
          readOnly
          rows={22}
          placeholder="Click Start → allow mic → share screen with audio for system capture..."
          className="transcript-box"
        />
      </div>

    </div>
  );
}

export default App;