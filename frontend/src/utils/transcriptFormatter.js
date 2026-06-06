// src/utils/transcriptFormatter.js

export const createReportData = (
  lines,
  sessionName
) => {

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

  return {

    appName:
      "MEETMIND AI Learning",

    sessionName,

    generatedAt:
      new Date().toLocaleString(),

    totalEntries:
      lines.length,

    micEntries:
      lines.filter(
        l => l.source === "mic"
      ).length,

    systemEntries:
      lines.filter(
        l => l.source === "system"
      ).length,

    transcriptBlocks
  };
};