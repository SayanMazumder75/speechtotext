// src/utils/exportWord.js

import { Document, Packer, Paragraph, TextRun } from "docx";
import { saveAs } from "file-saver";

export const exportWord = async (report) => {
  const children = [];

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "MEETMIND AI Learning",
          bold: true,
          size: 32
        })
      ]
    })
  );

  children.push(new Paragraph("AI Meeting & Learning Report"));
  children.push(new Paragraph(""));
  children.push(new Paragraph(`Session: ${report.sessionName}`));
  children.push(new Paragraph(`Generated: ${report.generatedAt}`));
  children.push(new Paragraph(""));

  // Executive Summary
  if (report.summary && report.summary.trim() !== "") {
    children.push(new Paragraph({ text: "Executive Summary", heading: "Heading2" }));
    children.push(new Paragraph(report.summary));
    children.push(new Paragraph(""));
  }

  // Transcript Guide
  children.push(new Paragraph({ text: "Transcript Guide", heading: "Heading2" }));
  children.push(new Paragraph("Bold Text = System Audio"));
  children.push(new Paragraph("Normal Text = Microphone Input"));
  children.push(new Paragraph(""));

  // Smart Transcript
  children.push(new Paragraph({ text: "Smart Transcript", heading: "Heading2" }));
  report.transcriptBlocks.forEach(block => {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: block.text,
            bold: block.type === "system"
          })
        ]
      })
    );
  });
  children.push(new Paragraph(""));

  // Session Statistics
  children.push(new Paragraph({ text: "Session Statistics", heading: "Heading2" }));
  children.push(new Paragraph(`Total Entries: ${report.totalEntries}`));
  children.push(new Paragraph(`Microphone Entries: ${report.micEntries}`));
  children.push(new Paragraph(`System Entries: ${report.systemEntries}`));
  children.push(new Paragraph(`Total Words: ${report.totalWords}`));
  children.push(new Paragraph(`Microphone Words: ${report.micWords}`));
  children.push(new Paragraph(`System Words: ${report.systemWords}`));

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  saveAs(blob, "MEETMIND_Report.docx");
};