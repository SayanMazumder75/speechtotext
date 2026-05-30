// import { useEffect, useRef, useState } from "react";
// import axios from "axios";
// import jsPDF from "jspdf";
// import { saveAs } from "file-saver";

// import {
//   Document,
//   Packer,
//   Paragraph
// } from "docx";

// import {
//   Moon,
//   Sun,
//   Play,
//   Square,
//   Download
// } from "lucide-react";

// import "./index.css";

// function App() {

//   // --------------------------------
//   // STATES
//   // --------------------------------
//   const [text, setText] = useState("");

//   const [darkMode, setDarkMode] =
//     useState(true);

//   const [isRunning, setIsRunning] =
//     useState(false);

//   const [transcripts, setTranscripts] =
//     useState([]);

//   const [selectedFile, setSelectedFile] =
//     useState("");

//   const textareaRef = useRef(null);

//   const [audioFiles, setAudioFiles] =
//     useState([]);

//   const [selectedAudio, setSelectedAudio] =
//     useState("");

//   const [isAudioRecording, setIsAudioRecording] =
//     useState(false);

//   // --------------------------------
//   // START SESSION
//   // --------------------------------
//   const startSession = async () => {

//     try {

//       const res = await axios.get(
//         "http://localhost:5000/start-session"
//       );

//       const newFile =
//         res.data.filename;

//       setSelectedFile(newFile);

//       setText("");

//       setIsRunning(true);
//       setIsAudioRecording(true);

//     } catch (err) {

//       console.log(err);
//     }
//   };

//   // --------------------------------
//   // STOP SESSION
//   // --------------------------------
//   const stopSession = () => {

//     setIsRunning(false);
//     setIsAudioRecording(false);
//   };

//   // --------------------------------
//   // LOAD TRANSCRIPT LIST
//   // --------------------------------
//   useEffect(() => {

//     const interval = setInterval(
//       async () => {

//         try {

//           const filesRes =
//             await axios.get(
//               "http://localhost:5000/transcripts"
//             );

//           setTranscripts(
//             filesRes.data
//           );

//           const audioRes =
//             await axios.get(
//               "http://localhost:5000/audio-files"
//             );

//           setAudioFiles(
//             audioRes.data
//           );

//         } catch (err) {

//           console.log(err);
//         }

//       },
//       2000
//     );

//     return () =>
//       clearInterval(interval);

//   }, []);

//   // --------------------------------
//   // LIVE FETCH CURRENT FILE
//   // --------------------------------
//   useEffect(() => {

//     let interval;

//     if (
//       isRunning &&
//       selectedFile
//     ) {

//       interval = setInterval(
//         async () => {

//           try {

//             const res =
//               await axios.get(
//                 `http://localhost:5000/transcript/${selectedFile}`
//               );

//             setText(
//               res.data.text
//             );

//           } catch (err) {

//             console.log(err);
//           }

//         },
//         2000
//       );
//     }

//     return () =>
//       clearInterval(interval);

//   }, [
//     isRunning,
//     selectedFile
//   ]);

//   // --------------------------------
//   // AUTO SCROLL
//   // --------------------------------
//   useEffect(() => {

//     if (
//       textareaRef.current
//     ) {

//       textareaRef.current.scrollTop =
//         textareaRef.current.scrollHeight;
//     }

//   }, [text]);

//   // --------------------------------
//   // LOAD OLD FILE
//   // --------------------------------
//   const loadTranscript =
//     async (filename) => {

//       try {

//         setSelectedFile(
//           filename
//         );

//         const res =
//           await axios.get(
//             `http://localhost:5000/transcript/${filename}`
//           );

//         setText(
//           res.data.text
//         );

//       } catch (err) {

//         console.log(err);
//       }
//     };

//   // --------------------------------
//   // PDF DOWNLOAD
//   // --------------------------------
//   const downloadPDF = () => {

//     const doc = new jsPDF();

//     doc.text(
//       text,
//       10,
//       10
//     );

//     doc.save(
//       "translation.pdf"
//     );
//   };

//   // --------------------------------
//   // WORD DOWNLOAD
//   // --------------------------------
//   const downloadWord = async () => {

//     const doc =
//       new Document({

//         sections: [
//           {
//             properties: {},

//             children: [
//               new Paragraph(
//                 text
//               )
//             ]
//           }
//         ]
//       });

//     const blob =
//       await Packer.toBlob(
//         doc
//       );

//     saveAs(
//       blob,
//       "translation.docx"
//     );
//   };

//   // --------------------------------
//   // UI
//   // --------------------------------
//   return (

//     <div
//       className={
//         darkMode
//           ? "app dark"
//           : "app"
//       }
//     >

//       {/* HEADER */}
//       <div className="header">

//         <div>

//           <h1>
//             AI Live Translator
//           </h1>

//           <p className="subtitle">
//             Real-time multilingual subtitle system
//           </p>

//         </div>

//         <button
//           onClick={() =>
//             setDarkMode(
//               !darkMode
//             )
//           }
//           className="theme-btn"
//         >

//           {
//             darkMode
//               ? <Sun size={20} />
//               : <Moon size={20} />
//           }

//         </button>

//       </div>

//       {/* CONTROLS */}
//       <div className="controls">

//         <div className="left-controls">

//           <button
//             onClick={
//               startSession
//             }
//             className="
//               main-btn
//               start-btn
//             "
//           >

//             <Play size={18} />

//             Start

//           </button>

//           <button
//             onClick={
//               stopSession
//             }
//             className="
//               main-btn
//               stop-btn
//             "
//           >

//             <Square size={18} />

//             Stop

//           </button>

//           <button
//             onClick={
//               downloadPDF
//             }
//             className="
//               main-btn
//             "
//           >

//             <Download size={18} />

//             PDF

//           </button>

//           <button
//             onClick={
//               downloadWord
//             }
//             className="
//               main-btn
//             "
//           >

//             <Download size={18} />

//             Word

//           </button>

//         </div>

//         {/* DROPDOWN ONLY WHEN STOPPED */}
//         <div className="right-controls">

//           {!isRunning && (

//             <>
//               {/* Previous Transcripts */}
//               <select
//                 value={selectedFile}
//                 onChange={(e) =>
//                   loadTranscript(
//                     e.target.value
//                   )
//                 }
//                 className="dropdown"
//               >

//                 <option value="">
//                   Previous Transcripts
//                 </option>

//                 {transcripts.map(
//                   (file) => (

//                     <option
//                       key={file}
//                       value={file}
//                     >

//                       {file}

//                     </option>

//                   )
//                 )}

//               </select>

//               {/* Previous Audio */}
//               <select
//                 value={selectedAudio}
//                 onChange={(e) =>
//                   setSelectedAudio(
//                     e.target.value
//                   )
//                 }
//                 className="dropdown"
//               >

//                 <option value="">
//                   Previous Audio
//                 </option>

//                 {audioFiles.map(
//                   (file) => (

//                     <option
//                       key={file}
//                       value={file}
//                     >

//                       {file}

//                     </option>

//                   )
//                 )}

//               </select>

//               {/* ADDED: Audio preview player — appears when an audio file is selected */}
//               {selectedAudio && (
//                 <audio
//                   key={selectedAudio}
//                   controls
//                   className="audio-preview"
//                   src={`http://localhost:5000/audio/${selectedAudio}`}
//                 />
//               )}

//             </>

//           )}

//         </div>

//       </div>

//       {/* STATUS */}
//       <div className="status">

//         <div
//           className={
//             isRunning
//               ? "status-dot active"
//               : "status-dot"
//           }
//         />

//         <span>

//           {
//             isRunning
//               ? "Translation Running"
//               : "Translation Stopped"
//           }

//         </span>

//         <div
//           className={
//             isAudioRecording
//               ? "audio-dot active"
//               : "audio-dot"
//           }
//         />

//         <span>

//           {
//             isAudioRecording
//               ? "Audio Recording"
//               : "Audio Stopped"
//           }

//         </span>

//       </div>

//       {/* TRANSCRIPT */}
//       <div
//         className="
//           transcript-container
//         "
//       >

//         <textarea

//           ref={textareaRef}

//           value={text}

//           readOnly

//           rows={22}

//           placeholder="
//             Live subtitles...
//           "

//           className="
//             transcript-box
//           "
//         />

//       </div>

//     </div>
//   );
// }

// export default App;

import { useEffect, useRef, useState } from "react";
import axios from "axios";
import jsPDF from "jspdf";
import { saveAs } from "file-saver";

import {
  Document,
  Packer,
  Paragraph
} from "docx";

import {
  Moon,
  Sun,
  Play,
  Square,
  Download
} from "lucide-react";

import "./index.css";

// --------------------------------
// CHANGE THIS to your Render URL
// --------------------------------
const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

function App() {

  // --------------------------------
  // STATES
  // --------------------------------
  const [text, setText] = useState("");

  const [darkMode, setDarkMode] =
    useState(true);

  const [isRunning, setIsRunning] =
    useState(false);

  const [transcripts, setTranscripts] =
    useState([]);

  const [selectedFile, setSelectedFile] =
    useState("");

  const textareaRef = useRef(null);

  const [selectedAudio, setSelectedAudio] =
    useState("");

  const [isAudioRecording, setIsAudioRecording] =
    useState(false);

  const [audioAvailable, setAudioAvailable] =
    useState(false);

  // --------------------------------
  // START SESSION
  // --------------------------------
  const startSession = async () => {

    try {

      const res = await axios.get(
        `${API}/start-session`
      );

      const newFile = res.data.session_id || res.data.filename;

      setSelectedFile(newFile);
      setSelectedAudio(newFile);
      setText("");
      setAudioAvailable(false);
      setIsRunning(true);
      setIsAudioRecording(true);

    } catch (err) {

      console.log(err);
    }
  };

  // --------------------------------
  // STOP SESSION
  // --------------------------------
  const stopSession = () => {

    setIsRunning(false);
    setIsAudioRecording(false);

    // Check if audio was recorded for this session
    if (selectedFile) {
      checkAudioAvailable(selectedFile);
    }
  };

  // --------------------------------
  // CHECK AUDIO AVAILABLE
  // --------------------------------
  const checkAudioAvailable = async (sessionId) => {

    try {

      const res = await axios.get(
        `${API}/audio-exists/${sessionId}`
      );

      setAudioAvailable(res.data.hasAudio);

    } catch {

      setAudioAvailable(false);
    }
  };

  // --------------------------------
  // DOWNLOAD AUDIO
  // --------------------------------
  const downloadAudio = () => {

    if (!selectedAudio) return;

    // Direct browser download via link
    const link = document.createElement("a");
    link.href = `${API}/audio/${selectedAudio}`;
    link.download = `session_${selectedAudio}.wav`;
    link.click();
  };

  // --------------------------------
  // LOAD TRANSCRIPT LIST
  // --------------------------------
  useEffect(() => {

    const interval = setInterval(
      async () => {

        try {

          const filesRes = await axios.get(
            `${API}/transcripts`
          );

          // API now returns [{id, label}] objects
          setTranscripts(filesRes.data);

        } catch (err) {

          console.log(err);
        }

      },
      2000
    );

    return () => clearInterval(interval);

  }, []);

  // --------------------------------
  // LIVE FETCH CURRENT FILE
  // --------------------------------
  useEffect(() => {

    let interval;

    if (isRunning && selectedFile) {

      interval = setInterval(
        async () => {

          try {

            const res = await axios.get(
              `${API}/transcript/${selectedFile}`
            );

            setText(res.data.text);

          } catch (err) {

            console.log(err);
          }

        },
        2000
      );
    }

    return () => clearInterval(interval);

  }, [isRunning, selectedFile]);

  // --------------------------------
  // AUTO SCROLL
  // --------------------------------
  useEffect(() => {

    if (textareaRef.current) {
      textareaRef.current.scrollTop =
        textareaRef.current.scrollHeight;
    }

  }, [text]);

  // --------------------------------
  // LOAD OLD SESSION
  // --------------------------------
  const loadTranscript = async (sessionId) => {

    try {

      setSelectedFile(sessionId);
      setSelectedAudio(sessionId);

      const res = await axios.get(
        `${API}/transcript/${sessionId}`
      );

      setText(res.data.text);

      // Check if audio exists for this session
      checkAudioAvailable(sessionId);

    } catch (err) {

      console.log(err);
    }
  };

  // --------------------------------
  // PDF DOWNLOAD
  // --------------------------------
  const downloadPDF = () => {

    const doc = new jsPDF();
    doc.text(text, 10, 10);
    doc.save("translation.pdf");
  };

  // --------------------------------
  // WORD DOWNLOAD
  // --------------------------------
  const downloadWord = async () => {

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: [new Paragraph(text)]
        }
      ]
    });

    const blob = await Packer.toBlob(doc);
    saveAs(blob, "translation.docx");
  };

  // --------------------------------
  // UI
  // --------------------------------
  return (

    <div className={darkMode ? "app dark" : "app"}>

      {/* HEADER */}
      <div className="header">

        <div>
          <h1>AI Live Translator</h1>
          <p className="subtitle">Real-time multilingual subtitle system</p>
        </div>

        <button
          onClick={() => setDarkMode(!darkMode)}
          className="theme-btn"
        >
          {darkMode ? <Sun size={20} /> : <Moon size={20} />}
        </button>

      </div>

      {/* CONTROLS */}
      <div className="controls">

        <div className="left-controls">

          <button
            onClick={startSession}
            className="main-btn start-btn"
          >
            <Play size={18} />
            Start
          </button>

          <button
            onClick={stopSession}
            className="main-btn stop-btn"
          >
            <Square size={18} />
            Stop
          </button>

          <button
            onClick={downloadPDF}
            className="main-btn"
          >
            <Download size={18} />
            PDF
          </button>

          <button
            onClick={downloadWord}
            className="main-btn"
          >
            <Download size={18} />
            Word
          </button>

        </div>

        {/* DROPDOWNS + AUDIO — only when stopped */}
        <div className="right-controls">

          {!isRunning && (

            <>
              {/* Previous Sessions */}
              <select
                value={selectedFile}
                onChange={(e) => loadTranscript(e.target.value)}
                className="dropdown"
              >
                <option value="">Previous Transcripts</option>
                {transcripts.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.label}
                  </option>
                ))}
              </select>

              {/* Download Audio button — only if audio exists */}
              {audioAvailable && selectedAudio && (
                <button
                  onClick={downloadAudio}
                  className="main-btn audio-dl-btn"
                >
                  <Download size={18} />
                  Download Audio
                </button>
              )}

            </>

          )}

        </div>

      </div>

      {/* STATUS */}
      <div className="status">

        <div className={isRunning ? "status-dot active" : "status-dot"} />

        <span>
          {isRunning ? "Translation Running" : "Translation Stopped"}
        </span>

        <div className={isAudioRecording ? "audio-dot active" : "audio-dot"} />

        <span>
          {isAudioRecording ? "Audio Recording" : "Audio Stopped"}
        </span>

      </div>

      {/* TRANSCRIPT */}
      <div className="transcript-container">

        <textarea
          ref={textareaRef}
          value={text}
          readOnly
          rows={22}
          placeholder="Live subtitles..."
          className="transcript-box"
        />

      </div>

    </div>
  );
}

export default App;