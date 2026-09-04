import {
  dropSourceRequestPlanGuard,
  dropCollectionPlanDiscoveryGuard,
  dropEvidencePlanOriginGuard,
  inspectEvidencePlanCount,
  inspectSourceRequestIds,
  inspectCollectionPlanCount,
} from "./query-helpers/collection-resume";
import {
  sourceRequestInsertionStatement,
  officialCollectionPlanInsertionStatement,
  evidencePlanInsertionStatement,
} from "../../../src/catalogue/source-evidence/source-plan-repository";
import * as ingestionQueries from "./query-helpers/ingestion";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";
import * as legalityQueries from "./query-helpers/legality";
import { applyD1Migrations } from "cloudflare:test";
import { expect, test } from "vitest";
import { catalogueStore, sha256 } from "../../../src/catalogue/shared";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import {
  approve,
  canonicalLegalityCardIdInvariantErrors,
  canonicalLegalityEffectInvariantErrors,
  canonicalLegalityScopeInvariantErrors,
  exportedLegalityRule,
  exportedManifest,
  installContextualLegalitySuite,
  officialAdapterUrl,
  productionFusionLegalityRequests,
  productionOnePieceReleaseTimingRequests,
  reconcile,
  rejectedError,
  request,
  requiredString,
  revisionLegalityRule,
  testEnv,
  waitForState,
} from "./contextual-legality-helpers";
import fusionLivePolicyRoot from "../../../acceptance/fixtures/retained-official-source/fusion-world-en-policy-live.json";
import fusionLivePolicyDetail from "../../../acceptance/fixtures/retained-official-source/fusion-world-en-policy-detail.json";

installContextualLegalitySuite();

test("D1 freshness scope remains structural while registered Source metadata owns lineage semantics", async () => {
  await ingestionQueries
    .insertIngestionRunsForD1FreshnessScopeRemainsStructuralWhileRegisteredSourceMetadata(testEnv.CATALOGUE_DB)
    .run();
  await expect(
    sourceEvidenceQueries
      .insertSourceFreshnessForD1FreshnessScopeRemainsStructuralWhileRegisteredSourceMetadata(testEnv.CATALOGUE_DB)
      .run(),
  ).resolves.toBeDefined();
  await sourceEvidenceQueries.deleteSourceFreshness(testEnv.CATALOGUE_DB).run();
});

test("applied D1 request copies and owning run identities are immutable", async () => {
  const runId = "run_operational_plan_immutability";
  const ownerTargetRunId = "run_operational_plan_owner_target";
  await testEnv.CATALOGUE_DB.batch([
    ingestionQueries
      .insertIngestionRunsForAppliedD1RequestCopiesOwningRunIdentitiesAreImmutable(testEnv.CATALOGUE_DB)
      .bind(runId, "operational-plan-immutability"),
    ingestionQueries
      .insertIngestionRunsForAppliedD1RequestCopiesOwningRunIdentitiesAreImmutable(testEnv.CATALOGUE_DB)
      .bind(ownerTargetRunId, "operational-plan-owner-target"),
    sourceEvidenceQueries
      .insertIngestionEvidencePlansForAuthenticatedReparseRejectsNormalizedFixtureEnvelopeThroughUnavailableProduction(
        testEnv.CATALOGUE_DB,
      )
      .bind(
        runId,
        JSON.stringify({
          requests: [
            {
              id: "update-target",
              method: "GET",
              url: "https://en.onepiece-cardgame.com/cardlist/",
              headers: { accept: "text/html" },
              representation_fingerprint: "a".repeat(64),
            },
            {
              id: "delete-target",
              method: "GET",
              url: "https://en.onepiece-cardgame.com/rules/",
              headers: { accept: "text/html" },
              representation_fingerprint: "b".repeat(64),
            },
            {
              id: "insert-target",
              method: "GET",
              url: "https://en.onepiece-cardgame.com/products/",
              headers: { accept: "text/html" },
              representation_fingerprint: "e".repeat(64),
            },
          ],
        }),
      ),
    sourceEvidenceQueries
      .insertSourceRequestsForAppliedD1RequestCopiesOwningRunIdentitiesAreImmutable(testEnv.CATALOGUE_DB)
      .bind(runId, "a".repeat(64)),
    sourceEvidenceQueries
      .insertSourceRequestsForAppliedD1RequestCopiesOwningRunIdentitiesAreImmutableWithPending(testEnv.CATALOGUE_DB)
      .bind(runId, "b".repeat(64)),
  ]);

  const updateError = await rejectedError(
    sourceEvidenceQueries
      .setSourceRequestsUrlRequestHeadersJson(testEnv.CATALOGUE_DB)
      .bind("c".repeat(64), runId)
      .run(),
  );
  const deleteError = await rejectedError(
    sourceEvidenceQueries.deleteSourceRequests(testEnv.CATALOGUE_DB).bind(runId).run(),
  );
  await dropSourceRequestPlanGuard(testEnv.CATALOGUE_DB).run();
  const insertError = await rejectedError(
    sourceRequestInsertionStatement(catalogueStore(testEnv.CATALOGUE_DB), {
      runId,
      requestId: "insert-target",
      sequenceNumber: 2,
      method: "GET",
      url: "https://attacker.example/wrong-plan-fields",
      requestHeadersJson: '{"accept":"application/json"}',
      representationFingerprint: "f".repeat(64),
    }).run(),
  );
  const unplannedInsertError = await rejectedError(
    sourceRequestInsertionStatement(catalogueStore(testEnv.CATALOGUE_DB), {
      runId,
      requestId: "unplanned",
      sequenceNumber: 3,
      method: "GET",
      url: "https://attacker.example/unplanned",
      requestHeadersJson: "{}",
      representationFingerprint: "d".repeat(64),
    }).run(),
  );
  await expect(
    catalogueStore(testEnv.CATALOGUE_DB).batch([
      sourceRequestInsertionStatement(catalogueStore(testEnv.CATALOGUE_DB), {
        runId,
        requestId: "insert-target",
        sequenceNumber: 2,
        method: "GET",
        url: "https://en.onepiece-cardgame.com/products/",
        requestHeadersJson: '{"accept":"text/html"}',
        representationFingerprint: "e".repeat(64),
      }),
      sourceRequestInsertionStatement(catalogueStore(testEnv.CATALOGUE_DB), {
        runId,
        requestId: "unplanned-tail",
        sequenceNumber: 3,
        method: "GET",
        url: "https://attacker.example/unplanned-tail",
        requestHeadersJson: "{}",
        representationFingerprint: "d".repeat(64),
      }),
    ]),
  ).rejects.toThrow(/source_request_not_in_immutable_plan/);
  expect((await inspectSourceRequestIds(testEnv.CATALOGUE_DB, runId).all()).results).toEqual([
    { request_id: "update-target" },
    { request_id: "delete-target" },
  ]);
  const requestOwnerError = await rejectedError(
    sourceEvidenceQueries.setSourceRequestsIngestionRunId(testEnv.CATALOGUE_DB).bind(ownerTargetRunId, runId).run(),
  );
  const planOwnerError = await rejectedError(
    sourceEvidenceQueries
      .setIngestionEvidencePlansIngestionRunId(testEnv.CATALOGUE_DB)
      .bind(ownerTargetRunId, runId)
      .run(),
  );

  expect([
    String(updateError),
    String(deleteError),
    String(insertError),
    String(unplannedInsertError),
    String(requestOwnerError),
    String(planOwnerError),
  ]).toEqual([
    expect.stringMatching(/source_request_plan_fields_immutable/),
    expect.stringMatching(/source_request_immutable/),
    expect.stringMatching(/source_request_not_in_immutable_plan/),
    expect.stringMatching(/source_request_not_in_immutable_plan/),
    expect.stringMatching(/source_request_plan_fields_immutable/),
    expect.stringMatching(/ingestion_evidence_plan_request_set_immutable/),
  ]);
});

test("an Official Source Collection Plan cannot freeze another run's discovery evidence", async () => {
  const sourceRunId = "run_collection_plan_discovery_source";
  const targetRunId = "run_collection_plan_discovery_target";
  const plan = JSON.stringify({
    requests: [
      {
        id: "discovery",
        method: "GET",
        url: "https://en.onepiece-cardgame.com/cardlist/",
        headers: {},
        representation_fingerprint: "1".repeat(64),
      },
    ],
  });
  await testEnv.CATALOGUE_DB.batch([
    ...[sourceRunId, targetRunId].map((runId, index) =>
      ingestionQueries
        .insertIngestionRunsForAppliedD1RequestCopiesOwningRunIdentitiesAreImmutable(testEnv.CATALOGUE_DB)
        .bind(runId, `collection-plan-owner-${index}`),
    ),
    ...[sourceRunId, targetRunId].map((runId) =>
      sourceEvidenceQueries
        .insertIngestionEvidencePlansForAuthenticatedReparseRejectsNormalizedFixtureEnvelopeThroughUnavailableProduction(
          testEnv.CATALOGUE_DB,
        )
        .bind(runId, plan),
    ),
    sourceEvidenceQueries
      .insertSourceRequestsForOfficialSourceCollectionPlanCannotFreezeAnotherRunS(testEnv.CATALOGUE_DB)
      .bind(sourceRunId, "1".repeat(64)),
    sourceEvidenceQueries
      .insertSourceFetchAttemptsForOfficialSourceCollectionPlanCannotFreezeAnotherRunS(testEnv.CATALOGUE_DB)
      .bind(sourceRunId),
    sourceEvidenceQueries
      .insertSourceSnapshotsForOfficialSourceCollectionPlanCannotFreezeAnotherRunS(testEnv.CATALOGUE_DB)
      .bind(sourceRunId, "1".repeat(64), "2".repeat(64)),
    sourceEvidenceQueries
      .insertSourceParseOperationsForOfficialSourceCollectionPlanCannotFreezeAnotherRunS(testEnv.CATALOGUE_DB)
      .bind("3".repeat(64)),
    sourceEvidenceQueries
      .insertSourceObservationSetsForOfficialSourceCollectionPlanCannotFreezeAnotherRunS(testEnv.CATALOGUE_DB)
      .bind("3".repeat(64)),
  ]);

  const collectionPlan = JSON.stringify({
    contract: "card-keepr-official-source-collection-plan@1",
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    game_profile_version: "one-piece@1",
    adapter_version: "fixture-one-piece-json@3",
    discovery_observation_set_id: "srcobsset_collection_owner",
    requests: [],
  });
  await dropCollectionPlanDiscoveryGuard(testEnv.CATALOGUE_DB).run();
  const insertPlan = (runId: string, contentDigest: string) =>
    officialCollectionPlanInsertionStatement(catalogueStore(testEnv.CATALOGUE_DB), {
      runId,
      sourceLineage: "one-piece-en",
      observationSetId: "srcobsset_collection_owner",
      collectionPlanJson: collectionPlan,
      contentDigest,
      createdAt: "2026-08-01T00:00:03.000Z",
    });
  await expect(insertPlan(sourceRunId, `a${"Z".repeat(63)}`).run()).rejects.toThrow(/CHECK constraint failed/);
  await expect(insertPlan(targetRunId, "4".repeat(64)).run()).rejects.toThrow(
    /official_source_collection_plan_discovery_owner_mismatch/,
  );
  expect(await inspectCollectionPlanCount(testEnv.CATALOGUE_DB, targetRunId).first("count")).toBe(0);
});

test("a fresh D1 enforces full lowercase digests and canonical revision rule identity", async () => {
  // A separate database: the discovery-owner trigger is dropped below so
  // the digest and identity guards can be exercised without a real plan.
  const scratchDatabase = testEnv.SCRATCH_DB;
  await applyD1Migrations(scratchDatabase, testEnv.TEST_MIGRATIONS);
  await dropCollectionPlanDiscoveryGuard(scratchDatabase).run();

  const malformedDigest = await rejectedError(
    sourceEvidenceQueries
      .insertOfficialSourceCollectionPlansForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(scratchDatabase)
      .bind(`a${"Z".repeat(63)}`)
      .run(),
  );
  const validDigestMissingOwner = await rejectedError(
    sourceEvidenceQueries
      .insertOfficialSourceCollectionPlansForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(scratchDatabase)
      .bind("a".repeat(64))
      .run(),
  );
  expect(String(malformedDigest)).toMatch(/CHECK constraint failed/);
  expect(String(validDigestMissingOwner)).toMatch(
    /official_source_collection_plan_discovery_owner_mismatch|FOREIGN KEY constraint failed/,
  );

  const foreignKeys = await legalityQueries
    .inspectForeignKeyList(scratchDatabase)
    .all<{ table: string; from: string }>();
  expect(foreignKeys.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        table: "legality_rules",
        from: "legality_rule_id",
      }),
    ]),
  );
  const guards = await legalityQueries.readSqliteMasterName(scratchDatabase).all<{ name: string }>();
  expect(guards.results.map((row) => row.name)).toEqual([
    "guard_legality_rule_identity",
    "legality_rule_card_ids_canonical_insert",
    "legality_rule_card_ids_canonical_update",
    "legality_rule_provenance_immutable",
    "legality_rule_provenance_owner_insert",
    "legality_rule_provenance_owner_update",
    "legality_rule_scope_valid_insert",
    "legality_rules_immutable_delete",
    "revision_legality_rule_matches_canonical",
    "revision_legality_rule_scope_valid_insert",
    "revision_legality_rules_immutable_delete",
    "revision_legality_rules_immutable_update",
  ]);

  const requestPlan = JSON.stringify({
    requests: [
      {
        id: "upgraded-legality",
        method: "GET",
        url: "https://en.onepiece-cardgame.com/rules/restriction/",
        headers: {},
        representation_fingerprint: "5".repeat(64),
      },
    ],
  });
  const sourceFieldPointers = JSON.stringify({
    official_wording: "/observations/0/value/legality_rules/0/official_wording",
  });
  const upgradedRule = {
    id: "legality_rule_upgraded_guard",
    official_id: "upgraded-guard",
    game: "one-piece",
    region: "EN-OCEANIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    unresolved_scope: null,
    card_ids: ["card_upgraded_guard"],
    official_wording: "The upgraded guard remains authoritative.",
    effect: {
      type: "prohibited_combination",
      with_card_ids: ["card_upgraded_companion"],
    },
    source_lineage: "one-piece-en",
    source_snapshot_id: "srcsnap_upgraded_legality_guard",
    source_observation_set_id: "srcobsset_upgraded_legality_guard",
    source_observation_id: "srcobs_upgraded_legality_guard",
    source_observation_pointer: "/observations/0/value/legality_rules/0",
    source_field_pointers: JSON.parse(sourceFieldPointers),
    first_revision_id: "catrev_upgraded_legality_guard",
    last_observed_revision_id: "catrev_upgraded_legality_guard",
    current: true,
    last_missing_revision_id: null,
  };
  await scratchDatabase.batch([
    ingestionQueries
      .insertIngestionRunsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(scratchDatabase)
      .bind(
        "8".repeat(64),
        JSON.stringify({
          candidate_digest: "8".repeat(64),
          expected_current_revision_id: "catrev_spine_000",
        }),
      ),
    ingestionQueries.setOperationStateActiveIngestionRunIdForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(
      scratchDatabase,
    ),
    sourceEvidenceQueries
      .insertIngestionEvidencePlansForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(scratchDatabase)
      .bind(requestPlan),
    sourceEvidenceQueries
      .insertSourceRequestsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(scratchDatabase)
      .bind("5".repeat(64)),
    sourceEvidenceQueries.insertSourceFetchAttemptsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(
      scratchDatabase,
    ),
    sourceEvidenceQueries
      .insertSourceSnapshotsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(scratchDatabase)
      .bind("5".repeat(64), "6".repeat(64)),
    sourceEvidenceQueries
      .insertSourceParseOperationsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(scratchDatabase)
      .bind("7".repeat(64)),
    sourceEvidenceQueries
      .insertSourceObservationSetsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(scratchDatabase)
      .bind("7".repeat(64)),
    ingestionQueries
      .insertCatalogueRevisionsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(scratchDatabase)
      .bind("8".repeat(64), "8".repeat(64)),
    sourceEvidenceQueries
      .insertLegalityRulesForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(scratchDatabase)
      .bind(
        upgradedRule.id,
        upgradedRule.official_id,
        upgradedRule.game,
        upgradedRule.region,
        upgradedRule.format,
        upgradedRule.event_tier,
        upgradedRule.effective_from,
        upgradedRule.effective_until,
        upgradedRule.official_wording,
        JSON.stringify(upgradedRule.effect),
        JSON.stringify([...upgradedRule.card_ids, ...upgradedRule.effect.with_card_ids].sort()),
        JSON.stringify(upgradedRule.card_ids),
        upgradedRule.source_lineage,
        upgradedRule.source_snapshot_id,
        upgradedRule.source_observation_set_id,
        upgradedRule.source_observation_id,
        upgradedRule.source_observation_pointer,
        sourceFieldPointers,
        upgradedRule.first_revision_id,
        upgradedRule.last_observed_revision_id,
      ),
    sourceEvidenceQueries
      .insertRevisionLegalityRulesForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(scratchDatabase)
      .bind(
        upgradedRule.id,
        upgradedRule.game,
        upgradedRule.region,
        upgradedRule.format,
        upgradedRule.event_tier,
        upgradedRule.effective_from,
        upgradedRule.effective_until,
        JSON.stringify([...upgradedRule.card_ids, ...upgradedRule.effect.with_card_ids].sort()),
        JSON.stringify(upgradedRule),
      ),
  ]);
  const upgradedCanonicalCardIdErrors = await canonicalLegalityCardIdInvariantErrors(
    scratchDatabase,
    {
      ...upgradedRule,
      effect_json: JSON.stringify(upgradedRule.effect),
      source_field_pointers_json: sourceFieldPointers,
    },
    "upgraded",
  );
  expect(upgradedCanonicalCardIdErrors.map(String)).toEqual(
    upgradedCanonicalCardIdErrors.map(() => expect.stringMatching(/legality_rule_card_ids_not_canonical/)),
  );
  const upgradedCanonicalEffectErrors = await canonicalLegalityEffectInvariantErrors(
    scratchDatabase,
    {
      ...upgradedRule,
      source_field_pointers_json: sourceFieldPointers,
    },
    "upgraded",
  );
  expect(upgradedCanonicalEffectErrors.map(String)).toEqual(
    upgradedCanonicalEffectErrors.map(() => expect.stringMatching(/legality_rule_effect_invalid/)),
  );
  const upgradedScopeErrors = await canonicalLegalityScopeInvariantErrors(
    scratchDatabase,
    {
      ...upgradedRule,
      source_field_pointers_json: sourceFieldPointers,
    },
    "upgraded",
  );
  expect(upgradedScopeErrors.map(String)).toEqual(
    upgradedScopeErrors.map(() => expect.stringMatching(/legality_rule_scope_invalid/)),
  );
  const upgradedProvenanceMutation = await rejectedError(
    sourceEvidenceQueries.setLegalityRulesSourceSnapshotId(scratchDatabase).bind(upgradedRule.id).run(),
  );
  const upgradedCrossOwner = await rejectedError(
    sourceEvidenceQueries
      .insertLegalityRulesForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRuleWithCatrevUpgradedLegalityGuard(
        scratchDatabase,
      )
      .run(),
  );
  const upgradedRevisionMutation = await rejectedError(
    legalityQueries.setRevisionLegalityRulesFormat(scratchDatabase).bind(upgradedRule.id).run(),
  );
  const upgradedRevisionDelete = await rejectedError(
    legalityQueries.deleteRevisionLegalityRules(scratchDatabase).bind(upgradedRule.id).run(),
  );
  const { event_tier: _missingUpgradedEventTier, ...upgradedWithoutNullableKey } = upgradedRule;
  const { effective_until: _replacedUpgradedEffectiveUntil, ...upgradedWithReplacementKey } = upgradedRule;
  const upgradedMissingNullableKey = await rejectedError(
    legalityQueries
      .insertRevisionLegalityRulesForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRuleWithCatrevUpgradedLegalityGuard(
        scratchDatabase,
      )
      .bind(
        upgradedRule.id,
        upgradedRule.game,
        upgradedRule.region,
        upgradedRule.format,
        upgradedRule.event_tier,
        upgradedRule.effective_from,
        upgradedRule.effective_until,
        JSON.stringify(upgradedRule.card_ids),
        JSON.stringify(upgradedWithoutNullableKey),
      )
      .run(),
  );
  const upgradedArbitraryKeySubstitution = await rejectedError(
    legalityQueries
      .insertRevisionLegalityRulesForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRuleWithCatrevUpgradedLegalityGuard(
        scratchDatabase,
      )
      .bind(
        upgradedRule.id,
        upgradedRule.game,
        upgradedRule.region,
        upgradedRule.format,
        upgradedRule.event_tier,
        upgradedRule.effective_from,
        upgradedRule.effective_until,
        JSON.stringify(upgradedRule.card_ids),
        JSON.stringify({
          ...upgradedWithReplacementKey,
          attacker_replacement: null,
        }),
      )
      .run(),
  );
  const upgradedDuplicateRequiredKey = await rejectedError(
    legalityQueries
      .insertRevisionLegalityRulesForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRuleWithCatrevUpgradedLegalityGuard(
        scratchDatabase,
      )
      .bind(
        upgradedRule.id,
        upgradedRule.game,
        upgradedRule.region,
        upgradedRule.format,
        upgradedRule.event_tier,
        upgradedRule.effective_from,
        upgradedRule.effective_until,
        JSON.stringify(upgradedRule.card_ids),
        JSON.stringify(upgradedRule).replace(/\}$/u, ',"official_wording":"Attacker-controlled duplicate."}'),
      )
      .run(),
  );
  const upgradedNestedDocuments = [
    { ...upgradedRule, card_ids: upgradedRule.card_ids[0] },
    {
      ...upgradedRule,
      card_ids: [upgradedRule.card_ids[0], upgradedRule.card_ids[0]],
    },
    {
      ...upgradedRule,
      card_ids: [...upgradedRule.card_ids, ...upgradedRule.effect.with_card_ids],
    },
  ];
  const upgradedNestedCardIds = await Promise.all(
    upgradedNestedDocuments.map((document) =>
      rejectedError(
        legalityQueries
          .insertRevisionLegalityRulesForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRuleWithCatrevUpgradedLegalityGuard(
            scratchDatabase,
          )
          .bind(
            upgradedRule.id,
            upgradedRule.game,
            upgradedRule.region,
            upgradedRule.format,
            upgradedRule.event_tier,
            upgradedRule.effective_from,
            upgradedRule.effective_until,
            JSON.stringify([...upgradedRule.card_ids, ...upgradedRule.effect.with_card_ids]),
            JSON.stringify(document),
          )
          .run(),
      ),
    ),
  );
  expect([
    String(upgradedProvenanceMutation),
    String(upgradedCrossOwner),
    String(upgradedRevisionMutation),
    String(upgradedRevisionDelete),
    String(upgradedMissingNullableKey),
    String(upgradedArbitraryKeySubstitution),
    String(upgradedDuplicateRequiredKey),
    ...upgradedNestedCardIds.map(String),
  ]).toEqual([
    expect.stringMatching(/legality_rule_provenance_immutable/),
    expect.stringMatching(/legality_rule_provenance_owner_mismatch/),
    expect.stringMatching(/revision_legality_rule_immutable/),
    expect.stringMatching(/revision_legality_rule_immutable/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
  ]);
});

test.each([
  ["one-piece-json-document@999", "one-piece", "one-piece-en"],
  ["fusion-world-en@999", "fusion-world", "fusion-world-en"],
  ["digimon-en@999", "digimon", "digimon-en"],
  ["gundam-en-asia@999", "gundam", "gundam-en-asia"],
  ["gundam-en-us@999", "gundam", "gundam-en-us"],
])("production planning rejects the unregistered %s publisher representation", async (adapter, game, lineage) => {
  const blocked = await request("/v1/ingestion-runs/evidence", {
    supported_game: game,
    source_lineage: lineage,
    adapter_version: adapter,
    idempotency_key: `reject-undemonstrated-${adapter}`,
    requests: [
      {
        id: "discovery",
        method: "GET",
        url: officialAdapterUrl(adapter, "contextual-legality-asia"),
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "adapter_not_supported",
  });
});

test("legality freshness remains independent across partial regional refreshes", async () => {
  const publishScope = async (
    key: string,
    lineage: "gundam-en-asia" | "gundam-en-us",
    url: string,
    observedAt: string,
  ) => {
    const started = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, {
      idempotency_key: key,
      supported_game: "gundam",
      source_lineage: lineage,
      adapter_version: lineage === "gundam-en-asia" ? "fixture-gundam-en-asia-json@2" : "fixture-gundam-en-us-json@2",
      requests: [
        {
          id: `${key}-rules`,
          method: "GET",
          url,
          headers: { accept: "application/json" },
        },
      ],
    });
    const runId = requiredString(started, "id");
    expect((await request(`/v1/ingestion-runs/${runId}/collection/resume`, {}, observedAt)).response.status).toBe(202);
    await waitForState(runId, "parsing");
    const reconciled = await reconcile(runId, observedAt);
    expect(reconciled.response.status).toBe(200);
    const published = await approve(reconciled.document, `publish-${key}`, observedAt);
    expect(published.response.status).toBe(200);
    const freshness = await sourceEvidenceQueries
      .readSourceFreshnessCheckedAt(testEnv.CATALOGUE_DB)
      .bind(lineage, runId)
      .first<{ checked_at: string }>();
    if (freshness === null) {
      throw new Error(`Freshness for ${lineage} is absent`);
    }
    return {
      runId,
      checkedAt: freshness.checked_at,
      revisionId: requiredString(published.document, "resulting_revision_id"),
      reconciled: reconciled.document,
    };
  };
  const freshnessRows = () =>
    sourceEvidenceQueries.readSourceFreshnessGameArea(testEnv.CATALOGUE_DB).all<Record<string, unknown>>();

  const asia = await publishScope(
    "regional-freshness-asia",
    "gundam-en-asia",
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=current",
    "2026-08-02T01:00:00.000Z",
  );
  expect((await freshnessRows()).results).toEqual([
    {
      game: "gundam",
      area: "legality-rules",
      source_lineage: "gundam-en-asia",
      region: "EN-ASIA",
      checked_at: asia.checkedAt,
      ingestion_run_id: asia.runId,
    },
  ]);

  const us = await publishScope(
    "regional-freshness-us",
    "gundam-en-us",
    "https://official-source.invalid/reconciliation/contextual-legality-domain-us",
    "2026-08-02T02:00:00.000Z",
  );
  const afterUs = (await freshnessRows()).results;
  expect(us.checkedAt).not.toBe(asia.checkedAt);
  expect(afterUs).toEqual([
    {
      game: "gundam",
      area: "legality-rules",
      source_lineage: "gundam-en-asia",
      region: "EN-ASIA",
      checked_at: asia.checkedAt,
      ingestion_run_id: asia.runId,
    },
    {
      game: "gundam",
      area: "legality-rules",
      source_lineage: "gundam-en-us",
      region: "EN-US",
      checked_at: us.checkedAt,
      ingestion_run_id: us.runId,
    },
  ]);
  const retainedUsFreshness = structuredClone(afterUs[1]);

  const retiredAsia = await publishScope(
    "regional-freshness-asia-empty",
    "gundam-en-asia",
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=empty",
    "2026-08-02T03:00:00.000Z",
  );
  const afterPartialRefresh = (await freshnessRows()).results;
  expect(retiredAsia.checkedAt).not.toBe(asia.checkedAt);
  expect(retiredAsia.checkedAt).not.toBe(us.checkedAt);
  expect(afterPartialRefresh[0]).toEqual({
    game: "gundam",
    area: "legality-rules",
    source_lineage: "gundam-en-asia",
    region: "EN-ASIA",
    checked_at: retiredAsia.checkedAt,
    ingestion_run_id: retiredAsia.runId,
  });
  expect(afterPartialRefresh[1]).toEqual(retainedUsFreshness);

  expect(await revisionLegalityRule(retiredAsia.revisionId, "legality_rule_us_eligible")).toMatchObject({
    current: true,
    source_lineage: "gundam-en-us",
  });
  expect(await revisionLegalityRule(retiredAsia.revisionId, "legality_rule_asia_eligible")).toMatchObject({
    current: false,
    source_lineage: "gundam-en-asia",
  });
  expect((await exportedManifest(retiredAsia.revisionId)).source_freshness).toEqual(
    expect.arrayContaining([
      {
        game: "gundam",
        area: "legality-rules",
        source_lineage: "gundam-en-asia",
        region: "EN-ASIA",
        checked_at: retiredAsia.checkedAt,
      },
      {
        game: "gundam",
        area: "legality-rules",
        source_lineage: "gundam-en-us",
        region: "EN-US",
        checked_at: us.checkedAt,
      },
    ]),
  );
}, 90_000);

test("a versioned production adapter derives and exports an exact representable Legality Rule", async () => {
  const seeded = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fixture-fusion-world-json@2",
    idempotency_key: "seed-production-legality-card",
    requests: [
      {
        id: "seed-card",
        method: "GET",
        url: "https://official-source.invalid/reconciliation/profile-fusion-world",
        headers: { accept: "application/json" },
      },
    ],
  });
  const seededRunId = requiredString(seeded, "id");
  expect((await request(`/v1/ingestion-runs/${seededRunId}/collection/resume`, {})).response.status).toBe(202);
  await waitForState(seededRunId, "parsing");
  const seededCandidate = await reconcile(seededRunId);
  expect(seededCandidate.response.status).toBe(200);
  const card = (seededCandidate.document.cards as Array<Record<string, unknown>>).find(
    (item) => (item.official_identity as Record<string, unknown>).value === "FB01-001",
  );
  if (card === undefined) throw new Error("FB01-001 is absent");
  expect((await approve(seededCandidate.document, "publish-production-legality-card")).response.status).toBe(200);

  const started = await request("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "production-representable-legality-v3",
    requests: productionFusionLegalityRequests("card-keepr-representable-legality-v3"),
  });
  expect(started.response.status).toBe(201);
  const runId = requiredString(started.document, "id");
  expect((await request(`/v1/ingestion-runs/${runId}/collection/resume`, {})).response.status).toBe(202);
  const completedProductionRun = await waitForState(runId, "awaiting_approval");
  const childIds = (
    completedProductionRun.workflow as {
      child_ids: string[];
    }
  ).child_ids;
  expect(childIds.length).toBeGreaterThanOrEqual(3);
  expect(new Set(childIds).size).toBe(childIds.length);
  const duplicateSnapshots = await sourceEvidenceQueries
    .countSourceSnapshotsCount(testEnv.CATALOGUE_DB)
    .bind(runId)
    .all();
  expect(duplicateSnapshots.results).toEqual([]);
  const candidate = await request(`/v1/ingestion-runs/${runId}/candidate`);
  expect(candidate.response.status).toBe(200);
  expect(requiredString(candidate.document, "candidate_digest")).toMatch(/^[0-9a-f]{64}$/u);
  const published = await approve(candidate.document, "publish-production-representable-legality-v3");
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");

  expect(await exportedLegalityRule(revisionId, "fw_production_eligible")).toMatchObject({
    official_wording: "FB01-001 is eligible 'as printed' – publisher–confirmed &#39;literal&#39;.",
    region: "EN-OCEANIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    effect: { type: "eligible" },
  });

  const conflicting = await request("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "production-conflicting-shared-legality-v3",
    requests: productionFusionLegalityRequests(
      "card-keepr-representable-legality-v3",
      "card-keepr-conflicting-shared-legality-v3",
    ),
  });
  expect(conflicting.response.status).toBe(201);
  const conflictingRunId = requiredString(conflicting.document, "id");
  expect((await request(`/v1/ingestion-runs/${conflictingRunId}/collection/resume`, {})).response.status).toBe(202);
  expect(await waitForState(conflictingRunId, "failed")).toMatchObject({
    state: "failed",
    failure_code: "printing_reconciliation_blocked",
  });
}, 90_000);

test("production discovery retains literal stages and cannot freeze a Collection Plan before closure", async () => {
  const started = await request("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "production-staged-discovery-gap-v3",
    requests: productionFusionLegalityRequests("card-keepr-staged-discovery-gap-v3"),
  });
  expect(started.response.status).toBe(201);
  const runId = requiredString(started.document, "id");
  expect((await request(`/v1/ingestion-runs/${runId}/collection/resume`, {})).response.status).toBe(202);
  expect(await waitForState(runId, "failed")).toMatchObject({
    state: "failed",
  });

  const frozen = await ingestionQueries
    .countOfficialSourceCollectionPlansCount(testEnv.CATALOGUE_DB)
    .bind(runId)
    .first<{ count: number }>();
  expect(frozen?.count).toBe(0);

  const staged = await sourceEvidenceQueries
    .readSourceDiscoveryRequestPlansParentRequestIdUrl(testEnv.CATALOGUE_DB)
    .bind(runId)
    .all<{
      parent_request_id: string;
      url: string;
      request_role: string;
    }>();
  expect(staged.results).toEqual(
    expect.arrayContaining([
      {
        parent_request_id: "fusion-world-en:discovery",
        url: "https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&category%5B0%5D=583301",
        request_role: "listing",
      },
      {
        parent_request_id: "fusion-world-en:discovery",
        url: "https://www.dbs-cardgame.com/fw/en/products/",
        request_role: "listing",
      },
      {
        parent_request_id: "fusion-world-en:discovery",
        url: "https://www.dbs-cardgame.com/fw/en/news/01_31.html",
        request_role: "listing",
      },
    ]),
  );
  expect((await request(`/v1/ingestion-runs/${runId}/candidate`)).response.status).toBe(409);
}, 90_000);

test("authenticated parsing retains staged live Fusion policy root and detail observations", async () => {
  const runId = "run_live_fusion_policy_evidence";
  const rootRequestId = `fusion-world-en:listing:rules:${"a".repeat(64)}`;
  const detailRequestId = `fusion-world-en:detail:${"b".repeat(64)}`;
  const fixtures = [
    {
      requestId: rootRequestId,
      snapshotId: "srcsnap_live_fusion_policy_root",
      fetchId: "srcfetch_live_fusion_policy_root",
      fixture: fusionLivePolicyRoot,
    },
    {
      requestId: detailRequestId,
      snapshotId: "srcsnap_live_fusion_policy_detail",
      fetchId: "srcfetch_live_fusion_policy_detail",
      fixture: fusionLivePolicyDetail,
    },
  ];
  const retained = await Promise.all(
    fixtures.map(async (item) => {
      const bytes = Uint8Array.from(atob(item.fixture.body_base64), (character) => character.charCodeAt(0));
      return { ...item, bytes, digest: await sha256(bytes) };
    }),
  );
  await testEnv.CATALOGUE_DB.batch([
    ingestionQueries
      .insertIngestionRunsForAuthenticatedParsingRetainsStagedLiveFusionPolicyRootDetail(testEnv.CATALOGUE_DB)
      .bind(runId, "live-fusion-policy-evidence"),
    sourceEvidenceQueries
      .insertIngestionEvidencePlansForAuthenticatedParsingRetainsStagedLiveFusionPolicyRootDetail(testEnv.CATALOGUE_DB)
      .bind(
        runId,
        JSON.stringify({
          requests: retained.map((item) => ({
            id: item.requestId,
            method: "GET",
            url: item.fixture.source_url,
            headers: { accept: "text/html" },
            representation_fingerprint: item.digest,
          })),
        }),
      ),
    ...retained.flatMap((item, index) => [
      sourceEvidenceQueries
        .insertSourceRequestsForAuthenticatedParsingRetainsStagedLiveFusionPolicyRootDetail(testEnv.CATALOGUE_DB)
        .bind(
          runId,
          item.requestId,
          index,
          item.fixture.source_url,
          JSON.stringify({ accept: "text/html" }),
          item.digest,
          item.snapshotId,
        ),
      sourceEvidenceQueries
        .insertSourceFetchAttemptsForAuthenticatedParsingRetainsStagedLiveFusionPolicyRootDetail(testEnv.CATALOGUE_DB)
        .bind(item.fetchId, runId, item.requestId),
      sourceEvidenceQueries
        .insertSourceSnapshotsForAuthenticatedParsingRetainsStagedLiveFusionPolicyRootDetail(testEnv.CATALOGUE_DB)
        .bind(
          item.snapshotId,
          runId,
          item.requestId,
          item.fetchId,
          item.fixture.source_url,
          JSON.stringify({ accept: "text/html" }),
          item.digest,
          item.fixture.content_type,
          item.digest,
          item.bytes.byteLength,
          `source-snapshots/${item.snapshotId}.bin`,
        ),
    ]),
  ]);
  await Promise.all(
    retained.map((item) => testEnv.EVIDENCE_OBJECTS.put(`source-snapshots/${item.snapshotId}.bin`, item.bytes)),
  );

  for (const item of retained) {
    const parsed = await request(`/v1/source-snapshots/${item.snapshotId}/observations`, {
      adapter_version: "fusion-world-en@9",
      idempotency_key: `parse-${item.snapshotId}`,
    });
    expect(parsed.response.status).toBe(201);
  }

  const observationSets = await sourceEvidenceQueries
    .readSourceObservationSetsSourceSnapshotIdObservationCount(testEnv.CATALOGUE_DB)
    .bind(fixtures[0]!.snapshotId, fixtures[1]!.snapshotId)
    .all<{
      source_snapshot_id: string;
      observation_count: number;
      content_object_key: string;
    }>();
  expect(observationSets.results.map((row) => row.observation_count)).toEqual([1, 1]);
  const documents = await Promise.all(
    observationSets.results.map(async (row) => {
      const object = await testEnv.EVIDENCE_OBJECTS.get(row.content_object_key);
      if (object === null) throw new Error("Live policy observations are absent");
      return object.json<{
        observations: Array<{ value: Record<string, unknown> }>;
      }>();
    }),
  );
  const rootObservation = documents
    .flatMap(({ observations }) => observations)
    .find(({ value }) => value.observation_type === "official_surface_evidence")?.value;
  expect(rootObservation?.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        surface: "legality-current",
        url: "https://www.dbs-cardgame.com/fw/en/news/01_305.html",
      }),
    ]),
  );
  const legalityObservation = documents
    .flatMap(({ observations }) => observations)
    .find(({ value }) => value.observation_type === "legality_rules")?.value;
  const rules = legalityObservation?.legality_rules as Array<Record<string, unknown>> | undefined;
  expect(rules).toHaveLength(8);
  expect(
    rules?.every(
      (rule) => rule.effective_from === null && (rule.effect as Record<string, unknown>).type === "unresolved",
    ),
  ).toBe(true);
}, 90_000);

test("the One Piece production release surface publishes release timing through the export seam", async () => {
  const seeded = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "seed-production-one-piece-release-card",
    requests: [
      {
        id: "seed-card",
        method: "GET",
        url: "https://official-source.invalid/reconciliation/base",
        headers: { accept: "application/json" },
      },
    ],
  });
  const seededRunId = requiredString(seeded, "id");
  expect((await request(`/v1/ingestion-runs/${seededRunId}/collection/resume`, {})).response.status).toBe(202);
  await waitForState(seededRunId, "parsing");
  const seededCandidate = await reconcile(seededRunId);
  expect(seededCandidate.response.status).toBe(200);
  const card = (seededCandidate.document.cards as Array<Record<string, unknown>>).find(
    (item) => (item.official_identity as Record<string, unknown>).value === "OP01-001",
  );
  if (card === undefined) throw new Error("OP01-001 is absent");
  expect((await approve(seededCandidate.document, "publish-production-one-piece-release-card")).response.status).toBe(
    200,
  );

  const started = await request("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: "production-one-piece-release-timing-v2",
    requests: productionOnePieceReleaseTimingRequests(),
  });
  expect(started.response.status).toBe(201);
  const runId = requiredString(started.document, "id");
  expect((await request(`/v1/ingestion-runs/${runId}/collection/resume`, {})).response.status).toBe(202);
  await waitForState(runId, "awaiting_approval");
  const candidate = await request(`/v1/ingestion-runs/${runId}/candidate`);
  const published = await approve(candidate.document, "publish-production-one-piece-release-timing-v2");
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");

  expect(await exportedLegalityRule(revisionId, "OP-RELEASE-2026-001")).toMatchObject({
    game: "one-piece",
    official_wording: "OP01-001 becomes legal for standard tournament play on 2026-09-04.",
    effect: { type: "release_timing", legal_from: "2026-09-04" },
  });

  const changed = await request("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: "production-one-piece-unrecognized-release-v2",
    requests: productionOnePieceReleaseTimingRequests("card-keepr-one-piece-unrecognized-release-v2"),
  });
  expect(changed.response.status).toBe(201);
  const changedRunId = requiredString(changed.document, "id");
  expect((await request(`/v1/ingestion-runs/${changedRunId}/collection/resume`, {})).response.status).toBe(202);
  await waitForState(changedRunId, "awaiting_approval");
  const changedCandidate = await request(`/v1/ingestion-runs/${changedRunId}/candidate`);
  expect(changedCandidate.response.status).toBe(200);
  const rejected = await request(`/v1/ingestion-runs/${changedRunId}/rejection`, {
    candidate_digest: requiredString(changedCandidate.document, "candidate_digest"),
    idempotency_key: "reject-ordinary-one-piece-product-release",
  });
  expect(rejected.response.status).toBe(200);
  expect(
    await publishedCatalogueQueries
      .readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB)
      .first("current_revision_id"),
  ).toBe(revisionId);
}, 90_000);

test("a repository Evidence Plan rejects an adapter origin mismatch without the schema trigger", async () => {
  const runId = "run_plan_origin_repository_guard";
  await ingestionQueries
    .insertIngestionRunsForAppliedD1RequestCopiesOwningRunIdentitiesAreImmutable(testEnv.CATALOGUE_DB)
    .bind(runId, "plan-origin-repository-guard")
    .run();
  await dropEvidencePlanOriginGuard(testEnv.CATALOGUE_DB).run();
  await expect(
    evidencePlanInsertionStatement(catalogueStore(testEnv.CATALOGUE_DB), {
      runId,
      sourceLineage: "one-piece-en",
      supportedGame: "one-piece",
      gameProfileVersion: "one-piece@1",
      adapterVersion: "fixture-one-piece-json@3",
      requestPlanJson: "{}",
      planOrigin: "production",
    }).run(),
  ).rejects.toThrow(/evidence_plan_origin_mismatch/);
  expect(await inspectEvidencePlanCount(testEnv.CATALOGUE_DB, runId).first("count")).toBe(0);
});
