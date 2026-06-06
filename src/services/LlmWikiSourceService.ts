import { App, TFile } from "obsidian";
import type { DirectoryLanguage } from "../settings";
import { ensureFolder, readFile } from "../utils/vault";
import { LlmWikiPathService } from "./LlmWikiPathService";
import {
  buildLlmWikiSourceMarkdown,
  classifyLlmWikiMaterialLength,
  simpleLlmWikiHash,
  slugifyLlmWikiTitle,
  type LlmWikiMaterialLength,
  type LlmWikiPrivacyLevel,
  type LlmWikiSourceKind
} from "./llm-wiki-logic";

const URL_SNAPSHOT_TIMEOUT_MS = 10_000;
const URL_SNAPSHOT_MAX_CHARS = 1_000_000;
const URL_SNAPSHOT_MAX_REDIRECTS = 3;
const URL_SNAPSHOT_CANCEL_CLEANUP_TIMEOUT_MS = 50;
const URL_SNAPSHOT_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SOURCE_FILENAME_SLUG_MAX_LENGTH = 96;
const NON_PUBLIC_IPV4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];
const NON_PUBLIC_IPV6_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3ffe::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8]
];

export interface SaveLlmWikiTextSourceInput {
  title: string;
  content: string;
  sourceKind: LlmWikiSourceKind;
  originalUrl?: string;
  sourcePath?: string;
  capturedAt: string;
  privacyLevel: LlmWikiPrivacyLevel;
  aiProcessingAllowed: boolean;
  batchId: string;
  duplicateOf?: string;
  versionOf?: string;
  status?: "inbox" | "versioned";
}

export interface SavedLlmWikiSource {
  id: string;
  path: string;
  materialLength: LlmWikiMaterialLength;
  file: TFile;
}

export interface LlmWikiSourceServiceOptions {
  directoryLanguage?: DirectoryLanguage;
  timeoutMs?: number;
  maxChars?: number;
  resolveHostname?: LlmWikiSnapshotHostnameResolver;
  /**
   * Safe fetch adapter for URL snapshots.
   *
   * The adapter must bind the actual network connection to one of the already
   * validated `resolvedAddresses`, and it must preserve manual redirect
   * semantics. It must not call ordinary `fetch(url)` in a way that re-resolves
   * the hostname or follows redirects automatically.
   */
  fetchSnapshotUrl?: LlmWikiSnapshotFetchAdapter;
}

export type LlmWikiSnapshotHostnameResolver = (hostname: string) => Promise<string[]>;

export interface LlmWikiSnapshotFetchOptions {
  signal: AbortSignal;
  /** Always "manual"; adapters must not automatically follow redirects. */
  redirect: "manual";
  /** Resolver results that were validated as public before this adapter is called. */
  resolvedAddresses: string[];
}

export type LlmWikiSnapshotFetchAdapter = (url: string, options: LlmWikiSnapshotFetchOptions) => Promise<Response>;

interface LlmWikiSnapshotUrlValidation {
  hostname: string;
  isIpLiteral: boolean;
  resolvedAddresses: string[];
}

export class LlmWikiSourceService {
  private paths: LlmWikiPathService;
  private timeoutMs: number;
  private maxChars: number;
  private resolveHostname?: LlmWikiSnapshotHostnameResolver;
  private fetchSnapshotUrl?: LlmWikiSnapshotFetchAdapter;

  constructor(private app: App, rootFolder: string, options: LlmWikiSourceServiceOptions = {}) {
    this.paths = new LlmWikiPathService(app, rootFolder, options.directoryLanguage);
    this.timeoutMs = options.timeoutMs ?? URL_SNAPSHOT_TIMEOUT_MS;
    this.maxChars = options.maxChars ?? URL_SNAPSHOT_MAX_CHARS;
    this.resolveHostname = options.resolveHostname ?? this.defaultResolveHostname();
    this.fetchSnapshotUrl = options.fetchSnapshotUrl;
  }

  async saveTextSource(input: SaveLlmWikiTextSourceInput): Promise<SavedLlmWikiSource> {
    return this.saveTextSourceToFolder(input, "Inbox");
  }

  async saveTextVersionSource(input: SaveLlmWikiTextSourceInput & { versionOf: string }): Promise<SavedLlmWikiSource> {
    return this.saveTextSourceToFolder({
      ...input,
      status: "versioned",
      versionOf: input.versionOf
    }, "Versions");
  }

  private async saveTextSourceToFolder(input: SaveLlmWikiTextSourceInput, rawFolder: "Inbox" | "Versions"): Promise<SavedLlmWikiSource> {
    const baseId = this.buildSourceId(input.title, input.content, input.capturedAt);
    const date = this.normalizeSourceDate(input.capturedAt);
    const slug = this.buildFilenameSlug(input.title);
    const saved = await this.createUniqueSourceFile(rawFolder, date, slug, baseId, (id) => buildLlmWikiSourceMarkdown({
      id,
      title: input.title,
      sourceKind: input.sourceKind,
      content: input.content,
      originalUrl: input.originalUrl,
      sourcePath: input.sourcePath,
      capturedAt: input.capturedAt,
      privacyLevel: input.privacyLevel,
      aiProcessingAllowed: input.aiProcessingAllowed,
      batchId: input.batchId,
      status: input.status || (rawFolder === "Versions" ? "versioned" : "inbox"),
      duplicateOf: input.duplicateOf,
      versionOf: input.versionOf
    }));
    return { id: saved.id, path: saved.file.path, materialLength: classifyLlmWikiMaterialLength(input.content), file: saved.file };
  }

  async saveCurrentNoteSnapshot(file: TFile, capturedAt: string, privacyLevel: LlmWikiPrivacyLevel, batchId: string): Promise<SavedLlmWikiSource> {
    const content = await readFile(this.app, file.path);
    if (!content.trim()) {
      throw new Error(`Cannot save empty current note snapshot: ${file.path}`);
    }
    return this.saveTextSource({
      title: file.basename,
      content,
      sourceKind: "current_note",
      sourcePath: file.path,
      capturedAt,
      privacyLevel,
      aiProcessingAllowed: privacyLevel !== "sensitive",
      batchId
    });
  }

  async fetchUrlSnapshot(url: string): Promise<string> {
    const parsedUrl = this.parseAllowedSnapshotUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const text = await this.fetchUrlSnapshotWithRedirects(parsedUrl, URL_SNAPSHOT_MAX_REDIRECTS, controller.signal);
      return text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("Cannot safely resolve URL snapshot hostname") ||
          error.message.startsWith("Cannot safely fetch URL snapshot hostname"))
      ) {
        return "";
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async createUniqueSourceFile(rawFolder: "Inbox" | "Versions", date: string, slug: string, baseId: string, buildContent: (id: string) => string): Promise<{ id: string; file: TFile }> {
    const folder = this.paths.path("Raw", rawFolder);
    await ensureFolder(this.app, folder);

    for (let index = 1; index <= 1000; index += 1) {
      const id = index === 1 ? baseId : `${baseId}_${index}`;
      const candidatePath = this.paths.path("Raw", rawFolder, `${date}-${slug}-${id}.md`);
      if (this.app.vault.getAbstractFileByPath(candidatePath)) {
        continue;
      }
      try {
        const file = await this.app.vault.create(candidatePath, buildContent(id));
        return { id, file };
      } catch (error) {
        if (this.app.vault.getAbstractFileByPath(candidatePath)) {
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Could not create unique LLM Wiki source file for ${baseId}`);
  }

  private normalizeSourceDate(capturedAt: string): string {
    return capturedAt.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "unknown-date";
  }

  private buildFilenameSlug(title: string): string {
    return slugifyLlmWikiTitle(title).slice(0, SOURCE_FILENAME_SLUG_MAX_LENGTH);
  }

  private buildSourceId(title: string, content: string, capturedAt: string): string {
    return `src_${capturedAt.replace(/\D/g, "").slice(0, 12)}_${simpleLlmWikiHash(`${title}${content}`)}`;
  }

  private async fetchUrlSnapshotWithRedirects(parsedUrl: URL, remainingRedirects: number, signal: AbortSignal): Promise<string> {
    const validation = await this.validateResolvedSnapshotUrl(parsedUrl, signal);
    let response: Response;
    try {
      response = await this.fetchValidatedSnapshotUrl(parsedUrl, validation, signal);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Cannot safely fetch URL snapshot hostname")) {
        throw error;
      }
      throw new Error(`Failed to fetch URL snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (URL_SNAPSHOT_REDIRECT_STATUSES.has(response.status)) {
      if (remainingRedirects <= 0) {
        throw new Error("Too many URL snapshot redirects");
      }

      const location = response.headers?.get("location") ?? response.headers?.get("Location");
      if (!location) {
        throw new Error(`URL snapshot redirect ${response.status} is missing Location`);
      }

      const nextUrl = this.parseAllowedSnapshotUrl(new URL(location, parsedUrl).toString());
      return this.fetchUrlSnapshotWithRedirects(nextUrl, remainingRedirects - 1, signal);
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch URL snapshot: ${response.status}`);
    }

    return this.readSnapshotResponseText(response, signal);
  }

  private async fetchValidatedSnapshotUrl(parsedUrl: URL, validation: LlmWikiSnapshotUrlValidation, signal: AbortSignal): Promise<Response> {
    if (!this.fetchSnapshotUrl) {
      throw new Error(`Cannot safely fetch URL snapshot hostname: ${validation.hostname}`);
    }

    return this.fetchSnapshotUrl(parsedUrl.toString(), {
      signal,
      redirect: "manual",
      resolvedAddresses: validation.resolvedAddresses
    });
  }

  private async readSnapshotResponseText(response: Response, signal: AbortSignal): Promise<string> {
    const body = response.body;
    if (body?.getReader) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let completed = false;

      try {
        while (true) {
          this.throwIfAborted(signal);
          const { done, value } = await this.raceWithAbort(reader.read(), signal);
          this.throwIfAborted(signal);
          if (done) {
            completed = true;
            break;
          }
          text += decoder.decode(value, { stream: true });
          this.assertSnapshotSize(text);
        }

        text += decoder.decode();
        this.assertSnapshotSize(text);
        return text;
      } finally {
        if (!completed) {
          this.cancelSnapshotReader(reader);
        }
      }
    }

    this.throwIfAborted(signal);
    const text = await this.raceWithAbort(response.text(), signal);
    this.throwIfAborted(signal);
    this.assertSnapshotSize(text);
    return text;
  }

  private cancelSnapshotReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    try {
      void Promise.race([
        reader.cancel(),
        new Promise((resolve) => setTimeout(resolve, URL_SNAPSHOT_CANCEL_CLEANUP_TIMEOUT_MS))
      ]).catch(() => {
        // Preserve the original stream read/size/abort error.
      });
    } catch {
      // Preserve the original stream read/size/abort error.
    }
  }

  private assertSnapshotSize(text: string): void {
    if (text.length > this.maxChars) {
      throw new Error(`URL snapshot is too large: ${text.length} chars`);
    }
  }

  private async raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      this.throwIfAborted(signal);
    }

    let abortListener: (() => void) | null = null;
    const abortPromise = new Promise<T>((_, reject) => {
      abortListener = () => reject(new Error("URL snapshot fetch timed out or was aborted"));
      signal.addEventListener("abort", abortListener, { once: true });
    });

    try {
      return await Promise.race([promise, abortPromise]);
    } finally {
      if (abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new Error("URL snapshot fetch timed out or was aborted");
    }
  }

  private isSnapshotAbortError(error: unknown): boolean {
    return error instanceof Error && /timed out|aborted/i.test(error.message);
  }

  private parseAllowedSnapshotUrl(url: string): URL {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Only http and https URLs can be fetched for LLM Wiki snapshots.");
    }

    if (this.isPrivateOrLocalHostname(parsedUrl.hostname)) {
      throw new Error(`Refusing to fetch private or local URL: ${parsedUrl.hostname}`);
    }

    return parsedUrl;
  }

  private async validateResolvedSnapshotUrl(parsedUrl: URL, signal: AbortSignal): Promise<LlmWikiSnapshotUrlValidation> {
    const hostname = this.normalizeSnapshotHostname(parsedUrl.hostname);
    if (this.isIpLiteralHostname(hostname)) {
      return { hostname, isIpLiteral: true, resolvedAddresses: [hostname] };
    }

    if (!this.resolveHostname) {
      throw new Error(`Cannot safely resolve URL snapshot hostname: ${hostname}`);
    }

    let addresses: string[];
    try {
      addresses = await this.raceWithAbort(this.resolveHostname(hostname), signal);
    } catch (error) {
      if (this.isSnapshotAbortError(error)) {
        throw error;
      }
      throw new Error(`Cannot safely resolve URL snapshot hostname ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!addresses.length) {
      throw new Error(`Cannot safely resolve URL snapshot hostname: ${hostname}`);
    }

    for (const address of addresses) {
      if (!this.isIpLiteralHostname(this.normalizeSnapshotHostname(address))) {
        throw new Error(`Cannot safely resolve URL snapshot hostname ${hostname}: resolver returned non-address ${address}`);
      }
      if (this.isPrivateOrLocalHostname(address)) {
        throw new Error(`Refusing to fetch private or local URL resolved from ${hostname}: ${address}`);
      }
    }

    return { hostname, isIpLiteral: false, resolvedAddresses: addresses };
  }

  private defaultResolveHostname(): LlmWikiSnapshotHostnameResolver | undefined {
    const dnsLike = (globalThis as typeof globalThis & {
      dns?: {
        resolve?: (hostname: string) => Promise<string[]>;
        resolveHostname?: (hostname: string) => Promise<string[]>;
      };
      resolveHostname?: (hostname: string) => Promise<string[]>;
    });
    return dnsLike.resolveHostname ?? dnsLike.dns?.resolveHostname ?? dnsLike.dns?.resolve;
  }

  private normalizeSnapshotHostname(hostname: string): string {
    return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/g, "");
  }

  private isIpLiteralHostname(hostname: string): boolean {
    return hostname.includes(":") || /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
  }

  private isPrivateOrLocalHostname(hostname: string): boolean {
    // Deterministic literal/local guard; hostnames also require resolver validation
    // and a safe fetch adapter before any network I/O.
    const host = this.normalizeSnapshotHostname(hostname);
    if (
      host === "localhost" ||
      host === "local" ||
      host === "lan" ||
      host === "home" ||
      host === "internal" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".lan") ||
      host.endsWith(".home") ||
      host.endsWith(".internal")
    ) {
      return true;
    }

    if (host.includes(":")) {
      return this.isPrivateOrLocalIpv6(host);
    }

    const octets = this.parseIpv4Octets(host);
    if (!octets) return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);

    return this.isPrivateOrLocalIpv4Octets(octets);
  }

  private isPrivateOrLocalIpv6(host: string): boolean {
    const normalized = host.split("%")[0];
    const hextets = this.parseIpv6Hextets(normalized);
    if (!hextets) return true;

    if (hextets.every((value) => value === 0) || (hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1)) {
      return true;
    }

    const mappedIpv4Octets = this.ipv4MappedIpv6ToOctets(hextets);
    if (mappedIpv4Octets && this.isPrivateOrLocalIpv4Octets(mappedIpv4Octets)) {
      return true;
    }

    const compatibleIpv4Octets = this.ipv4CompatibleIpv6ToOctets(hextets);
    if (compatibleIpv4Octets && this.isPrivateOrLocalIpv4Octets(compatibleIpv4Octets)) {
      return true;
    }

    const nat64Ipv4Octets = this.nat64Ipv6ToOctets(hextets);
    if (nat64Ipv4Octets && this.isPrivateOrLocalIpv4Octets(nat64Ipv4Octets)) {
      return true;
    }

    const value = this.ipv6HextetsToBigInt(hextets);
    return NON_PUBLIC_IPV6_CIDRS.some(([baseAddress, prefixLength]) => {
      const baseHextets = this.parseIpv6Hextets(baseAddress);
      return baseHextets ? this.isIpv6BigIntInCidr(value, this.ipv6HextetsToBigInt(baseHextets), prefixLength) : true;
    });
  }

  private ipv4MappedIpv6ToOctets(hextets: number[]): number[] | null {
    if (!hextets.slice(0, 5).every((value) => value === 0) || hextets[5] !== 0xffff) {
      return null;
    }

    return this.ipv4OctetsFromHextets(hextets[6], hextets[7]);
  }

  private ipv4CompatibleIpv6ToOctets(hextets: number[]): number[] | null {
    if (!hextets.slice(0, 6).every((value) => value === 0)) {
      return null;
    }

    return this.ipv4OctetsFromHextets(hextets[6], hextets[7]);
  }

  private nat64Ipv6ToOctets(hextets: number[]): number[] | null {
    const nat64Base = this.parseIpv6Hextets("64:ff9b::");
    if (!nat64Base || !this.isIpv6BigIntInCidr(this.ipv6HextetsToBigInt(hextets), this.ipv6HextetsToBigInt(nat64Base), 96)) {
      return null;
    }

    return this.ipv4OctetsFromHextets(hextets[6], hextets[7]);
  }

  private ipv4OctetsFromHextets(high: number, low: number): number[] | null {
    if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff) {
      return null;
    }

    return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
  }

  private parseIpv6Hextets(host: string): number[] | null {
    const normalized = host.toLowerCase().split("%")[0];
    if (!normalized.includes(":")) return null;
    if ((normalized.match(/::/g) ?? []).length > 1) return null;

    if (normalized.includes("::")) {
      const [leftText, rightText] = normalized.split("::");
      const left = this.parseIpv6HextetPart(leftText);
      const right = this.parseIpv6HextetPart(rightText);
      if (!left || !right) return null;

      const missingZeroes = 8 - left.length - right.length;
      if (missingZeroes < 1) return null;

      return [...left, ...Array(missingZeroes).fill(0), ...right];
    }

    const hextets = this.parseIpv6HextetPart(normalized);
    return hextets && hextets.length === 8 ? hextets : null;
  }

  private parseIpv6HextetPart(part: string): number[] | null {
    if (!part) return [];

    const values: number[] = [];
    const groups = part.split(":");
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (!group) return null;

      if (group.includes(".")) {
        if (index !== groups.length - 1) return null;
        const octets = this.parseIpv4Octets(group);
        if (!octets) return null;
        values.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }

      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      values.push(Number.parseInt(group, 16));
    }

    return values;
  }

  private parseIpv4Octets(host: string): number[] | null {
    const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return null;

    const octets = match.slice(1).map((part) => Number(part));
    return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
  }

  private isPrivateOrLocalIpv4Octets(octets: number[]): boolean {
    const value = this.ipv4OctetsToNumber(octets);
    return NON_PUBLIC_IPV4_CIDRS.some(([baseAddress, prefixLength]) => {
      const baseOctets = this.parseIpv4Octets(baseAddress);
      return baseOctets ? this.isIpv4NumberInCidr(value, this.ipv4OctetsToNumber(baseOctets), prefixLength) : true;
    });
  }

  private ipv4OctetsToNumber(octets: number[]): number {
    return ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3];
  }

  private isIpv4NumberInCidr(value: number, baseValue: number, prefixLength: number): boolean {
    const blockSize = 2 ** (32 - prefixLength);
    return value >= baseValue && value < baseValue + blockSize;
  }

  private ipv6HextetsToBigInt(hextets: number[]): bigint {
    return hextets.reduce((value, hextet) => (value << BigInt(16)) + BigInt(hextet), BigInt(0));
  }

  private isIpv6BigIntInCidr(value: bigint, baseValue: bigint, prefixLength: number): boolean {
    if (prefixLength === 0) return true;
    const shift = BigInt(128 - prefixLength);
    return value >> shift === baseValue >> shift;
  }
}
