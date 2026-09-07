import { type CatalogueStore, persistReconciliationPayloadChunkStatement } from "../shared";
import { type CanonicalWorkCursor, consumeCanonicalWork } from "./reconciliation-canonical-digest";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { prepareCandidateBatch } from "./reconciliation-preparation";

type Cursor = CanonicalWorkCursor & { firstReceipt: number; chunks: number; complete: boolean };

/** Canonical payload chunks and their preparation receipts precede the durable reader cursor. */
export async function prepareCandidatePayload(
  database: CatalogueStore,
  runId: string,
  kind: "candidate" | "digest",
  value: unknown,
  firstReceipt: number,
  yieldAtCheckpoint: boolean,
): Promise<number> {
  const phase = `payload_preparation:${kind}` as const;
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, phase);
  const cursor: Cursor = checkpoint?.value ?? {
    part: 0,
    after: "",
    chunk: 0,
    firstReceipt,
    chunks: 0,
    complete: false,
  };
  if (cursor.firstReceipt !== firstReceipt) throw new Error("Payload preparation receipt prefix changed.");
  if (cursor.complete) return cursor.chunks;
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  let pending = "",
    bytes = 0;
  const flush = async () => {
    if (!pending) return;
    await prepareCandidateBatch(database, runId, firstReceipt + cursor.chunks, kind, pending, () => [
      persistReconciliationPayloadChunkStatement(database, { runId, kind, index: cursor.chunks, content: pending }),
    ]);
    cursor.chunks++;
    pending = "";
    bytes = 0;
  };
  const save = async () => {
    await flush();
    await retainReconciliationCheckpoint(database, runId, phase, ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase, ordinal });
    ordinal++;
  };
  await consumeCanonicalWork(
    value,
    cursor,
    async (text) => {
      const length = new TextEncoder().encode(text).byteLength;
      if (bytes + length > 524288) await flush();
      pending += text;
      bytes += length;
    },
    save,
  );
  cursor.complete = true;
  await save();
  return cursor.chunks;
}
