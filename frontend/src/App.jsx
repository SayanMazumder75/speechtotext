import { useEffect, useRef, useState, useCallback } from "react";
import axios from "axios";
import jsPDF from "jspdf";
import { saveAs } from "file-saver";
import { Document, Packer, Paragraph } from "docx";
import { Moon, Sun, Play, Square, Download, Mic, Monitor, Zap } from "lucide-react";
import "./index.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// ─── Summarise a batch of system sentences via Claude ───────────────────────
async function summariseWithClaude(sentences) {
  if (!sentences.length) return null;
  const joined = sentences.join(" ");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: `Summarise the following transcribed system audio into ONE concise sentence that captures the key idea. Return ONLY the summary sentence, nothing else.\n\n"${joined}"`
          }
        ]
      })
    });
    const data = await res.json();
    return data?.content?.[0]?.text?.trim() || joined;
  } catch {
    return joined;
  }
}

// ─── Block types in the smart transcript ────────────────────────────────────
// { type: "mic",    text: string }
// { type: "system", text: string, summarising: boolean }

function App() {
  const [darkMode, setDarkMode]           = useState(true);
  const [isRunning, setIsRunning]         = useState(false);
  const [sessions, setSessions]           = useState([]);
  const [selectedSession, setSelectedSession] = useState("");
  const [sessionId, setSessionId]         = useState("");
  const [audioSources, setAudioSources]   = useState([]);
  const [errorMsg, setErrorMsg]           = useState("");

  // RIGHT PANEL — raw tagged feed
  const [taggedEntries, setTaggedEntries] = useState([]);

  // LEFT PANEL — smart transcript blocks
  const [smartBlocks, setSmartBlocks]     = useState([]);

  // Buffer of pending system sentences waiting to be summarised
  const systemBufferRef   = useRef([]);
  // Timer: flush system buffer after N ms of silence
  const flushTimerRef     = useRef(null);
  // Whether we're currently summarising (to show spinner)
  const summarisingRef    = useRef(false);

  const smartListRef      = useRef(null);
  const taggedListRef     = useRef(null);
  const sessionIdRef      = useRef("");
  const isRunningRef      = useRef(false);
  const recognitionRef    = useRef(null);
  const displayStreamRef  = useRef(null);
  const mediaRecorderRef  = useRef(null);
  const audioChunksRef    = useRef([]);

  // ── FLUSH: summarise buffered system audio and push as a block ─────────────
  const flushSystemBuffer = useCallback(async () => {
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    if (!systemBufferRef.current.length || summarisingRef.current) return;

    const sentences = [...systemBufferRef.current];
    systemBufferRef.current = [];
    summarisingRef.current = true;

    // Add placeholder block while summarising
    setSmartBlocks(prev => [...prev, { type: "system", text: "", summarising: true, id: Date.now() }]);

    const summary = await summariseWithClaude(sentences);
    summarisingRef.current = false;

    // Replace placeholder with final summary
    setSmartBlocks(prev => {
      const updated = [...prev];
      // find last summarising block
      const idx = [...updated].reverse().findIndex(b => b.summarising);
      if (idx !== -1) {
        updated[updated.length - 1 - idx] = { type: "system", text: summary, summarising: false, id: Date.now() };
      }
      return updated;
    });
  }, []);

  // Schedule a flush after 4 s of no new system audio
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(flushSystemBuffer, 4000);
  }, [flushSystemBuffer]);

  // ── ADD SYSTEM SENTENCE ─────────────────────────────────────────────────────
  const addSystemSentence = useCallback((text) => {
    systemBufferRef.current.push(text);
    scheduleFlush();
  }, [scheduleFlush]);

  // ── ADD MIC ENTRY (triggers immediate flush of pending system buffer) ───────
  const addMicEntry = useCallback(async (text) => {
    // Flush any pending system audio first
    if (systemBufferRef.current.length) {
      await flushSystemBuffer();
    }
    setSmartBlocks(prev => [...prev, { type: "mic", text, id: Date.now() }]);
  }, [flushSystemBuffer]);

  // ── TRANSLATE ───────────────────────────────────────────────────────────────
  const translateToEnglish = async (txt) => {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(txt)}`;
      const res = await axios.get(url);
      return res.data[0].map(chunk => chunk[0]).join(" ").trim();
    } catch { return txt; }
  };

  // ── PUSH TEXT (mic) ─────────────────────────────────────────────────────────
  const pushText = async (txt, sid) => {
    if (!txt || !sid) return;
    const english = await translateToEnglish(txt);
    setTaggedEntries(prev => [...prev, { source: "mic", text: english }]);
    addMicEntry(english);
    try { await axios.post(`${API}/push`, { session_id: sid, text: english }); } catch {}
  };

  // ── SEND AUDIO CHUNK TO WHISPER (system) ────────────────────────────────────
  const sendAudioChunk = async (blob, sid) => {
    if (!blob || blob.size < 1000 || !sid) return;
    try {
      const formData = new FormData();
      formData.append("audio", blob, "audio.webm");
      formData.append("session_id", sid);
      const res = await axios.post(`${API}/transcribe`, formData, {
        headers: { "Content-Type": "multipart/form-data" }
      });
      const transcribed = res.data?.text;
      if (transcribed) {
        setTaggedEntries(prev => [...prev, { source: "system", text: transcribed }]);
        addSystemSentence(transcribed);
      }
    } catch {}
  };

  // ── MIC RECOGNITION LOOP ───────────────────────────────────────────────────
  const createAndStartRecognition = (sid) => {
    if (!isRunningRef.current || sessionIdRef.current !== sid) return;
    if (!SpeechRecognition) return;
    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "hi-IN";
    rec.onresult = (e) => {
      const transcript = Array.from(e.results).filter(r => r.isFinal).map(r => r[0].transcript).join(" ");
      if (transcript) pushText(transcript, sid);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed") { setErrorMsg("Mic permission denied."); stopSession(); }
    };
    rec.onend = () => {
      if (isRunningRef.current && sessionIdRef.current === sid) setTimeout(() => createAndStartRecognition(sid), 200);
    };
    try { rec.start(); recognitionRef.current = rec; } catch { setTimeout(() => createAndStartRecognition(sid), 500); }
  };

  // ── SYSTEM AUDIO via MediaRecorder ─────────────────────────────────────────
  const startSystemAudio = (sid, displayStream) => {
    if (!displayStream || displayStream.getAudioTracks().length === 0) return;
    audioChunksRef.current = [];
    const audioStream = new MediaStream(displayStream.getAudioTracks());
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const recorder = new MediaRecorder(audioStream, { mimeType });
    recorder.ondataavailable = (e) => { if (e.data?.size > 0) audioChunksRef.current.push(e.data); };
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

  // ── START SESSION ───────────────────────────────────────────────────────────
  const startSession = async () => {
    if (!SpeechRecognition) { setErrorMsg("Use Chrome on desktop."); return; }
    setErrorMsg("");
    setTaggedEntries([]);
    setSmartBlocks([]);
    systemBufferRef.current = [];
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }

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
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false } });
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
      } catch {}
    } catch {
      setErrorMsg("Failed to start. Check server.");
      isRunningRef.current = false;
      setIsRunning(false);
    }
  };

  // ── STOP SESSION ────────────────────────────────────────────────────────────
  const stopSession = () => {
    isRunningRef.current = false;
    sessionIdRef.current = "";
    if (recognitionRef.current) { try { recognitionRef.current.abort(); } catch {} recognitionRef.current = null; }
    if (mediaRecorderRef.current?.state === "recording") { try { mediaRecorderRef.current.stop(); } catch {} mediaRecorderRef.current = null; }
    if (displayStreamRef.current) { displayStreamRef.current.getTracks().forEach(t => t.stop()); displayStreamRef.current = null; }
    // Final flush
    if (systemBufferRef.current.length) flushSystemBuffer();
    setIsRunning(false);
    setAudioSources([]);
  };

  // ── SESSIONS LIST ──────────────────────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(async () => {
      try { const res = await axios.get(`${API}/transcripts`); setSessions(res.data); } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // ── LOAD OLD SESSION ───────────────────────────────────────────────────────
  const loadSession = async (sid) => {
    if (!sid) return;
    setSelectedSession(sid);
    setTaggedEntries([]);
    setSmartBlocks([]);
    try {
      const res = await axios.get(`${API}/transcript/${sid}`);
      const lines = res.data.text.split("\n").filter(Boolean);
      // Show old sessions as plain system blocks (no source tag available)
      setSmartBlocks(lines.map((t, i) => ({ type: "system", text: t, id: i })));
    } catch {}
  };

  // ── DOWNLOAD HELPERS ───────────────────────────────────────────────────────
  const getSmartText = () => {

  const paragraphs = [];

  let currentSystem = [];

  smartBlocks.forEach((block) => {

    if (block.type === "mic") {

      if (currentSystem.length) {

        paragraphs.push(
          currentSystem.join(" ")
        );

        currentSystem = [];
      }

      paragraphs.push(
        block.text
      );

    } else {

      if (
        !block.summarising &&
        block.text
      ) {

        currentSystem.push(
          block.text
        );
      }
    }
  });

  if (currentSystem.length) {

    paragraphs.push(
      currentSystem.join(" ")
    );
  }

  return paragraphs.join("\n\n");
};

  const downloadPDF = () => {

  const doc = new jsPDF();

  const text =
    getSmartText();

  const lines =
    doc.splitTextToSize(
      text,
      170
    );

  doc.setFont(
    "helvetica",
    "normal"
  );

  doc.setFontSize(12);

  doc.text(
    lines,
    15,
    20
  );

  doc.save(
    "Smart_Transcript.pdf"
  );
};

  const downloadWord =
  async () => {

    const doc =
      new Document({

        sections: [
          {
            children:
              getSmartText()
                .split("\n\n")
                .map(
                  txt =>
                    new Paragraph(
                      txt
                    )
                )
          }
        ]
      });

    const blob =
      await Packer.toBlob(
        doc
      );

    saveAs(
      blob,
      "Smart_Transcript.docx"
    );
};

  // ── AUTO SCROLL ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (smartListRef.current) smartListRef.current.scrollTop = smartListRef.current.scrollHeight;
  }, [smartBlocks]);

  useEffect(() => {
    if (taggedListRef.current) taggedListRef.current.scrollTop = taggedListRef.current.scrollHeight;
  }, [taggedEntries]);

  // ── RENDER ─────────────────────────────────────────────────────────────────
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
            <select value={selectedSession} onChange={(e) => loadSession(e.target.value)} className="dropdown">
              <option value="">Previous Sessions</option>
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          )}
        </div>
      </div>

      {errorMsg && <div className="error-msg">⚠️ {errorMsg}</div>}

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

      {/* SPLIT PANELS */}
      <div className="panels">

        {/* LEFT — Smart Transcript (clean prose) */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Smart Transcript</span>
            <span className="panel-badge combined" style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <Zap size={11} /> AI Summary
            </span>
          </div>
          <div className="transcript-container">
            <div className="smart-prose-container" ref={smartListRef}>
              {smartBlocks.length === 0 && (
                <p className="tagged-placeholder">
                  System audio will be summarised into flowing sentences.<br />
                  Mic interruptions appear on a new line.
                </p>
              )}

              {/* Render: group consecutive system blocks inline, mic = new paragraph */}
              {(() => {
                // Build display paragraphs from smartBlocks
                // Each "paragraph" is an array of blocks that share a visual line
                // A mic block always starts its own paragraph
                const paragraphs = [];
                let currentGroup = [];

                smartBlocks.forEach((block, i) => {
                  if (block.type === "mic") {
                    if (currentGroup.length) { paragraphs.push({ type: "system", blocks: currentGroup }); currentGroup = []; }
                    paragraphs.push({ type: "mic", blocks: [block] });
                  } else {
                    currentGroup.push(block);
                  }
                });
                if (currentGroup.length) paragraphs.push({ type: "system", blocks: currentGroup });

                return paragraphs.map((para, pi) => {
                  if (para.type === "mic") {
                    const block = para.blocks[0];
                    return (
                      <p key={block.id ?? pi} className="prose-mic">
                        {block.text}
                      </p>
                    );
                  }
                  // system group — render as one prose paragraph
                  // summarising blocks show a pulse inline
                  return (
                    <p key={pi} className="prose-system">
                      {para.blocks.map((block, bi) => (
                        <span key={block.id ?? bi}>
                          {block.summarising
                            ? <span className="prose-summarising"><span className="dot-pulse" /> summarising…</span>
                            : <span>{block.text}{bi < para.blocks.length - 1 ? " " : ""}</span>
                          }
                        </span>
                      ))}
                    </p>
                  );
                });
              })()}
            </div>
          </div>
        </div>

        {/* RIGHT — Raw live feed */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Live Feed</span>
            <span className="panel-badge live">{isRunning ? "● Live" : "Paused"}</span>
          </div>
          <div className="transcript-container tagged-container">
            <div className="tagged-list" ref={taggedListRef}>
              {taggedEntries.length === 0 && (
                <p className="tagged-placeholder">Tagged entries will appear here when running…</p>
              )}
              {taggedEntries.map((entry, i) => (
                <div key={i} className={`tagged-entry entry-${entry.source}`}>
                  <span className={`source-badge badge-${entry.source}`}>
                    {entry.source === "mic" ? <><Mic size={11} /> mic</> : <><Monitor size={11} /> system</>}
                  </span>
                  <span className="entry-text">{entry.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

export default App;