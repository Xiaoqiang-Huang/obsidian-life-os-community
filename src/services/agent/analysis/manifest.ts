import type { Chunk, ChunkSpec, LogicalDocument, Manifest, ManifestReader, ModelIdentity, SourceEntry } from "./types";
import { hashRecord, hashText, safePath } from "./identity";

export async function effectiveIdentity(units: LogicalDocument["units"]): Promise<string> {
  return hashRecord(units.map(u => ({ ...u, originalVerified: Boolean(u.originalVerified) })));
}
export async function freezeManifest(scope: string, reader: ManifestReader): Promise<Manifest> {
  const entries = new Map<string, SourceEntry>(), seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await reader.enumerate(cursor);
    for (const entry of page.entries) {
      const normalized = { ...entry, path: safePath(entry.path), ...(entry.sourceFile ? { sourceFile: safePath(entry.sourceFile) } : {}) };
      if (entries.has(normalized.path)) throw new Error("duplicate-enumeration-path");
      entries.set(normalized.path, normalized);
    }
    cursor = page.next;
    if (cursor && seenCursors.has(cursor)) throw new Error("manifest-pagination-cycle");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  const eligible = Array.from(entries.values()).filter(e => e.kind !== "work-state" && (e.kind !== "derived-report" || e.explicitlyIncluded));
  const groups = new Map<string, SourceEntry[]>();
  for (const entry of eligible) {
    const parent = entry.sourceFile ? entries.get(entry.sourceFile) : undefined;
    // Only a concrete original in this authorized project establishes equivalence.
    const original = parent?.kind === "original" && parent.projectId === entry.projectId ? parent.path : entry.path;
    const key = `${entry.projectId}\u0000${original}`;
    groups.set(key, [...(groups.get(key) || []), entry]);
  }
  const documents: LogicalDocument[] = [];
  for (const [key, group] of Array.from(groups).sort((a, b) => a[0].localeCompare(b[0]))) {
    const originalPath = key.slice(key.indexOf("\u0000") + 1);
    const original = group.find(e => e.path === originalPath) || group[0];
    // Prefer explicit visible recognition/wrapper text; adapter verifies cache/source versions.
    const effective = group.find(e => e.kind === "recognition") || group.find(e => e.kind === "wrapper") || original;
    let snapshot;
    try { snapshot = await reader.snapshot(effective, original); }
    catch { snapshot = { sourceHash: "unknown", totalUnits: null, units: [], error: "reader-failed" }; }
    if (snapshot.totalUnits !== null && (!Number.isSafeInteger(snapshot.totalUnits) || snapshot.totalUnits < 0)) throw new Error("invalid-unit-count");
    const ids = new Set<string>();
    for (const unit of snapshot.units) {
      if (!unit.unitId || ids.has(unit.unitId)) throw new Error("duplicate-unit-id");
      ids.add(unit.unitId);
      if (typeof unit.text !== "string") throw new Error("invalid-unit-text");
    }
    documents.push({ docId: await hashText(key), originalPath, effectivePath: effective.path,
      paths: group.map(e => e.path).sort(), projectId: original.projectId, format: original.format,
      sourceHash: snapshot.sourceHash, effectiveTextHash: await effectiveIdentity(snapshot.units),
      totalUnits: snapshot.totalUnits, units: snapshot.units, ...(snapshot.error ? { error: snapshot.error } : {}) });
  }
  const manifest: Manifest = { schemaVersion: 1, scope, documents, manifestHash: "" };
  manifest.manifestHash = await hashRecord({ scope, documents }); return manifest;
}

/** Frozen denominator; page tokens bind the full manifest, not a mutable file listing. */
export function manifestPage(manifest: Manifest, cursor?: string, size = 200): { documents: LogicalDocument[]; next?: string } {
  if (!Number.isSafeInteger(size) || size < 1 || size > 200) throw new Error("invalid-page-size");
  let offset = 0;
  if (cursor) {
    const [hash, value] = cursor.split(":"); offset = Number(value);
    if (hash !== manifest.manifestHash || !Number.isSafeInteger(offset) || offset < 0 || offset > manifest.documents.length) throw new Error("stale-manifest-cursor");
  }
  const documents = manifest.documents.slice(offset, offset + size), end = offset + documents.length;
  return { documents, ...(end < manifest.documents.length ? { next: `${manifest.manifestHash}:${end}` } : {}) };
}

export function safeChunkWindow(model: ModelIdentity, requested: number): number {
  const ints = [model.contextTokens, model.inputTokens, model.outputTokens, model.overheadTokens, model.maxInputChars, requested];
  if (model.contextTokens === null) throw new Error("capability-test-required");
  if (ints.some(n => !Number.isSafeInteger(n) || n! < 0) || model.inputTokens < 1 || model.outputTokens < 1) throw new Error("invalid-context-budget");
  // Conservative byte-token estimate: up to three UTF-8 bytes per UTF-16 unit.
  // This is explicitly an estimate, not a provider tokenizer capability claim.
  const divisor = model.tokenCounting === "conservative-estimate" ? 3 : 1;
  const window = Math.floor(Math.min(requested, model.maxInputChars - model.overheadTokens,
    (model.inputTokens - model.overheadTokens) / divisor, (model.contextTokens - model.overheadTokens - model.outputTokens) / divisor));
  if (window < 16) throw new Error("context-window-too-small"); return window;
}
function boundary(text: string, end: number): number {
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) return end - 1;
  return end;
}
export async function makeChunks(manifest: Manifest, spec: ChunkSpec, model: ModelIdentity): Promise<Chunk[]> {
  for (const n of [model.sdkTurnLimit, model.sdkReportedTurnAllowance]) if (n !== undefined && (!Number.isSafeInteger(n) || n <= 0)) throw new Error("invalid-sdk-turn-allowance");
  const max = safeChunkWindow(model, spec.maxChars);
  if (!Number.isSafeInteger(spec.overlap) || spec.overlap < 0 || spec.overlap >= max / 2) throw new Error("invalid-overlap");
  const result: Chunk[] = [];
  for (const doc of manifest.documents) for (const unit of doc.units.filter(u => u.readState === "read")) {
    let ownedStart = 0;
    do {
      const start = boundary(unit.text, Math.max(0, ownedStart - spec.overlap));
      let end = boundary(unit.text, Math.min(unit.text.length, start + max));
      if (end < unit.text.length) {
        const region = unit.text.slice(ownedStart + Math.floor((end - ownedStart) / 2), end);
        const matches = Array.from(region.matchAll(/[\n。！？.!?；;]/gu));
        if (matches.length) end = ownedStart + Math.floor((end - ownedStart) / 2) + matches[matches.length - 1].index! + 1;
      }
      const text = unit.text.slice(start, end), inputHash = await hashText(text);
      const chunkId = await hashRecord({ docId: doc.docId, effectiveTextHash: doc.effectiveTextHash, unitId: unit.unitId, start, end, ownedStart, version: spec.version });
      const cacheKey = await hashRecord({ chunkId, inputHash, sourceHash: doc.sourceHash, extractionVersion: spec.extractionVersion,
        model: model.model, modelRevision: model.modelRevision, profile: model.profile, profileRevision: model.profileRevision });
      result.push({ chunkId, cacheKey, docId: doc.docId, unitId: unit.unitId, start, end, ownedStart, ownedEnd: end, inputHash, text, specVersion: spec.version });
      if (end === unit.text.length) break;
      if (end <= ownedStart) throw new Error("chunk-no-progress"); ownedStart = end;
    } while (true);
  }
  return result;
}
