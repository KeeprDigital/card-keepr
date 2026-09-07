import { canonicalJson, sha256Text, StreamingSha256, type StreamingSha256State, type CatalogueStore } from "../shared";
import { verifiedCandidatePartition } from "./game-candidate-inspection";
import { documentStorage } from "./reconciliation-document";
import { imageStorage } from "./reconciliation-images";
import { reconciliationTextStatement } from "./reconciliation-text-repository";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";

type Image = { object_key: string; content_sha256: string; content_byte_length: number };
type Text = { sha256: string; chunks: number; byte_length: number };
export type InspectionIntegrityCursor = {
  manifest_prefix: string;
  partition: number;
  record: number;
  part: number;
  chunk: number;
  textHash: StreamingSha256State | null;
  textBytes: number;
  receipts: number;
  texts: number;
  images: number;
  complete: boolean;
};

/** Verification advances durably without buffering a complete text, image or candidate. */
export async function verifyInspectionArtifacts(
  database: CatalogueStore,
  bucket: R2Bucket,
  candidate: { id: string; preparation_id: string },
  count: number,
  prefix: string,
  state: InspectionIntegrityCursor | undefined,
  save: (cursor: InspectionIntegrityCursor) => Promise<void>,
) {
  const cursor: InspectionIntegrityCursor = state ?? {
    manifest_prefix: prefix,
    partition: 0,
    record: 0,
    part: 0,
    chunk: 0,
    textHash: null,
    textBytes: 0,
    receipts: 0,
    texts: 0,
    images: 0,
    complete: false,
  };
  if (cursor.manifest_prefix !== prefix) throw new Error("Inspection integrity manifest changed during continuation.");
  if (cursor.complete) return cursor;
  const receipts = new ReconciliationReducerIndex<{ id: string }>(
    database,
    candidate.preparation_id,
    `inspection_integrity:${candidate.id}`,
  );
  receipts.resumeAt(cursor.receipts);
  let work = 0,
    bytes = 0;
  const checkpoint = async () => {
    cursor.receipts = receipts.position;
    work = bytes = 0;
    await save(cursor);
  };
  while (cursor.partition < count) {
    const partition = await verifiedCandidatePartition(database, candidate.id, cursor.partition);
    while (cursor.record < partition.records.length) {
      const envelope = partition.records[cursor.record]!;
      const record = envelope.value as {
        entity_class?: string;
        before?: Image | null;
        after?: Image | null;
        before_text?: { preparation_id: string; parts: Text[] };
        after_text?: { preparation_id: string; parts: Text[] };
      };
      const references = (envelope.text_parts as Text[]).map((part) => ({
        preparation: candidate.preparation_id,
        part,
      }));
      if (partition.kind === "inspection") {
        for (const side of [record.before_text, record.after_text])
          for (const part of side?.parts ?? []) references.push({ preparation: side!.preparation_id, part });
      }
      while (cursor.part < references.length) {
        const reference = references[cursor.part]!;
        const key = `text:${reference.preparation}:${reference.part.sha256}`;
        if (!cursor.chunk && (await receipts.get(key))) {
          cursor.part++;
          if (++work >= 16) await checkpoint();
          continue;
        }
        const hash = new StreamingSha256(cursor.textHash ?? undefined);
        while (cursor.chunk < reference.part.chunks) {
          const chunk = await documentStorage(() =>
            reconciliationTextStatement(database, reference.preparation, reference.part.sha256, cursor.chunk).first<{
              content: string;
            }>(),
          );
          if (!chunk) throw new Error("A required inspection text chunk is missing.");
          const data = new TextEncoder().encode(chunk.content);
          if (data.byteLength > 131072) throw new Error("Inspection text chunk exceeds its retained byte bound.");
          hash.update(data);
          cursor.textBytes += data.byteLength;
          bytes += data.byteLength;
          cursor.chunk++;
          cursor.textHash = hash.checkpoint;
          if (++work >= 16 || bytes >= 512000) await checkpoint();
        }
        if (cursor.textBytes !== reference.part.byte_length || hash.digestHex() !== reference.part.sha256)
          throw new Error("Required inspection text failed integrity verification.");
        await receipts.seed(key, { id: key });
        cursor.texts++;
        cursor.part++;
        cursor.chunk = cursor.textBytes = 0;
        cursor.textHash = null;
      }
      const images: Image[] =
        partition.kind === "printing_images"
          ? [envelope.value as Image]
          : partition.kind === "inspection" && record.entity_class === "printing_images"
            ? [record.before, record.after].filter((image): image is Image => image != null)
            : [];
      for (const image of images) {
        const key = `image:${image.object_key}:${image.content_sha256}`;
        if (!(await receipts.get(key))) {
          const object = await imageStorage(() => bucket.get(image.object_key));
          if (!object) throw new Error("A required inspection Printing Image is missing.");
          if (object.size !== image.content_byte_length) {
            await object.body.cancel();
            throw new Error("Required inspection Printing Image size is invalid.");
          }
          const digest = new crypto.DigestStream("SHA-256");
          await imageStorage(() => object.body.pipeTo(digest));
          const actual = Array.from(new Uint8Array(await digest.digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
          if (actual !== image.content_sha256)
            throw new Error("Required inspection Printing Image failed integrity verification.");
          await receipts.seed(key, { id: key });
          cursor.images++;
        }
      }
      cursor.record++;
      cursor.part = 0;
      if ((references.length || images.length) && ++work >= (images.length ? 8 : 16)) await checkpoint();
    }
    cursor.partition++;
    cursor.record = 0;
    bytes += partition.byte_length;
    if (++work >= 16 || bytes >= 512000) await checkpoint();
  }
  cursor.complete = true;
  await checkpoint();
  return cursor;
}

export async function inspectionIntegrityReceipt(cursor: InspectionIntegrityCursor) {
  const receipt = {
    manifest_prefix: cursor.manifest_prefix,
    partitions: cursor.partition,
    texts: cursor.texts,
    images: cursor.images,
    complete: cursor.complete,
  };
  return { ...receipt, sha256: await sha256Text(canonicalJson(receipt)) };
}
