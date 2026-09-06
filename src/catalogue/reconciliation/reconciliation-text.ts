import { type CatalogueStore, sha256Text } from "../shared";
import { reconciliationTextStatement, retainReconciliationTextStatement } from "./reconciliation-text-repository";

type TextPart = { path: (string | number)[]; sha256: string; chunks: number; byte_length: number };
type RecordEnvelope = { contract: "card-keepr-partitioned-record@1"; value: unknown; text_parts: TextPart[] };

export class ReconciliationTextStorageError extends Error {
  constructor(cause: unknown) {
    super("Reconciliation text storage is temporarily unavailable.", { cause });
    this.name = "ReconciliationTextStorageError";
  }
}
async function textStorage<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
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
        await textStorage(retainReconciliationTextStatement(database, runId, sha256, ordinal, content).run());
        const retained = await textStorage(
          reconciliationTextStatement(database, runId, sha256, ordinal).first<{ content: string }>(),
        );
        if (retained?.content !== content) throw new Error("Retained text replay changed its immutable content.");
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
  return { contract: "card-keepr-partitioned-record@1", value: await visit(record, []), text_parts: textParts };
}

/** Compatibility reader; bounded reducers consume the paths and chunks directly instead. */
export async function restorePartitionedRecord(
  database: CatalogueStore,
  runId: string,
  envelope: RecordEnvelope,
): Promise<unknown> {
  let value = envelope.value;
  for (const part of envelope.text_parts) {
    let text = "";
    for (let ordinal = 0; ordinal < part.chunks; ordinal++) {
      const chunk = await textStorage(
        reconciliationTextStatement(database, runId, part.sha256, ordinal).first<{ content: string }>(),
      );
      if (!chunk) throw new Error("Retained text chunk is unavailable.");
      text += chunk.content;
    }
    if ((await sha256Text(text)) !== part.sha256 || new TextEncoder().encode(text).byteLength !== part.byte_length)
      throw new Error("Retained text failed integrity verification.");
    if (!part.path.length) value = text;
    else {
      let target = value as Record<string | number, unknown>;
      for (const key of part.path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
      Object.defineProperty(target, part.path.at(-1)!, { value: text, enumerable: true, writable: true });
    }
  }
  return value;
}
