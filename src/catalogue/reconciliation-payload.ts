import { canonicalJson } from "./serialization";

const maximumChunkBytes = 524_288;
const maximumAtomicBatchStatements = 900;
const marker = (kind: "candidate" | "digest") =>
  canonicalJson({ chunked_reconciliation_payload: kind });

export function chunkedPayloadMarker(kind: "candidate" | "digest"): string {
  return marker(kind);
}

export function payloadChunkStatements(
  database: D1Database,
  runId: string,
  kind: "candidate" | "digest",
  value: string,
): D1PreparedStatement[] {
  return byteChunks(value).map((content, index) =>
    database
      .prepare(
        `INSERT INTO reconciliation_payload_chunks (
           ingestion_run_id, payload_kind, chunk_index, content
         ) VALUES (?, ?, ?, ?)`,
      )
      .bind(runId, kind, index, content),
  );
}

export async function retainedPayload(
  database: D1Database,
  runId: string,
  kind: "candidate" | "digest",
  inline: string,
): Promise<string> {
  if (inline !== marker(kind)) return inline;
  const chunks = await database
    .prepare(
      `SELECT chunk_index, content
       FROM reconciliation_payload_chunks
       WHERE ingestion_run_id = ? AND payload_kind = ?
       ORDER BY chunk_index`,
    )
    .bind(runId, kind)
    .all<{ chunk_index: number; content: string }>();
  if (chunks.results.length === 0) {
    throw new Error(`Chunked reconciliation ${kind} payload is unavailable.`);
  }
  if (
    chunks.results.some(
      ({ chunk_index: chunkIndex }, index) => chunkIndex !== index,
    )
  ) {
    throw new Error(`Chunked reconciliation ${kind} payload is incomplete.`);
  }
  return chunks.results.map(({ content }) => content).join("");
}

export function byteBoundedJsonArrays<T>(
  values: readonly T[],
): string[] {
  const chunks: string[] = [];
  let current: T[] = [];
  for (const value of values) {
    const next = canonicalJson([...current, value]);
    if (new TextEncoder().encode(next).byteLength > maximumChunkBytes) {
      if (current.length === 0) {
        throw new Error("One reconciliation persistence record exceeds 512 KiB.");
      }
      chunks.push(canonicalJson(current));
      current = [value];
    } else {
      current.push(value);
    }
  }
  if (current.length > 0 || values.length === 0) {
    chunks.push(canonicalJson(current));
  }
  return chunks;
}

export function guardedAtomicBatch(
  statements: readonly D1PreparedStatement[],
): D1PreparedStatement[] {
  if (statements.length > maximumAtomicBatchStatements) {
    throw new Error(
      "A reconciliation atomic batch exceeds its 900-statement D1 budget.",
    );
  }
  return [...statements];
}

function byteChunks(value: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    let low = 1;
    let high = Math.min(value.length - offset, maximumChunkBytes);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const bytes = new TextEncoder().encode(
        value.slice(offset, offset + middle),
      ).byteLength;
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
