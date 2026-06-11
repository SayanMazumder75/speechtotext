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
            content: `You are a live meeting translator producing the final transcript line.

CONTEXT (already translated, for continuity & terminology only): "${contextStr}"

NEW TEXT: "${text}"

Rules:
- Output ONE clean English sentence (or two short ones), nothing else — no preamble, no quotes, no explanations.
- If NEW TEXT is already fluent English, return it lightly cleaned: fix obvious typos, capitalization and missing punctuation, but do NOT paraphrase.
- If NEW TEXT is not English, translate it to natural fluent English using the CONTEXT for terminology.
- Use proper capitalization. End with a period unless the text is clearly an unfinished fragment.
- Do not invent content that is not in NEW TEXT.`
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
  // Normalize both texts (lowercase, strip punctuation) before
  // comparing, so trivial differences like "Hello." vs "hello!"
  // don't escape the duplicate detector.
  const tokensA = tokenizeForEcho(a);
  const tokensB = tokenizeForEcho(b);
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
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

// ── Cross-Source Echo Detection ──────────────────────────────────────────────
//
// When the user is on speakers (no headphones) the mic captures the system
// audio that was played back through them, so the same Meet / YouTube speech
// is transcribed twice — once via the SYSTEM pipeline (direct from
// getDisplayMedia) and once via the MIC pipeline (acoustic echo). The two
// pipelines are otherwise independent; this module is the only point where
// they coordinate, by treating SYSTEM as authoritative for any content that
// appears in both within a short time window.

const RECENT_SYSTEM_WINDOW_MS = 15000;
const recentSystemFlushes = new Map(); // session_id → [{ text, ts }]
const TAGGED_LINE_RE = /^\[(MIC|SYSTEM)\] \[([0-9:]+)\] (.*)$/;

function tokenizeForEcho(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Two transcripts are "echoes" of each other if their token sets overlap
// strongly OR one is a substring of the other (mic echo is often a partial
// capture of the cleaner system text).
function isEchoMatch(a, b) {
  const ta = tokenizeForEcho(a);
  const tb = tokenizeForEcho(b);
  if (ta.length < 2 || tb.length < 2) return false;
  const setA = new Set(ta);
  const setB = new Set(tb);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  const j = union === 0 ? 0 : inter / union;
  if (j >= 0.6) return true;
  const sa = ta.join(" ");
  const sb = tb.join(" ");
  if (sa.length >= 8 && sb.length >= 8 && (sa.includes(sb) || sb.includes(sa))) {
    return true;
  }
  return false;
}

function recordSystemFlush(session_id, text, ts) {
  if (!text) return;
  const arr = recentSystemFlushes.get(session_id) || [];
  arr.push({ text, ts });
  while (arr.length > 0 && ts - arr[0].ts > RECENT_SYSTEM_WINDOW_MS) arr.shift();
  while (arr.length > 30) arr.shift();
  recentSystemFlushes.set(session_id, arr);
}

function micEchoesRecentSystem(session_id, micText) {
  const arr = recentSystemFlushes.get(session_id);
  if (!arr || arr.length === 0) return false;
  const now = Date.now();
  // Prune in-place so the window stays tight.
  while (arr.length > 0 && now - arr[0].ts > RECENT_SYSTEM_WINDOW_MS) arr.shift();
  for (const entry of arr) {
    if (isEchoMatch(micText, entry.text)) return true;
  }
  return false;
}

// Scan only the last 8 lines of the persisted transcript and remove any
// MIC entries that are echoes of the new SYSTEM text. Returns the
// removed entries so the frontend can drop them from its already-
// rendered live transcript.
async function stripEchoedMicLines(session_id, systemText) {
  if (!systemText) return [];
  const session = await Session.findOne({ session_id });
  if (!session || !session.text) return [];

  const lines = session.text.split("\n");
  const scanFrom = Math.max(0, lines.length - 8);
  const before = lines.slice(0, scanFrom);
  const tail = lines.slice(scanFrom);
  const keptTail = [];
  const removed = [];

  for (const line of tail) {
    const m = TAGGED_LINE_RE.exec(line);
    if (m && m[1] === "MIC" && isEchoMatch(m[3], systemText)) {
      removed.push({ source: "mic", timestamp: m[2], text: m[3] });
      continue;
    }
    keptTail.push(line);
  }

  if (removed.length > 0) {
    try {
      await Session.findOneAndUpdate(
        { session_id },
        { text: [...before, ...keptTail].join("\n") }
      );
      console.log(
        `[${session_id}] stripped ${removed.length} echoed mic line(s) from DB`
      );
    } catch (err) {
      console.error("strip-echo persist error:", err.message);
    }
  }

  return removed;
}

// ── Output Cleanup ────────────────────────────────────────────────────────────
//
// cleanupSentence applies light typographic normalization to a final
// translated sentence before it lands in the live transcript or the
// persisted DB:
//   - collapse runs of whitespace,
//   - tighten space-before-punctuation, ensure single space after,
//   - capitalize the first Unicode letter,
//   - optionally close with a terminal period when the speaker has
//     stopped (idle flush) or the input already had terminal
//     punctuation. This avoids fragments like "we should also
//     consider the budget" with no period that read poorly in
//     prose-mode and exports.
function cleanupSentence(text, opts = {}) {
  const closeWithPeriod = !!opts.closeWithPeriod;
  if (!text) return "";
  let s = String(text).replace(/\s+/g, " ").trim();
  if (!s) return "";
  // No space before commas / periods / etc.
  s = s.replace(/\s+([.,!?;:])/g, "$1");
  // Single space after sentence-internal punctuation when missing.
  s = s.replace(/([.,!?;:])([^\s.,!?;:"'\)])/g, "$1 $2");
  // Drop dangling commas / semicolons at the end (Whisper sometimes
  // emits these on truncated chunks). Leave terminal punctuation alone.
  if (!/[.!?…]\s*$/.test(s)) {
    s = s.replace(/[\s,;:]+$/, "");
  }
  // Capitalize the first letter (Unicode-safe).
  s = s.replace(/^(\p{L})/u, (m) => m.toUpperCase());
  if (closeWithPeriod && !/[.!?…]["']?$/.test(s)) {
    s = s + ".";
  }
  return s;
}

// ── Buffer Flush ──────────────────────────────────────────────────────────────

async function flushBuffer(bufferKey, session_id, source, opts = {}) {
  const idleFlush = !!opts.idleFlush;
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
  const translatedRaw = await translateWithContext(rawText, context);

  // Decide whether the cleaned sentence should be closed with a
  // terminal period. Two cases say yes:
  //   - the chunk already ended with sentence-ending punctuation
  //     (the speaker visibly finished a thought), or
  //   - the buffer was flushed by the idle timer (the speaker stopped
  //     and we have no continuation in flight).
  // A 20-word inline flush mid-sentence stays open so the next flush
  // can continue the thought without an artificial split-period.
  const rawHasTerminal = /[.!?…]["']?\s*$/.test(rawText);
  const translatedHasTerminal = /[.!?…]["']?\s*$/.test(translatedRaw || "");
  const closeWithPeriod = idleFlush || rawHasTerminal || translatedHasTerminal;

  const translated = cleanupSentence(translatedRaw, { closeWithPeriod });
  if (!translated) return;

  // Cross-source echo guard — drop a MIC flush whose translated text is
  // already in the recent SYSTEM window. This is the speakers-echo case:
  // a remote Meet participant spoke, the user's mic picked it up via
  // the speakers, and Whisper transcribed it on the mic side too.
  // Without this guard the same speech would appear twice in the
  // transcript (once as [MIC], once as [SYSTEM]).
  if (source === "mic" && micEchoesRecentSystem(session_id, translated)) {
    console.log(
      `[${session_id}] dropped mic echo of recent system: "${translated}"`
    );
    return;
  }

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

  // Post-correction: when SYSTEM flushes, scan the recent persisted
  // tail and strip any MIC echoes that already made it through (this
  // happens when the MIC chunk flushed before the SYSTEM chunk
  // covering the same speech). The list of removed entries flows back
  // to the client as `supersedes` so it can remove them from the live
  // transcript view.
  let supersedes = null;
  if (source === "system") {
    recordSystemFlush(session_id, translated, Date.now());
    const removed = await stripEchoedMicLines(session_id, translated);
    if (removed.length > 0) supersedes = removed;
  }

  buf.flushedResults = buf.flushedResults || [];
  buf.flushedResults.push({ text: translated, timestamp, raw: rawText, supersedes });
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
    // speech threshold over the chunk window, the peak RMS in the chunk,
    // and the magnitude ratio in the 85–3500 Hz speech band. The first
    // two flag silence; the third flags broadband noise (fan, keyboard,
    // HVAC, TV) — a remote Meet participant's noisy mic looks loud on
    // RMS but spectrally flat, so RMS alone can't reject it.
    const speechRatioRaw = req.body.speechRatio;
    const peakRmsRaw = req.body.peakRms;
    const speechBandRatioRaw = req.body.speechBandRatio;
    const speechRatio = speechRatioRaw !== undefined ? Number(speechRatioRaw) : NaN;
    const peakRms = peakRmsRaw !== undefined ? Number(peakRmsRaw) : NaN;
    const speechBandRatio = speechBandRatioRaw !== undefined
      ? Number(speechBandRatioRaw)
      : NaN;
    const hasVad = Number.isFinite(speechRatio);
    const hasSpectral = Number.isFinite(speechBandRatio);

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

    // Audible but spectrally flat = broadband noise, not speech. We
    // only apply this gate to system audio because Meet / YouTube
    // streams are where noisy participants and ambient TV come from;
    // the user's own mic on the Whisper path can still benefit from
    // it, but we use a tighter threshold there to avoid clipping
    // soft-spoken users.
    if (hasSpectral) {
      const noiseOnlyThreshold = source === "system" ? 0.35 : 0.30;
      if (
        speechBandRatio < noiseOnlyThreshold &&
        Number.isFinite(peakRms) && peakRms >= 0.01
      ) {
        console.log(
          `[${session_id}][${source}] skipped noise-only chunk ` +
          `(speechBandRatio=${speechBandRatio.toFixed(3)}, ` +
          `peakRms=${peakRms.toFixed(4)})`
        );
        return res.json({ text: "", noise: true });
      }
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
    //  - client VAD says <8% of frames were above the speech floor,
    //  - or, for system audio, the spectral speech-band ratio is in
    //    the borderline band (audible but not strongly voiced — e.g.
    //    a TV in the background under the speaker).
    // For suspicious chunks we apply the weak-hallucination filter.
    const noSpeechCutoff = source === "system" ? 0.5 : 0.6;
    const lowSpectralForSystem =
      source === "system" && hasSpectral && speechBandRatio < 0.5;
    const suspicious =
      whisper.noSpeechProb > noSpeechCutoff ||
      whisper.avgLogprob < -1.0 ||
      (hasVad && speechRatio < 0.08) ||
      lowSpectralForSystem;

    console.log(
      `[${session_id}][${source}] raw: "${original}" ` +
      `(noSpeech=${whisper.noSpeechProb.toFixed(2)}, ` +
      `lp=${whisper.avgLogprob.toFixed(2)}, ` +
      `speechRatio=${hasVad ? speechRatio.toFixed(2) : "n/a"}, ` +
      `speechBandRatio=${hasSpectral ? speechBandRatio.toFixed(2) : "n/a"})`
    );

    if (isHallucination(original, { suspicious })) {
      console.log(`[${session_id}] filtered hallucination: "${original}"`);
      return res.json({ text: "" });
    }

    // Hard confidence reject: Whisper's avg_logprob runs roughly
    // [0, -1.5] in confident regions; below -1.5 the decoder is very
    // uncertain and the output is usually garbled, mistranscribed, or
    // a partial phonetic guess. These chunks degrade transcript
    // quality regardless of the hallucination filter.
    if (whisper.avgLogprob < -1.5) {
      console.log(
        `[${session_id}] dropped low-confidence chunk ` +
        `(lp=${whisper.avgLogprob.toFixed(2)}): "${original}"`
      );
      return res.json({ text: "" });
    }

    const bufferKey = `${session_id}:${source}`;
    let buf = transcriptBuffers.get(bufferKey);
    if (!buf) {
      buf = { chunks: [], timer: null, flushedResults: [] };
      transcriptBuffers.set(bufferKey, buf);
    }

    buf.chunks.push(original);

    const accumulated = buf.chunks.join(" ").trim();
    const accumulatedWordCount = accumulated.split(/\s+/).filter(Boolean).length;
    const hasTerminalEnd = SENTENCE_END_RE.test(original);
    const tooLong = accumulatedWordCount >= 20;
    const shouldFlushNow = hasTerminalEnd || tooLong;

    if (shouldFlushNow) {
      await flushBuffer(bufferKey, session_id, source, { idleFlush: false });
    } else {
      // Fragment merging: a buffer with very few words and no
      // terminal punctuation is almost certainly a sentence in
      // progress. Wait longer (5.5s) for a likely continuation
      // before forcing a flush; this halves the number of broken
      // mid-sentence lines in the final transcript.
      const idle = accumulatedWordCount < 6 ? 5500 : BUFFER_IDLE_MS;
      if (buf.timer) clearTimeout(buf.timer);
      buf.timer = setTimeout(async () => {
        await flushBuffer(bufferKey, session_id, source, { idleFlush: true });
      }, idle);
    }

    const results = buf.flushedResults.splice(0);
    if (results.length > 0) {
      const last = results[results.length - 1];
      // Aggregate supersedes across every flushed result in this batch
      // so the client can drop any mic echoes that were already
      // rendered before the corresponding system flush arrived.
      const supersedes = results
        .map((r) => r.supersedes)
        .filter(Boolean)
        .flat();
      const payload = { text: last.text, timestamp: last.timestamp };
      if (supersedes.length > 0) payload.supersedes = supersedes;
      return res.json(payload);
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
    recentSystemFlushes.delete(session_id);
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
