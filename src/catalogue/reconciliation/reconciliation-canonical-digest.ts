import { type CatalogueStore, canonicalJson, compareUtf8, StreamingSha256, type StreamingSha256State } from "../shared";
import { canonicalValueChunks } from "./reconciliation-preparation";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";

type Entry<T> = { key: string; value: T };
export type CanonicalRecordSource<T> = AsyncIterable<T> & {
  canonicalEntries(after: string): AsyncIterable<Entry<T>>;
};
export function canonicalRecordSource<T>(
  entries: (after: string) => AsyncIterable<Entry<T>>,
): CanonicalRecordSource<T> {
  return {
    canonicalEntries: entries,
    async *[Symbol.asyncIterator]() {
      for await (const entry of entries("")) yield entry.value;
    },
  };
}

type Part = { literal: string } | { source: CanonicalRecordSource<unknown> };
type Cursor = { part: number; after: string; chunk: number; sha: StreamingSha256State; digest?: string };

/** Hash the same canonical bytes while retaining a collection key and an intra-record chunk cursor. */
export async function prepareCanonicalDigest(
  database: CatalogueStore,
  runId: string,
  name: "catalogue" | "candidate",
  value: unknown,
  yieldAtCheckpoint: boolean,
): Promise<string> {
  const phase = `canonical_digest:${name}` as const;
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, phase);
  if (checkpoint?.value.digest) return checkpoint.value.digest;
  const cursor: Cursor = checkpoint?.value ?? { part: 0, after: "", chunk: 0, sha: new StreamingSha256().checkpoint };
  const hash = new StreamingSha256(cursor.sha);
  const parts = [...canonicalParts(value)];
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  let records = 0,
    bytes = 0;
  const save = async () => {
    cursor.sha = hash.checkpoint;
    await retainReconciliationCheckpoint(database, runId, phase, ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase, ordinal });
    ordinal++;
    records = bytes = 0;
  };
  const append = (text: string) => {
    const encoded = new TextEncoder().encode(text);
    hash.update(encoded);
    bytes += encoded.byteLength;
  };
  while (cursor.part < parts.length) {
    const part = parts[cursor.part]!;
    if ("literal" in part) {
      append(part.literal);
      cursor.part++;
      if (++records === 4 || bytes >= 524288) await save();
      continue;
    }
    for await (const entry of part.source.canonicalEntries(cursor.after)) {
      if (!entry.key || entry.key === cursor.after) throw new Error("Canonical record cursor must advance.");
      if (cursor.chunk === 0 && cursor.after) append(",");
      let chunk = 0;
      for (const text of canonicalValueChunks(entry.value)) {
        if (chunk++ < cursor.chunk) continue;
        append(text);
        cursor.chunk = chunk;
        if (bytes >= 524288) await save();
      }
      cursor.after = entry.key;
      cursor.chunk = 0;
      if (++records === 4) await save();
    }
    append("]");
    cursor.part++;
    cursor.after = "";
    cursor.chunk = 0;
    if (++records === 4 || bytes >= 524288) await save();
  }
  // Preserve the unfinished SHA state alongside its immutable completed digest.
  cursor.sha = hash.checkpoint;
  cursor.digest = hash.digestHex();
  await retainReconciliationCheckpoint(database, runId, phase, ordinal, cursor);
  if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase, ordinal });
  return cursor.digest;
}

function* canonicalParts(value: unknown): Generator<Part> {
  if (value !== null && typeof value === "object" && Symbol.asyncIterator in value) {
    if (!("canonicalEntries" in value)) throw new Error("Canonical hashing requires a resumable record source.");
    yield { literal: "[" };
    yield { source: value as CanonicalRecordSource<unknown> };
  } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    yield { literal: "{" };
    let first = true;
    for (const key of Object.keys(value).sort(compareUtf8)) {
      yield { literal: `${first ? "" : ","}${canonicalJson(key)}:` };
      first = false;
      yield* canonicalParts((value as Record<string, unknown>)[key]);
    }
    yield { literal: "}" };
  } else {
    for (const literal of canonicalValueChunks(value)) yield { literal };
  }
}
