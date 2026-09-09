import {
  readSourceRecordManifest,
  sourceRecordInitialDigest,
  sourceRecordNextDigest,
  sealedSourceRecordProgress,
  sourceRecordPage,
  type SourceRecordRow,
} from "../source-evidence";
import { type CatalogueStore, type StreamingSha256State, canonicalJson, sha256Text, StreamingSha256 } from "../shared";
import { documentStorage } from "./reconciliation-document";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { readSourceObservation } from "./reconciliation-source-observation";
import {
  sourceDocumentHeaderStatement,
  retainSourceDocumentHeaderStatement,
} from "./reconciliation-source-document-repository";

type SourceRow = {
  observation_set_id: string;
  content_object_key: string;
  content_byte_length: number;
  content_digest: string;
};
type Cursor = {
  inputDigest: string;
  sequenceNumber: number;
  requestId: string;
  complete: boolean;
  offset: number;
  hash: StreamingSha256State;
  values: Record<string, unknown>;
  observations: number;
  recordDigest?: string;
};
type Stored = { content: string; sha256: string };
type Header = { provenance: string; values: Record<string, unknown>; observationCount: number };

/** Hash exact ranged bytes before parsing addressable, independently verified chunks. */
export async function prepareSourceDocuments<T extends SourceRow>(
  database: CatalogueStore,
  objects: R2Bucket,
  runId: string,
  inputDigest: string,
  evidenceAfter: (after?: { sequenceNumber: number; requestId: string; complete?: boolean }) => AsyncIterable<{
    request: { sequence_number: number; request_id: string };
    row: T | null;
  }>,
  validate: (row: T, values: Record<string, unknown>, observations: number) => void,
  yieldAtCheckpoint: boolean,
) {
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "source_documents");
  if (checkpoint && checkpoint.value.inputDigest !== inputDigest) throw new Error("Source document selection changed.");
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  const saveCursor = async (cursor: Cursor) => {
    await retainReconciliationCheckpoint(database, runId, "source_documents", ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "source_documents", ordinal });
    ordinal++;
  };
  let skipped: Cursor | null = null;
  let skippedCount = 0;
  for await (const { request, row } of evidenceAfter(checkpoint?.value)) {
    // Preserve progress through unavailable selections before spending a document's
    // own callback budget. Their verified selection still participates in ordering.
    if (row !== null && skipped !== null) {
      await saveCursor(skipped);
      skipped = null;
      skippedCount = 0;
    }
    const cursor: Cursor =
      checkpoint?.value.requestId === request.request_id && !checkpoint.value.complete
        ? checkpoint.value
        : {
            inputDigest,
            sequenceNumber: request.sequence_number,
            requestId: request.request_id,
            complete: false,
            offset: 0,
            hash: new StreamingSha256().checkpoint,
            values: {},
            observations: 0,
          };
    const save = () => saveCursor(cursor);
    if (row === null) {
      cursor.complete = true;
      skipped = cursor;
      if (++skippedCount === 16) {
        await save();
        skipped = null;
        skippedCount = 0;
      }
      continue;
    }
    const bounded = await sealedSourceRecordProgress(database, row.observation_set_id, documentStorage);
    if (!bounded?.manifest_digest)
      throw new Error("source_record_migration_required: explicitly import retained observations before preparation.");
    if (cursor.recordDigest === undefined) {
      const hash = new StreamingSha256(cursor.hash);
      let ranges = 0;
      while (cursor.offset < row.content_byte_length) {
        const length = Math.min(65536, row.content_byte_length - cursor.offset);
        const object = await documentStorage(() =>
          objects.get(row.content_object_key, { range: { offset: cursor.offset, length } }),
        );
        if (!object || object.size !== row.content_byte_length)
          throw new Error("Retained Source Observation Set bytes are unavailable.");
        const bytes = new Uint8Array(await documentStorage(() => object.arrayBuffer()));
        if (bytes.length !== length) throw new Error("Retained Source Observation Set range is incomplete.");
        hash.update(bytes);
        cursor.offset += bytes.length;
        cursor.hash = hash.checkpoint;
        if (++ranges === 4 && cursor.offset < row.content_byte_length) {
          await save();
          ranges = 0;
        }
      }
      if (hash.digestHex() !== row.content_digest) throw new Error("Retained Source Observation Set digest changed.");
      const manifest = await readSourceRecordManifest(
        database,
        row.observation_set_id,
        bounded.manifest_digest,
        documentStorage,
      );
      const storage = manifest.record_storage as
        | { contract?: string; count?: number; sha256?: string; requests?: { count: number; sha256: string } }
        | undefined;
      if (
        storage?.contract !== "card-keepr-source-records@1" ||
        storage.count !== bounded.next_ordinal ||
        storage.sha256 !== bounded.digest ||
        (storage.requests &&
          (storage.requests.count !== bounded.requests_next_ordinal ||
            storage.requests.sha256 !== bounded.requests_digest))
      )
        throw new Error("Source record manifest is not sealed to its persisted records.");
      cursor.values = { ...manifest, observations: true };
      cursor.recordDigest = await sourceRecordInitialDigest(row.observation_set_id, bounded.header_json);
    }
    while (cursor.observations < bounded.next_ordinal) {
      const records = (
        await documentStorage(() =>
          sourceRecordPage(database, row.observation_set_id, cursor.observations - 1).all<SourceRecordRow>(),
        )
      ).results;
      if (!records.length) throw new Error("Source record manifest has missing records.");
      for (const record of records) {
        if (record.ordinal !== cursor.observations || (await sha256Text(record.content)) !== record.sha256)
          throw new Error("Source record manifest failed integrity verification.");
        cursor.recordDigest = await sourceRecordNextDigest(cursor.recordDigest, record);
        cursor.observations++;
      }
      await save();
    }
    if (cursor.recordDigest !== bounded.digest) throw new Error("Source record root digest changed.");
    validate(row, cursor.values, cursor.observations);
    const content = canonicalJson({
      provenance: await sha256Text(canonicalJson(row)),
      values: cursor.values,
      observationCount: cursor.observations,
    } satisfies Header);
    const digest = await sha256Text(content);
    await documentStorage(() =>
      retainSourceDocumentHeaderStatement(database, runId, row.observation_set_id, content, digest).run(),
    );
    await verifyStored(() => sourceDocumentHeaderStatement(database, runId, row.observation_set_id), content, digest);
    cursor.complete = true;
    await save();
  }
  if (skipped !== null) await saveCursor(skipped);
}

async function verifyStored(
  statement: () => ReturnType<typeof sourceDocumentHeaderStatement>,
  content: string,
  digest: string,
) {
  const receipt = await documentStorage(() => statement().first<Stored>());
  if (receipt?.content !== content || receipt.sha256 !== digest)
    throw new Error("Source document replay changed immutable content.");
}
export async function readSourceDocument<T extends SourceRow>(database: CatalogueStore, runId: string, row: T) {
  const retained = await documentStorage(() =>
    sourceDocumentHeaderStatement(database, runId, row.observation_set_id).first<Stored>(),
  );
  if (!retained || (await sha256Text(retained.content)) !== retained.sha256)
    throw new Error("Source document header failed integrity verification.");
  const header = JSON.parse(retained.content) as Header;
  if (header.provenance !== (await sha256Text(canonicalJson(row))))
    throw new Error("Source document provenance changed.");
  return {
    ...header,
    observations: {
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < header.observationCount; index++)
          yield await readSourceObservation(database, row.observation_set_id, index);
      },
    },
  };
}
