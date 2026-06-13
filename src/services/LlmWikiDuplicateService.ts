import { App, normalizePath } from "obsidian";
import type { DirectoryLanguage } from "../settings";
import { LlmWikiPathService } from "./LlmWikiPathService";
import {
  normalizedLlmWikiSimilarity,
  simpleLlmWikiHash
} from "./llm-wiki-logic";
import { stripKeywordLinksSection } from "./KeywordLinkService";

export interface LlmWikiDuplicateResult {
  kind: "none" | "exact" | "similar" | "same-topic";
  existingPath: string;
  similarity: number;
  recommendation: "skip" | "save-anyway" | "save-as-version" | "save";
}

interface LlmWikiRawFile {
  path: string;
  basename?: string;
}

interface LlmWikiDuplicateVault {
  getMarkdownFiles?: () => LlmWikiRawFile[];
  read(file: LlmWikiRawFile): Promise<string>;
}

export class LlmWikiDuplicateService {
  private paths: LlmWikiPathService;

  constructor(private app: App, private rootFolder: string, directoryLanguage: DirectoryLanguage = "en") {
    this.paths = new LlmWikiPathService(app, rootFolder, directoryLanguage);
  }

  async findDuplicate(title: string, content: string, originalUrl = ""): Promise<LlmWikiDuplicateResult> {
    const targetHash = `hash:${simpleLlmWikiHash(content)}`;
    const targetUrl = String(originalUrl || "").trim();
    const vault = this.vault();
    const candidates = this.rawMarkdownFiles();
    let best: LlmWikiDuplicateResult = this.none();

    for (const file of candidates) {
      let markdown: string;
      try {
        markdown = await vault.read(file);
      } catch {
        continue;
      }

      const frontmatter = this.readFrontmatter(markdown);
      const body = this.stripFrontmatter(markdown);
      if (frontmatter.content_hash === targetHash && this.normalizedBody(body) === this.normalizedBody(content)) {
        return {
          kind: "exact",
          existingPath: file.path,
          similarity: 1,
          recommendation: "skip"
        };
      }

      if (targetUrl && String(frontmatter.original_url || "").trim() === targetUrl) {
        return {
          kind: "exact",
          existingPath: file.path,
          similarity: 1,
          recommendation: "skip"
        };
      }

      const existingTitle = frontmatter.title || file.basename || "";
      const similarity = Math.max(
        normalizedLlmWikiSimilarity(title, existingTitle),
        normalizedLlmWikiSimilarity(String(content || "").slice(0, 1000), body.slice(0, 1000))
      );

      if (similarity > best.similarity) {
        best = this.resultForSimilarity(file.path, similarity);
      }
    }

    return best.kind === "none" ? this.none() : best;
  }

  private rawMarkdownFiles(): LlmWikiRawFile[] {
    const vault = this.vault();
    const getMarkdownFiles = vault.getMarkdownFiles;
    if (!getMarkdownFiles) return [];

    const rawPrefix = this.normalizedPath(this.paths.path("Raw"));
    const files: LlmWikiRawFile[] = getMarkdownFiles.call(vault);
    return files.filter((file: LlmWikiRawFile) => {
      const path = this.normalizedPath(file.path);
      return path === rawPrefix || path.startsWith(`${rawPrefix}/`);
    });
  }

  private readFrontmatter(markdown: string): Record<string, string> {
    const match = String(markdown || "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return {};

    const values: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
      const scalar = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (!scalar) continue;
      values[scalar[1]] = this.parseYamlScalar(scalar[2]);
    }
    return values;
  }

  private parseYamlScalar(value: string): string {
    const trimmed = String(value || "").trim();
    if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1).replace(/''/g, "'");
    }
    return trimmed;
  }

  private stripFrontmatter(markdown: string): string {
    return String(markdown || "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  }

  private normalizedBody(content: string): string {
    return stripKeywordLinksSection(String(content || "").replace(/\r\n/g, "\n")).trim();
  }

  private resultForSimilarity(existingPath: string, similarity: number): LlmWikiDuplicateResult {
    if (similarity >= 0.86) {
      return {
        kind: "similar",
        existingPath,
        similarity,
        recommendation: "save-as-version"
      };
    }

    if (similarity >= 0.55) {
      return {
        kind: "same-topic",
        existingPath,
        similarity,
        recommendation: "save"
      };
    }

    return this.none();
  }

  private none(): LlmWikiDuplicateResult {
    return {
      kind: "none",
      existingPath: "",
      similarity: 0,
      recommendation: "save"
    };
  }

  private normalizedPath(...parts: string[]): string {
    return normalizePath(parts.map((part) => String(part || "").trim()).filter(Boolean).join("/"));
  }

  private vault(): LlmWikiDuplicateVault {
    return this.app.vault as unknown as LlmWikiDuplicateVault;
  }
}
