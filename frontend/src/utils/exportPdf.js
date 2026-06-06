import jsPDF from "jspdf";

export const exportPDF = (report) => {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.width;
  const pageHeight = doc.internal.pageSize.height;
  const margin = 12; // inner margin from border
  const borderMargin = 5; // distance of border from edge

  // Function to draw border on current page
  const drawBorder = () => {
    doc.rect(
      borderMargin,
      borderMargin,
      pageWidth - borderMargin * 2,
      pageHeight - borderMargin * 2
    );
  };

  // Function to add centered text
  const centeredText = (text, y, fontSize, fontStyle = "normal") => {
    doc.setFontSize(fontSize);
    doc.setFont("helvetica", fontStyle);
    const textWidth = doc.getTextWidth(text);
    const x = (pageWidth - textWidth) / 2;
    doc.text(text, x, y);
  };

  let y = margin + 10; // start below border

  // Draw border on first page
  drawBorder();

  // ----- Centered Header Block -----
  centeredText(report.appName, y, 22, "bold");
  y += 10;
  centeredText("AI Meeting & Learning Report", y, 14, "normal");
  y += 12;
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  centeredText(`Session: ${report.sessionName}`, y, 11);
  y += 7;
  centeredText(`Generated: ${report.generatedAt}`, y, 11);
  y += 20;

  // ----- Executive Summary (if exists) -----
  if (report.summary && report.summary.trim() !== "") {
    doc.setFont("helvetica", "bold");
    doc.text("Executive Summary", margin, y);
    y += 8;
    doc.setFont("helvetica", "normal");
    const summaryLines = doc.splitTextToSize(report.summary, pageWidth - margin * 2);
    doc.text(summaryLines, margin, y);
    y += summaryLines.length * 7 + 10;
  }

  // ----- Transcript Guide -----
  doc.setFont("helvetica", "bold");
  doc.text("Transcript Guide", margin, y);
  y += 8;
  doc.setFont("helvetica", "normal");
  doc.text("Bold Text = System Audio", margin, y);
  y += 7;
  doc.text("Normal Text = Microphone Input", margin, y);
  y += 15;

  // ----- Smart Transcript -----
  doc.setFont("helvetica", "bold");
  doc.text("Smart Transcript", margin, y);
  y += 10;

  report.transcriptBlocks.forEach((block) => {
    // Check if we need a new page
    if (y > pageHeight - margin - 30) {
      doc.addPage();
      drawBorder();
      y = margin;
      // re-print section title on new page if needed
      doc.setFont("helvetica", "bold");
      doc.text("Smart Transcript (continued)", margin, y);
      y += 10;
    }
    doc.setFont("helvetica", block.type === "system" ? "bold" : "normal");
    const lines = doc.splitTextToSize(block.text, pageWidth - margin * 2);
    doc.text(lines, margin, y);
    y += lines.length * 7 + 5;
  });

  y += 10;

  // ----- Session Statistics -----
  if (y > pageHeight - margin - 50) {
    doc.addPage();
    drawBorder();
    y = margin;
  }
  doc.setFont("helvetica", "bold");
  doc.text("Session Statistics", margin, y);
  y += 10;
  doc.setFont("helvetica", "normal");
  doc.text(`Total Entries: ${report.totalEntries}`, margin, y); y += 8;
  doc.text(`Microphone Entries: ${report.micEntries}`, margin, y); y += 8;
  doc.text(`System Entries: ${report.systemEntries}`, margin, y); y += 8;
  doc.text(`Total Words: ${report.totalWords}`, margin, y); y += 8;
  doc.text(`Microphone Words: ${report.micWords}`, margin, y); y += 8;
  doc.text(`System Words: ${report.systemWords}`, margin, y); y += 12;

  // ----- Page Numbers (with border aware, but already have border) -----
  const addPageNumbers = () => {
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(100);
      const pageNumText = `Page ${i} of ${pageCount}`;
      const textWidth = doc.getTextWidth(pageNumText);
      const x = (pageWidth - textWidth) / 2;
      doc.text(pageNumText, x, pageHeight - borderMargin - 4);
      doc.setTextColor(0);
    }
  };
  addPageNumbers();

  doc.save("MEETMIND_Report.pdf");
};