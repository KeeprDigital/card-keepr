import { expect, test } from "vitest";
import {
  canonicalJson,
  sha256,
  utf8,
} from "../../../src/catalogue/serialization";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import {
  approve,
  canonicalLegalityCardIdInvariantErrors,
  canonicalLegalityEffectInvariantErrors,
  collectFixtureLegality,
  collectFixtureLegalityEvidence,
  exportedLegalityRule,
  installContextualLegalitySuite,
  reconcile,
  rejectedError,
  request,
  requiredString,
  resolveJsonPointer,
  revisionLegalityRule,
  testEnv,
  waitForState,
} from "./contextual-legality-helpers";

installContextualLegalitySuite();

test("test-owned domain evidence publishes exact Legality Rules and keeps still-effective history applicable", async () => {
  const first = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain",
    "contextual-legality-domain-current",
  );
  expect(first.reconciled).toMatchObject({
    state: "awaiting_approval",
    publishable: true,
    legality_rules: expect.arrayContaining([
      expect.objectContaining({
        official_id: "legality_rule_asia_copy_limit",
        effect: { type: "copy_limit", maximum_copies: 1 },
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_combination",
        effect: expect.objectContaining({
          type: "prohibited_combination",
        }),
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_membership",
        effect: {
          type: "membership",
          attribute: "traits",
          includes_any: ["Earth Federation"],
        },
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_rotation",
        effect: { type: "rotation", eligible_blocks: ["1"] },
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_release_timing",
        effect: { type: "release_timing", legal_from: "2026-01-01" },
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_unresolved_scope",
        effect: expect.objectContaining({ type: "unresolved" }),
      }),
    ]),
  });
  const retainedRules = first.reconciled.legality_rules as Array<
    Record<string, unknown>
  >;
  const retainedLocations = retainedRules.map((rule) =>
    requiredString(rule, "source_observation_set_id") + ":" +
      requiredString(rule, "source_observation_pointer")
  );
  expect(new Set(retainedLocations).size).toBe(retainedRules.length);
  const retainedDocuments = new Map<string, Record<string, unknown>>();
  for (const rule of retainedRules) {
    const observationSetId = requiredString(
      rule,
      "source_observation_set_id",
    );
    let retainedDocument = retainedDocuments.get(observationSetId);
    if (retainedDocument === undefined) {
      const retained = await request(
        `/v1/source-observation-sets/${observationSetId}/content`,
      );
      expect(retained.response.status).toBe(200);
      retainedDocument = retained.document;
      retainedDocuments.set(observationSetId, retainedDocument);
    }
    const pointer = requiredString(rule, "source_observation_pointer");
    expect(pointer).toMatch(
      /^\/observations\/\d+\/value\/legality_rules\/\d+$/,
    );
    expect(rule.source_field_pointers).toEqual({
      official_wording: `${pointer}/official_wording`,
      effective_from: `${pointer}/effective_from`,
      effective_until: `${pointer}/effective_until`,
      unresolved_scope: `${pointer}/unresolved_scope`,
      region: `${pointer}/region`,
      format: `${pointer}/format`,
      event_tier: `${pointer}/event_tier`,
      card_numbers: `${pointer}/card_numbers`,
      effect: `${pointer}/effect`,
    });
    for (const [field, fieldPointer] of Object.entries(
      rule.source_field_pointers as Record<string, string>,
    )) {
      const sourceValue = resolveJsonPointer(
        retainedDocument,
        fieldPointer,
      );
      expect(sourceValue).not.toBeUndefined();
      if (
        field !== "card_numbers" &&
        field !== "effect"
      ) {
        expect(sourceValue).toEqual(rule[field]);
      }
    }
  }
  const copyLimit = retainedRules.find(
    (rule) => rule.official_id === "legality_rule_asia_copy_limit",
  );
  const combination = retainedRules.find(
    (rule) => rule.official_id === "legality_rule_asia_combination",
  );
  expect(copyLimit).toBeDefined();
  expect(combination).toBeDefined();
  expect(copyLimit!.source_observation_id).toBe(
    combination!.source_observation_id,
  );
  expect(copyLimit!.source_observation_pointer).not.toBe(
    combination!.source_observation_pointer,
  );
  const published = await approve(first.reconciled, "publish-current-rules");
  expect(published.response.status).toBe(200);

  const omitted = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=omitted",
    "contextual-legality-domain-omitted",
  );
  expect(omitted.reconciled.legality_rules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        official_id: "legality_rule_asia_eligible",
        current: true,
      }),
    ]),
  );
  const omittedPublished = await approve(
    omitted.reconciled,
    "publish-omitted-rules",
  );
  expect(omittedPublished.response.status).toBe(200);
  const omittedRule = await revisionLegalityRule(
    requiredString(omittedPublished.document, "resulting_revision_id"),
    "legality_rule_asia_eligible",
  );
  expect(omittedRule).toMatchObject({ current: true });

  const empty = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=empty",
    "contextual-legality-domain-empty",
  );
  const emptyPublished = await approve(
    empty.reconciled,
    "publish-empty-rules",
  );
  expect(emptyPublished.response.status).toBe(200);
  const card = (empty.reconciled.cards as Array<Record<string, unknown>>)
    .find((candidate) =>
      (candidate.official_identity as Record<string, unknown>).value ===
        "GD30-001"
    );
  if (card === undefined) throw new Error("GD30-001 is absent");
  const eligible = await revisionLegalityRule(
    requiredString(emptyPublished.document, "resulting_revision_id"),
    "legality_rule_asia_eligible",
  );
  expect(eligible).toMatchObject({ current: false });

  const canonicalRules = await testEnv.CATALOGUE_DB.prepare(
    `SELECT id FROM legality_rules ORDER BY id LIMIT 3`,
  ).all<{ id: string }>();
  expect(canonicalRules.results).toHaveLength(3);
  const [idMutable, firstRevisionMutable, deleteMutable] =
    canonicalRules.results;
  const identityUpdate = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE legality_rules SET id = ? WHERE id = ?`,
    ).bind(`${idMutable!.id}_changed`, idMutable!.id).run(),
  );
  const firstRevisionUpdate = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE legality_rules SET first_revision_id = ? WHERE id = ?`,
    ).bind(
      requiredString(emptyPublished.document, "resulting_revision_id"),
      firstRevisionMutable!.id,
    ).run(),
  );
  const canonicalDelete = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `DELETE FROM legality_rules WHERE id = ?`,
    ).bind(deleteMutable!.id).run(),
  );
  const orphanRevisionRule = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES (?, 'legality_rule_missing_canonical', 'gundam',
         'EN-ASIA', 'standard', NULL, '2026-01-01', NULL, '[]', ?)`,
    ).bind(
      requiredString(emptyPublished.document, "resulting_revision_id"),
      JSON.stringify({
        id: "legality_rule_missing_canonical",
        official_id: "missing-canonical",
      }),
    ).run(),
  );
  const canonicalSnapshot = await testEnv.CATALOGUE_DB.prepare(
    `SELECT canonical.*, revision.document_json
     FROM legality_rules AS canonical
     JOIN revision_legality_rules AS revision
       ON revision.legality_rule_id = canonical.id
     WHERE revision.catalogue_revision_id = ?
       AND json_extract(canonical.effect_json, '$.type') =
       'prohibited_combination'
     ORDER BY canonical.id
     LIMIT 1`,
  ).bind(
    requiredString(emptyPublished.document, "resulting_revision_id"),
  ).first<Record<string, string | number | null>>();
  if (canonicalSnapshot === null) {
    throw new Error("Published canonical Legality Rule is absent");
  }
  const freshCanonicalCardIdErrors =
    await canonicalLegalityCardIdInvariantErrors(
      testEnv.CATALOGUE_DB,
      canonicalSnapshot,
      "fresh",
    );
  expect(freshCanonicalCardIdErrors.map(String)).toEqual(
    freshCanonicalCardIdErrors.map(() =>
      expect.stringMatching(/legality_rule_card_ids_not_canonical/),
    ),
  );
  const freshCanonicalEffectErrors =
    await canonicalLegalityEffectInvariantErrors(
      testEnv.CATALOGUE_DB,
      canonicalSnapshot,
      "fresh",
    );
  expect(freshCanonicalEffectErrors.map(String)).toEqual(
    freshCanonicalEffectErrors.map(() =>
      expect.stringMatching(/legality_rule_effect_invalid/),
    ),
  );
  const revisionUpdate = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE revision_legality_rules
       SET format = 'attacker-format'
       WHERE catalogue_revision_id = ? AND legality_rule_id = ?`,
    ).bind(
      requiredString(emptyPublished.document, "resulting_revision_id"),
      canonicalSnapshot.id,
    ).run(),
  );
  const revisionDelete = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `DELETE FROM revision_legality_rules
       WHERE catalogue_revision_id = ? AND legality_rule_id = ?`,
    ).bind(
      requiredString(emptyPublished.document, "resulting_revision_id"),
      canonicalSnapshot.id,
    ).run(),
  );
  const inconsistentRevisionContext = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_spine_000', ?, ?, ?, 'attacker-format', ?, ?, ?,
         ?, ?)`,
    ).bind(
      canonicalSnapshot.id,
      canonicalSnapshot.supported_game,
      canonicalSnapshot.region,
      canonicalSnapshot.event_tier,
      canonicalSnapshot.effective_from,
      canonicalSnapshot.effective_until,
      canonicalSnapshot.card_ids_json,
      canonicalSnapshot.document_json,
    ).run(),
  );
  const inconsistentDocument = JSON.stringify({
    ...JSON.parse(String(canonicalSnapshot.document_json)),
    official_wording: "Attacker-controlled wording.",
  });
  const inconsistentRevisionDocument = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_spine_000', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      canonicalSnapshot.id,
      canonicalSnapshot.supported_game,
      canonicalSnapshot.region,
      canonicalSnapshot.format,
      canonicalSnapshot.event_tier,
      canonicalSnapshot.effective_from,
      canonicalSnapshot.effective_until,
      canonicalSnapshot.card_ids_json,
      inconsistentDocument,
    ).run(),
  );
  const canonicalDocument = JSON.parse(
    String(canonicalSnapshot.document_json),
  ) as Record<string, unknown>;
  const {
    event_tier: _missingEventTier,
    ...documentWithoutNullableKey
  } = canonicalDocument;
  const {
    effective_until: _replacedEffectiveUntil,
    ...documentWithReplacementKey
  } = canonicalDocument;
  const missingNullableDocumentKey = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_spine_000', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      canonicalSnapshot.id,
      canonicalSnapshot.supported_game,
      canonicalSnapshot.region,
      canonicalSnapshot.format,
      canonicalSnapshot.event_tier,
      canonicalSnapshot.effective_from,
      canonicalSnapshot.effective_until,
      canonicalSnapshot.card_ids_json,
      JSON.stringify(documentWithoutNullableKey),
    ).run(),
  );
  const arbitraryDocumentKeySubstitution = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_spine_000', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      canonicalSnapshot.id,
      canonicalSnapshot.supported_game,
      canonicalSnapshot.region,
      canonicalSnapshot.format,
      canonicalSnapshot.event_tier,
      canonicalSnapshot.effective_from,
      canonicalSnapshot.effective_until,
      canonicalSnapshot.card_ids_json,
      JSON.stringify({
        ...documentWithReplacementKey,
        attacker_replacement: null,
      }),
    ).run(),
  );
  const duplicateRequiredDocumentKey = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_spine_000', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      canonicalSnapshot.id,
      canonicalSnapshot.supported_game,
      canonicalSnapshot.region,
      canonicalSnapshot.format,
      canonicalSnapshot.event_tier,
      canonicalSnapshot.effective_from,
      canonicalSnapshot.effective_until,
      canonicalSnapshot.card_ids_json,
      String(canonicalSnapshot.document_json).replace(
        /\}$/u,
        ',"official_wording":"Attacker-controlled duplicate."}',
      ),
    ).run(),
  );
  const canonicalCombinationDocument = JSON.parse(
    String(canonicalSnapshot.document_json),
  ) as Record<string, unknown>;
  const canonicalDirectCardIds = canonicalCombinationDocument.card_ids as string[];
  const canonicalEffect = canonicalCombinationDocument.effect as {
    type: string;
    with_card_ids: string[];
  };
  const nestedCardIdDocuments = [
    {
      ...canonicalCombinationDocument,
      card_ids: canonicalDirectCardIds[0],
    },
    {
      ...canonicalCombinationDocument,
      card_ids: [canonicalDirectCardIds[0], canonicalDirectCardIds[0]],
    },
    {
      ...canonicalCombinationDocument,
      card_ids: [
        ...canonicalDirectCardIds,
        ...canonicalEffect.with_card_ids,
      ],
    },
  ];
  const nestedCardIdMutations = await Promise.all(
    nestedCardIdDocuments.map((document) =>
      rejectedError(
        testEnv.CATALOGUE_DB.prepare(
          `INSERT INTO revision_legality_rules (
             catalogue_revision_id, legality_rule_id, supported_game,
             region, format, event_tier, effective_from, effective_until,
             card_ids_json, document_json
           ) VALUES ('catrev_spine_000', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          canonicalSnapshot.id,
          canonicalSnapshot.supported_game,
          canonicalSnapshot.region,
          canonicalSnapshot.format,
          canonicalSnapshot.event_tier,
          canonicalSnapshot.effective_from,
          canonicalSnapshot.effective_until,
          canonicalSnapshot.card_ids_json,
          JSON.stringify(document),
        ).run(),
      )
    ),
  );
  const provenanceOwners = await testEnv.CATALOGUE_DB.prepare(
    `SELECT id, source_snapshot_id
     FROM source_observation_sets
     ORDER BY id`,
  ).all<{ id: string; source_snapshot_id: string }>();
  const firstOwner = provenanceOwners.results[0];
  const differentOwner = provenanceOwners.results.find(
    (row) => row.source_snapshot_id !== firstOwner?.source_snapshot_id,
  );
  if (firstOwner === undefined || differentOwner === undefined) {
    throw new Error("Distinct provenance owners are absent");
  }
  const provenanceUpdate = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE legality_rules SET source_snapshot_id = ? WHERE id = ?`,
    ).bind(differentOwner.source_snapshot_id, canonicalSnapshot.id).run(),
  );
  const crossOwnedProvenance = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO legality_rules (
         id, official_id, supported_game, region, format, event_tier,
         effective_from, effective_until, official_wording, effect_json,
         card_ids_json, direct_card_ids_json, source_lineage, source_snapshot_id,
         source_observation_set_id, source_observation_id,
         source_observation_pointer, source_field_pointers_json,
         first_revision_id, last_observed_revision_id, current,
         last_missing_revision_id
       ) VALUES ('legality_rule_cross_owned', 'cross-owned', ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, 'srcobs_cross_owned',
         '/observations/0/value/legality_rules/0', ?, ?, ?, 1, NULL)`,
    ).bind(
      canonicalSnapshot.supported_game,
      canonicalSnapshot.region,
      canonicalSnapshot.format,
      canonicalSnapshot.event_tier,
      canonicalSnapshot.effective_from,
      canonicalSnapshot.effective_until,
      canonicalSnapshot.official_wording,
      canonicalSnapshot.effect_json,
      canonicalSnapshot.card_ids_json,
      canonicalSnapshot.direct_card_ids_json,
      canonicalSnapshot.source_lineage,
      firstOwner.source_snapshot_id,
      differentOwner.id,
      canonicalSnapshot.source_field_pointers_json,
      canonicalSnapshot.first_revision_id,
      canonicalSnapshot.last_observed_revision_id,
    ).run(),
  );
  expect([
    String(identityUpdate),
    String(firstRevisionUpdate),
    String(canonicalDelete),
    String(orphanRevisionRule),
    String(revisionUpdate),
    String(revisionDelete),
    String(inconsistentRevisionContext),
    String(inconsistentRevisionDocument),
    String(missingNullableDocumentKey),
    String(arbitraryDocumentKeySubstitution),
    String(duplicateRequiredDocumentKey),
    ...nestedCardIdMutations.map(String),
    String(provenanceUpdate),
    String(crossOwnedProvenance),
  ]).toEqual([
    expect.stringMatching(/legality_rule_identity_conflict/),
    expect.stringMatching(/legality_rule_identity_conflict/),
    expect.stringMatching(/legality_rule_immutable/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_immutable/),
    expect.stringMatching(/revision_legality_rule_immutable/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/revision_legality_rule_canonical_mismatch/),
    expect.stringMatching(/legality_rule_provenance_immutable/),
    expect.stringMatching(/legality_rule_provenance_owner_mismatch/),
  ]);
  const reappeared = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=current",
    "contextual-legality-domain-reappeared-provenance",
  );
  const reappearedCandidateRule = (
    reappeared.reconciled.legality_rules as Array<Record<string, unknown>>
  ).find((rule) => rule.official_id === "legality_rule_asia_eligible");
  if (reappearedCandidateRule === undefined) {
    throw new Error("Reappeared Legality Rule is absent");
  }
  const reappearedPublished = await approve(
    reappeared.reconciled,
    "publish-reappeared-provenance",
  );
  const reappearedRevisionId = requiredString(
    reappearedPublished.document,
    "resulting_revision_id",
  );
  const revisionRule = await revisionLegalityRule(
    reappearedRevisionId,
    "legality_rule_asia_eligible",
  );
  if (revisionRule === undefined) {
    throw new Error("Revision Legality Rule is absent");
  }
  expect(revisionRule).toMatchObject({
    current: true,
    last_missing_revision_id: expect.any(String),
  });
  const exportRule = await exportedLegalityRule(
    reappearedRevisionId,
    "legality_rule_asia_eligible",
  );
  const canonicalProvenance = {
    source_lineage: revisionRule.source_lineage,
    source_observation_id: revisionRule.source_observation_id,
    source_observation_pointer: revisionRule.source_observation_pointer,
    source_field_pointers: revisionRule.source_field_pointers,
  };
  const exportedProvenance = {
    source_lineage: exportRule.source_lineage,
    source_observation_id:
      (exportRule.source_observation_ids as unknown[])[0],
    source_observation_pointer: exportRule.source_observation_pointer,
    source_field_pointers: exportRule.source_field_pointers,
  };
  expect(reappearedCandidateRule.source_observation_id).not.toBe(
    revisionRule.source_observation_id,
  );
  expect(canonicalJson(exportedProvenance)).toBe(
    canonicalJson(canonicalProvenance),
  );
});

test.each([
  {
    boundary: "effective_from",
    rules: "current",
    reconciledAt: "2025-12-31T23:59:00.000Z",
    approvedAt: "2026-01-01T00:01:00.000Z",
  },
  {
    boundary: "effective_until",
    rules: "current",
    reconciledAt: "2025-05-31T23:59:00.000Z",
    approvedAt: "2025-06-01T00:01:00.000Z",
  },
  {
    boundary: "release_timing.legal_from",
    rules: "release-only",
    reconciledAt: "2025-12-31T23:59:00.000Z",
    approvedAt: "2026-01-01T00:01:00.000Z",
  },
])(
  "approval rejects a candidate after a Legality Rule $boundary boundary passes",
  async ({ boundary, rules, reconciledAt, approvedAt }) => {
    const runId = await collectFixtureLegalityEvidence(
      `https://official-source.invalid/reconciliation/contextual-legality-domain?rules=${rules}`,
      `legality-clock-${boundary}`,
    );
    const reconciled = await reconcile(runId, reconciledAt);
    expect(reconciled.response.status).toBe(200);
    const beforeApproval = await testEnv.CATALOGUE_DB.prepare(
      `SELECT state, candidate_digest, expected_current_revision_id,
              approval_json, approval_idempotency_key,
              published_revision_id, publication_outcome,
              resulting_revision_id
       FROM ingestion_runs WHERE id = ?`,
    ).bind(runId).first();
    const blocked = await approve(
      reconciled.document,
      `approve-legality-clock-${boundary}`,
      approvedAt,
    );
    expect(blocked.response.status).toBe(409);
    expect(blocked.document).toMatchObject({
      code: "candidate_legality_stale",
    });
    expect(await testEnv.CATALOGUE_DB.prepare(
      `SELECT state, candidate_digest, expected_current_revision_id,
              approval_json, approval_idempotency_key,
              published_revision_id, publication_outcome,
              resulting_revision_id
       FROM ingestion_runs WHERE id = ?`,
    ).bind(runId).first()).toEqual(beforeApproval);
    const retained = await request(
      `/v1/ingestion-runs/${runId}`,
      undefined,
      approvedAt,
    );
    expect(retained.document).toMatchObject({
      state: "awaiting_approval",
      expected_current_revision_id: requiredString(
        reconciled.document,
        "expected_current_revision_id",
      ),
    });
    const rejected = await request(
      `/v1/ingestion-runs/${runId}/rejection`,
      {
        candidate_digest: requiredString(
          reconciled.document,
          "candidate_digest",
        ),
        idempotency_key: `reject-legality-clock-${boundary}`,
      },
      approvedAt,
    );
    expect(rejected.response.status).toBe(200);
  },
);

test("approval rejects a partial candidate when a carried-forward game's Legality Rule crosses its boundary", async () => {
  const carriedRunId = await collectFixtureLegalityEvidence(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=release-only",
    "legality-clock-carried-game-seed",
  );
  const carried = await reconcile(
    carriedRunId,
    "2025-12-31T23:50:00.000Z",
  );
  expect(carried.response.status).toBe(200);
  expect((await approve(
    carried.document,
    "legality-clock-carried-game-seed-publish",
    "2025-12-31T23:55:00.000Z",
  )).response.status).toBe(200);

  const started = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "legality-clock-carried-game-partial",
    requests: [{
      id: "cards",
      method: "GET",
      url: "https://official-source.invalid/reconciliation/base",
      headers: { accept: "application/json" },
    }],
  });
  const runId = requiredString(started, "id");
  expect((await request(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    {},
  )).response.status).toBe(202);
  await waitForState(runId, "parsing");
  const partial = await reconcile(runId, "2025-12-31T23:59:00.000Z");
  expect(partial.response.status).toBe(200);
  expect(partial.document.legality_rules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        game: "gundam",
        effect: {
          type: "release_timing",
          legal_from: "2026-01-01",
        },
      }),
    ]),
  );
  const beforeApproval = await testEnv.CATALOGUE_DB.prepare(
    `SELECT state, candidate_digest, expected_current_revision_id,
            approval_json, approval_idempotency_key,
            published_revision_id, publication_outcome,
            resulting_revision_id
     FROM ingestion_runs WHERE id = ?`,
  ).bind(runId).first();

  const blocked = await approve(
    partial.document,
    "legality-clock-carried-game-blocked",
    "2026-01-01T00:01:00.000Z",
  );
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({ code: "candidate_legality_stale" });
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT state, candidate_digest, expected_current_revision_id,
            approval_json, approval_idempotency_key,
            published_revision_id, publication_outcome,
            resulting_revision_id
     FROM ingestion_runs WHERE id = ?`,
  ).bind(runId).first()).toEqual(beforeApproval);
  expect((await request(
    `/v1/ingestion-runs/${runId}`,
    undefined,
    "2026-01-01T00:01:00.000Z",
  )).document).toMatchObject({ state: "awaiting_approval" });
  expect((await request(
    `/v1/ingestion-runs/${runId}/rejection`,
    {
      candidate_digest: requiredString(
        partial.document,
        "candidate_digest",
      ),
      idempotency_key: "legality-clock-carried-game-rejected",
    },
    "2026-01-01T00:02:00.000Z",
  )).response.status).toBe(200);
});

test("approval rejects a missing-but-effective historical Legality Rule boundary", async () => {
  const initialRunId = await collectFixtureLegalityEvidence(
    "https://official-source.invalid/reconciliation/contextual-legality-domain",
    "legality-clock-missing-history-initial",
  );
  const initial = await reconcile(initialRunId, "2025-05-30T00:00:00.000Z");
  expect(initial.response.status).toBe(200);
  expect((await approve(
    initial.document,
    "legality-clock-missing-history-publish",
    "2025-05-30T00:01:00.000Z",
  )).response.status).toBe(200);
  const missingRunId = await collectFixtureLegalityEvidence(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=empty",
    "legality-clock-missing-history-candidate",
  );
  const missing = await reconcile(
    missingRunId,
    "2025-05-31T23:59:00.000Z",
  );
  expect(missing.response.status).toBe(200);
  expect((missing.document.legality_rules as Array<Record<string, unknown>>)
    .some((rule) =>
      rule.current === false && rule.effective_until === "2025-06-01"
    )).toBe(true);
  const blocked = await approve(
    missing.document,
    "legality-clock-missing-history-blocked",
    "2025-06-01T00:01:00.000Z",
  );
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({ code: "candidate_legality_stale" });
  const rejected = await request(
    `/v1/ingestion-runs/${missingRunId}/rejection`,
    {
      candidate_digest: requiredString(
        missing.document,
        "candidate_digest",
      ),
      idempotency_key: "reject-legality-clock-missing-history",
    },
    "2025-06-01T00:01:00.000Z",
  );
  expect(rejected.response.status).toBe(200);
});

test.each(["event-tier", "effective-until"])(
  "nullable legality field %s must be explicitly retained for exact provenance",
  async (field) => {
    const collected = await collectFixtureLegality(
      `https://official-source.invalid/reconciliation/contextual-legality-domain?rules=omit-${field}`,
      `contextual-legality-domain-omit-${field}`,
      409,
    );
    expect(collected.reconciled).toMatchObject({
      state: "failed",
      publishable: false,
      diagnostics: [
        expect.objectContaining({
          code: "retained_evidence_invalid",
          detail: expect.stringContaining(
            field === "event-tier" ? "event_tier" : "effective_until",
          ),
        }),
      ],
    });
  },
);

test.each(["missing", "false"])(
  "an observed fixture legality wrapper with %s completeness cannot carry prior rules across an unrelated card change",
  async (variant) => {
    const initial = await collectFixtureLegality(
      "https://official-source.invalid/reconciliation/contextual-legality-domain",
      `incomplete-legality-${variant}-initial`,
    );
    const published = await approve(
      initial.reconciled,
      `incomplete-legality-${variant}-publish-initial`,
    );
    expect(published.response.status).toBe(200);
    const currentBefore = await testEnv.CATALOGUE_DB.prepare(
      `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
    ).first();
    const freshnessBefore = (await testEnv.CATALOGUE_DB.prepare(
      `SELECT * FROM source_freshness ORDER BY game, area`,
    ).all()).results;
    const initialEvidence = await testEnv.CATALOGUE_DB.prepare(
      `SELECT observations.content_object_key
       FROM source_observation_sets AS observations
       JOIN source_snapshots AS snapshots
         ON snapshots.id = observations.source_snapshot_id
       WHERE snapshots.ingestion_run_id = ?`,
    ).bind(initial.runId).first<{ content_object_key: string }>();
    const initialObject = await testEnv.EVIDENCE_OBJECTS.get(
      initialEvidence?.content_object_key ?? "",
    );
    if (initialObject === null) throw new Error("Initial evidence is absent");
    const initialDocument = await initialObject.json<{
      observations: Array<{ value: Record<string, unknown> }>;
    }>();
    const retainedWrapper = initialDocument.observations.find(
      (observation) =>
        observation.value.observation_type === "legality_rules",
    )?.value;
    if (retainedWrapper === undefined) {
      throw new Error("Initial legality wrapper is absent");
    }

    const runId = await collectFixtureLegalityEvidence(
      "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=omitted",
      `incomplete-legality-${variant}-changed`,
    );
    const retained = await testEnv.CATALOGUE_DB.prepare(
      `SELECT observations.id, observations.parse_operation_id,
              observations.content_object_key
       FROM source_observation_sets AS observations
       JOIN source_snapshots AS snapshots
         ON snapshots.id = observations.source_snapshot_id
       WHERE snapshots.ingestion_run_id = ?`,
    ).bind(runId).first<{
      id: string;
      parse_operation_id: string;
      content_object_key: string;
    }>();
    if (retained === null) throw new Error("Changed evidence is absent");
    const changedObject = await testEnv.EVIDENCE_OBJECTS.get(
      retained.content_object_key,
    );
    if (changedObject === null) throw new Error("Changed bytes are absent");
    const changedDocument = await changedObject.json<{
      evidence_summary: Record<string, unknown>;
      observations: Array<{
        id: string;
        ordinal: number;
        value: Record<string, unknown>;
      }>;
    }>();
    const firstCard = changedDocument.observations[0]!.value.card as
      Record<string, unknown>;
    firstCard.name = `Unrelated changed card ${variant}`;
    const incompleteWrapper = structuredClone(retainedWrapper);
    if (variant === "missing") {
      delete incompleteWrapper.completeness;
    } else {
      incompleteWrapper.completeness = {
        ...(incompleteWrapper.completeness as Record<string, unknown>),
        structurally_complete: false,
      };
    }
    changedDocument.observations.push({
      id: `srcobs_${retained.id.slice(10)}_${changedDocument.observations.length + 1}`,
      ordinal: changedDocument.observations.length + 1,
      value: incompleteWrapper,
    });
    changedDocument.evidence_summary = {
      observation_count: changedDocument.observations.length,
      declared_record_count: changedDocument.observations.length,
      parsed_record_count: changedDocument.observations.length,
      required_surfaces_complete: true,
      partitions_complete: true,
      structurally_complete: true,
    };
    const bytes = utf8(canonicalJson(changedDocument));
    const digest = await sha256(bytes);
    await testEnv.EVIDENCE_OBJECTS.put(retained.content_object_key, bytes);
    await testEnv.CATALOGUE_DB.prepare(
      `DROP TRIGGER IF EXISTS source_observation_sets_are_immutable_on_update`,
    ).run();
    await testEnv.CATALOGUE_DB.batch([
      testEnv.CATALOGUE_DB.prepare(
        `UPDATE source_observation_sets
         SET content_digest = ?, content_byte_length = ?,
             observation_count = ?
         WHERE id = ?`,
      ).bind(digest, bytes.byteLength, changedDocument.observations.length, retained.id),
      testEnv.CATALOGUE_DB.prepare(
        `UPDATE source_parse_operations
         SET content_digest = ?, content_byte_length = ?,
             observation_count = ?
         WHERE id = ?`,
      ).bind(
        digest,
        bytes.byteLength,
        changedDocument.observations.length,
        retained.parse_operation_id,
      ),
    ]);
    await testEnv.CATALOGUE_DB.prepare(
      `CREATE TRIGGER source_observation_sets_are_immutable_on_update
       BEFORE UPDATE ON source_observation_sets
       BEGIN
         SELECT RAISE(ABORT, 'immutable_source_observation_set');
       END`,
    ).run();

    const blocked = await reconcile(runId);
    expect(blocked.response.status).toBe(409);
    expect(blocked.document).toMatchObject({
      state: "failed",
      publishable: false,
      diagnostics: [
        expect.objectContaining({
          code: "retained_evidence_invalid",
          detail: expect.stringContaining(
            "Legality Rule stream lacks explicit structurally complete coverage",
          ),
        }),
      ],
    });
    expect(await testEnv.CATALOGUE_DB.prepare(
      `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
    ).first()).toEqual(currentBefore);
    expect((await testEnv.CATALOGUE_DB.prepare(
      `SELECT * FROM source_freshness ORDER BY game, area`,
    ).all()).results).toEqual(freshnessBefore);
  },
);

test("resolved opaque Card identities are canonical before approval and publication", async () => {
  const directCardNumbers = ["GD30-001", "GD30-002"];
  const companionCardNumbers = ["GD30-003", "GD30-004"];
  const collected = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=resolved-card-order",
    "contextual-legality-resolved-card-order",
  );
  expect(collected.reconciled).toMatchObject({
    state: "awaiting_approval",
    publishable: true,
  });
  const cards = collected.reconciled.cards as Array<Record<string, unknown>>;
  const cardsByNumber = new Map(cards.map((card) => [
    requiredString(
      card.official_identity as Record<string, unknown>,
      "value",
    ),
    requiredString(card, "id"),
  ]));
  const cardIds = (cardNumbers: readonly string[]) =>
    cardNumbers.map((number) => {
      const id = cardsByNumber.get(number);
      if (id === undefined) throw new Error(`Card ${number} is absent`);
      return id;
    });
  const directIdsInNumberOrder = cardIds(directCardNumbers);
  const companionIdsInNumberOrder = cardIds(companionCardNumbers);
  const canonicalDirectIds = [...directIdsInNumberOrder].sort();
  const canonicalCompanionIds = [...companionIdsInNumberOrder].sort();
  const canonicalCardIds = [
    ...canonicalDirectIds,
    ...canonicalCompanionIds,
  ].sort();
  expect(directIdsInNumberOrder).not.toEqual(canonicalDirectIds);
  expect(companionIdsInNumberOrder).not.toEqual(canonicalCompanionIds);

  const candidateRule = (
    collected.reconciled.legality_rules as Array<Record<string, unknown>>
  ).find((rule) =>
    rule.official_id === "legality_rule_asia_resolved_card_order"
  );
  expect(candidateRule).toBeDefined();
  expect(candidateRule!.card_ids).toEqual(canonicalDirectIds);
  expect(candidateRule!.effect).toEqual({
    type: "prohibited_combination",
    with_card_ids: canonicalCompanionIds,
  });

  const published = await approve(
    collected.reconciled,
    "publish-resolved-card-order",
  );
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const revisionRule = await revisionLegalityRule(
    revisionId,
    "legality_rule_asia_resolved_card_order",
  );
  expect(revisionRule?.card_ids).toEqual(canonicalDirectIds);
  expect(revisionRule?.effect).toEqual({
    type: "prohibited_combination",
    with_card_ids: canonicalCompanionIds,
  });
  const canonicalRule = await testEnv.CATALOGUE_DB.prepare(
    `SELECT direct_card_ids_json, card_ids_json, effect_json
     FROM legality_rules
     WHERE official_id = ?`,
  ).bind("legality_rule_asia_resolved_card_order")
    .first<{
      direct_card_ids_json: string;
      card_ids_json: string;
      effect_json: string;
    }>();
  expect(canonicalRule).not.toBeNull();
  expect(JSON.parse(canonicalRule!.direct_card_ids_json)).toEqual(
    canonicalDirectIds,
  );
  expect(JSON.parse(canonicalRule!.card_ids_json)).toEqual(
    canonicalCardIds,
  );
  expect(JSON.parse(canonicalRule!.effect_json)).toEqual({
    type: "prohibited_combination",
    with_card_ids: canonicalCompanionIds,
  });
  const exportedRule = await exportedLegalityRule(
    revisionId,
    "legality_rule_asia_resolved_card_order",
  );
  expect(exportedRule.card_ids).toEqual(canonicalCardIds);
  expect(exportedRule.effect).toEqual({
    type: "prohibited_combination",
    with_card_ids: canonicalCompanionIds,
  });
});

test("overlapping prohibited-combination operands fail before a candidate can be approved or published", async () => {
  const currentBefore = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
  ).first();
  const revisionsBefore = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM catalogue_revisions`,
  ).first();
  const rulesBefore = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM legality_rules`,
  ).first();
  const objectsBefore = (await testEnv.CATALOGUE_EXPORTS.list()).objects
    .map((object) => object.key).sort();

  const blocked = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=operand-overlap",
    "contextual-legality-operand-overlap",
    409,
  );
  expect(blocked.reconciled).toMatchObject({
    state: "failed",
    publishable: false,
    diagnostics: [
      expect.objectContaining({
        code: "retained_evidence_invalid",
        detail:
          "Legality Rule legality_rule_asia_operand_overlap assigns Card card_83d4134414dab2492b3a209cd1758dd1 to both direct and prohibited-combination operands.",
      }),
    ],
  });
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
  ).first()).toEqual(currentBefore);
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM catalogue_revisions`,
  ).first()).toEqual(revisionsBefore);
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM legality_rules`,
  ).first()).toEqual(rulesBefore);
  expect((await testEnv.CATALOGUE_EXPORTS.list()).objects
    .map((object) => object.key).sort()).toEqual(objectsBefore);
});

