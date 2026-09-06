import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { canonicalValueChunks } from "./reconciliation-preparation";
import {
  verifiedDocumentStatement,
  documentPartitionStatement,
  retainDocumentPartitionStatement,
  verifyDocumentStatement,
} from "./reconciliation-document-repository";

export class ReconciliationDocumentStorageError extends Error {
  constructor(cause: unknown) {
    super("Reconciliation document storage is temporarily unavailable.", { cause });
    this.name = "ReconciliationDocumentStorageError";
  }
}
export async function documentStorage<T>(operation: Promise<T> | (() => Promise<T>)): Promise<T> {
  try {
    return await (typeof operation === "function" ? operation() : operation);
  } catch (cause) {
    throw new ReconciliationDocumentStorageError(cause);
  }
}

type SourceDocument = { observations: unknown[]; evidenceSummary: Record<string, number | boolean> };
type DocumentIdentity = { runId: string; observationSetId: string; provenanceDigest: string };

function initialDigest(identity: DocumentIdentity) {
  return sha256Text(canonicalJson({ contract: "card-keepr-verified-source-document@1", ...identity }));
}

/** Each document becomes reusable after its bytes and provenance have been checked, before global graph closure. */
export async function retainVerifiedSourceDocument(
  database: CatalogueStore,
  identity: DocumentIdentity,
  document: SourceDocument,
) {
  let digest = await initialDigest(identity);
  let ordinal = 0;
  const kind = "document";
  for (const chunk of canonicalValueChunks(document)) {
    for (let offset = 0; offset < chunk.length; ) {
      let end = Math.min(offset + 65536, chunk.length);
      if (end < chunk.length && chunk.charCodeAt(end - 1) >= 0xd800 && chunk.charCodeAt(end - 1) <= 0xdbff) end--;
      const content = canonicalJson([chunk.slice(offset, end)]);
      const sha256 = await sha256Text(content);
      await documentStorage(
        retainDocumentPartitionStatement(
          database,
          identity.runId,
          identity.observationSetId,
          ordinal,
          kind,
          content,
          sha256,
        ).run(),
      );
      const retained = await documentStorage(
        documentPartitionStatement(database, identity.runId, identity.observationSetId, ordinal).first<{
          kind: string;
          content: string;
          sha256: string;
        }>(),
      );
      if (retained?.content !== content || retained.kind !== kind || retained.sha256 !== sha256)
        throw new Error("Verified document partition replay changed immutable content.");
      digest = await sha256Text(canonicalJson({ previous: digest, ordinal, kind, sha256 }));
      ordinal++;
      offset = end;
    }
  }
  await documentStorage(
    verifyDocumentStatement(
      database,
      identity.runId,
      identity.observationSetId,
      identity.provenanceDigest,
      digest,
      ordinal,
    ).run(),
  );
  const retained = await documentStorage(
    verifiedDocumentStatement(database, identity.runId, identity.observationSetId).first<{
      provenance_digest: string;
      manifest_digest: string;
      partition_count: number;
    }>(),
  );
  if (
    retained?.provenance_digest !== identity.provenanceDigest ||
    retained.manifest_digest !== digest ||
    retained.partition_count !== ordinal
  )
    throw new Error("Verified document replay changed its immutable manifest.");
}

/** Legacy parser adapter; only a verified document is reconstructed, one partition at a time. */
export async function readVerifiedSourceDocument(
  database: CatalogueStore,
  identity: DocumentIdentity,
): Promise<SourceDocument | null> {
  const header = await documentStorage(
    verifiedDocumentStatement(database, identity.runId, identity.observationSetId).first<{
      provenance_digest: string;
      manifest_digest: string;
      partition_count: number;
    }>(),
  );
  if (!header) return null;
  if (header.provenance_digest !== identity.provenanceDigest)
    throw new Error("Verified source document provenance changed.");
  let digest = await initialDigest(identity);
  let document = "";
  for (let ordinal = 0; ordinal < header.partition_count; ordinal++) {
    const partition = await documentStorage(
      documentPartitionStatement(database, identity.runId, identity.observationSetId, ordinal).first<{
        kind: string;
        content: string;
        sha256: string;
      }>(),
    );
    if (!partition || (await sha256Text(partition.content)) !== partition.sha256)
      throw new Error("Verified source document partition failed integrity verification.");
    document += (JSON.parse(partition.content) as string[]).join("");
    digest = await sha256Text(
      canonicalJson({ previous: digest, ordinal, kind: partition.kind, sha256: partition.sha256 }),
    );
  }
  if (digest !== header.manifest_digest)
    throw new Error("Verified source document manifest failed integrity verification.");
  return JSON.parse(document) as SourceDocument;
}
