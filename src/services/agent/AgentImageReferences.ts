import type { AiImageUrlContentPart } from "../../ai";

/** Volatile, bounded payloads. The composite account/channel/project/session key is mandatory. */
export class AgentImageReferences {
  private sessions = new Map<string, { parts: AiImageUrlContentPart[]; at: number }>();
  constructor(private ttl = 30 * 60_000, private maxChars = 24_000_000) {}

  resolve(scope: string, content: string, incoming: AiImageUrlContentPart[] = [], now = Date.now()): {
    parts: AiImageUrlContentPart[]; missing: boolean; referenced: boolean;
  } {
    for (const [key, value] of this.sessions) if (now - value.at > this.ttl) this.sessions.delete(key);
    if (incoming.length) {
      const parts = incoming.map(part => ({ ...part, image_url: { ...part.image_url } }));
      this.sessions.delete(scope);
      const size = parts.reduce((n, part) => n + part.image_url.url.length, 0);
      if (parts.length <= 5 && size <= this.maxChars) {
        this.sessions.set(scope, { parts, at: now });
        while (this.sessions.size > 8 || this.size() > this.maxChars) this.sessions.delete(this.sessions.keys().next().value!);
      }
      return { parts, missing: false, referenced: false };
    }
    const explicit = /(?:上[一1]?张|刚才[的那]*|之前[的那]*|前面[的那]*|这[张些]|那[张些]|第[一二三四五\d]+张)(?:图片?|截图|照片)?|(?:previous|last)\s+(?:image|photo|picture)/iu.test(content)
      && /图|照片|image|photo|picture|张/iu.test(content);
    if (!explicit) return { parts: [], missing: false, referenced: false };
    const previous = this.sessions.get(scope)?.parts || [];
    const ordinals = [...new Set(Array.from(content.matchAll(/第([一二三四五\d]+)张/gu), match =>
      ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 }[match[1]] || Number(match[1]))))];
    // Do not silently compare an incomplete subset of explicitly named images.
    if (ordinals.some(n => !Number.isInteger(n) || n < 1 || n > previous.length)) return { parts: [], missing: true, referenced: false };
    const parts = ordinals.length ? ordinals.map(n => previous[n - 1]) : /上[一1]?张/u.test(content) ? previous.slice(-1) : previous;
    return { parts: parts.map(part => ({ ...part, image_url: { ...part.image_url } })), missing: !parts.length, referenced: !!parts.length };
  }
  clear(scope: string): void { this.sessions.delete(scope); }
  private size(): number { return [...this.sessions.values()].reduce((n, v) => n + v.parts.reduce((s, p) => s + p.image_url.url.length, 0), 0); }
}
