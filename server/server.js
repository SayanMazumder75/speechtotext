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

// --------------------------------
// START SESSION (POST - Python/Frontend)
// --------------------------------
app.post("/start-session", async (req, res) => {
  const session_id = (req.body && req.body.session_id) ? req.body.session_id : Date.now().toString();
  try {
    await Session.create({ session_id });
    console.log(`Session started: ${session_id}`);
    res.json({ success: true, session_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------
// START SESSION (GET - legacy)
// --------------------------------
app.get("/start-session", async (req, res) => {
  const session_id = Date.now().toString();
  try {
    await Session.create({ session_id });
    res.json({ success: true, session_id, filename: session_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------
// PUSH TEXT
// --------------------------------
app.post("/push", async (req, res) => {
  const { session_id, text } = req.body;
  if (!session_id || !text) return res.status(400).json({ error: "missing fields" });
  try {
    const session = await Session.findOne({ session_id });
    if (!session) return res.status(404).json({ error: "session not found" });
    await Session.findOneAndUpdate(
      { session_id },
      { text: session.text + text + "\n" }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------
// WHISPER TRANSCRIBE + TRANSLATE
// Receives audio blob from browser
// --------------------------------
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  const { session_id } = req.body;

  if (!session_id) return res.status(400).json({ error: "session_id required" });
  if (!req.file) return res.status(400).json({ error: "audio file required" });

  try {
    const formData = new FormData();
    formData.append("file", req.file.buffer, {
      filename: "audio.webm",
      contentType: req.file.mimetype || "audio/webm",
    });
    formData.append("model", "whisper-large-v3");
    formData.append("response_format", "json");
    // Groq Whisper auto-detects language and transcribes
    // No "task" param supported — translation handled by server below

    const whisperRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    const whisperData = await whisperRes.json();

    if (whisperData.error) {
      console.error("Whisper error:", whisperData.error);
      return res.status(500).json({ error: whisperData.error.message });
    }

    let transcript = whisperData.text?.trim();
    console.log(`[${session_id}] Whisper raw: ${transcript}`);

    // Filter Whisper hallucinations — common fake outputs on silence
    const HALLUCINATIONS = [
      "thank you", "thanks", "bye", "goodbye", "you", "no", "yes",
      "okay", "ok", "hmm", "um", "uh", "ah", "oh", ".", "...", " ",
      "subscribe", "like", "share", "please", "welcome", "hello"
    ];
    if (transcript && HALLUCINATIONS.some(h =>
      transcript.toLowerCase().trim() === h.toLowerCase()
    )) {
      console.log(`[${session_id}] Hallucination filtered: ${transcript}`);
      return res.json({ text: "" });
    }
    // Also filter very short outputs (1-2 words likely hallucination)
    if (transcript && transcript.split(" ").length <= 1 && transcript.length < 8) {
      console.log(`[${session_id}] Too short, filtered: ${transcript}`);
      return res.json({ text: "" });
    }

    // Translate to English using Google free API
    if (transcript) {
      try {
        const translateRes = await fetch(
          `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(transcript)}`
        );
        const translateData = await translateRes.json();
        transcript = translateData[0].map(c => c[0]).join(" ").trim();
        console.log(`[${session_id}] Translated: ${transcript}`);
      } catch (e) {
        console.log("Translation failed, using original");
      }
    }

    if (transcript) {
      const session = await Session.findOne({ session_id });
      if (session) {
        await Session.findOneAndUpdate(
          { session_id },
          { text: session.text + transcript + "\n" }
        );
      }
    }

    res.json({ text: transcript || "" });

  } catch (err) {
    console.error("Transcribe error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------
// SUMMARISE via Claude (called from frontend)
// Avoids CORS — browser can't call Anthropic directly
// --------------------------------
app.post("/summarise", async (req, res) => {
  const { sentences } = req.body;
  if (!sentences || !sentences.length) return res.json({ summary: "" });

  try {
    const joined = sentences.join(" ");
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `Summarise the following transcribed audio into ONE concise sentence. Return ONLY the sentence, nothing else.

"${joined}"`
        }]
      })
    });
    const data = await anthropicRes.json();
    const summary = data?.content?.[0]?.text?.trim() || joined;
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------
// GET ALL SESSIONS
// --------------------------------
app.get("/transcripts", async (req, res) => {
  try {
    const list = await Session.find()
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

// --------------------------------
// GET TRANSCRIPT
// --------------------------------
app.get("/transcript/:session_id", async (req, res) => {
  try {
    const session = await Session.findOne({ session_id: req.params.session_id });
    if (!session) return res.status(404).json({ error: "Not found" });
    res.json({ text: session.text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------
// SUMMARISE via Groq (replaces Claude direct call)
// --------------------------------
app.post("/summarise", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.json({ summary: text });

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: `Summarise the following transcribed audio into ONE concise sentence. Return ONLY the summary, nothing else.

"${text}"`
          }
        ]
      })
    });
    const data = await groqRes.json();
    const summary = data?.choices?.[0]?.message?.content?.trim() || text;
    res.json({ summary });
  } catch (err) {
    res.json({ summary: text });
  }
});

// --------------------------------
// HEALTH
// --------------------------------
app.get("/", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));