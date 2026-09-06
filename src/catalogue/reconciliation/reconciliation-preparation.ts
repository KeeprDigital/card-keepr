import { type CatalogueStore, canonicalJson, compareUtf8, sha256Text } from "../shared";
import { preparationBatchStatement, recordPreparationBatchStatement } from "./reconciliation-preparation-repository";

/** Each receipt and its bounded effects commit together, independent of Workflow history. */
export async function prepareCandidateBatch(
  database: CatalogueStore,
  runId: string,
  ordinal: number,
  kind: string,
  content: string,
  statements: readonly D1PreparedStatement[],
) {
  const sha256 = await sha256Text(`${kind}\u0000${content}`);
  const retained = () => preparationBatchStatement(database, runId, ordinal).first<{ kind: string; sha256: string }>();
  const verify = (row: { kind: string; sha256: string }) => {
    if (row.kind !== kind || row.sha256 !== sha256)
      throw new Error("Reconciliation preparation replay changed its pinned content.");
  };
  const previous = await retained();
  if (previous) {
    verify(previous);
    return;
  }
  try {
    await database.batch([recordPreparationBatchStatement(database, runId, ordinal, kind, sha256), ...statements]);
  } catch (error) {
    const concurrent = await retained();
    if (!concurrent) throw error;
    verify(concurrent);
  }
}

/** Traverse canonical JSON without assembling a second whole-candidate string. */
export function* canonicalValueChunks(value: unknown): Generator<string> {
  let chunk = "";
  let bytes = 0;
  for (const part of canonicalParts(value)) {
    const length = new TextEncoder().encode(part).byteLength;
    if (length > 524288) throw new Error("reconciliation_capacity_exceeded: one JSON value exceeds 512 KiB.");
    if (bytes + length > 524288) {
      yield chunk;
      chunk = "";
      bytes = 0;
    }
    chunk += part;
    bytes += length;
  }
  if (chunk.length) yield chunk;
}

function* canonicalParts(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield '"';
    const normalized = value.normalize("NFC");
    for (let offset = 0; offset < normalized.length; ) {
      let end = Math.min(offset + 32768, normalized.length);
      if (
        end < normalized.length &&
        normalized.charCodeAt(end - 1) >= 0xd800 &&
        normalized.charCodeAt(end - 1) <= 0xdbff
      )
        end--;
      yield JSON.stringify(normalized.slice(offset, end)).slice(1, -1);
      offset = end;
    }
    yield '"';
  } else if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index++) {
      if (index) yield ",";
      yield* canonicalParts(value[index]);
    }
    yield "]";
  } else if (value !== null && typeof value === "object") {
    yield "{";
    let first = true;
    for (const key of Object.keys(value).sort(compareUtf8)) {
      if (!first) yield ",";
      first = false;
      yield `${canonicalJson(key)}:`;
      yield* canonicalParts((value as Record<string, unknown>)[key]);
    }
    yield "}";
  } else yield canonicalJson(value);
}

export function* boundedRecordArrays<T>(records: Iterable<T>): Generator<string> {
  let parts: string[] = [];
  let bytes = 2;
  for (const record of records) {
    const encoded = canonicalJson(record);
    const length = new TextEncoder().encode(encoded).byteLength;
    if (length + 2 > 524288)
      throw new Error("reconciliation_capacity_exceeded: one preparation record exceeds 512 KiB.");
    if (parts.length === 500 || bytes + length + (parts.length ? 1 : 0) > 524288) {
      yield `[${parts.join(",")}]`;
      parts = [];
      bytes = 2;
    }
    bytes += length + (parts.length ? 1 : 0);
    parts.push(encoded);
  }
  if (parts.length) yield `[${parts.join(",")}]`;
}

export async function* boundedAsyncRecordArrays(records: AsyncIterable<unknown>): AsyncGenerator<string> {
  let parts: string[] = [];
  let bytes = 2;
  for await (const record of records) {
    const encoded = canonicalJson(record);
    const length = new TextEncoder().encode(encoded).byteLength;
    if (length + 2 > 524288)
      throw new Error("reconciliation_capacity_exceeded: one preparation record exceeds 512 KiB.");
    if (parts.length === 500 || bytes + length + (parts.length ? 1 : 0) > 524288) {
      yield `[${parts.join(",")}]`;
      parts = [];
      bytes = 2;
    }
    bytes += length + (parts.length ? 1 : 0);
    parts.push(encoded);
  }
  if (parts.length) yield `[${parts.join(",")}]`;
}

export async function canonicalValueDigest(value: unknown): Promise<string> {
  const digest = new crypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  for (const chunk of canonicalValueChunks(value)) await writer.write(new TextEncoder().encode(chunk));
  await writer.close();
  return Array.from(new Uint8Array(await digest.digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
