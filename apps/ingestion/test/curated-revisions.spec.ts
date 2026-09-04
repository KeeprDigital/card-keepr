import { catalogueStore } from "../../../src/catalogue/shared";
import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";
import * as ingestionQueries from "./query-helpers/ingestion";
import * as curatedQueries from "./query-helpers/curated";
import * as reconciliationQueries from "./query-helpers/reconciliation";
import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { canonicalJson, sha256Text, type CatalogueCard } from "../../../src/catalogue/shared";
import { buildCatalogueExport } from "../../../src/catalogue/export";
import {
  applyPinnedCuratedRevisions,
  createCuratedRevision,
  curatedSourceAbsence,
  pinCuratedRevisionsForRun,
  prepareCuratedRevisionRunStart,
  reaffirmCuratedRevision,
  retireCuratedRevision,
  showCuratedRevision,
  stripCuratedRevisionEffects,
  supersedeCuratedRevision,
} from "../../../src/catalogue/curated";

declare global {
  interface __BaseEnv_Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

const now = "2026-08-05T01:02:03.000Z";
let sequence = 0;
let currentRevision = "";
let card: CatalogueCard = {
  id: "card_op01_001",
  game: "one-piece",
  official_identity: { kind: "card_number", value: "OP01-001" },
  name: "Official Name",
  effective_rules_text: "Official text",
  game_data: {
    profile: "one-piece@1",
    attributes: {
      card_type: "character",
      colours: ["red"],
      cost: 1,
      life: null,
      battle_attributes: [],
      power: 1000,
      counter: 1000,
      traits: [],
      block_icons: [],
      effect_text: null,
      trigger_text: null,
    },
  },
};

beforeEach(async () => {
  await applyD1Migrations(env.CATALOGUE_DB, env.TEST_MIGRATIONS);
  sequence += 1;
  const previousRevision = await publishedCatalogueQueries
    .readCatalogueStateCurrentRevisionId(env.CATALOGUE_DB)
    .first<{ current_revision_id: string }>();
  currentRevision = `catrev_curated_seed_${sequence}`;
  const runId = `run_curated_seed_${sequence}`;
  card = { ...card, id: `card_op01_001_${sequence}` };
  const candidate = {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [card],
    printings: [
      {
        id: `printing_${sequence}`,
        card_id: card.id,
        rarity: { normalized: "common", raw: "C" },
        printed_rules_text: null,
        game_data: null,
      },
    ],
    products: [
      {
        id: `product_${sequence}`,
        reference: { kind: "official_code", value: "OP-01" },
        game: "one-piece",
        official_code: "OP-01",
        name: "Booster",
        releases: [
          {
            id: `release_${sequence}`,
            event_key: `event_${sequence}`,
            product_id: `product_${sequence}`,
            region: "EN-OCEANIA",
            date: { precision: "day", value: "2026-08-05" },
            status: "announced",
          },
        ],
        observed: true,
        withdrawal: null,
        included: [],
        provenance: {},
        disagreements: [],
      },
    ],
    product_relationships: [
      {
        id: `relationship_product_card_${sequence}`,
        game: "one-piece",
        kind: "product-card",
        from: { type: "product", id: `product_${sequence}` },
        to: { type: "card", id: card.id },
        evidence_category: "explicit",
        resolution: "canonical",
        source_lineage: "one-piece-en",
        source_observation_ids: [`srcobs_${sequence}`],
        relationship_value: card.official_identity.value,
        observed: true,
      },
    ],
    distribution_contexts: [
      {
        id: `distribution_context_${sequence}`,
        game: "one-piece",
        key: `promotion_${sequence}`,
        kind: "promotion",
        label: "Official Promotion",
        product_id: `product_${sequence}`,
        evidence_category: "explicit",
        observed: true,
        source_lineages: ["one-piece-en"],
      },
    ],
    errata: [
      {
        id: `erratum_${sequence}`,
        game: "one-piece",
        target_type: "card",
        target_id: card.id,
        effective_from: "2026-08-05",
        official_wording: "Official erratum wording.",
        corrected_value: "Official corrected text.",
        provenance: [
          {
            source_lineage: "one-piece-en",
            source_observation_id: `srcobs_erratum_${sequence}`,
          },
        ],
      },
    ],
    legality_rules: [
      {
        id: `legality_rule_${sequence}`,
        official_id: `official_rule_${sequence}`,
        game: "one-piece",
        region: "EN-OCEANIA",
        format: "standard",
        event_tier: null,
        effective_from: "2026-08-05",
        effective_until: null,
        unresolved_scope: null,
        card_ids: [card.id],
        official_wording: "This card is eligible.",
        effect: { type: "eligible" },
        source_lineage: "one-piece-en",
        source_snapshot_id: `snapshot_${sequence}`,
        source_observation_set_id: `set_${sequence}`,
        source_observation_id: `srcobs_legality_${sequence}`,
        source_observation_pointer: "/observations/0/value/legality_rules/0",
        source_field_pointers: {
          official_wording: "/observations/0/value/legality_rules/0/official_wording",
          effective_from: "/observations/0/value/legality_rules/0/effective_from",
          effective_until: "/observations/0/value/legality_rules/0/effective_until",
          unresolved_scope: "/observations/0/value/legality_rules/0/unresolved_scope",
          region: "/observations/0/value/legality_rules/0/region",
          format: "/observations/0/value/legality_rules/0/format",
          event_tier: "/observations/0/value/legality_rules/0/event_tier",
          card_numbers: "/observations/0/value/legality_rules/0/card_numbers",
          effect: "/observations/0/value/legality_rules/0/effect",
        },
      },
      {
        id: `legality_rule_gundam_${sequence}`,
        official_id: `official_rule_gundam_${sequence}`,
        game: "gundam",
        region: "EN-ASIA",
        format: "standard",
        event_tier: null,
        effective_from: "2026-08-05",
        effective_until: null,
        unresolved_scope: null,
        card_ids: [],
        official_wording: "This Gundam rule is eligible.",
        effect: { type: "eligible" },
        source_lineage: "gundam-en-asia",
        source_snapshot_id: `snapshot_gundam_${sequence}`,
        source_observation_set_id: `set_gundam_${sequence}`,
        source_observation_id: `srcobs_gundam_${sequence}`,
        source_observation_pointer: "/observations/0/value/legality_rules/0",
        source_field_pointers: {
          official_wording: "/observations/0/value/legality_rules/0/official_wording",
          effective_from: "/observations/0/value/legality_rules/0/effective_from",
          effective_until: "/observations/0/value/legality_rules/0/effective_until",
          unresolved_scope: "/observations/0/value/legality_rules/0/unresolved_scope",
          region: "/observations/0/value/legality_rules/0/region",
          format: "/observations/0/value/legality_rules/0/format",
          event_tier: "/observations/0/value/legality_rules/0/event_tier",
          card_numbers: "/observations/0/value/legality_rules/0/card_numbers",
          effect: "/observations/0/value/legality_rules/0/effect",
        },
      },
    ],
  };
  await ingestionQueries.setOperationStateActiveIngestionRunIdActiveProductionReleaseId(env.CATALOGUE_DB).run();
  await curatedQueries.setCuratedRevisionsStatusEventVersion(env.CATALOGUE_DB).run();
  await env.CATALOGUE_DB.batch([
    ingestionQueries.insertIngestionRunsForCuratedRevisions(env.CATALOGUE_DB).bind(
      runId,
      now,
      previousRevision!.current_revision_id,
      `curated-seed-${sequence}`,
      now,
      canonicalJson(candidate),
      canonicalJson({
        candidate_digest: "seed-digest",
        expected_current_revision_id: previousRevision!.current_revision_id,
      }),
    ),
    ingestionQueries
      .setOperationStateActiveIngestionRunIdForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        env.CATALOGUE_DB,
      )
      .bind(runId),
    ingestionQueries
      .insertCatalogueRevisionsForCuratedRevisions(env.CATALOGUE_DB)
      .bind(currentRevision, runId, now, previousRevision!.current_revision_id),
    publishedCatalogueQueries
      .setCatalogueStateCurrentRevisionIdPublishedAt(env.CATALOGUE_DB)
      .bind(currentRevision, now),
    publishedCatalogueQueries
      .insertRevisionCardsForCuratedRevisions(env.CATALOGUE_DB)
      .bind(currentRevision, card.id, canonicalJson(card)),
    publishedCatalogueQueries
      .insertRevisionPrintingsForCuratedRevisions(env.CATALOGUE_DB)
      .bind(currentRevision, `printing_${sequence}`, card.id, canonicalJson(candidate.printings[0])),
    ingestionQueries.setOperationStateActiveIngestionRunIdForInstallApiSuite(env.CATALOGUE_DB),
  ]);
});

afterEach(async () => {
  await env.CATALOGUE_DB.batch([
    ingestionQueries.setIngestionRunsStateTerminalAtForCuratedRevisions(env.CATALOGUE_DB),
    ingestionQueries.setOperationStateActiveIngestionRunIdActiveProductionReleaseId(env.CATALOGUE_DB),
  ]);
});

test("validate derives a canonical proposal digest and rejects protected identity fields", async () => {
  const valid = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: await proposal("/name", "Curated Name"),
    catalogue_revision_id: currentRevision,
  });
  expect(valid.status).toBe(200);
  await expect(valid.json()).resolves.toMatchObject({
    contract: "card-keepr-curated-revision-validation@1",
    valid: true,
    schema_binding: {
      catalogue_revision_id: currentRevision,
      game_profile: "one-piece@1",
    },
  });

  const protectedField = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: await proposal("/official_identity/value", "OP99-999"),
    catalogue_revision_id: currentRevision,
  });
  expect(protectedField.status).toBe(422);
  await expect(protectedField.json()).resolves.toMatchObject({
    code: "curated_revision_identity_forbidden",
  });

  const invalidNull = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: await proposal("/name", null),
    catalogue_revision_id: currentRevision,
  });
  expect(invalidNull.status).toBe(422);
  await expect(invalidNull.json()).resolves.toMatchObject({
    code: "curated_revision_assertion_type_invalid",
  });

  const profileProposal = {
    ...(await proposal("/name", "unused")),
    target: {
      kind: "field" as const,
      entity_type: "card" as const,
      entity_id: card.id,
      path: "/game_data/profile",
    },
    assertion: { kind: "field", value: "fusion-world@1" },
    reviewed_source_digest: await sha256Text(canonicalJson("one-piece@1")),
  };
  const protectedProfile = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: profileProposal,
    catalogue_revision_id: currentRevision,
  });
  expect(protectedProfile.status).toBe(422);
  await expect(protectedProfile.json()).resolves.toMatchObject({
    code: "curated_revision_identity_forbidden",
  });

  const wrongGamePrinting = {
    ...(await proposal("/name", "unused")),
    game: "fusion-world",
    target: {
      kind: "field",
      entity_type: "printing",
      entity_id: `printing_${sequence}`,
      path: "/printed_rules_text",
    },
    assertion: { kind: "field", value: "Curated text" },
    reviewed_source_digest: await sha256Text(canonicalJson(null)),
  };
  const wrongOwner = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: wrongGamePrinting,
    catalogue_revision_id: currentRevision,
  });
  expect(wrongOwner.status).toBe(422);
  await expect(wrongOwner.json()).resolves.toMatchObject({
    code: "curated_revision_target_invalid",
  });

  const malformedEvidence = await proposal("/name", "Curated Name");
  const malformedOwnerReference = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: {
      ...malformedEvidence,
      evidence: [
        {
          kind: "owner_reference",
          uri: "not an absolute URI",
          content_digest: "a".repeat(64),
        },
      ],
    },
    catalogue_revision_id: currentRevision,
  });
  expect(malformedOwnerReference.status).toBe(422);
  await expect(malformedOwnerReference.json()).resolves.toMatchObject({
    code: "curated_revision_schema_invalid",
  });
});

test("administration mutations require the exact normative request shapes", async () => {
  const proposalDocument = await proposal("/name", "Curated Name");
  const undocumentedValidate = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: proposalDocument,
    expected_current_revision_id: currentRevision,
  });
  expect(undocumentedValidate.status).toBe(422);
  await expect(undocumentedValidate.json()).resolves.toMatchObject({
    code: "invalid_parameter",
  });

  const created = await createCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      proposal: proposalDocument,
      proposal_digest: await sha256Text(canonicalJson(proposalDocument)),
      idempotency_key: `exact-shape-create-${sequence}`,
    },
    now,
  );
  const lifecycleBase = {
    environment: "production",
    expected_current_revision_id: currentRevision,
    expected_event_version: 1,
    rationale: "Exercise the exact mutation schema.",
  };
  const retired = await adminRequest(`/admin/v1/curated-revisions/${created.document.curated_revision_id}/retire`, {
    ...lifecycleBase,
    idempotency_key: `exact-shape-retire-${sequence}`,
  });
  expect(retired.status).toBe(422);
  await expect(retired.json()).resolves.toMatchObject({
    code: "curated_revision_schema_invalid",
  });

  const replacement = {
    ...(await proposal("/name", "Replacement Name")),
    supersedes_revision_id: created.document.curated_revision_id,
  };
  const superseded = await adminRequest(
    `/admin/v1/curated-revisions/${created.document.curated_revision_id}/supersede`,
    {
      ...lifecycleBase,
      proposal: replacement,
      proposal_digest: await sha256Text(canonicalJson(replacement)),
      idempotency_key: `exact-shape-supersede-${sequence}`,
    },
  );
  expect(superseded.status).toBe(422);
  await expect(superseded.json()).resolves.toMatchObject({
    code: "curated_revision_schema_invalid",
  });
});

test("proposal validation requires the exact canonical nullable fields and a closed interval", async () => {
  const complete = await proposal("/name", "Curated Name");
  const { effective_interval: _interval, ...withoutInterval } = complete;
  const { supersedes_revision_id: _supersedes, ...withoutSupersedes } = complete;
  for (const candidate of [
    withoutInterval,
    withoutSupersedes,
    { ...complete, effective_interval: { from: null, to: null, extra: true } },
  ]) {
    const response = await adminRequest("/admin/v1/curated-revisions/validate", {
      proposal: candidate,
      catalogue_revision_id: currentRevision,
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "curated_revision_schema_invalid",
    });
  }
});

test("Source Observation evidence must resolve to retained immutable evidence", async () => {
  const complete = await proposal("/name", "Curated Name");
  const missingEvidence = {
    ...complete,
    evidence: [{ kind: "source_observation", id: `srcobs_missing_${sequence}` }],
  };
  const validation = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: missingEvidence,
    catalogue_revision_id: currentRevision,
  });
  expect(validation.status).toBe(422);
  await expect(validation.json()).resolves.toMatchObject({
    code: "curated_revision_evidence_not_retained",
  });

  const creation = await adminRequest("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: missingEvidence,
    proposal_digest: await sha256Text(canonicalJson(missingEvidence)),
    idempotency_key: `missing-evidence-${sequence}`,
  });
  expect(creation.status).toBe(422);
  await expect(creation.json()).resolves.toMatchObject({
    code: "curated_revision_evidence_not_retained",
  });

  const ownerReference = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: complete,
    catalogue_revision_id: currentRevision,
  });
  expect(ownerReference.status).toBe(200);
});

test("product-only Source Observations remain valid Curated Revision evidence", async () => {
  const evidenceIds = {
    product: `srcobs_product_only_${sequence}`,
    release: `srcobs_release_only_${sequence}`,
    context: `srcobs_context_only_${sequence}`,
    relationship: `srcobs_relationship_only_${sequence}`,
  };
  await env.CATALOGUE_DB.batch([
    publishedCatalogueQueries
      .insertRevisionProductsForProductOnlySourceObservationsRemainValidCuratedRevisionEvidence(env.CATALOGUE_DB)
      .bind(
        currentRevision,
        `product_${sequence}`,
        canonicalJson({
          data: { id: `product_${sequence}` },
          included: Object.values(evidenceIds)
            .slice(0, 3)
            .map((id) => ({
              type: "source_observation",
              id,
              captured_at: now,
              source: "one-piece-en",
            })),
          provenance: {},
          disagreements: [],
        }),
      ),
    reconciliationQueries.insertReconciledProductRelationships(env.CATALOGUE_DB).bind(
      `relationship_product_card_${sequence}`,
      `product_${sequence}`,
      card.id,
      canonicalJson([evidenceIds.relationship]),
      card.official_identity.value,
      currentRevision,
      currentRevision,
      canonicalJson({
        source_observation_ids: [evidenceIds.relationship],
      }),
    ),
  ]);

  const cases = [
    {
      evidenceId: evidenceIds.product,
      target: {
        kind: "field",
        entity_type: "product",
        entity_id: `product_${sequence}`,
        path: "/name",
      },
      assertion: { kind: "field", value: "Curated Booster" },
      sourceValue: "Booster",
    },
    {
      evidenceId: evidenceIds.release,
      target: {
        kind: "field",
        entity_type: "release",
        entity_id: `release_${sequence}`,
        path: "/status",
      },
      assertion: { kind: "field", value: "released" },
      sourceValue: "announced",
    },
    {
      evidenceId: evidenceIds.context,
      target: {
        kind: "field",
        entity_type: "distribution_context",
        entity_id: `distribution_context_${sequence}`,
        path: "/label",
      },
      assertion: { kind: "field", value: "Curated Promotion" },
      sourceValue: "Official Promotion",
    },
    {
      evidenceId: evidenceIds.relationship,
      target: {
        kind: "relationship",
        relationship_kind: "product-card",
        from: { type: "product", id: `product_${sequence}` },
        to: { type: "card", id: card.id },
      },
      assertion: { kind: "relationship", presence: "absent" },
      sourceValue: "present",
    },
  ];
  for (const item of cases) {
    const proposalValue = {
      game: "one-piece",
      target: item.target,
      assertion: item.assertion,
      rationale: "Retained product-catalogue evidence supports this review.",
      evidence: [{ kind: "source_observation", id: item.evidenceId }],
      effective_interval: { from: null, to: null },
      reviewed_source_digest: await sha256Text(canonicalJson(item.sourceValue)),
      supersedes_revision_id: null,
    };
    const response = await adminRequest("/admin/v1/curated-revisions/validate", {
      proposal: proposalValue,
      catalogue_revision_id: currentRevision,
    });
    expect(response.status, item.evidenceId).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ valid: true });
  }
});

test("validation uses the pinned shared and Game Profile schemas", async () => {
  for (const invalidProposal of [
    await proposal("/name", ""),
    {
      ...(await proposal("/name", "unused")),
      target: {
        kind: "field",
        entity_type: "card",
        entity_id: card.id,
        path: "/game_data/attributes/cost",
      },
      assertion: { kind: "field", value: -1 },
      reviewed_source_digest: await sha256Text(canonicalJson(1)),
    },
  ]) {
    const response = await adminRequest("/admin/v1/curated-revisions/validate", {
      proposal: invalidProposal,
      catalogue_revision_id: currentRevision,
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "curated_revision_assertion_type_invalid",
    });
  }

  const nullable = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: await proposal("/effective_rules_text", null),
    catalogue_revision_id: currentRevision,
  });
  expect(nullable.status).toBe(200);

  await publishedCatalogueQueries
    .setRevisionPrintingsDocumentJsonForValidationUsesPinnedSharedGameProfileSchemas(env.CATALOGUE_DB)
    .bind(currentRevision, `printing_${sequence}`)
    .run();
  const optionalProposal = {
    ...(await proposal("/name", "unused")),
    target: {
      kind: "field",
      entity_type: "printing",
      entity_id: `printing_${sequence}`,
      path: "/game_data/attributes/illustration_types",
    },
    assertion: { kind: "field", value: [] },
    reviewed_source_digest: await sha256Text(canonicalJson(curatedSourceAbsence)),
  };
  const optional = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: optionalProposal,
    catalogue_revision_id: currentRevision,
  });
  expect(optional.status).toBe(200);

  const crossFieldRelease = {
    ...(await proposal("/name", "unused")),
    target: {
      kind: "field",
      entity_type: "release",
      entity_id: `release_${sequence}`,
      path: "/date/precision",
    },
    assertion: { kind: "field", value: "month" },
    reviewed_source_digest: await sha256Text(canonicalJson("day")),
  };
  const invalidRelease = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: crossFieldRelease,
    catalogue_revision_id: currentRevision,
  });
  expect(invalidRelease.status).toBe(422);
  await expect(invalidRelease.json()).resolves.toMatchObject({
    code: "curated_revision_assertion_type_invalid",
  });

  const invalidEffectiveFrom = {
    ...(await proposal("/name", "unused")),
    target: {
      kind: "field",
      entity_type: "legality_rule",
      entity_id: `legality_rule_${sequence}`,
      path: "/effective_from",
    },
    assertion: { kind: "field", value: null },
    reviewed_source_digest: await sha256Text(canonicalJson("2026-08-05")),
  };
  const invalidNullControl = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: invalidEffectiveFrom,
    catalogue_revision_id: currentRevision,
  });
  expect(invalidNullControl.status).toBe(422);
  await expect(invalidNullControl.json()).resolves.toMatchObject({
    code: "curated_revision_assertion_type_invalid",
  });
});

test("relationship endpoints are closed objects", async () => {
  const relationshipProposal = {
    game: "one-piece",
    target: {
      kind: "relationship",
      relationship_kind: "printing-product",
      from: { type: "printing", id: `printing_${sequence}`, extra: true },
      to: { type: "product", id: `product_${sequence}` },
    },
    assertion: { kind: "relationship", presence: "present" },
    rationale: "The owner reviewed the relationship.",
    evidence: [
      {
        kind: "owner_reference",
        uri: "https://owner.example/review/closed-endpoint",
        content_digest: "e".repeat(64),
      },
    ],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson("absent")),
    supersedes_revision_id: null,
  };
  const response = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: relationshipProposal,
    catalogue_revision_id: currentRevision,
  });
  expect(response.status).toBe(422);
  await expect(response.json()).resolves.toMatchObject({
    code: "curated_revision_schema_invalid",
  });
});

test("create is idempotent, server-authored, and available through stable list/show documents", async () => {
  const authoredProposal = await proposal("/name", "Curated Name");
  const input = {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: authoredProposal,
    proposal_digest: await sha256Text(canonicalJson(authoredProposal)),
    idempotency_key: "curated-create-1",
  };
  const created = await adminRequest("/admin/v1/curated-revisions", input);
  expect(created.status).toBe(201);
  const mutation = (await created.json()) as Record<string, unknown>;
  expect(mutation).toMatchObject({
    operation_id: expect.stringMatching(/^curop_/),
    curated_revision_id: expect.stringMatching(/^currev_/),
    status: "active",
    event_version: 1,
    content_digest: input.proposal_digest,
    current_catalogue_revision_id: currentRevision,
    code: "curated_revision_created",
  });

  const replay = await adminRequest("/admin/v1/curated-revisions", input);
  expect(replay.status).toBe(200);
  await expect(replay.json()).resolves.toEqual(mutation);

  const listed = await adminRequest("/admin/v1/curated-revisions?game=one-piece&status=active");
  expect(listed.status).toBe(200);
  await expect(listed.json()).resolves.toMatchObject({
    items: [{ id: mutation.curated_revision_id, author: "owner" }],
    next_cursor: null,
  });

  const shown = await adminRequest(
    `/admin/v1/curated-revisions/${encodeURIComponent(String(mutation.curated_revision_id))}`,
  );
  expect(shown.status).toBe(200);
  await expect(shown.json()).resolves.toMatchObject({
    revision: {
      id: mutation.curated_revision_id,
      author: "owner",
      status: "active",
    },
    events: [{ type: "authored" }],
  });
  await expect(
    curatedQueries.setCuratedRevisionIdempotencyResponseStatus(env.CATALOGUE_DB).bind(input.idempotency_key).run(),
  ).rejects.toThrow("curated_revision_idempotency_immutable");
  await curatedQueries
    .insertCatalogueCuratedProvenanceForCreateIdempotentServerAuthoredAvailableThroughStableListShow(env.CATALOGUE_DB)
    .bind(currentRevision, mutation.curated_revision_id, mutation.content_digest)
    .run();
  await expect(
    curatedQueries
      .deleteCatalogueCuratedProvenance(env.CATALOGUE_DB)
      .bind(currentRevision, mutation.curated_revision_id)
      .run(),
  ).rejects.toThrow("catalogue_curated_provenance_immutable");
});

test("create is guarded by production binding, current revision, idle operation, and nonblocked recovery", async () => {
  const authoredProposal = await proposal("/name", "Curated Name");
  const base = {
    environment: "staging",
    expected_current_revision_id: currentRevision,
    proposal: authoredProposal,
    proposal_digest: await sha256Text(canonicalJson(authoredProposal)),
    idempotency_key: "guard-1",
  };
  const wrongEnvironment = await adminRequest("/admin/v1/curated-revisions", base);
  expect(wrongEnvironment.status).toBe(422);
  await expect(wrongEnvironment.json()).resolves.toMatchObject({
    code: "production_target_required",
  });

  await ingestionQueries.setOperationStateRecoveryHealth(env.CATALOGUE_DB).run();
  const blocked = await adminRequest("/admin/v1/curated-revisions", {
    ...base,
    environment: "production",
    idempotency_key: "guard-2",
  });
  expect(blocked.status).toBe(409);
  await expect(blocked.json()).resolves.toMatchObject({
    code: "recovery_in_progress",
  });

  await ingestionQueries.setOperationStateRecoveryHealthActiveProductionReleaseId(env.CATALOGUE_DB).run();
  const releaseBlocked = await adminRequest("/admin/v1/curated-revisions", {
    ...base,
    environment: "production",
    idempotency_key: "guard-3",
  });
  expect(releaseBlocked.status).toBe(409);
  await expect(releaseBlocked.json()).resolves.toMatchObject({
    code: "release_not_idle",
  });
  await expect(insertParsingRun(`run_release_blocked_${sequence}`)).rejects.toThrow("active_ingestion_run_or_release");
});

test("the atomic mutation boundary rechecks the current Catalogue Revision", async () => {
  const authored = await proposal("/name", "Curated Name");
  await expect(
    curatedQueries
      .insertCuratedRevisionsForAtomicMutationBoundaryRechecksCurrentCatalogueRevision(env.CATALOGUE_DB)
      .bind(
        canonicalJson(authored),
        await sha256Text(canonicalJson(authored)),
        authored.reviewed_source_digest,
        canonicalJson({ catalogue_revision_id: "catrev_stale", game_profile: "one-piece@1" }),
        now,
      )
      .run(),
  ).rejects.toThrow("curated_revision_current_revision_mismatch");

  const created = await createCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      proposal: authored,
      proposal_digest: await sha256Text(canonicalJson(authored)),
      idempotency_key: `atomic-current-${sequence}`,
    },
    now,
  );
  await expect(
    curatedQueries
      .insertCuratedRevisionEvents(env.CATALOGUE_DB)
      .bind(created.document.curated_revision_id, canonicalJson({ expected_current_revision_id: "catrev_stale" }), now)
      .run(),
  ).rejects.toThrow("curated_revision_current_revision_mismatch");
});

test("release leases reclaim stale owners and fence cleanup and renewal", async () => {
  const insertBootstrap = async (id: string) =>
    ingestionQueries
      .insertIngestionRunsForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewal(env.CATALOGUE_DB)
      .bind(id, now, currentRevision, id)
      .run();
  const claimBootstrap = async (id: string) =>
    ingestionQueries
      .setOperationStateActiveIngestionRunIdForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewal(env.CATALOGUE_DB)
      .bind(id)
      .run();
  const failBootstrap = async (id: string, failureCode: string) =>
    ingestionQueries
      .setIngestionRunsStateTerminalAtForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewal(env.CATALOGUE_DB)
      .bind(now, failureCode, id, id)
      .run();
  const clearBootstrap = async (id: string) =>
    ingestionQueries
      .setOperationStateActiveIngestionRunIdForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewalWithundefined(
        env.CATALOGUE_DB,
      )
      .bind(id)
      .run();
  const deleteBootstrap = async (id: string) => {
    const [, result] = await env.CATALOGUE_DB.batch([
      ingestionQueries.deleteIngestionRunTransitions(env.CATALOGUE_DB).bind(id),
      ingestionQueries.deleteIngestionRuns(env.CATALOGUE_DB).bind(id),
    ]);
    if (result === undefined) {
      throw new Error("The bootstrap cleanup batch did not return a result.");
    }
    return result;
  };

  const firstFence = `release_first_${sequence}`;
  const firstBootstrap = `release-bootstrap|2099-01-01T00:00:00.000Z|${firstFence}`;
  await insertBootstrap(firstBootstrap);
  const firstClaim = await claimBootstrap(firstBootstrap);
  expect(firstClaim.meta.changes).toBe(1);

  // This is the cleanup query used by the previously deployed ingestion
  // worker. A matching active planning row prevents it from dropping the
  // pre-migration release fence as an orphan.
  await ingestionQueries
    .setOperationStateActiveIngestionRunIdForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewalWithPublishing(
      env.CATALOGUE_DB,
    )
    .run();
  expect(await ingestionQueries.readOperationStateActiveIngestionRunId(env.CATALOGUE_DB).first()).toEqual({
    active_ingestion_run_id: firstBootstrap,
  });

  const blockedBootstrap = `release-bootstrap|2099-01-01T00:00:00.000Z|release_blocked_${sequence}`;
  await expect(insertBootstrap(blockedBootstrap)).rejects.toThrow("active_ingestion_run_or_release");

  // Failure cleanup retains an immutable audit on the legacy schema, while
  // the migrated schema can remove this exact non-domain marker and retry.
  expect((await failBootstrap(firstBootstrap, "production_release_bootstrap_abandoned")).meta.changes).toBeGreaterThan(
    0,
  );
  expect((await clearBootstrap(firstBootstrap)).meta.changes).toBe(1);
  expect((await deleteBootstrap(firstBootstrap)).meta.changes).toBe(1);
  expect(await ingestionQueries.readIngestionRunsId(env.CATALOGUE_DB).bind(firstBootstrap).first()).toBeNull();

  const staleBootstrap = `release-bootstrap|2000-01-01T00:00:00.000Z|${firstFence}`;
  await insertBootstrap(staleBootstrap);
  expect((await claimBootstrap(staleBootstrap)).meta.changes).toBe(1);
  expect((await failBootstrap(staleBootstrap, "production_release_bootstrap_expired")).meta.changes).toBeGreaterThan(0);
  expect((await clearBootstrap(staleBootstrap)).meta.changes).toBe(1);

  const secondFence = `release_second_${sequence}`;
  const secondBootstrap = `release-bootstrap|2099-01-01T00:00:00.000Z|${secondFence}`;
  await insertBootstrap(secondBootstrap);
  const reclaimed = await claimBootstrap(secondBootstrap);
  expect(reclaimed.meta.changes).toBe(1);
  const transferred = await ingestionQueries
    .setOperationStateActiveProductionReleaseIdActiveProductionReleaseExpiresAt(env.CATALOGUE_DB)
    .bind(secondFence, "2099-01-01T00:00:00.000Z", secondBootstrap, now)
    .run();
  expect(transferred.meta.changes).toBeGreaterThan(0);
  expect((await deleteBootstrap(secondBootstrap)).meta.changes).toBe(1);
  expect((await deleteBootstrap(staleBootstrap)).meta.changes).toBe(1);
  expect(
    await ingestionQueries
      .countIngestionRunsBootstrapCount(env.CATALOGUE_DB)
      .bind(staleBootstrap, secondBootstrap)
      .first(),
  ).toEqual({
    bootstrap_count: 0,
  });

  const staleCleanup = await ingestionQueries
    .setOperationStateActiveProductionReleaseIdActiveProductionReleaseExpiresAtForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewal(
      env.CATALOGUE_DB,
    )
    .bind(firstFence)
    .run();
  expect(staleCleanup.meta.changes).toBe(0);
  const renewed = await ingestionQueries
    .setOperationStateActiveProductionReleaseExpiresAt(env.CATALOGUE_DB)
    .bind("2099-01-01T00:15:00.000Z", secondFence, now)
    .run();
  expect(renewed.meta.changes).toBeGreaterThan(0);
  expect(
    await ingestionQueries
      .readOperationStateActiveProductionReleaseIdActiveProductionReleaseExpiresAt(env.CATALOGUE_DB)
      .first(),
  ).toEqual({
    active_production_release_id: secondFence,
    active_production_release_expires_at: "2099-01-01T00:15:00.000Z",
  });

  await ingestionQueries
    .setOperationStateActiveProductionReleaseExpiresAtForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewal(
      env.CATALOGUE_DB,
    )
    .bind("2000-01-01T00:00:00.000Z", secondFence)
    .run();
  const thirdFence = `release_third_${sequence}`;
  const thirdBootstrap = `release-bootstrap|2099-01-01T00:00:00.000Z|${thirdFence}`;
  await insertBootstrap(thirdBootstrap);
  expect((await claimBootstrap(thirdBootstrap)).meta.changes).toBe(1);
  expect(
    (
      await ingestionQueries
        .setOperationStateActiveProductionReleaseIdActiveProductionReleaseExpiresAtForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewalWithundefined(
          env.CATALOGUE_DB,
        )
        .bind(thirdFence, "2099-01-01T00:00:00.000Z", thirdBootstrap, now)
        .run()
    ).meta.changes,
  ).toBeGreaterThan(0);
  expect((await deleteBootstrap(thirdBootstrap)).meta.changes).toBe(1);
  expect(
    (
      await ingestionQueries
        .setOperationStateActiveProductionReleaseExpiresAtForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewal(
          env.CATALOGUE_DB,
        )
        .bind("2099-01-01T00:30:00.000Z", secondFence)
        .run()
    ).meta.changes,
  ).toBe(0);
  expect(
    (
      await ingestionQueries
        .setOperationStateActiveProductionReleaseIdActiveProductionReleaseExpiresAtForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewal(
          env.CATALOGUE_DB,
        )
        .bind(secondFence)
        .run()
    ).meta.changes,
  ).toBe(0);
  expect(await ingestionQueries.readOperationStateActiveProductionReleaseId(env.CATALOGUE_DB).first()).toEqual({
    active_production_release_id: thirdFence,
  });
});

test("only one active assertion may overlap the same target interval", async () => {
  const firstProposal = await proposal("/name", "First");
  const first = {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: firstProposal,
    proposal_digest: await sha256Text(canonicalJson(firstProposal)),
    idempotency_key: "overlap-1",
  };
  expect((await adminRequest("/admin/v1/curated-revisions", first)).status).toBe(201);
  const secondProposal = await proposal("/name", "Second");
  const second = await adminRequest("/admin/v1/curated-revisions", {
    ...first,
    proposal: secondProposal,
    proposal_digest: await sha256Text(canonicalJson(secondProposal)),
    idempotency_key: "overlap-2",
  });
  expect(second.status).toBe(409);
  await expect(second.json()).resolves.toMatchObject({
    code: "curated_revision_target_conflict",
  });
});

test("a run pins an exact ordered set and applies it after official reconciliation with curated provenance", async () => {
  const authoredProposal = await proposal("/name", "Curated Name");
  const created = await adminRequest("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: authoredProposal,
    proposal_digest: await sha256Text(canonicalJson(authoredProposal)),
    idempotency_key: `apply-${sequence}`,
  });
  const revision = (await created.json()) as { curated_revision_id: string };
  const runId = `run_curated_apply_${sequence}`;
  await insertParsingRun(runId);

  const pin = await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), runId, now);
  expect(pin.revision_ids).toContain(revision.curated_revision_id);
  expect(pin.set_digest).toMatch(/^[a-f0-9]{64}$/);

  const unselected = {
    ...card,
    id: `card_digimon_apply_${sequence}`,
    game: "digimon" as const,
    official_identity: { kind: "card_number" as const, value: "BT1-001" },
    name: "Preserved Digimon Curation",
    game_data: {
      profile: "digimon@1" as const,
      attributes: digimonAttributes(),
    },
    curated_provenance: [
      {
        curated_revision_id: "currev_digimon_apply",
        content_digest: "c".repeat(64),
        target: {
          kind: "field" as const,
          entity_type: "card" as const,
          entity_id: `card_digimon_apply_${sequence}`,
          path: "/name",
        },
        rationale: "Retain an unselected game's curation.",
        evidence: [{ kind: "source_observation" as const, id: "srcobs_digimon_apply" }],
        author: "owner",
        reviewed_source_value: "Official Digimon Name",
      },
    ],
  };
  const applied = await applyPinnedCuratedRevisions(
    catalogueStore(env.CATALOGUE_DB),
    runId,
    {
      contract: "card-keepr-catalogue-candidate@1",
      selected_games: ["one-piece", "digimon"],
      cards: [card, unselected],
      printings: [],
    },
    now,
  );
  expect(applied.cards[0]).toMatchObject({
    name: "Curated Name",
    curated_provenance: [{ curated_revision_id: revision.curated_revision_id }],
  });
  expect(applied.cards[1]).toEqual(unselected);
  const stripped = stripCuratedRevisionEffects(applied);
  expect(stripped.cards[0]).toMatchObject({ name: "Official Name" });
  expect(stripped.cards[0]).not.toHaveProperty("curated_provenance");
});

test("candidate inspection exposes the exact pinned set and every curated effect", async () => {
  const seed = await ingestionQueries
    .readIngestionRunsCandidateJsonForCandidateInspectionExposesExactPinnedSetEveryCuratedEffect(env.CATALOGUE_DB)
    .bind(`curated-seed-${sequence}`)
    .first<{ candidate_json: string }>();
  const official = JSON.parse(seed!.candidate_json) as {
    contract: "card-keepr-catalogue-candidate@1";
    selected_games: ["one-piece"];
    cards: Record<string, unknown>[];
    printings: Record<string, unknown>[];
    products: Record<string, unknown>[];
    distribution_contexts: Record<string, unknown>[];
    product_relationships: Record<string, unknown>[];
    errata: Record<string, unknown>[];
    legality_rules: Record<string, unknown>[];
  };
  const definitions = [
    {
      target: {
        kind: "field" as const,
        entity_type: "card" as const,
        entity_id: card.id,
        path: "/name",
      },
      assertion: { kind: "field" as const, value: "Inspected Card" },
      sourceValue: "Official Name",
    },
    {
      target: {
        kind: "field" as const,
        entity_type: "printing" as const,
        entity_id: `printing_${sequence}`,
        path: "/printed_rules_text",
      },
      assertion: { kind: "field" as const, value: "Inspected printing text." },
      sourceValue: null,
    },
    {
      target: {
        kind: "field" as const,
        entity_type: "product" as const,
        entity_id: `product_${sequence}`,
        path: "/name",
      },
      assertion: { kind: "field" as const, value: "Inspected Product" },
      sourceValue: "Booster",
    },
    {
      target: {
        kind: "field" as const,
        entity_type: "release" as const,
        entity_id: `release_${sequence}`,
        path: "/status",
      },
      assertion: { kind: "field" as const, value: "released" },
      sourceValue: "announced",
    },
    {
      target: {
        kind: "field" as const,
        entity_type: "distribution_context" as const,
        entity_id: `distribution_context_${sequence}`,
        path: "/label",
      },
      assertion: { kind: "field" as const, value: "Inspected Promotion" },
      sourceValue: "Official Promotion",
    },
    {
      target: {
        kind: "field" as const,
        entity_type: "erratum" as const,
        entity_id: `erratum_${sequence}`,
        path: "/official_wording",
      },
      assertion: { kind: "field" as const, value: "Inspected erratum wording." },
      sourceValue: "Official erratum wording.",
    },
    {
      target: {
        kind: "field" as const,
        entity_type: "legality_rule" as const,
        entity_id: `legality_rule_${sequence}`,
        path: "/official_wording",
      },
      assertion: { kind: "field" as const, value: "Inspected legality wording." },
      sourceValue: "This card is eligible.",
    },
    {
      target: {
        kind: "relationship" as const,
        relationship_kind: "printing-product" as const,
        from: { type: "printing" as const, id: `printing_${sequence}` },
        to: { type: "product" as const, id: `product_${sequence}` },
      },
      assertion: { kind: "relationship" as const, presence: "present" as const },
      sourceValue: "absent",
    },
  ];
  const expectedByRevision = new Map<string, Record<string, unknown>>();
  for (const [index, definition] of definitions.entries()) {
    const proposalValue = {
      game: "one-piece" as const,
      target: definition.target,
      assertion: definition.assertion,
      rationale: `Private rationale ${index}.`,
      evidence: [
        {
          kind: "owner_reference" as const,
          uri: `https://owner.example/private/${index}`,
          content_digest: String(index + 1).repeat(64),
        },
      ],
      effective_interval: { from: null, to: null },
      reviewed_source_digest: await sha256Text(canonicalJson(definition.sourceValue)),
      supersedes_revision_id: null,
    };
    const created = await createCuratedRevision(
      catalogueStore(env.CATALOGUE_DB),
      {
        environment: "production",
        expected_current_revision_id: currentRevision,
        proposal: proposalValue,
        proposal_digest: await sha256Text(canonicalJson(proposalValue)),
        idempotency_key: `inspect-effect-${sequence}-${index}`,
      },
      now,
    );
    const target =
      definition.target.kind === "field"
        ? [
            "one-piece",
            "field",
            definition.target.entity_type,
            definition.target.entity_id,
            definition.target.path,
          ].join("|")
        : [
            "one-piece",
            "relationship",
            definition.target.relationship_kind,
            definition.target.from.type,
            definition.target.from.id,
            definition.target.to.type,
            definition.target.to.id,
          ].join("|");
    expectedByRevision.set(created.document.curated_revision_id, {
      revision_id: created.document.curated_revision_id,
      target,
      assertion: definition.assertion,
      evidence_category: "curated",
    });
  }

  const runId = `run_candidate_inspection_${sequence}`;
  await insertParsingRun(runId);
  const pinned = await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), runId, now);
  const candidate = await applyPinnedCuratedRevisions(catalogueStore(env.CATALOGUE_DB), runId, official as never, now);
  const digest = await sha256Text(canonicalJson(candidate));
  await ingestionQueries.setIngestionRunsStateProgressJson(env.CATALOGUE_DB).bind(runId).run();
  await ingestionQueries
    .setIngestionRunsStateCandidateJson(env.CATALOGUE_DB)
    .bind(canonicalJson(candidate), digest, digest, now, "2026-08-12T01:02:03.000Z", runId)
    .run();

  const response = await adminRequest(`/v1/ingestion-runs/${runId}/candidate`);
  expect(response.status).toBe(200);
  const inspection = (await response.json()) as {
    curated_revision_ids: string[];
    curated_revision_set_digest: string;
    diff: { curated_effects: Record<string, unknown>[] };
  };
  expect(inspection.curated_revision_ids).toEqual(pinned.revision_ids);
  expect(inspection.curated_revision_set_digest).toBe(pinned.set_digest);
  expect(inspection.diff.curated_effects).toEqual(pinned.revision_ids.map((id) => expectedByRevision.get(id)));
  const exposed = canonicalJson(inspection.diff.curated_effects);
  expect(exposed).not.toContain("Private rationale");
  expect(exposed).not.toContain("owner.example/private");
  expect(exposed).not.toContain("reviewed_source_value");
  expect(exposed).not.toContain("content_digest");
  expect(exposed).not.toContain("author");
});

test("prepared runs strip prior effects, reapply exact pins, and persist the real digest atomically", async () => {
  const authoredProposal = await proposal("/name", "Current Curated Name");
  const created = await adminRequest("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: authoredProposal,
    proposal_digest: await sha256Text(canonicalJson(authoredProposal)),
    idempotency_key: `prepared-create-${sequence}`,
  });
  const revision = (await created.json()) as { curated_revision_id: string };
  const runId = `run_prepared_curated_${sequence}`;
  const unselectedCard = {
    ...card,
    id: `card_digimon_${sequence}`,
    game: "digimon" as const,
    name: "Preserved Digimon Curation",
    official_identity: { kind: "card_number" as const, value: "BT1-001" },
    game_data: {
      profile: "digimon@1" as const,
      attributes: digimonAttributes(),
    },
    curated_provenance: [
      {
        curated_revision_id: "currev_unselected",
        content_digest: "b".repeat(64),
        target: {
          kind: "field" as const,
          entity_type: "card" as const,
          entity_id: `card_digimon_${sequence}`,
          path: "/name",
        },
        rationale: "Preserve an unselected game's active curation.",
        evidence: [{ kind: "source_observation" as const, id: "srcobs_digimon" }],
        author: "owner",
        reviewed_source_value: "Official Digimon Name",
      },
    ],
  };
  const prepared = await prepareCuratedRevisionRunStart(
    catalogueStore(env.CATALOGUE_DB),
    runId,
    ["one-piece"],
    {
      contract: "card-keepr-catalogue-candidate@1",
      selected_games: ["one-piece"],
      cards: [
        {
          ...card,
          name: "Old Curated Name",
          curated_provenance: [
            {
              curated_revision_id: "currev_old",
              content_digest: "a".repeat(64),
              target: authoredProposal.target,
              rationale: "Prior effect.",
              evidence: authoredProposal.evidence,
              author: "owner",
              reviewed_source_value: card.name,
            },
          ],
        },
        unselectedCard,
      ],
      printings: [],
    },
    now,
  );
  expect(prepared.candidate.cards[0]).toMatchObject({
    name: "Current Curated Name",
    curated_provenance: [
      {
        curated_revision_id: revision.curated_revision_id,
      },
    ],
  });
  expect(prepared.candidate.cards[1]).toEqual(unselectedCard);
  await env.CATALOGUE_DB.batch([
    ingestionQueries
      .insertIngestionRunsForPreparedRunsStripPriorEffectsReapplyExactPinsPersist(env.CATALOGUE_DB)
      .bind(runId, now, currentRevision, `prepared-${sequence}`),
    ...prepared.statements,
  ]);
  const pin = await ingestionQueries
    .readIngestionRunCuratedRevisionSetsRevisionIdsJsonSetDigest(env.CATALOGUE_DB)
    .bind(runId)
    .first<{ revision_ids_json: string; set_digest: string }>();
  expect(pin).toEqual({
    revision_ids_json: JSON.stringify([revision.curated_revision_id]),
    set_digest: await sha256Text(canonicalJson([revision.curated_revision_id])),
  });
});

test("pinned assertions hard-fail when companion-field drift makes the composed candidate invalid", async () => {
  const legalityProposal = {
    game: "one-piece" as const,
    target: {
      kind: "field" as const,
      entity_type: "legality_rule" as const,
      entity_id: `legality_rule_${sequence}`,
      path: "/event_tier",
    },
    assertion: { kind: "field" as const, value: "regional" },
    rationale: "The owner reviewed the event tier.",
    evidence: [
      {
        kind: "owner_reference" as const,
        uri: "https://owner.example/review/event-tier",
        content_digest: "d".repeat(64),
      },
    ],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson(null)),
    supersedes_revision_id: null,
  };
  const created = await createCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      proposal: legalityProposal,
      proposal_digest: await sha256Text(canonicalJson(legalityProposal)),
      idempotency_key: `companion-drift-${sequence}`,
    },
    now,
  );
  const runId = `run_companion_drift_${sequence}`;
  await insertParsingRun(runId);
  await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), runId, now);
  const officialRule = {
    ...(
      JSON.parse(
        (await ingestionQueries
          .readIngestionRunsCandidateJsonForCandidateInspectionExposesExactPinnedSetEveryCuratedEffect(env.CATALOGUE_DB)
          .bind(`curated-seed-${sequence}`)
          .first<{ candidate_json: string }>())!.candidate_json,
      ) as { legality_rules: Record<string, unknown>[] }
    ).legality_rules[0]!,
    event_tier: null,
    effective_from: "2026-08-05",
    effective_until: null,
    unresolved_scope: { dimensions: ["event_tier"] },
    effect: { type: "unresolved" },
  };
  await expect(
    applyPinnedCuratedRevisions(
      catalogueStore(env.CATALOGUE_DB),
      runId,
      {
        contract: "card-keepr-catalogue-candidate@1",
        selected_games: ["one-piece"],
        cards: [card],
        printings: [],
        legality_rules: [officialRule as never],
      },
      now,
    ),
  ).rejects.toThrow("curated_revision_composed_candidate_invalid");
  const run = await ingestionQueries
    .readIngestionRunsStateFailureCode(env.CATALOGUE_DB)
    .bind(runId)
    .first<{ state: string; failure_code: string | null }>();
  expect(run).toEqual({
    state: "failed",
    failure_code: "curated_revision_composed_candidate_invalid",
  });
  expect(created.document.status).toBe("active");
});

test("Legality Rule curation preserves registered regional authority", async () => {
  const invalidRegion = {
    game: "gundam" as const,
    target: {
      kind: "field" as const,
      entity_type: "legality_rule" as const,
      entity_id: `legality_rule_gundam_${sequence}`,
      path: "/region",
    },
    assertion: { kind: "field" as const, value: "EN-OCEANIA" },
    rationale: "Try to move an Asia authority rule to Oceania.",
    evidence: [
      {
        kind: "owner_reference" as const,
        uri: "https://owner.example/review/gundam-region",
        content_digest: "e".repeat(64),
      },
    ],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson("EN-ASIA")),
    supersedes_revision_id: null,
  };
  const authored = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: invalidRegion,
    catalogue_revision_id: currentRevision,
  });
  expect(authored.status).toBe(422);
  await expect(authored.json()).resolves.toMatchObject({
    code: "curated_revision_assertion_type_invalid",
  });

  const wordingProposal = {
    ...invalidRegion,
    target: { ...invalidRegion.target, path: "/official_wording" },
    assertion: {
      kind: "field" as const,
      value: "Owner-reviewed Gundam wording.",
    },
    reviewed_source_digest: await sha256Text(canonicalJson("This Gundam rule is eligible.")),
  };
  const created = await createCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      proposal: wordingProposal,
      proposal_digest: await sha256Text(canonicalJson(wordingProposal)),
      idempotency_key: `gundam-authority-${sequence}`,
    },
    now,
  );
  const runId = `run_gundam_authority_${sequence}`;
  await insertParsingRun(runId, ["gundam"]);
  await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), runId, now);
  const stored = await ingestionQueries
    .readIngestionRunsCandidateJsonForCandidateInspectionExposesExactPinnedSetEveryCuratedEffect(env.CATALOGUE_DB)
    .bind(`curated-seed-${sequence}`)
    .first<{ candidate_json: string }>();
  const official = JSON.parse(stored!.candidate_json) as {
    legality_rules: Record<string, unknown>[];
  };
  const gundamRule = official.legality_rules.find((rule) => rule.id === `legality_rule_gundam_${sequence}`)!;
  await expect(
    applyPinnedCuratedRevisions(
      catalogueStore(env.CATALOGUE_DB),
      runId,
      {
        contract: "card-keepr-catalogue-candidate@1",
        selected_games: ["gundam"],
        cards: [],
        printings: [],
        legality_rules: [{ ...gundamRule, region: "EN-OCEANIA" } as never],
      },
      now,
    ),
  ).rejects.toThrow("curated_revision_composed_candidate_invalid");
  expect(created.document.status).toBe("active");
});

test("a prepared retry persists its failed run and every source-change conflict", async () => {
  const authored = await proposal("/name", "Curated Name");
  const created = await createCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      proposal: authored,
      proposal_digest: await sha256Text(canonicalJson(authored)),
      idempotency_key: `prepared-conflict-create-${sequence}`,
    },
    now,
  );
  const authoredRules = await proposal("/effective_rules_text", "Curated rules text");
  const createdRules = await createCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      proposal: authoredRules,
      proposal_digest: await sha256Text(canonicalJson(authoredRules)),
      idempotency_key: `prepared-conflict-rules-${sequence}`,
    },
    now,
  );
  const sourceRunId = `run_prepared_conflict_source_${sequence}`;
  const failedCandidate = {
    contract: "card-keepr-catalogue-candidate@1" as const,
    selected_games: ["one-piece" as const],
    cards: [
      {
        ...card,
        name: "Curated Name",
        effective_rules_text: "Curated rules text",
        curated_provenance: [
          {
            curated_revision_id: created.document.curated_revision_id,
            content_digest: created.document.content_digest,
            target: authored.target,
            rationale: authored.rationale,
            evidence: authored.evidence,
            author: "owner",
            reviewed_source_value: "Changed Official Name",
          },
          {
            curated_revision_id: createdRules.document.curated_revision_id,
            content_digest: createdRules.document.content_digest,
            target: authoredRules.target,
            rationale: authoredRules.rationale,
            evidence: authoredRules.evidence,
            author: "owner",
            reviewed_source_value: "Changed Official Rules",
          },
        ],
      },
    ],
    printings: [],
  };
  const sourceDigest = await sha256Text(canonicalJson(failedCandidate));
  await ingestionQueries
    .insertIngestionRunsForPreparedRetryPersistsFailedRunEverySourceChangeConflict(env.CATALOGUE_DB)
    .bind(
      sourceRunId,
      now,
      currentRevision,
      `prepared-conflict-source-${sequence}`,
      sourceDigest,
      sourceDigest,
      now,
      now,
      canonicalJson(failedCandidate),
    )
    .run();

  const retried = await adminRequest(`/v1/ingestion-runs/${sourceRunId}/retry`, {
    idempotency_key: `prepared-conflict-retry-${sequence}`,
  });
  expect(retried.status, JSON.stringify(await retried.clone().json())).toBe(201);
  const document = (await retried.json()) as {
    id: string;
    warnings: Record<string, unknown>[];
  };
  expect(document.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "curated_revision_reconfirmation_required",
        conflict_id: expect.stringMatching(/^crconf_/),
        conflict_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]),
  );
  await expect(
    ingestionQueries.readIngestionRunsStateFailureCode(env.CATALOGUE_DB).bind(document.id).first(),
  ).resolves.toEqual({
    state: "failed",
    failure_code: "curated_revision_reconfirmation_required",
  });
  const conflictedIds = [created.document.curated_revision_id, createdRules.document.curated_revision_id];
  const statuses = await curatedQueries
    .readCuratedRevisionsStatusEventVersion(env.CATALOGUE_DB)
    .bind(canonicalJson(conflictedIds))
    .all<{ status: string; event_version: number }>();
  expect(statuses.results).toHaveLength(2);
  expect(
    statuses.results.every(({ status, event_version }) => status === "reconfirmation_required" && event_version === 2),
  ).toBe(true);
  await expect(
    curatedQueries.countCuratedRevisionEventsCount(env.CATALOGUE_DB).bind(canonicalJson(conflictedIds)).first(),
  ).resolves.toEqual({ count: 2 });
  const inspectionResponse = await adminRequest(`/v1/ingestion-runs/${document.id}/candidate`);
  expect(inspectionResponse.status, JSON.stringify(await inspectionResponse.clone().json())).toBe(200);
  const inspection = (await inspectionResponse.json()) as {
    candidate_digest: string;
    curated_revision_ids: string[];
    diff: {
      curated_effects: unknown[];
      warnings: Record<string, unknown>[];
    };
  };
  expect(inspection.curated_revision_ids).toEqual([...conflictedIds].sort());
  expect(inspection.diff.curated_effects).toEqual([]);
  expect(inspection.diff.warnings).toEqual(
    expect.arrayContaining(
      conflictedIds.map((curatedRevisionId) =>
        expect.objectContaining({
          code: "curated_revision_reconfirmation_required",
          curated_revision_id: curatedRevisionId,
          conflict_id: expect.stringMatching(/^crconf_/),
          conflict_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ),
    ),
  );
  await expect(
    ingestionQueries.setIngestionRunsCandidateJson(env.CATALOGUE_DB).bind(document.id).run(),
  ).rejects.toThrow("candidate_immutable");
  const replay = await adminRequest(`/v1/ingestion-runs/${sourceRunId}/retry`, {
    idempotency_key: `prepared-conflict-retry-${sequence}`,
  });
  expect([200, 201]).toContain(replay.status);
  await expect(replay.json()).resolves.toMatchObject({ id: document.id });
  const inspectionReplay = await adminRequest(`/v1/ingestion-runs/${document.id}/candidate`);
  await expect(inspectionReplay.json()).resolves.toMatchObject({
    candidate_digest: inspection.candidate_digest,
    curated_revision_ids: inspection.curated_revision_ids,
  });
});

test("the Worker binds source-change reaffirmation to the exact public conflict", async () => {
  const authored = await proposal("/name", "Curated Name");
  const createdResponse = await adminRequest("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: authored,
    proposal_digest: await sha256Text(canonicalJson(authored)),
    idempotency_key: `public-conflict-create-${sequence}`,
  });
  expect(createdResponse.status).toBe(201);
  const created = (await createdResponse.json()) as {
    curated_revision_id: string;
    content_digest: string;
  };
  const sourceRunId = `run_public_conflict_source_${sequence}`;
  const sourceCandidate = {
    contract: "card-keepr-catalogue-candidate@1" as const,
    selected_games: ["one-piece" as const],
    cards: [
      {
        ...card,
        name: "Curated Name",
        curated_provenance: [
          {
            curated_revision_id: created.curated_revision_id,
            content_digest: created.content_digest,
            target: authored.target,
            rationale: authored.rationale,
            evidence: authored.evidence,
            author: "owner",
            reviewed_source_value: "Changed Official Name",
          },
        ],
      },
    ],
    printings: [],
  };
  const sourceDigest = await sha256Text(canonicalJson(sourceCandidate));
  await ingestionQueries
    .insertIngestionRunsForWorkerBindsSourceChangeReaffirmationExactPublicConflict(env.CATALOGUE_DB)
    .bind(
      sourceRunId,
      now,
      currentRevision,
      `public-conflict-source-${sequence}`,
      sourceDigest,
      sourceDigest,
      now,
      now,
      canonicalJson(sourceCandidate),
    )
    .run();

  const retriedResponse = await adminRequest(`/v1/ingestion-runs/${sourceRunId}/retry`, {
    idempotency_key: `public-conflict-run-${sequence}`,
  });
  expect(retriedResponse.status).toBe(201);
  const retried = (await retriedResponse.json()) as {
    id: string;
    state: string;
    failure_code: string;
    warnings: Array<Record<string, unknown>>;
  };
  expect(retried).toMatchObject({
    state: "failed",
    failure_code: "curated_revision_reconfirmation_required",
    warnings: [
      expect.objectContaining({
        code: "curated_revision_reconfirmation_required",
        curated_revision_id: created.curated_revision_id,
      }),
    ],
  });

  const shownResponse = await adminRequest(`/admin/v1/curated-revisions/${created.curated_revision_id}`);
  expect(shownResponse.status).toBe(200);
  const shown = (await shownResponse.json()) as {
    revision: {
      status: string;
      event_version: number;
      pending_conflict: {
        id: string;
        digest: string;
        run_id: string;
        previous_source_digest: string;
        observed_source_digest: string;
      };
    };
    events: Array<{ type: string; details: Record<string, unknown> }>;
  };
  expect(shown.revision).toMatchObject({
    status: "reconfirmation_required",
    event_version: 2,
    pending_conflict: {
      run_id: retried.id,
      previous_source_digest: authored.reviewed_source_digest,
      observed_source_digest: await sha256Text(canonicalJson("Changed Official Name")),
    },
  });
  const conflict = shown.revision.pending_conflict;
  expect(conflict.digest).toBe(
    await sha256Text(
      canonicalJson({
        conflict_id: conflict.id,
        run_id: retried.id,
        revision_id: created.curated_revision_id,
        previous_source_digest: conflict.previous_source_digest,
        observed_source_digest: conflict.observed_source_digest,
      }),
    ),
  );
  expect(shown.events.at(-1)).toMatchObject({
    type: "source_change_detected",
    details: { conflict_digest: conflict.digest },
  });

  const freshRunKey = `public-conflict-fresh-run-${sequence}`;
  const blockedRun = await adminRequest(`/v1/ingestion-runs/${sourceRunId}/retry`, { idempotency_key: freshRunKey });
  expect(blockedRun.status).toBe(409);
  const blockedProblem = (await blockedRun.json()) as Record<string, unknown>;
  expect(blockedProblem).toMatchObject({
    code: "curated_revision_reconfirmation_required",
  });

  const unaffectedSourceRunId = `run_public_unaffected_source_${sequence}`;
  const unaffectedCandidate = {
    contract: "card-keepr-catalogue-candidate@1" as const,
    selected_games: ["digimon" as const],
    cards: [],
    printings: [],
  };
  const unaffectedDigest = await sha256Text(canonicalJson(unaffectedCandidate));
  await ingestionQueries
    .insertIngestionRunsForWorkerBindsSourceChangeReaffirmationExactPublicConflictWithCompletedStagesPlanningCollectingParsingReconciling(
      env.CATALOGUE_DB,
    )
    .bind(
      unaffectedSourceRunId,
      now,
      currentRevision,
      `public-unaffected-source-${sequence}`,
      unaffectedDigest,
      unaffectedDigest,
      now,
      now,
      canonicalJson(unaffectedCandidate),
    )
    .run();
  const unaffectedResponse = await adminRequest(`/v1/ingestion-runs/${unaffectedSourceRunId}/retry`, {
    idempotency_key: `public-unaffected-run-${sequence}`,
  });
  expect(unaffectedResponse.status).toBe(201);
  const unaffected = (await unaffectedResponse.json()) as {
    id: string;
    state: string;
    candidate_digest: string;
  };
  expect(unaffected).toMatchObject({
    state: "awaiting_approval",
    linked_run_id: unaffectedSourceRunId,
  });
  const rejectedUnaffected = await adminRequest(`/v1/ingestion-runs/${unaffected.id}/rejection`, {
    candidate_digest: unaffected.candidate_digest,
    idempotency_key: `public-unaffected-reject-${sequence}`,
  });
  expect(rejectedUnaffected.status).toBe(200);

  const stale = await adminRequest(`/admin/v1/curated-revisions/${created.curated_revision_id}/reaffirm`, {
    environment: "production",
    expected_current_revision_id: currentRevision,
    expected_event_version: 2,
    conflict_digest: "f".repeat(64),
    rationale: "Review the changed Official Source value.",
    idempotency_key: `public-conflict-stale-${sequence}`,
  });
  expect(stale.status).toBe(409);
  await expect(stale.json()).resolves.toMatchObject({
    code: "curated_revision_conflict_digest_mismatch",
  });

  const reaffirmInput = {
    environment: "production",
    expected_current_revision_id: currentRevision,
    expected_event_version: 2,
    conflict_digest: conflict.digest,
    rationale: "The exception remains necessary after source review.",
    idempotency_key: `public-conflict-reaffirm-${sequence}`,
  };
  const reaffirmedResponse = await adminRequest(
    `/admin/v1/curated-revisions/${created.curated_revision_id}/reaffirm`,
    reaffirmInput,
  );
  expect(reaffirmedResponse.status).toBe(200);
  const reaffirmed = await reaffirmedResponse.json();
  expect(reaffirmed).toMatchObject({
    curated_revision_id: created.curated_revision_id,
    content_digest: created.content_digest,
    status: "active",
    event_version: 3,
    code: "curated_revision_reaffirmed",
  });
  const replay = await adminRequest(
    `/admin/v1/curated-revisions/${created.curated_revision_id}/reaffirm`,
    reaffirmInput,
  );
  expect(replay.status).toBe(200);
  await expect(replay.json()).resolves.toEqual(reaffirmed);
  const changedReuse = await adminRequest(`/admin/v1/curated-revisions/${created.curated_revision_id}/reaffirm`, {
    ...reaffirmInput,
    rationale: "Changed idempotent request.",
  });
  expect(changedReuse.status).toBe(409);
  await expect(changedReuse.json()).resolves.toMatchObject({
    code: "idempotency_conflict",
  });

  const blockedReplay = await adminRequest(`/v1/ingestion-runs/${sourceRunId}/retry`, { idempotency_key: freshRunKey });
  expect(blockedReplay.status).toBe(409);
  await expect(blockedReplay.json()).resolves.toEqual({
    ...blockedProblem,
    request_id: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  });
  const freshRunResponse = await adminRequest(`/v1/ingestion-runs/${sourceRunId}/retry`, {
    idempotency_key: `public-conflict-after-reaffirm-${sequence}`,
  });
  expect(freshRunResponse.status).toBe(201);
  const freshRun = (await freshRunResponse.json()) as {
    id: string;
    candidate_digest: string;
  };
  expect(freshRun).toMatchObject({
    state: "awaiting_approval",
    linked_run_id: sourceRunId,
  });
  const inspectedFresh = await adminRequest(`/v1/ingestion-runs/${freshRun.id}/candidate`);
  expect(inspectedFresh.status).toBe(200);
  await expect(inspectedFresh.json()).resolves.toMatchObject({
    curated_revision_ids: [created.curated_revision_id],
    diff: {
      curated_effects: [
        expect.objectContaining({
          revision_id: created.curated_revision_id,
          assertion: { kind: "field", value: "Curated Name" },
        }),
      ],
    },
  });
});

test("a changed official value requires reconfirmation instead of silently applying", async () => {
  const authoredProposal = await proposal("/name", "Curated Name");
  const created = await adminRequest("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: authoredProposal,
    proposal_digest: await sha256Text(canonicalJson(authoredProposal)),
    idempotency_key: `source-change-${sequence}`,
  });
  const revision = (await created.json()) as { curated_revision_id: string };
  const runId = `run_curated_source_change_${sequence}`;
  await insertParsingRun(runId);
  await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), runId, now);

  await expect(
    applyPinnedCuratedRevisions(
      catalogueStore(env.CATALOGUE_DB),
      runId,
      {
        contract: "card-keepr-catalogue-candidate@1",
        selected_games: ["one-piece"],
        cards: [{ ...card, name: "New Official Name" }],
        printings: [],
      },
      now,
    ),
  ).rejects.toThrow("curated_revision_reconfirmation_required");
  await expect(
    curatedQueries
      .readCuratedRevisionsStatusEventVersionForChangedOfficialValueRequiresReconfirmationInsteadSilentlyApplying(
        env.CATALOGUE_DB,
      )
      .bind(revision.curated_revision_id)
      .first(),
  ).resolves.toMatchObject({
    status: "reconfirmation_required",
    event_version: 2,
  });
  await expect(
    ingestionQueries
      .readIngestionRunsStateFailureCodeForChangedOfficialValueRequiresReconfirmationInsteadSilentlyApplying(
        env.CATALOGUE_DB,
      )
      .bind(runId)
      .first(),
  ).resolves.toEqual({
    state: "failed",
    failure_code: "curated_revision_reconfirmation_required",
    terminal_at: now,
  });
  await expect(ingestionQueries.readOperationStateActiveIngestionRunId(env.CATALOGUE_DB).first()).resolves.toEqual({
    active_ingestion_run_id: null,
  });
  await expect(
    applyPinnedCuratedRevisions(
      catalogueStore(env.CATALOGUE_DB),
      runId,
      {
        contract: "card-keepr-catalogue-candidate@1",
        selected_games: ["one-piece"],
        cards: [{ ...card, name: "New Official Name" }],
        printings: [],
      },
      now,
    ),
  ).rejects.toThrow("curated_revision_reconfirmation_required");
  await expect(
    curatedQueries
      .countCuratedRevisionEventsCountForChangedOfficialValueRequiresReconfirmationInsteadSilentlyApplying(
        env.CATALOGUE_DB,
      )
      .bind(revision.curated_revision_id)
      .first(),
  ).resolves.toEqual({ count: 1 });
});

test("all changed pinned revisions are marked before the run fails once", async () => {
  const createdIds: string[] = [];
  for (const [path, value] of [
    ["/name", "Curated Name"],
    ["/effective_rules_text", "Curated text"],
  ] as const) {
    const authored = await proposal(path, value);
    const response = await adminRequest("/admin/v1/curated-revisions", {
      environment: "production",
      expected_current_revision_id: currentRevision,
      proposal: authored,
      proposal_digest: await sha256Text(canonicalJson(authored)),
      idempotency_key: `all-conflicts-${path}-${sequence}`,
    });
    expect(response.status).toBe(201);
    createdIds.push(
      String(
        (
          (await response.json()) as {
            curated_revision_id: string;
          }
        ).curated_revision_id,
      ),
    );
  }
  const runId = `run_all_conflicts_${sequence}`;
  await insertParsingRun(runId);
  await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), runId, now);
  await expect(
    applyPinnedCuratedRevisions(
      catalogueStore(env.CATALOGUE_DB),
      runId,
      {
        contract: "card-keepr-catalogue-candidate@1",
        selected_games: ["one-piece"],
        cards: [
          {
            ...card,
            name: "Changed Official Name",
            effective_rules_text: "Changed Official Text",
          },
        ],
        printings: [],
      },
      now,
    ),
  ).rejects.toThrow("curated_revision_reconfirmation_required");
  const statuses = await curatedQueries
    .readCuratedRevisionsIdStatus(env.CATALOGUE_DB)
    .bind(JSON.stringify(createdIds))
    .all<{ id: string; status: string }>();
  expect(statuses.results).toHaveLength(2);
  expect(statuses.results.every(({ status }) => status === "reconfirmation_required")).toBe(true);
});

test("field absence is distinct from null and retirement restores exact absence", async () => {
  const absence = curatedSourceAbsence;
  const printingId = `printing_optional_${sequence}`;
  const printing = {
    id: printingId,
    card_id: card.id,
    rarity: { normalized: "common", raw: "C" },
    printed_rules_text: null,
    game_data: { profile: "one-piece@1", attributes: {} },
  };
  await publishedCatalogueQueries
    .insertRevisionPrintingsForPublicPrintingResponseValidatesFullDistributionContextObjects(env.CATALOGUE_DB)
    .bind(currentRevision, printingId, card.id, canonicalJson(printing))
    .run();
  const authored = {
    ...(await proposal("/name", "unused")),
    target: {
      kind: "field" as const,
      entity_type: "printing" as const,
      entity_id: printingId,
      path: "/game_data/attributes/illustration_types",
    },
    assertion: { kind: "field" as const, value: ["comic"] },
    reviewed_source_digest: await sha256Text(canonicalJson(absence)),
  };
  const validation = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: authored,
    catalogue_revision_id: currentRevision,
  });
  expect(validation.status, JSON.stringify(await validation.clone().json())).toBe(200);
  const created = await createCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      proposal: authored,
      proposal_digest: await sha256Text(canonicalJson(authored)),
      idempotency_key: `absence-create-${sequence}`,
    },
    now,
  );

  const appliedRunId = `run_absence_applied_${sequence}`;
  await insertParsingRun(appliedRunId);
  await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), appliedRunId, now);
  const applied = await applyPinnedCuratedRevisions(
    catalogueStore(env.CATALOGUE_DB),
    appliedRunId,
    {
      contract: "card-keepr-catalogue-candidate@1",
      selected_games: ["one-piece"],
      cards: [card],
      printings: [printing as never],
    },
    now,
  );
  expect((applied.printings[0]!.game_data!.attributes as Record<string, unknown>).illustration_types).toEqual([
    "comic",
  ]);
  expect(applied.printings[0]!.curated_provenance?.[0]?.reviewed_source_value).toEqual(absence);
  const stripped = stripCuratedRevisionEffects(applied);
  expect(Object.hasOwn(stripped.printings[0]!.game_data!.attributes, "illustration_types")).toBe(false);
  await env.CATALOGUE_DB.batch([
    ingestionQueries
      .setIngestionRunsStateTerminalAtForFieldAbsenceDistinctFromNullRetirementRestoresExactAbsence(env.CATALOGUE_DB)
      .bind(now, appliedRunId),
    ingestionQueries.setOperationStateActiveIngestionRunIdForInstallApiSuite(env.CATALOGUE_DB),
  ]);

  const nullRunId = `run_absence_to_null_${sequence}`;
  await insertParsingRun(nullRunId);
  await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), nullRunId, now);
  const explicitNull = structuredClone(printing) as Record<string, unknown>;
  (explicitNull.game_data as { attributes: Record<string, unknown> }).attributes.illustration_types = null;
  await expect(
    applyPinnedCuratedRevisions(
      catalogueStore(env.CATALOGUE_DB),
      nullRunId,
      {
        contract: "card-keepr-catalogue-candidate@1",
        selected_games: ["one-piece"],
        cards: [card],
        printings: [explicitNull as never],
      },
      now,
    ),
  ).rejects.toThrow("curated_revision_reconfirmation_required");

  const shown = (await showCuratedRevision(catalogueStore(env.CATALOGUE_DB), created.document.curated_revision_id)) as {
    revision: { event_version: number; pending_conflict: { digest: string } };
  };
  await retireCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    created.document.curated_revision_id,
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      expected_event_version: shown.revision.event_version,
      conflict_digest: shown.revision.pending_conflict.digest,
      rationale: "Restore the Official Source absence.",
      idempotency_key: `absence-retire-${sequence}`,
    },
    now,
  );
  const restoredRunId = `run_absence_restored_${sequence}`;
  await insertParsingRun(restoredRunId);
  await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), restoredRunId, now);
  const restored = await applyPinnedCuratedRevisions(
    catalogueStore(env.CATALOGUE_DB),
    restoredRunId,
    {
      contract: "card-keepr-catalogue-candidate@1",
      selected_games: ["one-piece"],
      cards: [card],
      printings: [printing as never],
    },
    now,
  );
  expect(Object.hasOwn(restored.printings[0]!.game_data!.attributes, "illustration_types")).toBe(false);
});

test("retargeted supersession binds the old conflict and the replacement target's official digest", async () => {
  const authored = await proposal("/name", "Curated Name");
  const created = await createCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      proposal: authored,
      proposal_digest: await sha256Text(canonicalJson(authored)),
      idempotency_key: `retarget-create-${sequence}`,
    },
    now,
  );
  const runId = `run_retarget_${sequence}`;
  await insertParsingRun(runId);
  await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), runId, now);
  await expect(
    applyPinnedCuratedRevisions(
      catalogueStore(env.CATALOGUE_DB),
      runId,
      {
        contract: "card-keepr-catalogue-candidate@1",
        selected_games: ["one-piece"],
        cards: [{ ...card, name: "Changed Official Name" }],
        printings: [],
      },
      now,
    ),
  ).rejects.toThrow("curated_revision_reconfirmation_required");
  await ingestionQueries.setOperationStateActiveIngestionRunIdForInstallApiSuite(env.CATALOGUE_DB).run();
  const shown = await adminRequest(`/admin/v1/curated-revisions/${created.document.curated_revision_id}`);
  const inspected = (await shown.json()) as {
    revision: { pending_conflict: { digest: string }; event_version: number };
  };
  const replacement = {
    ...(await proposal("/effective_rules_text", "Replacement text")),
    supersedes_revision_id: created.document.curated_revision_id,
  };
  const superseded = await adminRequest(
    `/admin/v1/curated-revisions/${created.document.curated_revision_id}/supersede`,
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      expected_event_version: inspected.revision.event_version,
      conflict_digest: inspected.revision.pending_conflict.digest,
      proposal: replacement,
      proposal_digest: await sha256Text(canonicalJson(replacement)),
      rationale: "Move the exception to the independently reviewed target.",
      idempotency_key: `retarget-supersede-${sequence}`,
    },
  );
  expect(superseded.status).toBe(201);
  await expect(superseded.json()).resolves.toMatchObject({
    code: "curated_revision_superseded",
    status: "active",
  });
});

test("exact reaffirmation, supersession, and retirement recover lifecycle without rewriting history", async () => {
  const authoredProposal = await proposal("/name", "Curated Name");
  const createdResult = await createCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      proposal: authoredProposal,
      proposal_digest: await sha256Text(canonicalJson(authoredProposal)),
      idempotency_key: `lifecycle-create-${sequence}`,
    },
    now,
  );
  const created = createdResult.document;
  const runId = `run_curated_lifecycle_${sequence}`;
  await insertParsingRun(runId);
  await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), runId, now);
  await expect(
    applyPinnedCuratedRevisions(
      catalogueStore(env.CATALOGUE_DB),
      runId,
      {
        contract: "card-keepr-catalogue-candidate@1",
        selected_games: ["one-piece"],
        cards: [{ ...card, name: "New Official Name" }],
        printings: [],
      },
      now,
    ),
  ).rejects.toThrow("curated_revision_reconfirmation_required");
  await ingestionQueries.setOperationStateActiveIngestionRunIdForInstallApiSuite(env.CATALOGUE_DB).run();

  const conflictDocument = (await showCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    created.curated_revision_id,
  )) as {
    events: { details: { conflict_digest?: string } }[];
  };
  const conflictDigest = conflictDocument.events.at(-1)!.details.conflict_digest!;
  const reaffirmed = await reaffirmCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    created.curated_revision_id,
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      expected_event_version: 2,
      conflict_digest: conflictDigest,
      rationale: "The owner accepts the new Official Source value.",
      idempotency_key: `reaffirm-${sequence}`,
    },
    now,
  );
  expect(reaffirmed.document).toMatchObject({
    curated_revision_id: created.curated_revision_id,
    status: "active",
    event_version: 3,
    code: "curated_revision_reaffirmed",
  });

  const replacement = {
    ...(await proposal("/name", "Replacement Name")),
    reviewed_source_digest: await sha256Text(canonicalJson("New Official Name")),
    supersedes_revision_id: created.curated_revision_id,
  };
  const replacementWithMissingEvidence = {
    ...replacement,
    evidence: [
      {
        kind: "source_observation" as const,
        id: `srcobs_missing_replacement_${sequence}`,
      },
    ],
  };
  await expect(
    supersedeCuratedRevision(
      catalogueStore(env.CATALOGUE_DB),
      created.curated_revision_id,
      {
        environment: "production",
        expected_current_revision_id: currentRevision,
        expected_event_version: 3,
        conflict_digest: null,
        proposal: replacementWithMissingEvidence,
        proposal_digest: await sha256Text(canonicalJson(replacementWithMissingEvidence)),
        rationale: "Reject unresolved replacement evidence.",
        idempotency_key: `supersede-missing-evidence-${sequence}`,
      },
      now,
    ),
  ).rejects.toMatchObject({
    code: "curated_revision_evidence_not_retained",
  });
  const superseded = await supersedeCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    created.curated_revision_id,
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      expected_event_version: 3,
      conflict_digest: null,
      proposal: replacement,
      proposal_digest: await sha256Text(canonicalJson(replacement)),
      rationale: "Replace the assertion.",
      idempotency_key: `supersede-${sequence}`,
    },
    now,
  );
  expect(superseded.created).toBe(true);
  const replacementResult = superseded.document;

  const retired = await retireCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    replacementResult.curated_revision_id,
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      expected_event_version: 1,
      conflict_digest: null,
      rationale: "The exception is no longer required.",
      idempotency_key: `retire-${sequence}`,
    },
    now,
  );
  expect(retired.document).toMatchObject({
    status: "retired",
    event_version: 2,
    code: "curated_revision_retired",
  });
});

test("the Worker lifecycle endpoints fail closed on every mutation guard", async () => {
  const authored = await proposal("/name", "Guarded Name");
  const createdResponse = await adminRequest("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: authored,
    proposal_digest: await sha256Text(canonicalJson(authored)),
    idempotency_key: `public-guards-create-${sequence}`,
  });
  const created = (await createdResponse.json()) as {
    curated_revision_id: string;
    content_digest: string;
  };
  const retirePath = `/admin/v1/curated-revisions/${created.curated_revision_id}/retire`;
  const retireInput = {
    environment: "production",
    expected_current_revision_id: currentRevision,
    expected_event_version: 1,
    conflict_digest: null,
    rationale: "The exception is no longer required.",
    idempotency_key: "",
  };
  for (const [name, body, code] of [
    [
      "current",
      {
        ...retireInput,
        expected_current_revision_id: "catrev_stale",
        idempotency_key: `public-guards-current-${sequence}`,
      },
      "current_revision_mismatch",
    ],
    [
      "event",
      {
        ...retireInput,
        expected_event_version: 2,
        idempotency_key: `public-guards-event-${sequence}`,
      },
      "curated_revision_event_version_mismatch",
    ],
    [
      "conflict",
      {
        ...retireInput,
        conflict_digest: "f".repeat(64),
        idempotency_key: `public-guards-conflict-${sequence}`,
      },
      "curated_revision_has_no_pending_conflict",
    ],
  ] as const) {
    const response = await adminRequest(retirePath, body);
    expect(response.status, name).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code });
  }

  await ingestionQueries.setOperationStateRecoveryHealth(env.CATALOGUE_DB).run();
  const recovery = await adminRequest(retirePath, {
    ...retireInput,
    idempotency_key: `public-guards-recovery-${sequence}`,
  });
  expect(recovery.status).toBe(409);
  await expect(recovery.json()).resolves.toMatchObject({
    code: "recovery_in_progress",
  });

  await ingestionQueries
    .setOperationStateRecoveryHealthActiveProductionReleaseIdForWorkerLifecycleEndpointsFailClosedOnEveryMutationGuard(
      env.CATALOGUE_DB,
    )
    .run();
  const release = await adminRequest(retirePath, {
    ...retireInput,
    idempotency_key: `public-guards-release-${sequence}`,
  });
  expect(release.status).toBe(409);
  await expect(release.json()).resolves.toMatchObject({
    code: "release_not_idle",
  });

  await ingestionQueries
    .setOperationStateActiveProductionReleaseIdActiveProductionReleaseExpiresAtForWorkerLifecycleEndpointsFailClosedOnEveryMutationGuard(
      env.CATALOGUE_DB,
    )
    .run();
  const activeRunId = `run_public_guard_active_${sequence}`;
  await insertParsingRun(activeRunId);
  const activeRun = await adminRequest(retirePath, {
    ...retireInput,
    idempotency_key: `public-guards-run-${sequence}`,
  });
  expect(activeRun.status).toBe(409);
  await expect(activeRun.json()).resolves.toMatchObject({
    code: "active_ingestion_run",
  });
  await env.CATALOGUE_DB.batch([
    ingestionQueries
      .setIngestionRunsStateTerminalAtForFieldAbsenceDistinctFromNullRetirementRestoresExactAbsence(env.CATALOGUE_DB)
      .bind(now, activeRunId),
    ingestionQueries
      .setOperationStateActiveIngestionRunIdForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewalWithundefined(
        env.CATALOGUE_DB,
      )
      .bind(activeRunId),
  ]);

  const replacement = {
    ...authored,
    assertion: { kind: "field" as const, value: "Replacement Name" },
    supersedes_revision_id: created.curated_revision_id,
  };
  const wrongProposalDigest = await adminRequest(
    `/admin/v1/curated-revisions/${created.curated_revision_id}/supersede`,
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      expected_event_version: 1,
      conflict_digest: null,
      proposal: replacement,
      proposal_digest: "f".repeat(64),
      rationale: "Replace the assertion.",
      idempotency_key: `public-guards-proposal-${sequence}`,
    },
  );
  expect(wrongProposalDigest.status).toBe(409);
  await expect(wrongProposalDigest.json()).resolves.toMatchObject({
    code: "curated_revision_content_digest_mismatch",
  });

  const supersededResponse = await adminRequest(
    `/admin/v1/curated-revisions/${created.curated_revision_id}/supersede`,
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      expected_event_version: 1,
      conflict_digest: null,
      proposal: replacement,
      proposal_digest: await sha256Text(canonicalJson(replacement)),
      rationale: "Replace the assertion.",
      idempotency_key: `public-guards-supersede-${sequence}`,
    },
  );
  expect(supersededResponse.status).toBe(201);
  const superseded = (await supersededResponse.json()) as {
    curated_revision_id: string;
  };
  const oldResponse = await adminRequest(`/admin/v1/curated-revisions/${created.curated_revision_id}`);
  await expect(oldResponse.json()).resolves.toMatchObject({
    revision: { status: "superseded", event_version: 2 },
    events: [{ type: "authored" }, { type: "superseded" }],
  });

  const finalRetireInput = {
    ...retireInput,
    expected_event_version: 1,
    idempotency_key: `public-guards-retire-${sequence}`,
  };
  const retiredResponse = await adminRequest(
    `/admin/v1/curated-revisions/${superseded.curated_revision_id}/retire`,
    finalRetireInput,
  );
  expect(retiredResponse.status).toBe(200);
  const retired = await retiredResponse.json();
  const retiredReplay = await adminRequest(
    `/admin/v1/curated-revisions/${superseded.curated_revision_id}/retire`,
    finalRetireInput,
  );
  expect(retiredReplay.status).toBe(200);
  await expect(retiredReplay.json()).resolves.toEqual(retired);
  const changedReuse = await adminRequest(`/admin/v1/curated-revisions/${superseded.curated_revision_id}/retire`, {
    ...finalRetireInput,
    rationale: "Changed reuse.",
  });
  expect(changedReuse.status).toBe(409);
  await expect(changedReuse.json()).resolves.toMatchObject({
    code: "idempotency_conflict",
  });
  const retiredShown = await adminRequest(`/admin/v1/curated-revisions/${superseded.curated_revision_id}`);
  await expect(retiredShown.json()).resolves.toMatchObject({
    revision: { status: "retired", event_version: 2 },
    events: [{ type: "authored" }, { type: "retired" }],
  });
});

test("supersession rolls back both lifecycle sides when replacement persistence fails", async () => {
  const authored = await proposal("/name", "Atomic Prior Name");
  const createdResponse = await adminRequest("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: authored,
    proposal_digest: await sha256Text(canonicalJson(authored)),
    idempotency_key: `atomic-supersession-create-${sequence}`,
  });
  expect(createdResponse.status).toBe(201);
  const created = (await createdResponse.json()) as {
    curated_revision_id: string;
  };
  const replacement = {
    ...authored,
    assertion: { kind: "field" as const, value: "Atomic Replacement Name" },
    supersedes_revision_id: created.curated_revision_id,
  };
  const supersedeInput = {
    environment: "production",
    expected_current_revision_id: currentRevision,
    expected_event_version: 1,
    conflict_digest: null,
    proposal: replacement,
    proposal_digest: await sha256Text(canonicalJson(replacement)),
    rationale: "Replace both lifecycle sides atomically.",
    idempotency_key: `atomic-supersession-${sequence}`,
  };
  await curatedQueries.createInjectCuratedReplacementFailure(env.CATALOGUE_DB).run();
  const failed = await adminRequest(
    `/admin/v1/curated-revisions/${created.curated_revision_id}/supersede`,
    supersedeInput,
  );
  await publishedCatalogueQueries.dropInjectCuratedReplacementFailure(env.CATALOGUE_DB).run();
  expect(failed.status).toBe(500);
  await expect(failed.json()).resolves.toMatchObject({ code: "internal_error" });

  const unchanged = await adminRequest(`/admin/v1/curated-revisions/${created.curated_revision_id}`);
  await expect(unchanged.json()).resolves.toMatchObject({
    revision: {
      status: "active",
      event_version: 1,
      content: authored,
    },
    events: [{ type: "authored", event_version: 1 }],
  });
  await expect(
    curatedQueries.countCuratedRevisionIdempotencyCount(env.CATALOGUE_DB).bind(supersedeInput.idempotency_key).first(),
  ).resolves.toEqual({
    count: 0,
  });
  await expect(
    curatedQueries.countCuratedRevisionsCount(env.CATALOGUE_DB).bind(created.curated_revision_id).first(),
  ).resolves.toEqual({ count: 0 });

  const committed = await adminRequest(
    `/admin/v1/curated-revisions/${created.curated_revision_id}/supersede`,
    supersedeInput,
  );
  expect(committed.status).toBe(201);
  const committedDocument = (await committed.clone().json()) as {
    curated_revision_id?: unknown;
  };
  if (typeof committedDocument.curated_revision_id !== "string") {
    throw new Error("The replacement Curated Revision identity is absent");
  }
  const replacementId = committedDocument.curated_revision_id;
  const [prior, replacementShown] = await Promise.all([
    adminRequest(`/admin/v1/curated-revisions/${created.curated_revision_id}`),
    adminRequest(`/admin/v1/curated-revisions/${replacementId}`),
  ]);
  await expect(prior.json()).resolves.toMatchObject({
    revision: { status: "superseded", event_version: 2 },
  });
  await expect(replacementShown.json()).resolves.toMatchObject({
    revision: {
      status: "active",
      event_version: 1,
      content: replacement,
    },
  });
});

test("an empty curated revision set is still pinned with its digest", async () => {
  const runId = `run_curated_empty_${sequence}`;
  await insertParsingRun(runId);
  const pin = await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), runId, now);
  expect(pin.revision_ids).toEqual([]);
  await expect(
    ingestionQueries
      .readIngestionRunCuratedRevisionSetsRevisionIdsJsonSetDigestForEmptyCuratedRevisionSetStillPinnedDigest(
        env.CATALOGUE_DB,
      )
      .bind(runId)
      .first(),
  ).resolves.toEqual({
    revision_ids_json: "[]",
    set_digest: pin.set_digest,
    pinned_at: now,
  });

  await expect(
    ingestionQueries.setIngestionRunCuratedRevisionSetsSetDigest(env.CATALOGUE_DB).bind("f".repeat(64), runId).run(),
  ).rejects.toThrow("curated_revision_pin_set_immutable");
  const replay = await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), runId, "2026-08-06T00:00:00.000Z");
  expect(replay).toEqual(pin);
});

test("a curated relationship carries owner provenance and never invents Official Source lineage", async () => {
  const relationshipProposal = {
    game: "one-piece",
    target: {
      kind: "relationship",
      relationship_kind: "printing-product",
      from: { type: "printing", id: `printing_${sequence}` },
      to: { type: "product", id: `product_${sequence}` },
    },
    assertion: { kind: "relationship", presence: "present" },
    rationale: "The owner reviewed the product membership.",
    evidence: [
      {
        kind: "owner_reference",
        uri: "https://owner.example/review/relationship",
        content_digest: "d".repeat(64),
      },
    ],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson("absent")),
    supersedes_revision_id: null,
  };
  const created = await createCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      proposal: relationshipProposal,
      proposal_digest: await sha256Text(canonicalJson(relationshipProposal)),
      idempotency_key: `relationship-${sequence}`,
    },
    now,
  );
  expect(created.created).toBe(true);
  const mutation = created.document;
  const runId = `run_relationship_${sequence}`;
  await insertParsingRun(runId);
  await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), runId, now);
  const applied = await applyPinnedCuratedRevisions(
    catalogueStore(env.CATALOGUE_DB),
    runId,
    {
      contract: "card-keepr-catalogue-candidate@1",
      selected_games: ["one-piece"],
      cards: [card],
      printings: [
        {
          id: `printing_${sequence}`,
          card_id: card.id,
          rarity: { normalized: "common", raw: "C" },
          printed_rules_text: null,
          game_data: null,
        },
      ],
      products: [
        {
          id: `product_${sequence}`,
          reference: { kind: "official_code", value: "OP-01" },
          game: "one-piece",
          official_code: "OP-01",
          name: "Booster",
          releases: [],
          observed: true,
          withdrawal: null,
          included: [],
          provenance: {},
          disagreements: [],
        },
      ],
      product_relationships: [],
    },
    now,
  );
  expect(applied.product_relationships).toEqual([
    expect.objectContaining({
      evidence_category: "curated",
      curated_provenance: [
        expect.objectContaining({
          curated_revision_id: mutation.curated_revision_id,
          rationale: relationshipProposal.rationale,
        }),
      ],
    }),
  ]);
  expect(applied.product_relationships![0]).not.toHaveProperty("source_lineage");
});

test("a curated absence derives one relationship state and retains Official Source evidence", async () => {
  const from = { type: "product" as const, id: `product_${sequence}` };
  const to = { type: "card" as const, id: card.id };
  const official = {
    id: `relationship_product_card_${sequence}`,
    game: "one-piece" as const,
    kind: "product-card" as const,
    from,
    to,
    evidence_category: "explicit" as const,
    resolution: "canonical" as const,
    source_lineage: "one-piece-en",
    source_observation_ids: [`srcobs_${sequence}`],
    relationship_value: card.official_identity.value,
    observed: true,
  };
  const corroboratingOfficial = {
    ...official,
    id: `${official.id}_corroborating`,
    source_lineage: "one-piece-product-detail",
    source_observation_ids: [`srcobs_${sequence}_corroborating`],
  };
  const relationshipProposal = {
    game: "one-piece",
    target: {
      kind: "relationship",
      relationship_kind: "product-card",
      from,
      to,
    },
    assertion: { kind: "relationship", presence: "absent" },
    rationale: "The owner reviewed the canonical relationship as absent.",
    evidence: [
      {
        kind: "owner_reference",
        uri: "https://owner.example/review/relationship-absence",
        content_digest: "e".repeat(64),
      },
    ],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson("present")),
    supersedes_revision_id: null,
  };
  const created = await createCuratedRevision(
    catalogueStore(env.CATALOGUE_DB),
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      proposal: relationshipProposal,
      proposal_digest: await sha256Text(canonicalJson(relationshipProposal)),
      idempotency_key: `relationship-absence-${sequence}`,
    },
    now,
  );
  expect(created.created).toBe(true);
  const runId = `run_relationship_absence_${sequence}`;
  await insertParsingRun(runId);
  await pinCuratedRevisionsForRun(catalogueStore(env.CATALOGUE_DB), runId, now);
  const applied = await applyPinnedCuratedRevisions(
    catalogueStore(env.CATALOGUE_DB),
    runId,
    {
      contract: "card-keepr-catalogue-candidate@1",
      selected_games: ["one-piece"],
      cards: [card],
      printings: [
        {
          id: `printing_${sequence}`,
          card_id: card.id,
          rarity: { normalized: "common", raw: "C" },
          printed_rules_text: null,
          game_data: null,
        },
      ],
      products: [
        {
          id: from.id,
          reference: { kind: "official_code", value: "OP-01" },
          game: "one-piece",
          official_code: "OP-01",
          name: "Booster",
          releases: [],
          observed: true,
          withdrawal: null,
          included: [],
          provenance: {},
          disagreements: [],
        },
      ],
      product_relationships: [official, corroboratingOfficial],
    },
    now,
  );
  expect(applied.product_relationships).toHaveLength(2);
  expect(applied.product_relationships).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: official.id, observed: false }),
      expect.objectContaining({ id: corroboratingOfficial.id, observed: false }),
    ]),
  );
  expect(
    applied.product_relationships!.every(
      (relationship) => relationship.curated_provenance?.at(-1)?.reviewed_source_value === "present",
    ),
  ).toBe(true);
  expect(stripCuratedRevisionEffects(applied).product_relationships).toEqual([official, corroboratingOfficial]);
  const built = await buildCatalogueExport(
    applied,
    await sha256Text(canonicalJson(applied)),
    `catrev_curated_relationship_${sequence}`,
    now,
  );
  expect(built.manifest).toMatchObject({
    format: "card-keepr-catalogue-export-manifest@5",
    export_schema_major: 5,
  });
  expect(built.manifest.components.find(({ name }) => name === "relationships")?.record_schema).toBe(
    "https://card-keepr.invalid/schemas/catalogue-export-record@5#/$defs/RelationshipRecord",
  );
});

async function proposal(path: string, value: unknown) {
  return {
    game: "one-piece",
    target: {
      kind: "field" as const,
      entity_type: "card" as const,
      entity_id: card.id,
      path,
    },
    assertion: { kind: "field" as const, value },
    rationale: "The owner reviewed an authoritative correction.",
    evidence: [
      {
        kind: "owner_reference" as const,
        uri: "https://owner.example/review/1",
        content_digest: "a".repeat(64),
      },
    ],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(
      canonicalJson(
        path === "/name"
          ? card.name
          : path === "/effective_rules_text"
            ? card.effective_rules_text
            : card.official_identity.value,
      ),
    ),
    supersedes_revision_id: null,
  };
}

function adminRequest(pathname: string, body?: unknown): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": `203.0.113.${(sequence % 250) + 1}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-keepr-test-now": now,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function digimonAttributes(): Record<string, unknown> {
  return {
    card_type: "digimon",
    colours: ["red"],
    level: 3,
    play_cost: 3,
    dp: 2000,
    digivolution_requirements: [],
    form: "Rookie",
    attribute: "Vaccine",
    traits: ["Reptile"],
    text_sections: [],
    use_cost: null,
  };
}

async function insertParsingRun(runId: string, selectedGames: readonly string[] = ["one-piece"]) {
  await env.CATALOGUE_DB.batch([
    ingestionQueries
      .insertIngestionRunsForInsertParsingRun(env.CATALOGUE_DB)
      .bind(runId, canonicalJson(selectedGames), now, currentRevision, `parse-${runId}`),
    ingestionQueries
      .setOperationStateActiveIngestionRunIdForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        env.CATALOGUE_DB,
      )
      .bind(runId),
  ]);
}
