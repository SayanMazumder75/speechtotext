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
      // ❌ DO NOT APPEND "task" – Groq does NOT support it
      // formData.append("task", "translate");

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

      // Hallucination filter (unchanged)
      const HALLUCINATIONS = [
        "thank you", "thanks", "bye", "goodbye", "you", "no", "yes",
        "okay", "ok", "hmm", "um", "uh", "ah", "oh", ".", "...", " ",
        "subscribe", "like", "share", "please", "welcome", "hello"
      ];
      if (transcript && HALLUCINATIONS.some(h => transcript.toLowerCase().trim() === h.toLowerCase())) {
        return "";
      }
      if (transcript && transcript.split(" ").length <= 1 && transcript.length < 8) {
        return "";
      }
      return transcript;
    } catch (err) {
      console.error(`Attempt ${attempt+1} failed with key ${apiKey?.slice(0,5)}:`, err.message);
      lastError = err;
    }
  }
  throw new Error(`All Groq keys failed: ${lastError?.message}`);
}

// --------------------------------
// START SESSION (POST)
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
// PUSH TEXT (manual lines)
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
// TRANSCRIBE (receives audio from browser)
// --------------------------------
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  const { session_id, source } = req.body;
  if (!session_id) return res.status(400).json({ error: "session_id required" });
  if (!req.file) return res.status(400).json({ error: "audio file required" });

  try {
    const transcript = await callGroqWhisper(req.file.buffer, req.file.mimetype);
    if (transcript) {
      const tagged = `[${source?.toUpperCase() || "SYSTEM"}] ${transcript}`;
      const session = await Session.findOne({ session_id });
      if (session) {
        await Session.findOneAndUpdate(
          { session_id },
          { text: session.text + tagged + "\n" }
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
// SUMMARISE via Groq (LLaMA)
// --------------------------------
app.post("/summarise", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.json({ summary: "" });

  try {
    // Use the same load balancing for summarisation? For simplicity, use first key.
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
    console.error("Summarise error:", err);
    res.json({ summary: text });
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
// GET SINGLE TRANSCRIPT
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
// HEALTH CHECK
// --------------------------------
app.get("/", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));