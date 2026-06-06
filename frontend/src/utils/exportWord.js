import { Document, Packer, Paragraph, TextRun, AlignmentType, PageBorder, PageBorderZOrder, PageBorderDisplay, BorderStyle } from "docx";
import { saveAs } from "file-saver";

export const exportWord = async (report) => {
  const children = [];

  // ----- Centered Header Block -----
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: report.appName, bold: true, size: 44 })],
    })
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "AI Meeting & Learning Report", size: 28 })],
    })
  );
  children.push(new Paragraph({ text: "", alignment: AlignmentType.CENTER }));
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Session: ${report.sessionName}`, size: 22 })],
    })
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Generated: ${report.generatedAt}`, size: 22 })],
    })
  );
  children.push(new Paragraph({ text: "", alignment: AlignmentType.CENTER }));
  children.push(new Paragraph({ text: "" })); // extra spacing

  // ----- Executive Summary -----
  if (report.summary && report.summary.trim() !== "") {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: "Executive Summary", bold: true, size: 24 })],
      })
    );
    children.push(new Paragraph({ text: report.summary }));
    children.push(new Paragraph({ text: "" }));
  }

  // ----- Transcript Guide -----
  children.push(
    new Paragraph({
      children: [new TextRun({ text: "Transcript Guide", bold: true, size: 24 })],
    })
  );
  children.push(new Paragraph({ text: "Bold Text = System Audio" }));
  children.push(new Paragraph({ text: "Normal Text = Microphone Input" }));
  children.push(new Paragraph({ text: "" }));

  // ----- Smart Transcript -----
  children.push(
    new Paragraph({
      children: [new TextRun({ text: "Smart Transcript", bold: true, size: 24 })],
    })
  );
  report.transcriptBlocks.forEach((block) => {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: block.text,
            bold: block.type === "system",
          }),
        ],
      })
    );
  });
  children.push(new Paragraph({ text: "" }));

  // ----- Session Statistics -----
  children.push(
    new Paragraph({
      children: [new TextRun({ text: "Session Statistics", bold: true, size: 24 })],
    })
  );
  children.push(new Paragraph({ text: `Total Entries: ${report.totalEntries}` }));
  children.push(new Paragraph({ text: `Microphone Entries: ${report.micEntries}` }));
  children.push(new Paragraph({ text: `System Entries: ${report.systemEntries}` }));
  children.push(new Paragraph({ text: `Total Words: ${report.totalWords}` }));
  children.push(new Paragraph({ text: `Microphone Words: ${report.micWords}` }));
  children.push(new Paragraph({ text: `System Words: ${report.systemWords}` }));

  // ----- Document with Page Border -----
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            pageBorders: {
              pageBorderTop: {
                style: BorderStyle.SINGLE,
                size: 1,          // 1 point
                color: "000000",
              },
              pageBorderBottom: {
                style: BorderStyle.SINGLE,
                size: 1,
                color: "000000",
              },
              pageBorderLeft: {
                style: BorderStyle.SINGLE,
                size: 1,
                color: "000000",
              },
              pageBorderRight: {
                style: BorderStyle.SINGLE,
                size: 1,
                color: "000000",
              },
              pageBorderZOrder: PageBorderZOrder.FRONT,
              pageBorderDisplay: PageBorderDisplay.ALL_PAGES,
            },
          },
        },
        children: children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  saveAs(blob, "MEETMIND_Report.docx");
};