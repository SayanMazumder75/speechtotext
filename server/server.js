const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// --------------------------------
// MONGODB CONNECTION
// --------------------------------
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB error:", err));

// --------------------------------
// SCHEMA
// --------------------------------
const sessionSchema = new mongoose.Schema({
  session_id: { type: String, required: true, unique: true },
  text: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
});

const Session = mongoose.model("Session", sessionSchema);

// --------------------------------
// START SESSION (Frontend)
// --------------------------------
app.post("/start-session", async (req, res) => {
  const session_id = Date.now().toString();

  try {
    await Session.create({ session_id });
    console.log(`Session started: ${session_id}`);
    res.json({ success: true, session_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------
// PUSH TEXT (Frontend sends transcript)
// --------------------------------
app.post("/push", async (req, res) => {
  const { session_id, text } = req.body;

  if (!session_id || !text) {
    return res.status(400).json({ error: "session_id and text required" });
  }

  try {
    await Session.findOneAndUpdate(
      { session_id },
      { $set: { text: await getAppendedText(session_id, text) } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: append new text to existing
async function getAppendedText(session_id, newText) {
  const session = await Session.findOne({ session_id });
  if (!session) return newText;
  return session.text + newText + "\n";
}

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
// GET TRANSCRIPT TEXT
// --------------------------------
app.get("/transcript/:session_id", async (req, res) => {
  try {
    const session = await Session.findOne({
      session_id: req.params.session_id
    });

    if (!session) {
      return res.status(404).json({ error: "Not found" });
    }

    res.json({ text: session.text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------
// DELETE SESSION
// --------------------------------
app.delete("/transcript/:session_id", async (req, res) => {
  try {
    await Session.findOneAndDelete({
      session_id: req.params.session_id
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------
// HEALTH CHECK
// --------------------------------
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));