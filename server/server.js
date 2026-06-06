const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer");
const FormData = require("form-data");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB error:", err));

const sessionSchema = new mongoose.Schema({
  session_id: { type: String, required: true, unique: true },
  text: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.model("Session", sessionSchema);

function formatTimestamp() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// --------------------------------
// GROQ KEY ROTATION
// --------------------------------
const groqApiKeys = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY
].filter(k => k && k.trim());

let currentKeyIndex = 0;
function getNextGroqKey() {
  if (!groqApiKeys.length) throw new Error("No Groq API keys configured");
  const key = groqApiKeys[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % groqApiKeys.length;
  return key;
}

// --------------------------------
// TRANSLATE
// --------------------------------
async function translateToEnglish(text) {
  if (!text) return "";
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data[0].map(c => c[0]).join(" ").trim();
  } catch { return text; }
}

// --------------------------------
// WHISPER
// --------------------------------
async function callGroqWhisper(audioBuffer, mimeType) {
  const maxRetries = groqApiKeys.length;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const apiKey = getNextGroqKey();
    try {
      const formData = new FormData();
      formData.append("file", audioBuffer, {
        filename: "audio.webm",
        contentType: mimeType || "audio/webm",
      });
      formData.append("model", "whisper-large-v3");
      formData.append("response_format", "json");

      const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, ...formData.getHeaders() },
        body: formData,
      });

      if (response.status === 429) { console.warn("Rate limit, trying next key"); continue; }
      if (!response.ok) throw new Error(`Groq ${response.status}`);

      const data = await response.json();
      return data.text?.trim() || "";
    } catch (err) {
      console.error(`Whisper attempt ${attempt+1} failed:`, err.message);
    }
  }
  return "";
}

// --------------------------------
// HALLUCINATION FILTER
// --------------------------------
const HALLUCINATIONS = [
  "thank you", "thanks", "bye", "goodbye",
  "you", "no", "yes", "okay", "ok",
  "hmm", "um", "uh", "ah", "oh",
  ".", "...", " ", "hello",
  "subscribe", "like", "share", "please", "welcome",
  "hello everyone", "i'm going to make a",
  "i'm going to make", "i'm going to",
  "hello everyone, i'm going to make",
  "going to make", "looking at the camera",
  "subtitles by", "translated by", "transcribed by",
  "[music]", "[applause]", "[laughter]", "[ music ]",
  "foreign", "[foreign]",
];

function isHallucination(text) {
  const lower = text.toLowerCase().trim();

  // Exact match
  if (HALLUCINATIONS.some(h => lower === h.toLowerCase())) return true;

  // Partial match on short text (≤6 words)
  const wordCount = text.split(" ").length;
  if (wordCount <= 6 && HALLUCINATIONS.some(h => lower.includes(h.toLowerCase()))) return true;

  // Too short
  if (wordCount <= 2 && text.length < 12) return true;

  // Repetitive words — "you you you", "the the the"
  const words = lower.split(" ");
  const unique = new Set(words);
  if (words.length >= 3 && unique.size <= 2) return true;

  return false;
}

// --------------------------------
// DUPLICATE CACHE
// --------------------------------
const recentTranscripts = new Map();

// --------------------------------
// TRANSCRIBE
// --------------------------------
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  const { session_id, source } = req.body;
  if (!session_id) return res.status(400).json({ error: "session_id required" });
  if (!req.file) return res.status(400).json({ error: "audio required" });

  try {
    let original = await callGroqWhisper(req.file.buffer, req.file.mimetype);
    if (!original) return res.json({ text: "" });

    console.log(`[${session_id}][${source}] raw: ${original}`);

    if (isHallucination(original)) {
      console.log(`[${session_id}] filtered: ${original}`);
      return res.json({ text: "" });
    }

    // Duplicate check
    const cacheKey = `${session_id}:${source}`;
    if (recentTranscripts.get(cacheKey) === original) {
      console.log(`[${session_id}] duplicate ignored`);
      return res.json({ text: "" });
    }
    recentTranscripts.set(cacheKey, original);
    setTimeout(() => {
      if (recentTranscripts.get(cacheKey) === original) recentTranscripts.delete(cacheKey);
    }, 10000);

    const english = await translateToEnglish(original);
    console.log(`[${session_id}][${source}] translated: ${english}`);

    // Save to DB
    const timestamp = formatTimestamp();
    const tagged = `[${(source || "system").toUpperCase()}] [${timestamp}] ${english}`;
    const session = await Session.findOne({ session_id });
    if (session) {
      await Session.findOneAndUpdate({ session_id }, { text: session.text + tagged + "\n" });
    }

    res.json({ text: english, timestamp });
  } catch (err) {
    console.error("Transcribe error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------
// SUMMARISE
// --------------------------------
app.post("/summarise", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.json({ summary: "" });
  try {
    const apiKey = groqApiKeys[0];
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        max_tokens: 200,
        messages: [{ role: "user", content: `Summarise into ONE sentence. Return ONLY the summary.\n\n"${text}"` }]
      })
    });
    const data = await groqRes.json();
    res.json({ summary: data?.choices?.[0]?.message?.content?.trim() || text });
  } catch { res.json({ summary: text }); }
});

// --------------------------------
// SESSION ROUTES
// --------------------------------
app.post("/start-session", async (req, res) => {
  const session_id = req.body?.session_id || Date.now().toString();
  try {
    await Session.create({ session_id });
    res.json({ success: true, session_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/start-session", async (req, res) => {
  const session_id = Date.now().toString();
  try {
    await Session.create({ session_id });
    res.json({ success: true, session_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/push", async (req, res) => {
  const { session_id, text } = req.body;
  if (!session_id || !text) return res.status(400).json({ error: "missing fields" });
  try {
    const session = await Session.findOne({ session_id });
    if (!session) return res.status(404).json({ error: "session not found" });
    await Session.findOneAndUpdate({ session_id }, { text: session.text + text + "\n" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/transcripts", async (req, res) => {
  try {
    const list = await Session.find().sort({ createdAt: -1 }).select("session_id createdAt");
    res.json(list.map(s => ({ id: s.session_id, label: `Session ${new Date(s.createdAt).toLocaleString()}` })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/transcript/:session_id", async (req, res) => {
  try {
    const session = await Session.findOne({ session_id: req.params.session_id });
    if (!session) return res.status(404).json({ error: "Not found" });
    res.json({ text: session.text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));