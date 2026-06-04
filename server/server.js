const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer");
const FormData = require("form-data");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

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
  const session_id = req.body.session_id || Date.now().toString();
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
    formData.append("model", "whisper-1");
    formData.append("task", "translate"); // translate → always outputs English
    formData.append("language", "hi");    // hint: Hindi/multilingual input

    const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    const whisperData = await whisperRes.json();

    if (whisperData.error) {
      console.error("Whisper error:", whisperData.error);
      return res.status(500).json({ error: whisperData.error.message });
    }

    const transcript = whisperData.text?.trim();
    console.log(`[${session_id}] Whisper: ${transcript}`);

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
// HEALTH
// --------------------------------
app.get("/", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));