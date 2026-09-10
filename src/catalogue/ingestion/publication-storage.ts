import type { BuiltCatalogueExport, ExportObject } from "../export";
import { type CatalogueStore, catalogueRevisionIdentity } from "../shared";
import { publicationRegistrationStateStatement } from "./publication-storage-repository";

import { requiredRun } from "./run-storage";
import type { RunRow } from "./run-types";
import { isSha256Digest } from "./run-values";

export class PublicationPrefixOwnershipError extends Error {}

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
