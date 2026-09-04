import type { BuiltCatalogueExport, ExportObject } from "../export";
import { cardSearchChunks, cardSearchTerms, cardSearchText } from "../read";
import {
  AdministrationProblem,
  type CatalogueCandidate,
  type CatalogueStore,
  canonicalJson,
  catalogueRevisionIdentity,
  sha256,
} from "../shared";
import {
  publicationRegistrationStateStatement,
  publicationWriterAuthorityStatement,
  recordLatePublicationObjectStatement,
  reservePublicationWriterStatement,
} from "./publication-storage-repository";

import { progressFor } from "./run-document-codec";
import { publicationCleanupNotBefore, requiredRun } from "./run-storage";
import {
  maximumPublicationCandidateBytes,
  maximumPublicationEntityBytes,
  maximumPublicationExportBytes,
  maximumPublicationSearchMaterializationBytes,
  publicationLeaseMilliseconds,
  type RunRow,
} from "./run-types";
import { isSha256Digest } from "./run-values";

export class PublicationPrefixOwnershipError extends Error {}

export async function reservePublication(
  database: CatalogueStore,
  runId: string,
  approval: Record<string, unknown>,
  idempotencyKey: string,
  revisionId: string,
  manifestDigest: string,
  writerToken: string,
  startedAt: string,
): Promise<void> {
  const reconcileAfter = new Date(Date.parse(startedAt) + publicationLeaseMilliseconds).toISOString();
  const reserved = await reservePublicationWriterStatement(database, {
    approvalJson: JSON.stringify(approval),
    idempotencyKey: idempotencyKey,
    approvalHistoryJson: JSON.stringify([approval]),
    progressJson: JSON.stringify(progressFor("publishing")),
    revisionId: revisionId,
    startedAt: startedAt,
    reconcileAfter: reconcileAfter,
    manifestDigest: manifestDigest,
    writerToken: writerToken,
    runId: runId,
  }).first<{ id: string }>();
  if (reserved === null) {
    throw new AdministrationProblem(
      409,
      "publication_precondition_failed",
      "The Ingestion Run could not reserve publication.",
    );
  }
}

export async function storeAndVerifyExport(
  database: CatalogueStore,
  bucket: R2Bucket,
  runId: string,
  revisionId: string,
  writerToken: string,
  objects: readonly ExportObject[],
): Promise<void> {
  for (const object of objects) {
    await assertReservedPublicationOwnsUnpublishedPrefix(database, runId);
    await assertPublicationWriterActive(database, runId, revisionId, writerToken);
    const existing = await bucket.head(object.key);
    await assertReservedPublicationOwnsUnpublishedPrefix(database, runId);
    if (existing !== null) {
      if (!(await storedExportObjectMatches(bucket, object))) {
        throw new Error("Immutable Catalogue Export object changed");
      }
      continue;
    }
    const body = object.body();
    await Promise.all([
      bucket.put(object.key, body.readable, {
        sha256: object.sha256,
        httpMetadata: {
          contentType: object.contentType,
          ...(object.contentEncoding === undefined ? {} : { contentEncoding: object.contentEncoding }),
          cacheControl: "private, max-age=31536000, immutable",
        },
      }),
      body.completed,
    ]);
    if (!(await storedExportObjectMatches(bucket, object))) {
      throw new Error("Catalogue Export object verification failed");
    }
    await assertPublicationWriterActive(database, runId, revisionId, writerToken, bucket, object.key);
  }
}

export async function storeAndVerifyPrintingImages(
  candidate: CatalogueCandidate,
  bucket: R2Bucket | undefined,
): Promise<void> {
  const images = candidate.printing_images ?? [];
  if (images.length === 0) return;
  if (bucket === undefined) {
    throw new Error("The Printing Image object binding is unavailable.");
  }
  for (const image of images) {
    const bytes = decodeBase64Bytes(image.content_base64);
    if (
      bytes.byteLength !== image.content_byte_length ||
      (await sha256(bytes)) !== image.content_sha256 ||
      image.object_key !== `printing-images/${image.content_sha256}`
    ) {
      throw new Error("Captured Printing Image bytes failed verification.");
    }
    const existing = await bucket.head(image.object_key);
    if (existing !== null) {
      await assertStoredPrintingImage(bucket, existing, image);
      continue;
    }
    const stored = await bucket.put(image.object_key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: image.content_sha256,
      httpMetadata: {
        contentType: image.media_type,
        cacheControl: "private, max-age=31536000, immutable",
      },
      customMetadata: { sha256: image.content_sha256 },
    });
    if (stored === null) {
      const concurrent = await bucket.head(image.object_key);
      if (concurrent === null) {
        throw new Error("Immutable Printing Image write conflict.");
      }
      await assertStoredPrintingImage(bucket, concurrent, image);
      continue;
    }
    await assertStoredPrintingImage(bucket, stored, image);
  }
}

function decodeBase64Bytes(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Captured Printing Image bytes are not valid base64.");
  }
}

async function assertStoredPrintingImage(
  bucket: R2Bucket,
  object: R2Object,
  image: NonNullable<CatalogueCandidate["printing_images"]>[number],
): Promise<void> {
  if (object.size !== image.content_byte_length) {
    throw new Error("Immutable Printing Image object key collision.");
  }
  const storedChecksum = object.checksums.toJSON().sha256;
  if (storedChecksum !== undefined) {
    if (storedChecksum !== image.content_sha256) {
      throw new Error("Immutable Printing Image object key collision.");
    }
    return;
  }
  const body = await bucket.get(image.object_key);
  if (body === null) {
    throw new Error("Immutable Printing Image object disappeared.");
  }
  const digest = new crypto.DigestStream("SHA-256");
  await body.body.pipeTo(digest);
  if (digestHex(await digest.digest) !== image.content_sha256) {
    throw new Error("Immutable Printing Image object key collision.");
  }
}

export function assertPublicationAggregateBudget(candidate: CatalogueCandidate): void {
  const encoder = new TextEncoder();
  const candidateBytes = encoder.encode(canonicalJson(candidate)).byteLength;
  if (candidateBytes > maximumPublicationCandidateBytes) {
    throw new AdministrationProblem(
      422,
      "publication_aggregate_too_large",
      "The Catalogue candidate exceeds the bounded publication aggregate.",
    );
  }
  let searchTermBytes = 2;
  let searchChunkBytes = 2;
  for (const card of candidate.cards) {
    assertPublicationEntityBudget(card, "Card", encoder);
    const document = cardSearchText(card);
    for (const term of cardSearchTerms(document)) {
      searchTermBytes +=
        (searchTermBytes === 2 ? 0 : 1) +
        encoder.encode(
          canonicalJson({
            card_id: card.id,
            term,
          }),
        ).byteLength;
    }
    for (const chunk of cardSearchChunks(document)) {
      searchChunkBytes +=
        (searchChunkBytes === 2 ? 0 : 1) +
        encoder.encode(
          canonicalJson({
            card_id: card.id,
            field_ordinal: chunk.field,
            chunk_ordinal: chunk.ordinal,
            search_text: chunk.text,
          }),
        ).byteLength;
    }
    if (searchTermBytes + searchChunkBytes > maximumPublicationSearchMaterializationBytes) {
      throw new AdministrationProblem(
        422,
        "publication_aggregate_too_large",
        "The Catalogue candidate exceeds the byte-bounded Card search publication aggregate.",
      );
    }
  }
  for (const printing of candidate.printings) {
    assertPublicationEntityBudget(printing, "Printing", encoder);
  }
  for (const erratum of candidate.errata ?? []) {
    assertPublicationEntityBudget(erratum, "Erratum", encoder);
  }
}

function assertPublicationEntityBudget(entity: unknown, description: string, encoder: TextEncoder): void {
  if (encoder.encode(canonicalJson(entity)).byteLength > maximumPublicationEntityBytes) {
    throw new AdministrationProblem(
      422,
      "publication_aggregate_too_large",
      `One ${description} exceeds the byte-bounded publication record budget.`,
    );
  }
}

export function assertBuiltPublicationBudget(catalogueExport: BuiltCatalogueExport): void {
  let bytes = 0;
  for (const object of catalogueExport.objects) {
    bytes += object.byteLength;
    if (bytes > maximumPublicationExportBytes) {
      throw new AdministrationProblem(
        422,
        "publication_aggregate_too_large",
        "The Catalogue Export exceeds the bounded publication aggregate.",
      );
    }
  }
}

async function assertPublicationWriterActive(
  database: CatalogueStore,
  runId: string,
  revisionId: string,
  writerToken: string,
  bucket?: R2Bucket,
  lateObjectKey?: string,
): Promise<void> {
  const reservation = await publicationWriterAuthorityStatement(database, {
    runId: runId,
    includePublished: bucket === undefined ? 0 : 1,
    revisionId: revisionId,
    writerToken: writerToken,
  }).first<{ id: string }>();
  if (reservation === null) {
    if (bucket !== undefined && lateObjectKey !== undefined) {
      await compensateLatePublicationWrite(database, bucket, runId, lateObjectKey);
    }
    throw new Error("publication_writer_fenced");
  }
}

async function compensateLatePublicationWrite(
  database: CatalogueStore,
  bucket: R2Bucket,
  runId: string,
  objectKey: string,
): Promise<void> {
  try {
    await bucket.delete(objectKey);
    if ((await bucket.get(objectKey)) === null) return;
  } catch {
    // Persisting cleanup ownership below is the fail-closed fallback.
  }
  const run = await requiredRun(database, runId);
  if (run.state !== "failed" || run.terminal_at === null) {
    throw new Error("The late publication write could not be attached to terminal cleanup.");
  }
  const failureAt = run.terminal_at;
  await recordLatePublicationObjectStatement(database, {
    runId: runId,
    objectKey: objectKey,
    failedAt: failureAt,
    notBefore: publicationCleanupNotBefore(run, failureAt),
  }).run();
}

export async function reservedPublicationOwnsUnpublishedPrefix(
  database: CatalogueStore,
  run: RunRow,
): Promise<boolean> {
  if (
    run.candidate_digest === null ||
    !isSha256Digest(run.candidate_digest) ||
    run.publication_revision_id === null ||
    (run.state !== "publishing" && run.state !== "failed")
  ) {
    return false;
  }
  const expectedRevisionId = await catalogueRevisionIdentity({
    runId: run.id,
    candidateDigest: run.candidate_digest,
    expectedCurrentRevisionId: run.expected_current_revision_id,
  });
  if (run.publication_revision_id !== expectedRevisionId) return false;
  const registered = await publicationRegistrationStateStatement(database, {
    revisionId: expectedRevisionId,
    runId: run.id,
  }).first<{
    revision_registered: number;
    export_registered: number;
    other_run_reserved: number;
  }>();
  return (
    registered?.revision_registered === 0 && registered.export_registered === 0 && registered.other_run_reserved === 0
  );
}

export async function assertReservedPublicationOwnsUnpublishedPrefix(
  database: CatalogueStore,
  runId: string,
): Promise<void> {
  const run = await requiredRun(database, runId);
  if (!(await reservedPublicationOwnsUnpublishedPrefix(database, run))) {
    throw new PublicationPrefixOwnershipError(
      "The publication prefix is not exclusively owned by this unpublished run.",
    );
  }
}

export function requiredCandidateCatalogueDigest(run: RunRow): string {
  if (run.candidate_catalogue_digest === null || !isSha256Digest(run.candidate_catalogue_digest)) {
    throw new Error("The candidate Catalogue Data digest is invalid.");
  }
  return run.candidate_catalogue_digest;
}

export async function listCatalogueExportPrefix(bucket: R2Bucket, revisionId: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: `catalogue-exports/${revisionId}/`,
      ...(cursor === undefined ? {} : { cursor }),
    });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}

export async function isExactVerifiedExport(
  bucket: R2Bucket,
  revisionId: string,
  catalogueExport: BuiltCatalogueExport,
): Promise<boolean> {
  const prefix = `catalogue-exports/${revisionId}/`;
  const actualKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
    });
    actualKeys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  const expectedKeys = [...new Set(catalogueExport.objects.map((object) => object.key))].sort();
  actualKeys.sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    return false;
  }
  for (const object of catalogueExport.objects) {
    if (!(await storedExportObjectMatches(bucket, object))) {
      return false;
    }
  }
  return true;
}

async function storedExportObjectMatches(bucket: R2Bucket, expected: ExportObject): Promise<boolean> {
  const stored = await bucket.head(expected.key);
  if (stored === null || stored.size !== expected.byteLength) return false;
  const checksum = stored.checksums.toJSON().sha256;
  if (checksum !== undefined) return checksum === expected.sha256;
  const body = await bucket.get(expected.key);
  if (body === null) return false;
  const digest = new crypto.DigestStream("SHA-256");
  await body.body.pipeTo(digest);
  return digestHex(await digest.digest) === expected.sha256;
}

function digestHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
