import { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, WidthType, Table, TableRow, TableCell, ShadingType } from "docx";
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

  // ----- Wrap everything in a bordered table (simulates page border) -----
  const borderStyle = {
    style: BorderStyle.SINGLE,
    size: 1,
    color: "000000",
  };

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    margins: { top: 200, bottom: 200, left: 200, right: 200 },
    borders: {
      top: borderStyle,
      bottom: borderStyle,
      left: borderStyle,
      right: borderStyle,
      insideHorizontal: borderStyle, // optional, but gives cell separation
      insideVertical: borderStyle,
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: children,
            borders: {
              top: borderStyle,
              bottom: borderStyle,
              left: borderStyle,
              right: borderStyle,
            },
          }),
        ],
      }),
    ],
  });

  const doc = new Document({
    sections: [
      {
        children: [table],
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  saveAs(blob, "MEETMIND_Report.docx");
};