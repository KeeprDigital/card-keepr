import { expect, test } from "vitest";
import { publishProductRelationshipLifecyclesStatements } from "../../../src/catalogue/reconciliation/product-release-publication-repository";
import { catalogueStore } from "../../../src/catalogue/shared";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import {
  missingRetainedCandidateEvidence,
  missingRetainedProductEvidence,
  missingRetainedRelationshipEvidence,
  relationshipPublicationInput,
  removeEvidenceRetentionTriggers,
  retainedEvidenceCounts,
  retainedObservation,
} from "./query-helpers/evidence-retention";
import { seedSearchMaterializationRevision } from "./query-helpers/search-materialization";
import { collect, installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();
test("candidate and Product publication retains every observation without materialization triggers", async () => {
  await removeEvidenceRetentionTriggers(testEnv.CATALOGUE_DB);
  const run = await collect("/reconciliation/product-release", "repository_retention_product");
  const candidate = await prepareNativeCandidate(
    run.id,
    "one-piece",
    "catrev_spine_000",
    "retention-repository-candidate",
  );
  expect(await missingRetainedCandidateEvidence(testEnv.CATALOGUE_DB, run.id).first("count")).toBe(0);
  const published = await approveNativeCandidate(candidate, "retention-repository-publication");
  expect(published.response.status, JSON.stringify(published.document)).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  expect(await missingRetainedProductEvidence(testEnv.CATALOGUE_DB, revisionId).first("count")).toBe(0);
  expect(await missingRetainedRelationshipEvidence(testEnv.CATALOGUE_DB).first("count")).toBe(0);
  const counts = (
    await retainedEvidenceCounts(testEnv.CATALOGUE_DB).all<{ retained_by_table: string; count: number }>()
  ).results;
  expect(counts.reduce((sum, row) => sum + row.count, 0)).toBeGreaterThan(0);
  const relationship = await relationshipPublicationInput(testEnv.CATALOGUE_DB).first<Record<string, unknown>>();
  expect(relationship).not.toBeNull();
  if (relationship === null) throw new Error("Fixture must publish a relationship");
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await database.batch(
    publishProductRelationshipLifecyclesStatements(database, [
      {
        ...relationship,
        source_observation_ids_json: '["observation_updated_relationship"]',
      },
    ]),
  );
  expect(await retainedObservation(testEnv.CATALOGUE_DB, "observation_updated_relationship").first()).toEqual({
    retained_by_table: "reconciled_product_relationships",
    retained_record_id: relationship.id,
  });
});

test("duplicate relationship IDs retain every intermediate observation inside one atomic publication", async () => {
  await removeEvidenceRetentionTriggers(testEnv.CATALOGUE_DB);
  await seedSearchMaterializationRevision(testEnv.CATALOGUE_DB);
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  const relationship = {
    id: "relationship_repeated",
    game: "one-piece",
    kind: "product-card",
    from_type: "product",
    from_id: "product",
    to_type: "card",
    to_id: "card",
    evidence_category: "explicit",
    source_lineage: "one-piece-en",
    relationship_value: "included",
    first_revision_id: "catrev_materialization",
    last_observed_revision_id: "catrev_materialization",
    current: 1,
    last_missing_revision_id: null,
    document_json: "{}",
  };
  await database.batch(
    publishProductRelationshipLifecyclesStatements(database, [
      { ...relationship, source_observation_ids_json: '["observation_intermediate_relationship"]' },
      { ...relationship, source_observation_ids_json: '["observation_final_relationship"]' },
    ]),
  );
  for (const observationId of ["observation_intermediate_relationship", "observation_final_relationship"]) {
    expect(await retainedObservation(testEnv.CATALOGUE_DB, observationId).first()).toEqual({
      retained_by_table: "reconciled_product_relationships",
      retained_record_id: relationship.id,
    });
  }
});
