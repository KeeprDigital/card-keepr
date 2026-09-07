import { type CatalogueStore, sha256Text } from "../shared";
import {
  reconciliationTextPageStatement,
  reconciliationTextStatement,
  retainReconciliationTextStatement,
} from "./reconciliation-text-repository";

type TextPart = { path: (string | number)[]; sha256: string; chunks: number; byte_length: number };
type RecordEnvelope = { contract: "card-keepr-partitioned-record@1"; value: unknown; text_parts: TextPart[] };

export class ReconciliationTextStorageError extends Error {
  constructor(cause: unknown) {
    super("Reconciliation text storage is temporarily unavailable.", { cause });
    this.name = "ReconciliationTextStorageError";
  }
}
async function textStorage<T>(operation: Promise<T> | (() => Promise<T>)): Promise<T> {
  try {
    return await (typeof operation === "function" ? operation() : operation);
  } catch (cause) {
    throw new ReconciliationTextStorageError(cause);
  }
}

/** Paths live outside the source record, so source-defined objects cannot impersonate text references. */
export async function retainPartitionedRecord(
  database: CatalogueStore,
  runId: string,
  record: unknown,
): Promise<RecordEnvelope> {
  const textParts: TextPart[] = [];
  let pending: { sha256: string; ordinal: number; content: string }[] = [];
  let pendingBytes = 0;
  const flush = async () => {
    if (!pending.length) return;
    const results = await textStorage(() =>
      database.batch<{ content: string }>(
        pending.flatMap((chunk) => [
          retainReconciliationTextStatement(database, runId, chunk.sha256, chunk.ordinal, chunk.content),
          reconciliationTextStatement(database, runId, chunk.sha256, chunk.ordinal),
        ]),
      ),
    );
    for (const [index, chunk] of pending.entries())
      if (results[index * 2 + 1]?.results[0]?.content !== chunk.content)
        throw new Error("Retained text replay changed its immutable content.");
    pending = [];
    pendingBytes = 0;
  };
  const visit = async (value: unknown, path: (string | number)[]): Promise<unknown> => {
    if (typeof value === "string" && value.length > 32768) {
      const normalized = value.normalize("NFC");
      const sha256 = await sha256Text(normalized);
      let ordinal = 0;
      for (let offset = 0; offset < normalized.length; ) {
        let end = Math.min(offset + 32768, normalized.length);
        if (
          end < normalized.length &&
          normalized.charCodeAt(end - 1) >= 0xd800 &&
          normalized.charCodeAt(end - 1) <= 0xdbff
        )
          end--;
        const content = normalized.slice(offset, end);
        const bytes = new TextEncoder().encode(JSON.stringify(content)).byteLength;
        if (pending.length === 16 || pendingBytes + bytes > 512000) await flush();
        pending.push({ sha256, ordinal, content });
        pendingBytes += bytes;
        ordinal++;
        offset = end;
      }
      textParts.push({ path, sha256, chunks: ordinal, byte_length: new TextEncoder().encode(normalized).byteLength });
      return null;
    }
    if (Array.isArray(value)) {
      const result = [];
      for (let index = 0; index < value.length; index++) result.push(await visit(value[index], [...path, index]));
      return result;
    }
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value))
        Object.defineProperty(result, key, {
          value: await visit(field, [...path, key]),
          enumerable: true,
          writable: true,
        });
      return result;
    }
    return value;
  };
  const value = await visit(record, []);
  await flush();
  return { contract: "card-keepr-partitioned-record@1", value, text_parts: textParts };
}

/** Compatibility reader; bounded reducers consume the paths and chunks directly instead. */
export async function restorePartitionedRecord(
  database: CatalogueStore,
  runId: string,
  envelope: RecordEnvelope,
): Promise<unknown> {
  let value = envelope.value;
  type Reader = { part: TextPart; text: string; ordinal: number };
  const readers: Reader[] = [];
  let nextPart = 0;
  while (readers.length || nextPart < envelope.text_parts.length) {
    while (readers.length < 2 && nextPart < envelope.text_parts.length)
      readers.push({ part: envelope.text_parts[nextPart++]!, text: "", ordinal: 0 });
    // Each page is capped at 512000 bytes and 16 rows; two pages remain
    // below the one-MiB fetch budget even when separate text fields are large.
    const statements = readers.map(({ part, ordinal }) =>
      reconciliationTextPageStatement(database, runId, part.sha256, ordinal, part.chunks),
    );
    const pages = await textStorage(() =>
      statements.length === 1
        ? statements[0]!.all<{ ordinal: number; content: string }>().then((page) => [page])
        : database.batch<{ ordinal: number; content: string }>(statements),
    );
    for (let index = 0; index < readers.length; index++) {
      const reader = readers[index]!;
      const page = pages[index]!;
      if (!page.results.length) throw new Error("Retained text chunk is unavailable.");
      for (const chunk of page.results) {
        if (chunk.ordinal !== reader.ordinal) throw new Error("Retained text chunk is unavailable.");
        reader.text += chunk.content;
        reader.ordinal++;
      }
    }
    for (let index = readers.length - 1; index >= 0; index--) {
      const { part, text, ordinal } = readers[index]!;
      if (ordinal < part.chunks) continue;
      if ((await sha256Text(text)) !== part.sha256 || new TextEncoder().encode(text).byteLength !== part.byte_length)
        throw new Error("Retained text failed integrity verification.");
      if (!part.path.length) value = text;
      else {
        let target = value as Record<string | number, unknown>;
        for (const key of part.path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
        Object.defineProperty(target, part.path.at(-1)!, { value: text, enumerable: true, writable: true });
      }
      readers.splice(index, 1);
    }
  }
  return value;
}
