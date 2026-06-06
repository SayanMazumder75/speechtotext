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

// --------------------------------
// MONGODB
// --------------------------------
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB error:", err));

const sessionSchema = new mongoose.Schema({
  session_id: { type: String, required: true, unique: true },
  text: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.model("Session", sessionSchema);
mongoose.connection.on('connected', () => console.log('MongoDB connected'));
mongoose.connection.on('error', (err) => console.error('MongoDB connection error:', err));
// --------------------------------
// LOAD BALANCING FOR GROQ API KEYS
// --------------------------------
const groqApiKeys = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4
].filter(key => key && key.trim() !== "");

let currentKeyIndex = 0;

function getNextGroqKey() {
  if (groqApiKeys.length === 0) {
    throw new Error("No Groq API keys configured");
  }
  const key = groqApiKeys[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % groqApiKeys.length;
  return key;
}

// --------------------------------
// GOOGLE TRANSLATE (free)
// --------------------------------
async function translateToEnglish(text) {
  if (!text) return "";
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data[0].map(c => c[0]).join(" ").trim();
  } catch (err) {
    console.error("Translation error:", err);
    return text; // fallback to original
  }
}

// --------------------------------
// CALL GROQ WHISPER (no task param)
// --------------------------------
async function callGroqWhisper(audioBuffer, mimeType, maxRetries = groqApiKeys.length) {
  let lastError = null;
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
      // NO task=translate – Groq doesn't support it

      const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...formData.getHeaders(),
        },
        body: formData,
      });

      if (response.status === 429) {
        console.warn(`Rate limit hit for key ${apiKey.slice(0,5)}..., trying next`);
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Groq API error (${response.status}): ${errorText}`);
        throw new Error(`Groq API returned ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      let transcript = data.text?.trim() || "";
      return transcript;
    } catch (err) {
      console.error(`Attempt ${attempt+1} failed with key ${apiKey?.slice(0,5)}:`, err.message);
      lastError = err;
    }
  }
  throw new Error(`All Groq keys failed: ${lastError?.message}`);
}

// --------------------------------
// IN‑MEMORY CACHE TO PREVENT DUPLICATE LINES
// --------------------------------
const recentTranscripts = new Map(); // key: `${session_id}:${source}` -> last transcript

// --------------------------------
// TRANSCRIBE ENDPOINT
// --------------------------------
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  const { session_id, source } = req.body;
  console.log(`[${session_id}] Transcribe request from ${source}`);

  if (!session_id) return res.status(400).json({ error: "session_id required" });
  if (!req.file) return res.status(400).json({ error: "audio file required" });

  try {
    // Step 1: Whisper transcription (original language)
    let originalText = await callGroqWhisper(req.file.buffer, req.file.mimetype);
    if (!originalText) {
      return res.json({ text: "" });
    }

    console.log(`[${session_id}] Whisper raw (${source}): ${originalText}`);

    // Step 2: Filter out obvious hallucinations / silence
    const HALLUCINATIONS = [
      "thank you", "thanks", "bye", "goodbye", "you", "no", "yes",
      "okay", "ok", "hmm", "um", "uh", "ah", "oh", ".", "...", " ",
      "subscribe", "like", "share", "please", "welcome", "hello",
      "hello everyone", "i'm going to make a", "i'm going to make",  // added common repeats
    ];
    const lower = originalText.toLowerCase();
    if (HALLUCINATIONS.some(h => lower === h || lower.includes(h) && originalText.split(" ").length <= 5)) {
      console.log(`[${session_id}] Filtered hallucination: ${originalText}`);
      return res.json({ text: "" });
    }
    if (originalText.split(" ").length <= 2 && originalText.length < 10) {
      console.log(`[${session_id}] Too short, filtered: ${originalText}`);
      return res.json({ text: "" });
    }

    // Step 3: Prevent duplicate consecutive lines (same text from same source within 10 seconds)
    const cacheKey = `${session_id}:${source}`;
    const lastText = recentTranscripts.get(cacheKey);
    if (lastText === originalText) {
      console.log(`[${session_id}] Duplicate line ignored: ${originalText}`);
      return res.json({ text: "" });
    }
    // After setting the cache, schedule deletion after 10 seconds
recentTranscripts.set(cacheKey, originalText);
setTimeout(() => {
  if (recentTranscripts.get(cacheKey) === originalText) {
    recentTranscripts.delete(cacheKey);
  }
}, 10000);
    // Optional: auto‑clear after 10 seconds (but not critical)

    // Step 4: Translate to English
    const englishText = await translateToEnglish(originalText);
    console.log(`[${session_id}] Translated (${source}): ${englishText}`);

    // Step 5: Save to database with proper tag
    const tagged = `[${source?.toUpperCase() || "SYSTEM"}] ${englishText}`;
    const session = await Session.findOne({ session_id });
    if (session) {
      await Session.findOneAndUpdate(
        { session_id },
        { text: session.text + tagged + "\n" }
      );
    }

    res.json({ text: englishText });
  } catch (err) {
    console.error(`Transcribe error (${source}):`, err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------
// SUMMARISE (unchanged, uses Groq Llama)
// --------------------------------
app.post("/summarise", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.json({ summary: "" });

  try {
    const apiKey = groqApiKeys[0];
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        max_tokens: 200,
        messages: [{ role: "user", content: `Summarise the following into ONE sentence. Return ONLY the summary.\n\n"${text}"` }]
      })
    });
    const data = await groqRes.json();
    const summary = data?.choices?.[0]?.message?.content?.trim() || text;
    res.json({ summary });
  } catch (err) {
    console.error("Summarise error:", err);
    res.json({ summary: text });
  }
});

// --------------------------------
// SESSION ROUTES (unchanged)
// --------------------------------
app.post("/start-session", async (req, res) => {
  const session_id = req.body?.session_id || Date.now().toString();
  try {
    console.log("Creating session with ID:", session_id);
    await Session.create({ session_id });
    console.log("Session created successfully");
    res.json({ success: true, session_id });
  } catch (err) {
    console.error("ERROR in /start-session:", err.message);
    console.error(err.stack);
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