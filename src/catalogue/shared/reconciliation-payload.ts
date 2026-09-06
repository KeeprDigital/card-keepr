import type { CatalogueStore } from "./catalogue-store-repository";
import {
  persistReconciliationPayloadChunkStatement,
  retainedReconciliationPayloadChunkStatement,
  retainedReconciliationPayloadChunksStatement,
} from "./reconciliation-payload-repository";
import { canonicalJson } from "./serialization";

const maximumChunkBytes = 524_288;
const maximumAtomicBatchStatements = 900;
const marker = (kind: "candidate" | "digest") => canonicalJson({ chunked_reconciliation_payload: kind });

export function chunkedPayloadMarker(kind: "candidate" | "digest"): string {
  return marker(kind);
}

export function payloadChunkStatements(
  database: CatalogueStore,
  runId: string,
  kind: "candidate" | "digest",
  value: string,
): D1PreparedStatement[] {
  return byteChunks(value).map((content, index) =>
    persistReconciliationPayloadChunkStatement(database, { runId: runId, kind: kind, index: index, content: content }),
  );
}

export async function retainedPayload(
  database: CatalogueStore,
  runId: string,
  kind: "candidate" | "digest",
  inline: string,
): Promise<string> {
  if (inline !== marker(kind)) return inline;
  const chunks = await retainedReconciliationPayloadChunksStatement(database, { runId: runId, kind: kind }).all<{
    chunk_index: number;
    content: string;
  }>();
  if (chunks.results.length === 0) {
    throw new Error(`Chunked reconciliation ${kind} payload is unavailable.`);
  }
  if (chunks.results.some(({ chunk_index: chunkIndex }, index) => chunkIndex !== index)) {
    throw new Error(`Chunked reconciliation ${kind} payload is incomplete.`);
  }
  return chunks.results.map(({ content }) => content).join("");
}

export function byteBoundedJsonArrays<T>(values: readonly T[]): string[] {
  const chunks: string[] = [];
  const encoder = new TextEncoder();
  let current: string[] = [];
  let currentBytes = 2;
  for (const value of values) {
    const encoded = canonicalJson(value);
    const encodedBytes = encoder.encode(encoded).byteLength;
    if (encodedBytes + 2 > maximumChunkBytes) {
      throw new Error("One reconciliation persistence record exceeds 512 KiB.");
    }
    const additionalBytes = encodedBytes + (current.length === 0 ? 0 : 1);
    if (current.length > 0 && currentBytes + additionalBytes > maximumChunkBytes) {
      chunks.push(`[${current.join(",")}]`);
      current = [];
      currentBytes = 2;
    }
    current.push(encoded);
    currentBytes += encodedBytes + (current.length === 1 ? 0 : 1);
  }
  if (current.length > 0 || values.length === 0) {
    chunks.push(`[${current.join(",")}]`);
  }
  return chunks;
}

export function guardedAtomicBatch(statements: readonly D1PreparedStatement[]): D1PreparedStatement[] {
  if (statements.length > maximumAtomicBatchStatements) {
    throw new Error("A reconciliation atomic batch exceeds its 900-statement D1 budget.");
  }
  return [...statements];
}

export function byteChunks(value: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    let low = 1;
    let high = Math.min(value.length - offset, maximumChunkBytes);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const bytes = new TextEncoder().encode(value.slice(offset, offset + middle)).byteLength;
      if (bytes <= maximumChunkBytes) low = middle;
      else high = middle - 1;
    }
    let end = offset + low;
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff && end < value.length) end -= 1;
    if (end === offset) {
      throw new Error("A reconciliation payload character exceeds its chunk bound.");
    }
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks.length === 0 ? [""] : chunks;
}

export async function* retainedPayloadChunks(
  database: CatalogueStore,
  runId: string,
  kind: "candidate" | "digest",
  inline: string,
): AsyncGenerator<string> {
  if (inline !== marker(kind)) {
    yield inline;
    return;
  }
  let expected = 0;
  while (true) {
    const chunk = await retainedReconciliationPayloadChunkStatement(database, {
      runId,
      kind,
      after: expected - 1,
    }).first<{ chunk_index: number; content: string }>();
    if (chunk === null) {
      if (expected === 0) throw new Error(`Chunked reconciliation ${kind} payload is unavailable.`);
      return;
    }
    if (chunk.chunk_index !== expected) throw new Error(`Chunked reconciliation ${kind} payload is incomplete.`);
    yield chunk.content;
    expected += 1;
  }
}
