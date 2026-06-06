// src/utils/exportPdf.js

import jsPDF from "jspdf";

export const exportPDF = (
  report
) => {

  const doc = new jsPDF();

  let y = 20;

  doc.setFontSize(22);
  doc.text(
    report.appName,
    15,
    y
  );

  y += 12;

  doc.setFontSize(14);

  doc.text(
    "AI Meeting & Learning Report",
    15,
    y
  );

  y += 15;

  doc.setFontSize(11);

  doc.text(
    `Session: ${report.sessionName}`,
    15,
    y
  );

  y += 8;

  doc.text(
    `Generated: ${report.generatedAt}`,
    15,
    y
  );

  y += 15;

  doc.setFont(
    "helvetica",
    "bold"
  );

  doc.text(
    "Transcript Guide",
    15,
    y
  );

  y += 8;

  doc.setFont(
    "helvetica",
    "normal"
  );

  doc.text(
    "Bold Text = System Audio",
    15,
    y
  );

  y += 7;

  doc.text(
    "Normal Text = Microphone Input",
    15,
    y
  );

  y += 15;

  doc.setFont(
    "helvetica",
    "bold"
  );

  doc.text(
    "Smart Transcript",
    15,
    y
  );

  y += 10;

  report.transcriptBlocks.forEach(
    (block) => {

      doc.setFont(
        "helvetica",
        block.type === "system"
          ? "bold"
          : "normal"
      );

      const lines =
        doc.splitTextToSize(
          block.text,
          180
        );

      doc.text(
        lines,
        15,
        y
      );

      y +=
        lines.length * 7 +
        5;

      if (y > 270) {

        doc.addPage();

        y = 20;
      }
    }
  );

  y += 10;

  doc.setFont(
    "helvetica",
    "bold"
  );

  doc.text(
    "Session Statistics",
    15,
    y
  );

  y += 10;

  doc.setFont(
    "helvetica",
    "normal"
  );

  doc.text(
    `Total Entries: ${report.totalEntries}`,
    15,
    y
  );

  y += 8;

  doc.text(
    `Microphone Entries: ${report.micEntries}`,
    15,
    y
  );

  y += 8;

  doc.text(
    `System Entries: ${report.systemEntries}`,
    15,
    y
  );

  doc.save(
    "MEETMIND_Report.pdf"
  );
};