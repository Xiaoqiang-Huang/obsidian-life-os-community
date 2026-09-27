import type PersonalLifeSystemPlugin from "../main";
import { FileSystemService } from "./FileSystemService";
import { ProjectDocumentService, type ProjectDocumentAiFormatterInput } from "./ProjectDocumentService";
import { PdfOcrService } from "./PdfOcrService";

export function createSharedProjectDocumentService(plugin: PersonalLifeSystemPlugin, fs: FileSystemService): ProjectDocumentService {
    return new ProjectDocumentService(plugin.app, fs, {
      pdfOcr: new PdfOcrService(plugin.app, {
        engine: plugin.settings.pdfOcrEngine,
        paddleEndpoint: plugin.settings.paddleOcrEndpoint
      }),
      aiFormatter: (input) => formatImportedProjectDocumentWithAi(plugin, input)
    });
  }

export async function formatImportedProjectDocumentWithAi(plugin: PersonalLifeSystemPlugin, input: ProjectDocumentAiFormatterInput): Promise<{ markdown: string }> {
    const response = await plugin.ai.complete({
      responseFormat: "text",
      temperature: 0.15,
      reasoningEffort: "default",
      skipModelCheck: true,
      messages: [
        {
          role: "system",
          content: [
            "You are the Life OS project document formatting assistant.",
            "The original file has already been fully extracted and will be sent to you in ordered batches.",
            "This is a formatting pass over imported source text, not a summarization or analysis task.",
            "Format the current batch paragraph by paragraph as readable Markdown: headings, paragraphs, lists, tables, or code blocks.",
            "Every source paragraph, line, question number, option, table cell, figure caption, citation, date, number, and proper noun must still be represented in your output.",
            "Do not summarize, omit, translate, deduplicate, rewrite facts, merge away paragraphs, or invent content.",
            "If a fragment is messy or uncertain, copy it unchanged instead of shortening it.",
            "Return only the formatted Markdown for the current batch. Do not wrap it in code fences and do not add explanations, disclaimers, or an AI signature."
          ].join("\n")
        },
        {
          role: "user",
          content: [
            `Project: ${input.project.name}`,
            `Document: ${input.title}`,
            `Source: ${input.sourceName}`,
            `Type: ${input.importKind}`,
            `Batch: ${input.chunkIndex ?? 1}/${input.chunkCount ?? 1}`,
            `Batch characters: ${input.chunkTextLength ?? input.text.length}`,
            `Full extracted characters: ${input.fullTextLength ?? input.text.length}`,
            "",
            "Format only this ordered source batch. Keep one-to-one coverage with the source text and do not omit any sentence, number, option, or line:",
            "----- SOURCE BATCH START -----",
            input.text,
            "----- SOURCE BATCH END -----"
          ].join("\n")
        }
      ]
    });
    const responseText = response.text?.trim() ?? "";
    if (!response.ok || !responseText) {
      throw new Error(response.error || "AI formatter returned no markdown.");
    }
    return { markdown: responseText };
  }
