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

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB error:", err));

// ── Auth Middleware ────────────────────────────────────────────────────────────
// Uses same JWT_SECRET as MeetMind — SSO via postMessage token hand-off

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
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
};

// ── Schemas ───────────────────────────────────────────────────────────────────

const sessionSchema = new mongoose.Schema({
  session_id: { type: String, required: true, unique: true },
  // userId: optional for migration safety — old records won't break
  userId: { type: String, index: true },
  text: { type: String, default: "" },
  audioUrl: { type: String, default: "" },
  audioDuration: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.model("Session", sessionSchema);

const vaultSchema = new mongoose.Schema({
  session_id: String,
  // userId: optional for migration safety
  userId: { type: String, index: true },
  savedAt: { type: Date, default: Date.now },
  transcript: String,
  summary: String,
  keyPoints: [String],
  actionItems: [{ task: String, owner: String, priority: String }],
  flashcards: [{ front: String, back: String }],
  quiz: [{
    question: String,
    options: [String],
    answer: String
  }]
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

// ── Whisper ───────────────────────────────────────────────────────────────────

async function callGroqWhisper(audioBuffer, mimeType, opts = {}) {
  const { language, prompt } = opts;
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
      // verbose_json gives us per-segment no_speech_prob and avg_logprob,
      // which are the strongest signals for detecting Whisper's
      // silence-induced hallucinations ("Thank you", "Thanks for
      // watching", "Bye", etc.). Without these we can only filter on
      // the text itself, after the damage is done.
      formData.append("response_format", "verbose_json");
      // Greedy decoding (temperature=0) is documented as the single
      // biggest mitigation against Whisper hallucinations on near-silent
      // audio. Sampling at higher temperatures is what produces the
      // creative "thanks for watching, see you next time" tails.
      formData.append("temperature", "0");
      // Pinning the language activates the matching Whisper decoder
      // (en for Indian English, hi for Hindi, bn for Bengali). This is
      // the largest single accuracy win for Indian speakers because it
      // stops Whisper guessing the locale on every chunk and prevents
      // it from falling back to phonetic English transcription on
      // Hindi / Bengali audio.
      if (language) formData.append("language", language);
      // A short, content-free prompt biases Whisper's vocabulary and
      // punctuation style without seeding hallucinated continuations.
      if (prompt) formData.append("prompt", prompt);

      const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, ...formData.getHeaders() },
        body: formData,
      });

      if (response.status === 429) { console.warn("Rate limit, trying next key"); continue; }
      if (!response.ok) throw new Error(`Groq ${response.status}`);

      const data = await response.json();
      const text = (data.text || "").trim();

      // Aggregate per-segment confidence so the caller can decide how
      // suspicious this chunk is overall.
      const segments = Array.isArray(data.segments) ? data.segments : [];
      let noSpeechProb = 0;
      let avgLogprob = 0;
      let compressionRatio = 0;
      if (segments.length > 0) {
        for (const s of segments) {
          noSpeechProb += Number(s.no_speech_prob || 0);
          avgLogprob += Number(s.avg_logprob || 0);
          compressionRatio += Number(s.compression_ratio || 0);
        }
        noSpeechProb /= segments.length;
        avgLogprob /= segments.length;
        compressionRatio /= segments.length;
      }
      return { text, noSpeechProb, avgLogprob, compressionRatio };
    } catch (err) {
      console.error(`Whisper attempt ${attempt + 1} failed:`, err.message);
    }
  }
  return { text: "", noSpeechProb: 1, avgLogprob: -10, compressionRatio: 0 };
}

// Map UI BCP-47 language tags (en-IN, hi-IN, bn-IN) to the ISO-639-1
// codes Whisper expects. Returns null for unknown values so we fall
// back to Whisper's auto-detect.
function uiLangToWhisperLang(uiLang) {
  if (!uiLang || typeof uiLang !== "string") return null;
  const lower = uiLang.toLowerCase();
  if (lower.startsWith("en")) return "en";
  if (lower.startsWith("hi")) return "hi";
  if (lower.startsWith("bn")) return "bn";
  return null;
}

// Style/vocabulary biasing prompt for the mic path. Kept short and
// content-free so Whisper does not "continue" it as a hallucination on
// silent chunks. Names are listed only as vocabulary cues — the model
// uses them to bias spelling, not to insert them.
const MIC_BIAS_PROMPT_BY_LANG = {
  en: "Indian English meeting. Names like Aarav, Priya, Rahul, Ananya. Use proper punctuation.",
  hi: "हिंदी की मीटिंग। उचित विराम चिह्नों का प्रयोग करें।",
  bn: "বাংলা মিটিং। যথাযথ যতিচিহ্ন ব্যবহার করুন।",
};

// ── Hallucination Filter ──────────────────────────────────────────────────────
//
// Two-tier filter:
//
//   HARD patterns are dropped unconditionally — these are phrases Whisper
//   is documented to emit on silence/non-speech audio and never appear as
//   real meeting content (YouTube tail phrases, "Subtitles by ...", etc).
//
//   WEAK patterns are dropped only when the chunk looks "suspicious" —
//   i.e. the client's VAD ratio is low or Whisper's own no_speech_prob /
//   avg_logprob indicates poor confidence. Single tokens like "yes",
//   "no", "okay", "hello" can be perfectly valid speech, so we keep them
//   when there is acoustic evidence of actual speech in the chunk.

const HARD_HALLUCINATION_PATTERNS = [
  // "Thanks for watching", "Thanks everyone", "Thanks!" — the YouTube tail.
  /^thanks?( for watching| for listening| everyone| guys| all| again)*[.!? ]*$/,
  /^thank you( so much| very much| all| everyone| for watching| for listening)*[.!? ]*$/,
  // "Bye bye", "Goodbye", "See you in the next video", etc.
  /^(bye+|goodbye|see ya|see you( in the next video| next time| later)?)[.!? ]*$/,
  // "Please subscribe", "Like and subscribe to my channel", "Don't forget to subscribe".
  /^(please )?(like and )?subscribe( to (my|the|our) channel)?[.!? ]*$/,
  /^(don.?t forget to )?(like|subscribe|comment)([ ,]+(and|&)[ ,]+(like|subscribe|comment))*[.!? ]*$/,
  // "Subtitles by Amara.org community", "Translated by ...", "Captions by ...".
  /^subtitles? (by|provided by|from)[\w\s.\-]+$/,
  /^(translated|transcribed|captions|closed captions) (by|from)[\w\s.\-]+$/,
  // Standalone media markers Whisper sometimes emits as text.
  /^\[?(music|applause|laughter|silence|noise|inaudible|foreign|crosstalk)\]?[.!? ]*$/,
  // Single-token Whisper hallucinations.
  /^you[.!? ]*$/,
  /^yourself[.!? ]*$/,
  // Specific phrases observed in this project's prior filter.
  /^looking at the camera[.!? ]*$/,
  /^i'?m going to make( a)?[.!? ]*$/,
  /^hello everyone,? i'?m going to make( a)?[.!? ]*$/,
];

const WEAK_HALLUCINATION_PATTERNS = [
  /^thanks?[.!? ]*$/,
  /^thank you[.!? ]*$/,
  /^hello[.!? ]*$/,
  /^hi[.!? ]*$/,
  /^hey[.!? ]*$/,
  /^bye[.!? ]*$/,
  /^okay?[.!? ]*$/,
  /^yes[.!? ]*$/,
  /^no[.!? ]*$/,
  /^uh[ -]?huh[.!? ]*$/,
  /^mm[ -]?hmm[.!? ]*$/,
  /^hmm+[.!? ]*$/,
  /^um+[.!? ]*$/,
  /^uh+[.!? ]*$/,
  /^ah+[.!? ]*$/,
  /^oh+[.!? ]*$/,
];

const MEDIA_MARKER_RE = /^\[?(music|applause|laughter|foreign|inaudible|silence|noise|crosstalk)\]?[.!? ]*$/i;

function normalizeForFilter(text) {
  return text
    .toLowerCase()
    // Strip smart quotes and stray quote-like characters.
    .replace(/[\u201c\u201d"`']/g, "")
    .trim()
    // Collapse repeated identical tokens: "bye bye bye" → "bye",
    // "okay, okay, okay." → "okay". Catches Whisper's stutter-on-noise
    // pattern without affecting ordinary speech.
    .replace(/^([\p{L}']+)([ .,!?]+\1)+[ .,!?]*$/u, "$1");
}

function isHallucination(text, opts = {}) {
  const suspicious = !!opts.suspicious;

  if (!text) return true;
  const trimmed = text.trim();

  // Pure punctuation / whitespace.
  if (/^[\s.,!?;:\-–—]*$/.test(trimmed)) return true;
  // Single character output.
  if (trimmed.length <= 1) return true;
  if (MEDIA_MARKER_RE.test(trimmed)) return true;

  // Repeated single weak token like "okay okay okay" or "bye bye" is
  // always a hallucination, regardless of suspicious flag. Run this on
  // the pre-collapse tokens so we don't miss it after normalization.
  const rawTokens = trimmed
    .toLowerCase()
    .replace(/[.,!?;:\-–—]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (
    rawTokens.length >= 2 &&
    new Set(rawTokens).size === 1 &&
    WEAK_HALLUCINATION_PATTERNS.some((re) => re.test(rawTokens[0]))
  ) {
    return true;
  }

  const norm = normalizeForFilter(trimmed);

  for (const re of HARD_HALLUCINATION_PATTERNS) {
    if (re.test(norm)) return true;
  }

  const tokens = norm.split(/\s+/).filter(Boolean);

  // Long output that's just two tokens cycling — classic stuck Whisper.
  if (tokens.length >= 4 && new Set(tokens).size <= 2) return true;

  if (suspicious) {
    for (const re of WEAK_HALLUCINATION_PATTERNS) {
      if (re.test(norm)) return true;
    }
    // On a suspicious chunk, very short outputs are almost always
    // Whisper guessing on silence/noise.
    if (tokens.length <= 2 && trimmed.length < 12) return true;
  }

  return false;
}

// ── Smart Transcript Buffer ───────────────────────────────────────────────────

const SENTENCE_END_RE = /[.!?]["']?\s*$/;
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

async function translateToEnglish(text) {
  if (!text) return "";
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data[0].map(c => c[0]).join(" ").trim();
  } catch { return text; }
}

// ── Duplicate Detection ───────────────────────────────────────────────────────

const recentTranscripts = new Map();

function jaccardSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function isDuplicate(cacheKey, text) {
  const entry = recentTranscripts.get(cacheKey);
  if (!entry) return false;
  if (Date.now() - entry.time > 30000) {
    recentTranscripts.delete(cacheKey);
    return false;
  }
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

  const cacheKey = `${session_id}:${source}`;
  if (isDuplicate(cacheKey, rawText)) {
    console.log(`[${session_id}] buffered duplicate skipped`);
    return;
  }
  cacheTranscript(cacheKey, rawText);

  const context = getTranslationContext(session_id);
  const translated = await translateWithContext(rawText, context);
  pushTranslationContext(session_id, translated);

  console.log(`[${session_id}][${source}] flushed: "${rawText}" → "${translated}"`);

  const timestamp = formatTimestamp();
  const tagged = `[${(source || "system").toUpperCase()}] [${timestamp}] ${translated}`;
  try {
    const session = await Session.findOne({ session_id });
    if (session) {
      await Session.findOneAndUpdate(
        { session_id },
        { text: session.text + tagged + "\n" }
      );
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
  const { session_id, source } = req.body;
  if (!session_id) return res.status(400).json({ error: "session_id required" });
  if (!req.file) return res.status(400).json({ error: "audio required" });

  // Verify session belongs to user
  const session = await Session.findOne({ session_id });
  if (session && session.userId && session.userId !== req.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    // Client-side VAD signals: fraction of frames whose RMS exceeded the
    // speech threshold over the chunk window, and the peak RMS in the
    // chunk. When both are very low the chunk is essentially silence —
    // we skip Whisper entirely to remove any hallucination opportunity.
    const speechRatioRaw = req.body.speechRatio;
    const peakRmsRaw = req.body.peakRms;
    const speechRatio = speechRatioRaw !== undefined ? Number(speechRatioRaw) : NaN;
    const peakRms = peakRmsRaw !== undefined ? Number(peakRmsRaw) : NaN;
    const hasVad = Number.isFinite(speechRatio);

    if (
      hasVad &&
      speechRatio < 0.02 &&
      (!Number.isFinite(peakRms) || peakRms < 0.01)
    ) {
      console.log(
        `[${session_id}][${source}] skipped silent chunk ` +
        `(speechRatio=${speechRatio.toFixed(3)}, peakRms=${
          Number.isFinite(peakRms) ? peakRms.toFixed(4) : "n/a"
        })`
      );
      return res.json({ text: "", silent: true });
    }

    // Language hint and biasing prompt are applied only to the mic path
    // because:
    //   - the UI's language picker is labeled "Mic audio language";
    //   - system audio is meeting/video content whose language is not
    //     known up-front, so we let Whisper auto-detect it.
    let whisperLanguage = null;
    let whisperPrompt = null;
    if (source === "mic") {
      whisperLanguage = uiLangToWhisperLang(req.body.language);
      if (whisperLanguage && MIC_BIAS_PROMPT_BY_LANG[whisperLanguage]) {
        whisperPrompt = MIC_BIAS_PROMPT_BY_LANG[whisperLanguage];
      }
    }

    const whisper = await callGroqWhisper(req.file.buffer, req.file.mimetype, {
      language: whisperLanguage,
      prompt: whisperPrompt,
    });
    const original = whisper.text;
    if (!original) return res.json({ text: "" });

    // A chunk is "suspicious" if any of:
    //  - Whisper itself reports high no_speech_prob,
    //  - decoder confidence (avg_logprob) is very low,
    //  - client VAD says <8% of frames were above the speech floor.
    // For suspicious chunks we apply the weak-hallucination filter.
    const suspicious =
      whisper.noSpeechProb > 0.6 ||
      whisper.avgLogprob < -1.0 ||
      (hasVad && speechRatio < 0.08);

    console.log(
      `[${session_id}][${source}] raw: "${original}" ` +
      `(noSpeech=${whisper.noSpeechProb.toFixed(2)}, ` +
      `lp=${whisper.avgLogprob.toFixed(2)}, ` +
      `speechRatio=${hasVad ? speechRatio.toFixed(2) : "n/a"})`
    );

    if (isHallucination(original, { suspicious })) {
      console.log(`[${session_id}] filtered hallucination: "${original}"`);
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

// Start session — protected, stores userId
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

// GET start-session — protected
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
    // Ownership check — allow if no userId (legacy) or matches
    if (session.userId && session.userId !== req.user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
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
      // Allow: user owns it OR legacy record (no userId)
      $or: [
        { userId: req.user.id },
        { userId: { $exists: false } },
        { userId: null }
      ]
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
  if (!session_id || !req.file) {
    return res.status(400).json({ error: "session_id and audio file required" });
  }

  // Ownership check
  const session = await Session.findOne({ session_id });
  if (session && session.userId && session.userId !== req.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    console.log(`Uploading audio for session ${session_id}, size: ${req.file.size} bytes`);

    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      throw new Error("Cloudinary not configured. Missing env variables.");
    }

    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: "auto",
          folder: "meetmind_audio",
          public_id: session_id,
        },
        (error, uploadResult) => {
          if (error) { console.error("Cloudinary upload error details:", error); reject(error); }
          else resolve(uploadResult);
        }
      );
      uploadStream.end(req.file.buffer);
    });

    const audioUrl = result.secure_url;
    const audioDuration = Math.round(result.duration || 0);

    await Session.findOneAndUpdate(
      { session_id },
      { audioUrl, audioDuration },
      { upsert: true }
    );

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
      $or: [
        { userId: req.user.id },
        { userId: { $exists: false } },
        { userId: null }
      ]
    });
    if (!session) return res.status(403).json({ error: "Forbidden" });
    res.json({ audioUrl: session.audioUrl, audioDuration: session.audioDuration });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI Insights — protected (stateless, no ownership filter needed)
app.post("/ai-insights", protect, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  try {
    const apiKey = getNextGroqKey();
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 2000,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Groq AI Insights error:", err);
      return res.status(500).json({ error: "Groq API error" });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    const clean = text.replace(/```json\n?|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      console.error("JSON parse failed:", clean.slice(0, 300));
      return res.status(500).json({ error: "Failed to parse AI response" });
    }

    res.json(parsed);
  } catch (err) {
    console.error("AI Insights error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Vault save — protected, stores userId
app.post("/vault/save", protect, async (req, res) => {
  const { session_id, transcript, summary, keyPoints, actionItems, flashcards, quiz } = req.body;
  if (!session_id) return res.status(400).json({ error: "session_id required" });

  try {
    const entry = await VaultEntry.create({
      session_id,
      userId: req.user.id,
      transcript: transcript || "",
      summary: summary || "",
      keyPoints: keyPoints || [],
      actionItems: actionItems || [],
      flashcards: flashcards || [],
      quiz: quiz || []
    });
    res.json({ ok: true, id: entry._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List vault — protected, user-scoped
app.get("/vault", protect, async (req, res) => {
  try {
    const entries = await VaultEntry.find({ userId: req.user.id })
      .sort({ savedAt: -1 })
      .select("-transcript");
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get vault entry — protected, ownership check
app.get("/vault/:id", protect, async (req, res) => {
  try {
    const entry = await VaultEntry.findOne({
      _id: req.params.id,
      userId: req.user.id
    });
    if (!entry) return res.status(403).json({ error: "Forbidden" });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Root
app.get("/", (req, res) => res.json({ status: "ok", service: "AI Meeting Intelligence" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
