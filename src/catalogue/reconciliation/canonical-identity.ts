import type { CanonicalRecordSource } from "./reconciliation-canonical-digest";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { documentStorage } from "./reconciliation-document";
import { AdministrationProblem, type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import {
  allocateIdentityStatement,
  allocatedIdentityStatement,
  identityAllocationStatement,
  identityMappingsStatement,
  insertSourceMappingsStatement,
  type SourceMapping,
  identityReviewsStatement,
  identityReviewStatement,
  identityDecisionStatement,
  insertIdentityDecisionStatement,
  insertIdentityReviewStatement,
  type IdentityReview,
  type IdentityDecision,
} from "./canonical-identity-repository";

export async function allocateCanonicalIdentity(
  database: CatalogueStore,
  kind: "card" | "printing",
  key: unknown,
  runId: string,
  observedAt: string,
) {
  const allocationKey = canonicalJson([kind, key]);
  const existing = await allocatedIdentityStatement(database, allocationKey).first<{ entity_id: string }>();
  if (existing) return existing.entity_id;
  await allocateIdentityStatement(
    database,
    allocationKey,
    `${kind}_${crypto.randomUUID().replaceAll("-", "")}`,
    kind,
    observedAt,
    runId,
  ).run();
  const allocated = await allocatedIdentityStatement(database, allocationKey).first<{ entity_id: string }>();
  if (!allocated) throw new Error("Canonical identity allocation was not retained.");
  return allocated.entity_id;
}
export async function boundedSourceMapping(mapping: SourceMapping): Promise<SourceMapping> {
  if (new TextEncoder().encode(mapping.evidenceJson).byteLength <= 128 * 1024) return mapping;
  const evidence = JSON.parse(mapping.evidenceJson);
  return {
    ...mapping,
    evidenceJson: canonicalJson({
      compatibility: evidence.compatibility,
      retained_evidence: {
        source_observation_id: mapping.sourceObservationId,
        source_observation_set_id: mapping.sourceObservationSetId,
        source_snapshot_id: mapping.sourceSnapshotId,
        content_digest: await sha256Text(mapping.evidenceJson),
      },
    }),
  };
}

export async function retainSourceMappings(
  database: CatalogueStore,
  runId: string,
  mappings: Pick<CanonicalRecordSource<SourceMapping>, "canonicalEntries">,
  yieldAtCheckpoint: boolean,
) {
  const checkpoint = await reconciliationCheckpoint<{ after: string; complete: boolean }>(
    database,
    runId,
    "source_mappings",
  );
  if (checkpoint?.value.complete) return;
  const cursor = checkpoint?.value ?? { after: "", complete: false };
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  let records: string[] = [],
    bytes = 2;
  const flush = async () => {
    if (records.length)
      await documentStorage(() => insertSourceMappingsStatement(database, runId, `[${records.join(",")}]`).run());
    await retainReconciliationCheckpoint(database, runId, "source_mappings", ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "source_mappings", ordinal });
    ordinal++;
    records = [];
    bytes = 2;
  };
  for await (const entry of mappings.canonicalEntries(cursor.after)) {
    const content = canonicalJson(entry.value);
    const length = new TextEncoder().encode(content).byteLength;
    if (length + 2 > 512000)
      throw new Error("reconciliation_capacity_exceeded: one source mapping exceeds 512000 bytes.");
    if (records.length && bytes + length + 1 > 512000) await flush();
    bytes += length + (records.length ? 1 : 0);
    records.push(content);
    cursor.after = entry.key;
    if (records.length === 4) await flush();
  }
  cursor.complete = true;
  await flush();
}
export type { SourceMapping } from "./canonical-identity-repository";
export async function inspectCanonicalIdentity(database: CatalogueStore, id: string, after = "") {
  const allocation = await identityAllocationStatement(database, id).first<{ entity_kind: string }>();
  const mappings = (
    await identityMappingsStatement(database, id, after).all<{
      entity_kind: string;
      evidence_json: string;
      source_observation_id: string;
    }>()
  ).results;
  if (!allocation && mappings.length === 0)
    throw new AdministrationProblem(
      404,
      "canonical_identity_not_found",
      "No retained canonical identity mapping exists for this ID.",
    );
  return {
    id,
    kind: allocation?.entity_kind ?? mappings[0]!.entity_kind,
    allocation: allocation ? "opaque" : "previously_published",
    mappings: mappings
      .slice(0, 100)
      .map(({ evidence_json, ...mapping }) => ({ ...mapping, evidence: JSON.parse(evidence_json) })),
    next_cursor: mappings.length > 100 ? mappings[99]!.source_observation_id : null,
  };
}

export async function inspectIdentityReviews(database: CatalogueStore, run: string, after: string) {
  const rows = (await identityReviewsStatement(database, run, after).all<IdentityReview>()).results;
  return {
    reviews: rows.slice(0, 100).map(({ evidence_json, candidate_printing_ids_json, ...row }) => ({
      ...row,
      evidence: JSON.parse(evidence_json),
      candidate_printing_ids: JSON.parse(candidate_printing_ids_json),
    })),
    next_cursor: rows.length > 100 ? rows[99]!.id : null,
  };
}
export async function resolveIdentityReview(
  database: CatalogueStore,
  reviewId: string,
  request: { printing_id: string; rationale: string; idempotency_key: string },
  at: string,
) {
  const requestJson = canonicalJson({ review_id: reviewId, ...request });
  const replay = await identityDecisionStatement(database, reviewId).first<IdentityDecision>();
  if (replay) {
    if (replay.request_json !== requestJson)
      throw new AdministrationProblem(
        409,
        "identity_review_already_resolved",
        "This immutable evidence review already has a different decision.",
      );
    return replay;
  }
  const review = await identityReviewStatement(database, reviewId).first<IdentityReview>();
  if (!review)
    throw new AdministrationProblem(404, "identity_review_not_found", "Inspect an existing retained identity review.");
  const candidates = JSON.parse(review.candidate_printing_ids_json) as string[];
  if (!candidates.includes(request.printing_id))
    throw new AdministrationProblem(
      422,
      "identity_review_target_invalid",
      "Select one of the noncontradictory retained Printing candidates.",
    );
  const decision = { review_id: reviewId, ...request, request_json: requestJson, decided_at: at };
  try {
    await insertIdentityDecisionStatement(database, decision).run();
  } catch {
    throw new AdministrationProblem(
      409,
      "identity_decision_conflict",
      "The decision was not recorded. Inspect the existing decision and wait for collection, release and recovery operations to be idle.",
    );
  }
  return decision;
}

export async function matchingIdentityDecision(
  database: CatalogueStore,
  input: {
    runId: string;
    sourceLineage: string;
    sourceObservationId: string;
    sourceSnapshotId: string;
    evidence: unknown;
    candidates: string[];
    at: string;
  },
) {
  const evidenceJson = canonicalJson(input.evidence);
  const id = `identity_review_${await sha256Text(canonicalJson([input.sourceLineage, evidenceJson, input.candidates]))}`;
  const decision = await identityDecisionStatement(database, id, input.runId).first<IdentityDecision>();
  if (decision && input.candidates.includes(decision.printing_id)) return decision.printing_id;
  await insertIdentityReviewStatement(database, {
    id,
    ingestion_run_id: input.runId,
    source_lineage: input.sourceLineage,
    source_observation_id: input.sourceObservationId,
    source_snapshot_id: input.sourceSnapshotId,
    evidence_json: evidenceJson,
    candidate_printing_ids_json: canonicalJson(input.candidates),
    created_at: input.at,
  }).run();
  return null;
}
