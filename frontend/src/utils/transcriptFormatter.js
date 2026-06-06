// src/utils/transcriptFormatter.js

export const createReportData = (lines, sessionName) => {
  const transcriptBlocks = [];
  let currentSystem = [];

  lines.forEach((line) => {
    if (line.source === "system") {
      currentSystem.push(line.text);
    } else {
      if (currentSystem.length) {
        transcriptBlocks.push({
          type: "system",
          text: currentSystem.join(" ")
        });
        currentSystem = [];
      }
      transcriptBlocks.push({
        type: "mic",
        text: line.text
      });
    }
  });

  if (currentSystem.length) {
    transcriptBlocks.push({
      type: "system",
      text: currentSystem.join(" ")
    });
  }

  // Word count calculations
  const totalWords = lines.reduce((acc, l) => acc + l.text.split(/\s+/).filter(w => w).length, 0);
  const micWords = lines.filter(l => l.source === "mic").reduce((acc, l) => acc + l.text.split(/\s+/).filter(w => w).length, 0);
  const systemWords = totalWords - micWords;

  return {
    appName: "MEETMIND AI Learning",
    sessionName,
    generatedAt: new Date().toLocaleString(),
    totalEntries: lines.length,
    micEntries: lines.filter(l => l.source === "mic").length,
    systemEntries: lines.filter(l => l.source === "system").length,
    totalWords,
    micWords,
    systemWords,
    transcriptBlocks,
    summary: ""   // will be filled before export
  };
};