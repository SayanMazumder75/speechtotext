import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, BorderStyle, WidthType, AlignmentType, ShadingType, VerticalAlign, HeadingLevel, PageBreak } from "docx";

// ─── COLOR PALETTE (hex) ────────────────────────────────────────────────────
const C = {
  purple:      "6C2BD9",
  purpleLight: "EDE9FE",
  pink:        "EC4899",
  cyan:        "06B6D4",
  green:       "10B981",
  amber:       "F59E0B",
  slate900:    "0F172A",
  slate700:    "334155",
  slate500:    "64748B",
  slate200:    "E2E8F0",
  slate100:    "F1F5F9",
  white:       "FFFFFF",
};

// ─── HELPER: create a styled paragraph with optional bullet and indentation ──
function styledText(text, bold = false, size = 24, color = C.slate900, bullet = false) {
  const run = new TextRun({ text, bold, size, color, font: "Helvetica" });
  const props = bullet ? { bullet: { level: 0 } } : {};
  return new Paragraph({ children: [run], ...props });
}

function shadedBox(content, accentColor, bgColor = C.slate100, leftBorder = true) {
  const border = leftBorder ? { left: { style: BorderStyle.SINGLE, size: 6, color: accentColor } } : {};
  return new Paragraph({
    children: [new TextRun({ text: content, size: 24, color: C.slate900 })],
    shading: { type: ShadingType.CLEAR, color: "auto", fill: bgColor },
    spacing: { before: 120, after: 120, line: 276 },
    indent: { left: 360, right: 360 },
    ...border,
  });
}

// ─── COVER PAGE ─────────────────────────────────────────────────────────────
function createCover(report) {
  const sections = [];

  // Purple gradient simulation (top bar + full page background not easily done, so we use a large table)
  sections.push(
    new Paragraph({ children: [], spacing: { before: 2000 } }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "M",
          bold: true,
          size: 72,
          color: C.white,
          font: "Helvetica",
        }),
      ],
      shading: { type: ShadingType.CLEAR, color: "auto", fill: C.purple },
      spacing: { before: 300, after: 300 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: "MEETMIND AI LEARNING", bold: true, size: 48, color: C.white }),
      ],
      spacing: { before: 400, after: 200 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "AI MEETING INTELLIGENCE REPORT", bold: true, size: 28, color: "C4B5FD" })],
      spacing: { after: 400 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: "SESSION", bold: true, size: 20, color: C.slate500 }),
      ],
      spacing: { after: 100 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: report.sessionName || "Meeting Session", bold: true, size: 28, color: C.slate900 }),
      ],
      spacing: { after: 100 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: report.generatedAt || new Date().toLocaleString(), size: 20, color: C.slate500 }),
      ],
      spacing: { after: 600 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: "Powered by MEETMIND AI", size: 18, color: "A07BFF" }),
      ],
    })
  );
  return sections;
}

// ─── STATS TABLE ────────────────────────────────────────────────────────────
function createStats(report) {
  const stats = [
    { label: "Total Entries", value: report.totalEntries, color: C.purple },
    { label: "Mic Entries", value: report.micEntries, color: C.amber },
    { label: "System Entries", value: report.systemEntries, color: C.cyan },
    { label: "Total Words", value: report.totalWords, color: C.slate700 },
    { label: "Mic Words", value: report.micWords, color: C.amber },
    { label: "System Words", value: report.systemWords, color: C.cyan },
  ];

  const rows = [];
  for (let i = 0; i < stats.length; i += 3) {
    const rowCells = [];
    for (let j = 0; j < 3; j++) {
      const s = stats[i + j];
      if (!s) continue;
      rowCells.push(
        new TableCell({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: String(s.value ?? 0), bold: true, size: 44, color: s.color })],
            }),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: s.label, size: 18, color: C.slate500 })],
            }),
          ],
          shading: { fill: C.slate100, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          margins: { top: 120, bottom: 120 },
        })
      );
    }
    rows.push(new TableRow({ children: rowCells }));
  }

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    margins: { marginUnit: "dxa", top: 0, bottom: 0, left: 0, right: 0 },
  });
}

// ─── AI SUMMARY (shaded box with left purple border) ────────────────────────
function createSummary(report) {
  if (!report.summary) return [];
  return [
    new Paragraph({
      children: [new TextRun({ text: "AI Summary", bold: true, size: 32, color: C.slate900 })],
      spacing: { before: 240, after: 120 },
    }),
    shadedBox(report.summary, C.purple, C.purpleLight, true),
  ];
}

// ─── KEY POINTS (bullets with green check) ──────────────────────────────────
function createKeyPoints(report) {
  if (!report.keyPoints?.length) return [];
  const points = [];
  points.push(
    new Paragraph({
      children: [new TextRun({ text: "Key Takeaways", bold: true, size: 32, color: C.slate900 })],
      spacing: { before: 240, after: 120 },
    })
  );
  report.keyPoints.forEach(point => {
    points.push(
      new Paragraph({
        children: [
          new TextRun({ text: "✓  ", bold: true, size: 24, color: C.green }),
          new TextRun({ text: point, size: 24, color: C.slate700 }),
        ],
        indent: { left: 360 },
        spacing: { after: 120 },
      })
    );
  });
  return points;
}

// ─── FLASHCARDS (two‑column table) ──────────────────────────────────────────
function createFlashcards(report) {
  if (!report.flashcards?.length) return [];
  const rows = [];
  report.flashcards.forEach((card, idx) => {
    const termCell = new TableCell({
      children: [
        new Paragraph({ children: [new TextRun({ text: `CARD ${idx+1} - TERM`, bold: true, size: 16, color: C.purple })] }),
        new Paragraph({ children: [new TextRun({ text: card.front, bold: true, size: 24, color: C.slate900 })] }),
      ],
      shading: { fill: C.purpleLight, type: ShadingType.CLEAR },
    });
    const defCell = new TableCell({
      children: [
        new Paragraph({ children: [new TextRun({ text: "DEFINITION", bold: true, size: 16, color: C.cyan })] }),
        new Paragraph({ children: [new TextRun({ text: card.back, size: 22, color: C.slate700 })] }),
      ],
      shading: { fill: "F0FFFA", type: ShadingType.CLEAR },
    });
    rows.push(new TableRow({ children: [termCell, defCell] }));
  });
  const table = new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [50, 50],
    margins: { top: 120, bottom: 120, left: 120, right: 120 },
  });
  return [
    new Paragraph({
      children: [new TextRun({ text: "Study Flashcards", bold: true, size: 32, color: C.slate900 })],
      spacing: { before: 240, after: 120 },
    }),
    table,
  ];
}

// ─── QUIZ (each question with options, correct answer highlighted) ──────────
function createQuiz(report) {
  if (!report.quiz?.length) return [];
  const blocks = [];
  blocks.push(
    new Paragraph({
      children: [new TextRun({ text: "Knowledge Check", bold: true, size: 32, color: C.slate900 })],
      spacing: { before: 240, after: 120 },
    })
  );
  const letters = ["A", "B", "C", "D"];
  report.quiz.forEach((q, idx) => {
    blocks.push(
      new Paragraph({
        children: [
          new TextRun({ text: `Q${idx+1}  `, bold: true, size: 24, color: C.pink }),
          new TextRun({ text: q.question, bold: true, size: 24, color: C.slate900 }),
        ],
        spacing: { after: 120 },
      })
    );
    q.options.forEach((opt, optIdx) => {
      const isCorrect = opt === q.answer;
      const prefix = `${letters[optIdx]}. `;
      const run = new TextRun({ text: prefix + opt, size: 22, color: isCorrect ? C.green : C.slate700, bold: isCorrect });
      blocks.push(
        new Paragraph({
          children: [run],
          indent: { left: 480 },
          spacing: { after: 60 },
        })
      );
    });
    blocks.push(
      new Paragraph({
        children: [new TextRun({ text: `✅ Correct Answer: ${q.answer}`, bold: true, size: 20, color: C.green })],
        spacing: { after: 240 },
      })
    );
  });
  return blocks;
}

// ─── TRANSCRIPT (appendix with color‑coded left bars) ───────────────────────
function createTranscript(report) {
  if (!report.transcriptBlocks?.length) return [];
  const blocks = [];
  blocks.push(new Paragraph({ children: [new PageBreak()] }));
  blocks.push(
    new Paragraph({
      children: [new TextRun({ text: "APPENDIX A", bold: true, size: 20, color: C.slate500 })],
      spacing: { after: 100 },
    }),
    new Paragraph({
      children: [new TextRun({ text: "Full Transcript", bold: true, size: 32, color: C.slate900 })],
      spacing: { after: 200 },
    })
  );
  // Legend
  blocks.push(
    new Paragraph({
      children: [
        new TextRun({ text: "■  ", bold: true, size: 20, color: C.amber }),
        new TextRun({ text: "MIC = Microphone input    ", size: 20, color: C.slate500 }),
        new TextRun({ text: "■  ", bold: true, size: 20, color: C.cyan }),
        new TextRun({ text: "SYS = System audio", bold: true, size: 20, color: C.cyan }),
      ],
      spacing: { after: 200 },
    })
  );
  // Each transcript line as a shaded paragraph with left border
  report.transcriptBlocks.forEach((block, i) => {
    const isMic = block.type === "mic";
    const color = isMic ? C.amber : C.cyan;
    const prefix = isMic ? "[MIC] " : "[SYS] ";
    const text = prefix + block.text;
    const para = new Paragraph({
      children: [new TextRun({ text: text, size: 22, color: isMic ? C.slate700 : C.slate900, bold: !isMic })],
      shading: { type: ShadingType.CLEAR, fill: i % 2 === 0 ? C.slate100 : C.white },
      indent: { left: 360, right: 360 },
      spacing: { after: 80 },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: color } },
    });
    blocks.push(para);
  });
  return blocks;
}

// ─── MAIN EXPORT FUNCTION ────────────────────────────────────────────────────
export async function exportWord(report) {
  const sections = [
    ...createCover(report),
    new Paragraph({ children: [new PageBreak()] }), // force stats on new page
    new Paragraph({ children: [new TextRun({ text: "Meeting Overview", bold: true, size: 32, color: C.slate900 })], spacing: { after: 120 } }),
    createStats(report),
    ...createSummary(report),
    ...createKeyPoints(report),
    ...createFlashcards(report),
    ...createQuiz(report),
    ...createTranscript(report),
  ];

  const doc = new Document({
    sections: [{ children: sections }],
    styles: { default: { document: { run: { font: "Helvetica" } } } },
  });

  const blob = await Packer.toBlob(doc);
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  const fileName = `MEETMIND_Report_${(report.sessionName || "session").replace(/\W+/g, "_")}.docx`;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}