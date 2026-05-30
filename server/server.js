// const express = require("express");
// const fs = require("fs");
// const path = require("path");
// const cors = require("cors");
// const app = express();

// app.use(cors());

// const TRANSCRIBE_FOLDER = path.join(
//   __dirname,
//   "transcribe"
// );

// const RECORD_FOLDER = path.join(
//   __dirname,
//   "Record"
// );

// app.get("/start-session", (req, res) => {

//   const timestamp = new Date()
//     .toISOString()
//     .replace(/[:.]/g, "-");

//   const filename = `transcript_${timestamp}.txt`;

//   const filePath = path.join(
//     TRANSCRIBE_FOLDER,
//     filename
//   );

//   // Create empty transcript file
//   fs.writeFileSync(filePath, "");

//   // Save current session
//   fs.writeFileSync(
//     path.join(
//       __dirname,
//       "current_session.txt"
//     ),
//     filename
//   );

//   res.json({ success: true, filename });
// });

// // -----------------------------------
// // GET LATEST TRANSCRIPT
// // -----------------------------------
// app.get("/transcript", (req, res) => {

//   fs.readdir(
//     TRANSCRIBE_FOLDER,
//     (err, files) => {

//       if (err || files.length === 0) {
//         return res.json({ text: "" });
//       }

//       // Get latest file
//       const latestFile = files
//         .filter(file => file.endsWith(".txt"))
//         .sort()
//         .reverse()[0];

//       const filePath = path.join(
//         TRANSCRIBE_FOLDER,
//         latestFile
//       );

//       fs.readFile(
//         filePath,
//         "utf8",
//         (err, data) => {

//           if (err) {
//             return res.json({ text: "" });
//           }

//           res.json({ file: latestFile, text: data });
//         }
//       );
//     }
//   );
// });

// // -----------------------------------
// // GET ALL TRANSCRIPTS
// // -----------------------------------
// app.get("/transcripts", (req, res) => {

//   fs.readdir(
//     TRANSCRIBE_FOLDER,
//     (err, files) => {

//       if (err) {
//         return res.json([]);
//       }

//       const transcriptFiles = files
//         .filter(file => file.endsWith(".txt"))
//         .sort()
//         .reverse();

//       res.json(transcriptFiles);
//     }
//   );
// });

// // -----------------------------------
// // GET SPECIFIC TRANSCRIPT
// // -----------------------------------
// app.get("/transcript/:filename", (req, res) => {

//   const filePath = path.join(
//     TRANSCRIBE_FOLDER,
//     req.params.filename
//   );

//   fs.readFile(
//     filePath,
//     "utf8",
//     (err, data) => {

//       if (err) {
//         return res.status(404).json({
//           error: "File not found"
//         });
//       }

//       res.json({ text: data });
//     }
//   );
// });

// // -----------------------------------
// // GET ALL AUDIO FILES
// // -----------------------------------
// app.get("/audio-files", (req, res) => {

//   if (!fs.existsSync(RECORD_FOLDER)) {
//     return res.json([]);
//   }

//   const files = fs.readdirSync(RECORD_FOLDER)
//     .filter(file => file.endsWith(".wav"))
//     .sort()
//     .reverse();

//   res.json(files);
// });

// // -----------------------------------
// // ADDED: STREAM AUDIO FILE
// // Supports range requests so the
// // browser <audio> player can seek
// // -----------------------------------
// app.get("/audio/:filename", (req, res) => {

//   const filePath = path.join(
//     RECORD_FOLDER,
//     req.params.filename
//   );

//   if (!fs.existsSync(filePath)) {
//     return res.status(404).send("Not found");
//   }

//   const stat = fs.statSync(filePath);
//   const range = req.headers.range;

//   if (range) {

//     const parts = range
//       .replace(/bytes=/, "")
//       .split("-");

//     const start = parseInt(parts[0], 10);

//     const end = parts[1]
//       ? parseInt(parts[1], 10)
//       : stat.size - 1;

//     const chunkSize = end - start + 1;

//     res.writeHead(206, {
//       "Content-Range": `bytes ${start}-${end}/${stat.size}`,
//       "Accept-Ranges": "bytes",
//       "Content-Length": chunkSize,
//       "Content-Type": "audio/wav",
//     });

//     fs.createReadStream(filePath, { start, end }).pipe(res);

//   } else {

//     res.writeHead(200, {
//       "Content-Length": stat.size,
//       "Content-Type": "audio/wav",
//       "Accept-Ranges": "bytes",
//     });

//     fs.createReadStream(filePath).pipe(res);
//   }
// });

// app.listen(5000, () => {
//   console.log(
//     "Server running on port 5000"
//   );
// });

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// --------------------------------
// IN-MEMORY STORE
// sessions = {
//   sessionId: {
//     text: "",
//     audioChunks: [ base64string, ... ]
//   }
// }
// --------------------------------
const sessions = {};

// --------------------------------
// START SESSION (Python recorder)
// --------------------------------
app.post("/start-session", (req, res) => {

    const { session_id } = req.body;

    if (!session_id) {
        return res.status(400).json({ error: "session_id required" });
    }

    sessions[session_id] = {
        text: "",
        audioChunks: [],
        createdAt: new Date().toISOString()
    };

    console.log(`Session started: ${session_id}`);

    res.json({ success: true, session_id });
});

// --------------------------------
// START SESSION (Frontend button)
// --------------------------------
app.get("/start-session", (req, res) => {

    const session_id = Date.now().toString();

    sessions[session_id] = {
        text: "",
        audioChunks: [],
        createdAt: new Date().toISOString()
    };

    console.log(`Session started (frontend): ${session_id}`);

    res.json({ success: true, session_id, filename: session_id });
});

// --------------------------------
// PUSH — Python sends text + audio chunk
// --------------------------------
app.post("/push", (req, res) => {

    const { session_id, text, audio_b64 } = req.body;

    if (!session_id || !sessions[session_id]) {
        return res.status(404).json({ error: "Session not found" });
    }

    if (text) {
        sessions[session_id].text += text + "\n";
    }

    if (audio_b64) {
        sessions[session_id].audioChunks.push(audio_b64);
    }

    res.json({ ok: true });
});

// --------------------------------
// GET ALL SESSIONS (transcript list)
// --------------------------------
app.get("/transcripts", (req, res) => {

    const list = Object.keys(sessions)
        .sort()
        .reverse()
        .map(id => ({
            id,
            label: `Session ${new Date(sessions[id].createdAt).toLocaleTimeString()}`
        }));

    res.json(list);
});

// --------------------------------
// GET TRANSCRIPT TEXT
// --------------------------------
app.get("/transcript/:session_id", (req, res) => {

    const session = sessions[req.params.session_id];

    if (!session) {
        return res.status(404).json({ error: "Not found" });
    }

    res.json({ text: session.text });
});

// --------------------------------
// DOWNLOAD AUDIO — sends merged WAV
// --------------------------------
app.get("/audio/:session_id", (req, res) => {

    const session = sessions[req.params.session_id];

    if (!session || session.audioChunks.length === 0) {
        return res.status(404).json({ error: "No audio found" });
    }

    const buffers = session.audioChunks.map(b64 =>
        Buffer.from(b64, "base64")
    );

    const combined = Buffer.concat(buffers);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="session_${req.params.session_id}.wav"`
    );

    res.send(combined);
});

// --------------------------------
// CHECK AUDIO EXISTS
// --------------------------------
app.get("/audio-exists/:session_id", (req, res) => {

    const session = sessions[req.params.session_id];

    const hasAudio = session && session.audioChunks.length > 0;

    res.json({ hasAudio });
});

// --------------------------------
// HEALTH CHECK (Render needs this)
// --------------------------------
app.get("/", (req, res) => {
    res.json({
        status: "ok",
        sessions: Object.keys(sessions).length
    });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});