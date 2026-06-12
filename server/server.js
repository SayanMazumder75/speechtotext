require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer");
const FormData = require("form-data");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB error:", err));

// ── Auth Middleware ────────────────────────────────────────────────────────────

const protect = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id };
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") return res.status(401).json({ error: "Token expired" });
    return res.status(401).json({ error: "Invalid token" });
  }
};

// ── Schemas ───────────────────────────────────────────────────────────────────

const sessionSchema = new mongoose.Schema({
  session_id: { type: String, required: true, unique: true },
  userId: { type: String, index: true },
  text: { type: String, default: "" },
  audioUrl: { type: String, default: "" },
  audioDuration: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.model("Session", sessionSchema);

const vaultSchema = new mongoose.Schema({
  session_id: String,
  userId: { type: String, index: true },
  savedAt: { type: Date, default: Date.now },
  transcript: String,
  summary: String,
  keyPoints: [String],
  actionItems: [{ task: String, owner: String, priority: String }],
  flashcards: [{ front: String, back: String }],
  quiz: [{ question: String, options: [String], answer: String }]
});
const VaultEntry = mongoose.model("VaultEntry", vaultSchema);

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTimestamp() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

// ── Groq Key Rotation ─────────────────────────────────────────────────────────

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

// ── Whisper via Groq ──────────────────────────────────────────────────────────
// Uses verbose_json → gets no_speech_prob per segment for real VAD
// Forces language code → prevents auto-detect guessing wrong language

async function callGroqWhisper(audioBuffer, mimeType, language) {
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
      formData.append("response_format", "verbose_json"); // needed for no_speech_prob

      // Force language → prevents cross-language hallucination
      if (language && language !== "auto") {
        const langCode = language.split("-")[0]; // "bn-IN" → "bn"
        formData.append("language", langCode);
      }

      const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, ...formData.getHeaders() },
        body: formData,
      });

      if (response.status === 429) { console.warn("Rate limit, trying next key"); continue; }
      if (!response.ok) throw new Error(`Groq ${response.status}`);

      const data = await response.json();

      // ── no_speech_prob check: if Whisper itself thinks no speech → reject ──
      // This is the most reliable server-side VAD — Whisper's own confidence
      if (data.segments && data.segments.length > 0) {
        const avgNoSpeech =
          data.segments.reduce((sum, s) => sum + (s.no_speech_prob || 0), 0) /
          data.segments.length;

        if (avgNoSpeech > 0.6) {
          console.log(`[Whisper] no_speech_prob=${avgNoSpeech.toFixed(3)}, rejecting as silence`);
          return "";
        }

        // Also reject if ALL segments are high no_speech even at lower avg
        const allHighNoSpeech = data.segments.every(s => (s.no_speech_prob || 0) > 0.5);
        if (allHighNoSpeech && data.segments.length >= 1) {
          console.log(`[Whisper] all segments high no_speech_prob, rejecting`);
          return "";
        }
      }

      return data.text?.trim() || "";
    } catch (err) {
      console.error(`Whisper attempt ${attempt + 1} failed:`, err.message);
    }
  }
  return "";
}

// ── Hallucination Filter ──────────────────────────────────────────────────────
// KEY FIX: Unicode normalization before comparison.
// Bengali/Hindi chars can have different Unicode representations that look
// identical visually but compare as different → unique.size > 1 even for repeats.
// NFC normalize first, then check.

const EXACT_NOISE = new Set([
  "thank you", "thanks", "bye", "goodbye", "hello", "ok", "okay",
  "hmm", "um", "uh", "ah", "oh", "no", "yes",
  "subscribe", "like and subscribe", "please subscribe",
  "hello everyone", "welcome back", "please like",
  "i'm going to make a", "i'm going to make", "i'm going to",
  "hello everyone, i'm going to make",
  "subtitles by", "translated by", "transcribed by",
  "looking at the camera", "you", "yourself",
  ".", "..", "...", " ",
  // Common Bengali hallucinations from near-silence
  "আমাদ", "আমাদ আমাদ", "সাইলা", "সাইলা সাইলা",
  "প্রাক্ষন", "ধন্যবাদ", "ধন্যবাদ।",
  // Common Hindi hallucinations
  "नमस्ते", "धन्यवाद", "ठीक है",
]);

const MEDIA_MARKER_RE = /^\[?(music|applause|laughter|foreign|inaudible|silence|noise)\]?$/i;

// Whisper hallucination phrases — repeated patterns Whisper generates on silence
const WHISPER_HALLUCINATION_PHRASES_RE = /^(thank you\.?\s*)+$/i;

function isHallucination(text) {
  if (!text) return true;

  // NFC normalize — critical for Bengali/Hindi repeated-word detection
  const trimmed = text.trim().normalize("NFC");
  const lower = trimmed.toLowerCase().normalize("NFC");

  if (EXACT_NOISE.has(lower)) return true;
  if (MEDIA_MARKER_RE.test(trimmed)) return true;
  if (WHISPER_HALLUCINATION_PHRASES_RE.test(trimmed)) return true;
  if (/^[\s.,!?;:\-–—।]+$/.test(trimmed)) return true; // includes Devanagari danda
  if (trimmed.length <= 1) return true;

  // Split on whitespace — NFC normalized
  const words = lower.split(/\s+/).filter(Boolean);

  // ── FIX 1: Catch 2+ identical words (was only 3+) ──────────────────────
  // NFC normalize each word before Set comparison
  // This catches "আমাদ আমাদ", "সাইলা সাইলা", "hello hello"
  if (words.length >= 2) {
    const normalizedWords = words.map(w => w.normalize("NFC"));
    const unique = new Set(normalizedWords);
    if (unique.size === 1) {
      console.log(`[HalluFilter] 2+ identical words: "${trimmed}"`);
      return true;
    }
  }

  // ── FIX 2: Catch mostly-repeated 4+ words ──────────────────────────────
  // e.g. "আমাদ আমাদ something আমাদ" — 4 words, only 2 unique
  if (words.length >= 4) {
    const normalizedWords = words.map(w => w.normalize("NFC"));
    const unique = new Set(normalizedWords);
    if (unique.size <= 2) {
      console.log(`[HalluFilter] mostly-repeated ${words.length} words: "${trimmed}"`);
      return true;
    }
  }

  // ── FIX 3: Short non-Latin text (Bengali/Hindi) rejection ──────────────
  // Real speech in Bengali/Hindi almost always has 3+ words.
  // 1-2 non-Latin words = very likely noise/hallucination.
  // Exception: meaningful short phrases allowed if > 20 chars (longer = more likely real)
  if (words.length < 3) {
    const hasNonLatin = /[\u0080-\uFFFF]/.test(trimmed);
    if (hasNonLatin && trimmed.length < 20) {
      console.log(`[HalluFilter] short non-Latin chunk rejected: "${trimmed}"`);
      return true;
    }
  }

  // ── FIX 4: Word diversity gate ──────────────────────────────────────────
  // Low diversity = hallucination. e.g. "প্রাক্ষন X প্রাক্ষন Y" — many repeats
  if (words.length >= 3) {
    const normalizedWords = words.map(w => w.normalize("NFC"));
    const unique = new Set(normalizedWords);
    const diversity = unique.size / normalizedWords.length;
    if (diversity < 0.4) {
      console.log(`[HalluFilter] low diversity=${diversity.toFixed(2)}: "${trimmed}"`);
      return true;
    }
  }

  return false;
}

// ── Smart Transcript Buffer ───────────────────────────────────────────────────

const SENTENCE_END_RE = /[.!?।]["']?\s*$/; // includes Devanagari danda
const BUFFER_IDLE_MS = 3500;

const transcriptBuffers = new Map();
const translationContext = new Map();

function getTranslationContext(session_id) {
  return translationContext.get(session_id) || [];
}

function pushTranslationContext(session_id, sentence) {
  const ctx = translationContext.get(session_id) || [];
  ctx.push(sentence);
  if (ctx.length > 5) ctx.shift();
  translationContext.set(session_id, ctx);
}

// ── Context-Aware Translation ─────────────────────────────────────────────────

async function translateWithContext(text, contextChunks) {
  if (!text) return "";

  const hasNonLatin = /[\u0080-\uFFFF]/.test(text);
  const hasContext = contextChunks && contextChunks.length > 0;

  if (!hasNonLatin && !hasContext) return text;

  if (hasContext && groqApiKeys.length > 0) {
    try {
      const contextStr = contextChunks.slice(-3).join(" ");
      const apiKey = getNextGroqKey();
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          max_tokens: 200,
          temperature: 0.1,
          messages: [{
            role: "user",
            content: `You are a live meeting translator. Translate the NEW TEXT to fluent English.
Use the CONTEXT to ensure continuity and accurate terminology.
Return ONLY the translated text, nothing else.

CONTEXT (already translated): "${contextStr}"

NEW TEXT: "${text}"`
          }]
        })
      });
      if (groqRes.ok) {
        const data = await groqRes.json();
        const result = data?.choices?.[0]?.message?.content?.trim();
        if (result) return result;
      }
    } catch (err) {
      console.warn("Context-aware translation failed, falling back:", err.message);
    }
  }

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data[0].map(c => c[0]).join(" ").trim() || text;
  } catch {
    return text;
  }
}

// ── Duplicate Detection ───────────────────────────────────────────────────────

const recentTranscripts = new Map();

function jaccardSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().normalize("NFC").split(/\s+/));
  const setB = new Set(b.toLowerCase().normalize("NFC").split(/\s+/));
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function isDuplicate(cacheKey, text) {
  const entry = recentTranscripts.get(cacheKey);
  if (!entry) return false;
  if (Date.now() - entry.time > 30000) { recentTranscripts.delete(cacheKey); return false; }
  return jaccardSimilarity(entry.text, text) > 0.85;
}

function cacheTranscript(cacheKey, text) {
  recentTranscripts.set(cacheKey, { text, time: Date.now() });
  setTimeout(() => {
    const e = recentTranscripts.get(cacheKey);
    if (e && e.text === text) recentTranscripts.delete(cacheKey);
  }, 5000);
}

// ── Buffer Flush ──────────────────────────────────────────────────────────────

async function flushBuffer(bufferKey, session_id, source) {
  const buf = transcriptBuffers.get(bufferKey);
  if (!buf || buf.chunks.length === 0) return;

  if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }

  const rawText = buf.chunks.join(" ").trim();
  buf.chunks = [];

  if (!rawText) return;

  // Run hallucination check again on combined buffer text
  if (isHallucination(rawText)) {
    console.log(`[${session_id}] buffer flush hallucination rejected: "${rawText}"`);
    return;
  }

  const cacheKey = `${session_id}:${source}`;
  if (isDuplicate(cacheKey, rawText)) {
    console.log(`[${session_id}] buffered duplicate skipped`);
    return;
  }
  cacheTranscript(cacheKey, rawText);

  const context = getTranslationContext(session_id);
  const translated = await translateWithContext(rawText, context);
  pushTranslationContext(session_id, translated);

  // Final check: don't persist if translation itself looks like a hallucination
  // e.g. "We ourselves" from "আমাদ আমাদ" — catches cases that slip pre-translation
  const translatedLower = translated.toLowerCase().trim();
  const SHORT_TRANSLATED_NOISE = new Set([
    "we ourselves", "ourselves", "we", "they themselves",
    "she herself", "he himself", "yourself", "itself",
  ]);
  if (SHORT_TRANSLATED_NOISE.has(translatedLower)) {
    console.log(`[${session_id}] translated hallucination rejected: "${rawText}" → "${translated}"`);
    return;
  }

  console.log(`[${session_id}][${source}] flushed: "${rawText}" → "${translated}"`);

  const timestamp = formatTimestamp();
  const tagged = `[${(source || "system").toUpperCase()}] [${timestamp}] ${translated}`;
  try {
    const session = await Session.findOne({ session_id });
    if (session) {
      await Session.findOneAndUpdate({ session_id }, { text: session.text + tagged + "\n" });
    }
  } catch (err) {
    console.error("DB persist error:", err.message);
  }

  buf.flushedResults = buf.flushedResults || [];
  buf.flushedResults.push({ text: translated, timestamp, raw: rawText });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Transcribe — protected
app.post("/transcribe", protect, upload.single("audio"), async (req, res) => {
  const { session_id, source, language } = req.body;
  if (!session_id) return res.status(400).json({ error: "session_id required" });
  if (!req.file) return res.status(400).json({ error: "audio required" });

  const session = await Session.findOne({ session_id });
  if (session && session.userId && session.userId !== req.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    // Force language → Whisper uses correct model for Bengali/Hindi/English
    // verbose_json → no_speech_prob per segment for real VAD
    const original = await callGroqWhisper(req.file.buffer, req.file.mimetype, language);
    if (!original) return res.json({ text: "" });

    console.log(`[${session_id}][${source}] raw: ${original}`);

    if (isHallucination(original)) {
      console.log(`[${session_id}] filtered hallucination: "${original}"`);
      return res.json({ text: "" });
    }

    // Word diversity gate before buffering
    // NFC normalize for correct Bengali/Hindi word counting
    const words = original.trim().normalize("NFC").split(/\s+/);
    const normalizedWords = words.map(w => w.toLowerCase().normalize("NFC"));
    const diversity = new Set(normalizedWords).size / normalizedWords.length;
    if (words.length >= 3 && diversity < 0.4) {
      console.log(`[${session_id}] low diversity rejected: "${original}" (diversity=${diversity.toFixed(2)})`);
      return res.json({ text: "" });
    }

    const bufferKey = `${session_id}:${source}`;
    let buf = transcriptBuffers.get(bufferKey);
    if (!buf) {
      buf = { chunks: [], timer: null, flushedResults: [] };
      transcriptBuffers.set(bufferKey, buf);
    }

    buf.chunks.push(original);

    const shouldFlushNow =
      SENTENCE_END_RE.test(original) ||
      buf.chunks.join(" ").split(/\s+/).length >= 20;

    if (shouldFlushNow) {
      await flushBuffer(bufferKey, session_id, source);
    } else {
      if (buf.timer) clearTimeout(buf.timer);
      buf.timer = setTimeout(async () => {
        await flushBuffer(bufferKey, session_id, source);
      }, BUFFER_IDLE_MS);
    }

    const results = buf.flushedResults.splice(0);
    if (results.length > 0) {
      const last = results[results.length - 1];
      return res.json({ text: last.text, timestamp: last.timestamp });
    }

    return res.json({ text: "", buffering: true });

  } catch (err) {
    console.error("Transcribe error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Summarise — protected
app.post("/summarise", protect, async (req, res) => {
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

// Start session — protected
app.post("/start-session", protect, async (req, res) => {
  const session_id = req.body?.session_id || Date.now().toString();
  try {
    await Session.create({ session_id, userId: req.user.id });
    for (const key of transcriptBuffers.keys()) {
      if (key.startsWith(session_id + ":")) transcriptBuffers.delete(key);
    }
    translationContext.delete(session_id);
    res.json({ success: true, session_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/start-session", protect, async (req, res) => {
  const session_id = Date.now().toString();
  try {
    await Session.create({ session_id, userId: req.user.id });
    res.json({ success: true, session_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push — protected, ownership check
app.post("/push", protect, async (req, res) => {
  const { session_id, text } = req.body;
  if (!session_id || !text) return res.status(400).json({ error: "missing fields" });
  try {
    const session = await Session.findOne({ session_id });
    if (!session) return res.status(404).json({ error: "session not found" });
    if (session.userId && session.userId !== req.user.id) return res.status(403).json({ error: "Forbidden" });
    await Session.findOneAndUpdate({ session_id }, { text: session.text + text + "\n" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List transcripts — protected, user-scoped
app.get("/transcripts", protect, async (req, res) => {
  try {
    const list = await Session.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .select("session_id createdAt");
    res.json(list.map(s => ({
      id: s.session_id,
      label: `Session ${new Date(s.createdAt).toLocaleString()}`
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get transcript — protected, ownership check
app.get("/transcript/:session_id", protect, async (req, res) => {
  try {
    const session = await Session.findOne({
      session_id: req.params.session_id,
      $or: [{ userId: req.user.id }, { userId: { $exists: false } }, { userId: null }]
    });
    if (!session) return res.status(403).json({ error: "Forbidden" });
    res.json({ text: session.text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload audio — protected
app.post("/upload-audio", protect, upload.single("audio"), async (req, res) => {
  const { session_id } = req.body;
  if (!session_id || !req.file) return res.status(400).json({ error: "session_id and audio file required" });

  const session = await Session.findOne({ session_id });
  if (session && session.userId && session.userId !== req.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    if (!process.env.CLOUDINARY_CLOUD_NAME) throw new Error("Cloudinary not configured.");

    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: "auto", folder: "meetmind_audio", public_id: session_id },
        (error, uploadResult) => {
          if (error) reject(error);
          else resolve(uploadResult);
        }
      );
      uploadStream.end(req.file.buffer);
    });

    const audioUrl = result.secure_url;
    const audioDuration = Math.round(result.duration || 0);
    await Session.findOneAndUpdate({ session_id }, { audioUrl, audioDuration }, { upsert: true });
    res.json({ audioUrl, audioDuration });
  } catch (err) {
    console.error("Upload-audio error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get audio — protected, ownership check
app.get("/audio/:session_id", protect, async (req, res) => {
  try {
    const session = await Session.findOne({
      session_id: req.params.session_id,
      $or: [{ userId: req.user.id }, { userId: { $exists: false } }, { userId: null }]
    });
    if (!session) return res.status(403).json({ error: "Forbidden" });
    res.json({ audioUrl: session.audioUrl, audioDuration: session.audioDuration });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI Insights — protected
app.post("/ai-insights", protect, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  try {
    const apiKey = getNextGroqKey();
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 2000,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: "Groq API error" });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    const clean = text.replace(/```json\n?|```/g, "").trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { return res.status(500).json({ error: "Failed to parse AI response" }); }

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vault save — protected
app.post("/vault/save", protect, async (req, res) => {
  const { session_id, transcript, summary, keyPoints, actionItems, flashcards, quiz } = req.body;
  if (!session_id) return res.status(400).json({ error: "session_id required" });
  try {
    const entry = await VaultEntry.create({
      session_id, userId: req.user.id,
      transcript: transcript || "", summary: summary || "",
      keyPoints: keyPoints || [], actionItems: actionItems || [],
      flashcards: flashcards || [], quiz: quiz || []
    });
    res.json({ ok: true, id: entry._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List vault — protected
app.get("/vault", protect, async (req, res) => {
  try {
    const entries = await VaultEntry.find({ userId: req.user.id })
      .sort({ savedAt: -1 }).select("-transcript");
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get vault entry — protected
app.get("/vault/:id", protect, async (req, res) => {
  try {
    const entry = await VaultEntry.findOne({ _id: req.params.id, userId: req.user.id });
    if (!entry) return res.status(403).json({ error: "Forbidden" });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "ok", service: "AI Meeting Intelligence" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));