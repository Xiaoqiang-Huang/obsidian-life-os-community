import type { ManifestReader, ReadSnapshot, SourceEntry, TextUnit } from "./types";
import { effectiveIdentity } from "./manifest";
import { hashBytes } from "./identity";

/** Bind these methods to existing vault/DocumentRecognitionCacheService/DocumentImportService APIs.
 * Core never passes a recognizeImage callback and never silently starts OCR or SDK requests. */
export interface ExistingDocumentReads {
  enumerateAuthorized(cursor?: string): Promise<{ entries: SourceEntry[]; next?: string }>;
  readOriginalBytes(path: string): Promise<Uint8Array>;
  readMarkdown(path: string): Promise<string>;
  /** Optional explicit document metadata. Never infer commenter segmentation. */
  markdownMetadata?(text: string): { role: TextUnit["role"]; author?: string };
  /** Cache/native only. Keep edited recognized text verbatim and describe its provenance. */
  readCachedOrNative(effective: SourceEntry, original: SourceEntry, options: { allowVision: false }): Promise<{
    totalUnits: number | null; units: TextUnit[]; error?: string;
  }>;
}
export function createExistingReaderAdapter(api: ExistingDocumentReads): ManifestReader {
  const snapshot = async (effective: SourceEntry, original: SourceEntry): Promise<ReadSnapshot> => {
    const bytes = await api.readOriginalBytes(original.path), sourceHash = await hashBytes(bytes);
    if (effective.path === original.path && original.format.toLowerCase() === "md") {
      const text = await api.readMarkdown(original.path), metadata = api.markdownMetadata?.(text);
      return { sourceHash, totalUnits: 1, units: [{ unitId: "document", text,
        readState: "read", role: "unknown", ...metadata, origin: "native", originalVerified: true }] };
    }
    return { sourceHash, ...await api.readCachedOrNative(effective, original, { allowVision: false }) };
  };
  return { enumerate: cursor => api.enumerateAuthorized(cursor), snapshot,
    currentIdentity: async doc => {
      const original: SourceEntry = { path: doc.originalPath, projectId: doc.projectId, format: doc.format, kind: "original" };
      const effective: SourceEntry = { path: doc.effectivePath, projectId: doc.projectId, format: doc.format,
        kind: doc.effectivePath === doc.originalPath ? "original" : "recognition", sourceFile: doc.originalPath };
      const current = await snapshot(effective, original);
      return { sourceHash: current.sourceHash, effectiveTextHash: await effectiveIdentity(current.units) };
    } };
}
