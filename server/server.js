require("dotenv").config();
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

// ── Schemas ───────────────────────────────────────────────────────────────────

const sessionSchema = new mongoose.Schema({
  session_id: { type: String, required: true, unique: true },
  text: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.model("Session", sessionSchema);

// NEW: Study Vault schema — stores full AI insights + transcript per save
const vaultSchema = new mongoose.Schema({
  session_id: String,
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
      console.error(`Whisper attempt ${attempt + 1} failed:`, err.message);
    }
  }
  return "";
}

// ── Improved Hallucination Filter ─────────────────────────────────────────────
//
// DESIGN PRINCIPLE:
//   Only filter text that is clearly noise / hallucination output from Whisper.
//   Do NOT filter partial but valid sentences like "This is one reason why".
//   Short fragments are valid; only exact noise tokens and media markers are blocked.
//
// Changed from old approach:
//   OLD: partial-match on short text ≤6 words → too aggressive, kills real speech
//   NEW: exact-match only for noise tokens; partial-match only for media artifacts
//        in brackets; single-word noise; repetitive-word gibberish

const EXACT_NOISE = new Set([
  // Filler tokens
  "thank you", "thanks", "bye", "goodbye", "hello", "ok", "okay",
  "hmm", "um", "uh", "ah", "oh", "no", "yes",
  // Whisper hallucination phrases (these appear verbatim with no real audio)
  "subscribe", "like and subscribe", "please subscribe",
  "hello everyone", "welcome back", "please like",
  "i'm going to make a", "i'm going to make", "i'm going to",
  "hello everyone, i'm going to make",
  "subtitles by", "translated by", "transcribed by",
  "looking at the camera","you","yourself","thank you","thanks",
  "okay","ok","hello","bye","goodbye",
  // Punctuation-only
  ".", "..", "...", " ",
]);

// Media/annotation markers — always filter these (bracket style)
const MEDIA_MARKER_RE = /^\[?(music|applause|laughter|foreign|inaudible|silence|noise)\]?$/i;

function isHallucination(text) {
  if (!text) return true;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // 1. Exact match against known noise set
  if (EXACT_NOISE.has(lower)) return true;

  // 2. Media/annotation markers like [Music], [Applause]
  if (MEDIA_MARKER_RE.test(trimmed)) return true;

  // 3. Purely punctuation / whitespace
  if (/^[\s.,!?;:\-–—]+$/.test(trimmed)) return true;

  // 4. Repetitive gibberish: ≥4 words where unique word count ≤ 2
  //    e.g. "you you you you", "the the the"
  //    (Kept from original but threshold raised to avoid clipping valid repetition)
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length >= 4) {
    const unique = new Set(words);
    if (unique.size <= 2) return true;
  }

  // 5. Single-character or empty
  if (trimmed.length <= 1) return true;

  // NOT filtered:
  //   - short valid fragments ("This is one reason why", "I want to hear your story")
  //   - any text with real word diversity
  //   - partial sentences
  const repeatedWords = lower.split(/\s+/);

  if (repeatedWords.length >= 3) {
    const unique = new Set(repeatedWords);

    if (unique.size === 1) {
      return true;
    }
  }
  return false;
}

// ── Smart Transcript Buffer ───────────────────────────────────────────────────
//
// Buffers raw Whisper chunks per (session, source).
// Flushes when a sentence boundary is detected OR when a configurable idle
// pause has elapsed since the last chunk (simulates pause detection).
//
// SENTENCE BOUNDARY: chunk ends with . ? ! or next chunk starts with capital
// after a natural pause.
//
// When flushed, the accumulated text is sent for context-aware translation.

const SENTENCE_END_RE = /[.!?]["']?\s*$/;
const BUFFER_IDLE_MS = 3500; // flush after 3.5s of silence per source

// Map: `${session_id}:${source}` → { chunks: string[], timer: NodeJS.Timeout }
const transcriptBuffers = new Map();

// Map: `${session_id}` → string[] (last 5 flushed translated sentences for context)
const translationContext = new Map();

function getTranslationContext(session_id) {
  return translationContext.get(session_id) || [];
}

function pushTranslationContext(session_id, sentence) {
  const ctx = translationContext.get(session_id) || [];
  ctx.push(sentence);
  if (ctx.length > 5) ctx.shift(); // keep last 5
  translationContext.set(session_id, ctx);
}

// ── Context-Aware Translation ─────────────────────────────────────────────────
//
// Changed from old approach:
//   OLD: translateToEnglish(text) → Google Translate, no context
//   NEW: if context is available and text looks non-English → use LLaMA with
//        context window for fluent translation.
//        Falls back to Google Translate for pure English or on error.

async function translateWithContext(text, contextChunks) {
  if (!text) return "";

  // Heuristic: skip LLM translation if text is already English-looking
  // (ASCII-only, no Devanagari/Bengali unicode ranges)
  const hasNonLatin = /[\u0080-\uFFFF]/.test(text);
  const hasContext = contextChunks && contextChunks.length > 0;

  if (!hasNonLatin && !hasContext) {
    // Already English, no context needed — return as-is
    return text;
  }

  if (hasContext && groqApiKeys.length > 0) {
    // Use LLaMA for context-aware translation
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

  // Fallback: Google Translate
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data[0].map(c => c[0]).join(" ").trim() || text;
  } catch {
    return text;
  }
}

// Legacy plain translate (kept for internal use by summarise route)
async function translateToEnglish(text) {
  if (!text) return "";
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data[0].map(c => c[0]).join(" ").trim();
  } catch { return text; }
}

// ── Duplicate Detection (Similarity-based) ────────────────────────────────────
//
// Changed from old approach:
//   OLD: exact string match, 10s TTL — too aggressive on legitimate repetition
//   NEW: similarity score via Jaccard on word sets, 5s TTL
//        only block if >85% similar (near-identical strings)

const recentTranscripts = new Map(); // key → { text, time }

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

// ── Buffer Flush Logic ────────────────────────────────────────────────────────

async function flushBuffer(bufferKey, session_id, source) {
  const buf = transcriptBuffers.get(bufferKey);
  if (!buf || buf.chunks.length === 0) return;

  // Clear the idle timer
  if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }

  const rawText = buf.chunks.join(" ").trim();
  buf.chunks = [];

  if (!rawText) return;

  // Duplicate check on the flushed sentence
  const cacheKey = `${session_id}:${source}`;
  if (isDuplicate(cacheKey, rawText)) {
    console.log(`[${session_id}] buffered duplicate skipped`);
    return;
  }
  cacheTranscript(cacheKey, rawText);

  // Context-aware translation
  const context = getTranslationContext(session_id);
  const translated = await translateWithContext(rawText, context);
  pushTranslationContext(session_id, translated);

  console.log(`[${session_id}][${source}] flushed: "${rawText}" → "${translated}"`);

  // Persist to MongoDB
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

  // Emit the flushed result so the HTTP response can return it
  // (stored on buf for polling by the pending request)
  buf.flushedResults = buf.flushedResults || [];
  buf.flushedResults.push({ text: translated, timestamp, raw: rawText });
}

// ── Transcribe Route ──────────────────────────────────────────────────────────

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  const { session_id, source } = req.body;
  if (!session_id) return res.status(400).json({ error: "session_id required" });
  if (!req.file) return res.status(400).json({ error: "audio required" });

  try {
    const original = await callGroqWhisper(req.file.buffer, req.file.mimetype);
    if (!original) return res.json({ text: "" });

    console.log(`[${session_id}][${source}] raw: ${original}`);

    if (isHallucination(original)) {
      console.log(`[${session_id}] filtered hallucination: "${original}"`);
      return res.json({ text: "" });
    }

    // ── Smart Buffering ──
    // Instead of translating and returning immediately, append to the buffer.
    // If the chunk ends a sentence (. ? !) OR is long enough, flush immediately.
    // Otherwise set/reset an idle timer that flushes after silence.

    const bufferKey = `${session_id}:${source}`;
    let buf = transcriptBuffers.get(bufferKey);
    if (!buf) {
      buf = { chunks: [], timer: null, flushedResults: [] };
      transcriptBuffers.set(bufferKey, buf);
    }

    buf.chunks.push(original);

    // Determine if we should flush now
    const shouldFlushNow =
      SENTENCE_END_RE.test(original) ||          // ends with punctuation
      buf.chunks.join(" ").split(/\s+/).length >= 20; // accumulated ≥20 words

    if (shouldFlushNow) {
      await flushBuffer(bufferKey, session_id, source);
    } else {
      // Reset idle timer — flush after BUFFER_IDLE_MS of silence
      if (buf.timer) clearTimeout(buf.timer);
      buf.timer = setTimeout(async () => {
        await flushBuffer(bufferKey, session_id, source);
      }, BUFFER_IDLE_MS);
    }

    // Return any results that were flushed in this call
    const results = buf.flushedResults.splice(0);
    if (results.length > 0) {
      const last = results[results.length - 1];
      return res.json({ text: last.text, timestamp: last.timestamp });
    }

    // Nothing flushed yet — chunk is buffering, return empty so UI waits
    return res.json({ text: "", buffering: true });

  } catch (err) {
    console.error("Transcribe error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Summarise ─────────────────────────────────────────────────────────────────

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

// ── Session Routes ────────────────────────────────────────────────────────────

app.post("/start-session", async (req, res) => {
  const session_id = req.body?.session_id || Date.now().toString();
  try {
    await Session.create({ session_id });
    // Clear any stale buffers for a reused session_id
    for (const key of transcriptBuffers.keys()) {
      if (key.startsWith(session_id + ":")) transcriptBuffers.delete(key);
    }
    translationContext.delete(session_id);
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

// ── AI Insights ───────────────────────────────────────────────────────────────
// Unchanged from original — uses existing Groq rotation, no new env vars needed.
// Called only when user clicks "Generate AI Insights" (frontend-triggered).
// Source: MongoDB transcript (fetched by frontend before calling this).

app.post("/ai-insights", async (req, res) => {
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

// ── Study Vault Routes ────────────────────────────────────────────────────────
// NEW: Save and retrieve Study Vault entries from MongoDB.
// The frontend sends the full insights object; we persist it with session_id.

app.post("/vault/save", async (req, res) => {
  const { session_id, transcript, summary, keyPoints, actionItems, flashcards, quiz } = req.body;
  if (!session_id) return res.status(400).json({ error: "session_id required" });

  try {
    const entry = await VaultEntry.create({
      session_id,
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

app.get("/vault", async (req, res) => {
  try {
    const entries = await VaultEntry.find()
      .sort({ savedAt: -1 })
      .select("-transcript"); // exclude large transcript from listing
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/vault/:id", async (req, res) => {
  try {
    const entry = await VaultEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ error: "Not found" });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Root ──────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.json({ status: "ok", service: "AI Meeting Intelligence" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));