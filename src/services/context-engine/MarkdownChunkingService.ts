export interface MarkdownChunk {
  id: string;
  path: string;
  title: string;
  heading: string;
  headingPath: string[];
  lineStart: number;
  lineEnd: number;
  content: string;
  searchableText: string;
}

interface MarkdownBlock {
  heading: string;
  headingPath: string[];
  lineStart: number;
  lineEnd: number;
  content: string;
}

const TARGET_CHARS = 1300;
const HARD_MAX_CHARS = 1800;

/**
 * Markdown-aware, deterministic chunking. It keeps headings and line ranges so
 * every retrieved fact can be opened at a human-readable location.
 */
export class MarkdownChunkingService {
  chunk(path: string, title: string, markdown: string): MarkdownChunk[] {
    const blocks = this.blocks(markdown);
    const chunks: MarkdownChunk[] = [];
    let group: MarkdownBlock[] = [];
    let groupChars = 0;

    const flush = () => {
      if (group.length === 0) return;
      const first = group[0];
      const last = group[group.length - 1];
      const headingPath = last.headingPath.length > 0 ? last.headingPath : first.headingPath;
      const heading = last.heading || first.heading || title;
      const content = group.map((block) => block.content).join("\n\n").trim();
      if (content) {
        const id = `chunk-${this.hash(`${path}:${first.lineStart}:${last.lineEnd}:${content}`)}`;
        chunks.push({
          id,
          path,
          title,
          heading,
          headingPath,
          lineStart: first.lineStart,
          lineEnd: last.lineEnd,
          content,
          searchableText: [title, path, ...headingPath, content].filter(Boolean).join("\n")
        });
      }
      group = [];
      groupChars = 0;
    };

    for (const block of blocks) {
      const headingChanged = group.length > 0 && block.heading !== group[group.length - 1].heading;
      if (headingChanged && groupChars >= 280) flush();

      if (block.content.length > HARD_MAX_CHARS) {
        flush();
        for (const part of this.splitLongBlock(block, HARD_MAX_CHARS)) {
          group = [part];
          groupChars = part.content.length;
          flush();
        }
        continue;
      }

      if (group.length > 0 && groupChars + block.content.length + 2 > TARGET_CHARS) flush();
      group.push(block);
      groupChars += block.content.length + 2;
    }
    flush();
    return chunks;
  }

  private blocks(markdown: string): MarkdownBlock[] {
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    const frontmatterEnd = this.frontmatterEnd(lines);
    const headingStack: string[] = [];
    const blocks: MarkdownBlock[] = [];
    let currentLines: string[] = [];
    let currentStart = Math.max(1, frontmatterEnd + 2);
    let currentHeading = "";
    let currentHeadingPath: string[] = [];

    const flush = (lineEnd: number) => {
      const content = currentLines.join("\n").trim();
      if (content) {
        blocks.push({
          heading: currentHeading,
          headingPath: [...currentHeadingPath],
          lineStart: currentStart,
          lineEnd: Math.max(currentStart, lineEnd),
          content
        });
      }
      currentLines = [];
    };

    for (let index = frontmatterEnd + 1; index < lines.length; index += 1) {
      const line = lines[index];
      const lineNumber = index + 1;
      const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (headingMatch) {
        flush(lineNumber - 1);
        const level = headingMatch[1].length;
        const value = headingMatch[2].replace(/\s+#+\s*$/, "").trim();
        headingStack.splice(level - 1);
        headingStack[level - 1] = value;
        currentHeadingPath = headingStack.filter(Boolean);
        currentHeading = value;
        currentStart = lineNumber;
        currentLines.push(line);
        continue;
      }

      if (!line.trim()) {
        flush(lineNumber - 1);
        currentStart = lineNumber + 1;
        continue;
      }

      if (currentLines.length === 0) currentStart = lineNumber;
      currentLines.push(line);
    }
    flush(lines.length);
    return blocks;
  }

  private splitLongBlock(block: MarkdownBlock, maxChars: number): MarkdownBlock[] {
    const parts: MarkdownBlock[] = [];
    const lines = block.content.split("\n");
    let buffer: string[] = [];
    let start = block.lineStart;
    let offset = 0;

    const flush = () => {
      const content = buffer.join("\n").trim();
      if (content) {
        parts.push({
          ...block,
          lineStart: start,
          lineEnd: Math.max(start, block.lineStart + offset - 1),
          content
        });
      }
      buffer = [];
      start = block.lineStart + offset;
    };

    for (const line of lines) {
      if (line.length > maxChars) {
        flush();
        for (let cursor = 0; cursor < line.length; cursor += maxChars) {
          parts.push({
            ...block,
            lineStart: block.lineStart + offset,
            lineEnd: block.lineStart + offset,
            content: line.slice(cursor, cursor + maxChars)
          });
        }
        offset += 1;
        start = block.lineStart + offset;
        continue;
      }
      const nextLength = buffer.join("\n").length + line.length + 1;
      if (buffer.length > 0 && nextLength > maxChars) flush();
      buffer.push(line);
      offset += 1;
    }
    flush();
    return parts;
  }

  private frontmatterEnd(lines: string[]): number {
    if (lines[0]?.trim() !== "---") return -1;
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index].trim() === "---") return index;
    }
    return -1;
  }

  private hash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }
}
