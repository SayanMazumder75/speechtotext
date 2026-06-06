// src/utils/exportWord.js

import {
  Document,
  Packer,
  Paragraph,
  TextRun
} from "docx";

import {
  saveAs
} from "file-saver";

export const exportWord =
  async (report) => {

    const children = [];

    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text:
              "MEETMIND AI Learning",
            bold: true,
            size: 32
          })
        ]
      })
    );

    children.push(
      new Paragraph(
        "AI Meeting & Learning Report"
      )
    );

    children.push(
      new Paragraph("")
    );

    children.push(
      new Paragraph(
        `Session: ${report.sessionName}`
      )
    );

    children.push(
      new Paragraph(
        `Generated: ${report.generatedAt}`
      )
    );

    children.push(
      new Paragraph("")
    );

    children.push(
      new Paragraph(
        "Transcript Guide"
      )
    );

    children.push(
      new Paragraph(
        "Bold Text = System Audio"
      )
    );

    children.push(
      new Paragraph(
        "Normal Text = Microphone Input"
      )
    );

    children.push(
      new Paragraph("")
    );

    report.transcriptBlocks.forEach(
      block => {

        children.push(
          new Paragraph({

            children: [

              new TextRun({

                text:
                  block.text,

                bold:
                  block.type ===
                  "system"
              })
            ]
          })
        );
      }
    );

    const doc =
      new Document({

        sections: [
          {
            children
          }
        ]
      });

    const blob =
      await Packer.toBlob(
        doc
      );

    saveAs(
      blob,
      "MEETMIND_Report.docx"
    );
};