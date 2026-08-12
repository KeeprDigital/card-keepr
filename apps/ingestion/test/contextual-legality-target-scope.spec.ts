import { expect, test } from "vitest";
import {
  approve,
  collectFixtureLegality,
  exportedLegalityRule,
  installContextualLegalitySuite,
  rejectedError,
  requiredString,
  revisionLegalityRule,
  testEnv,
} from "./contextual-legality-helpers";

installContextualLegalitySuite();

test("an open-predicate rule publishes with explicit target-scope uncertainty and all-cards applicability", async () => {
  const collected = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=open-predicate",
    "contextual-legality-target-scope",
  );
  expect(collected.reconciled).toMatchObject({
    state: "awaiting_approval",
    publishable: true,
    legality_rules: expect.arrayContaining([
      expect.objectContaining({
        official_id: "legality_rule_asia_open_predicate",
        effective_from: null,
        effective_until: null,
        unresolved_scope: {
          dimensions: ["effective_interval", "target_scope"],
        },
        effect: expect.objectContaining({ type: "unresolved" }),
      }),
    ]),
  });
  const published = await approve(
    collected.reconciled,
    "publish-target-scope-rule",
  );
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );

  const rule = await revisionLegalityRule(
    revisionId,
    "legality_rule_asia_open_predicate",
  );
  expect(rule).toMatchObject({
    region: "EN-ASIA",
    format: "standard",
    effective_from: null,
    unresolved_scope: { dimensions: ["effective_interval", "target_scope"] },
    effect: expect.objectContaining({ type: "unresolved" }),
    current: true,
  });
  expect(rule!.card_ids).toHaveLength(2);

  // Publication materializes the enumerated Card rows plus one explicit
  // all_cards row so every contextual status query in the rule's game,
  // region, and format retains the uncertainty.
  const applicability = await testEnv.CATALOGUE_DB.prepare(
    `SELECT applicability_kind, card_id
     FROM revision_legality_rule_applicability
     WHERE catalogue_revision_id = ? AND legality_rule_id = ?
     ORDER BY applicability_kind, card_id`,
  ).bind(revisionId, requiredString(rule!, "id")).all<{
    applicability_kind: string;
    card_id: string;
  }>();
  expect(applicability.results.map(({ applicability_kind }) =>
    applicability_kind
  )).toEqual(["all_cards", "card", "card"]);
  expect(applicability.results[0]).toEqual({
    applicability_kind: "all_cards",
    card_id: "",
  });

  // A rule without the target_scope dimension keeps its Card-only rows.
  const intervalRule = await revisionLegalityRule(
    revisionId,
    "legality_rule_asia_unresolved_scope",
  );
  const intervalApplicability = await testEnv.CATALOGUE_DB.prepare(
    `SELECT applicability_kind
     FROM revision_legality_rule_applicability
     WHERE catalogue_revision_id = ? AND legality_rule_id = ?`,
  ).bind(revisionId, requiredString(intervalRule!, "id")).all<{
    applicability_kind: string;
  }>();
  expect(intervalApplicability.results).toEqual([
    { applicability_kind: "card" },
  ]);

  // The schema-major-5 export retains the complete unresolved scope.
  const exported = await exportedLegalityRule(
    revisionId,
    "legality_rule_asia_open_predicate",
  );
  expect(exported).toMatchObject({
    kind: "indeterminate",
    effective_from: null,
    unresolved_scope: { dimensions: ["effective_interval", "target_scope"] },
    effect: expect.objectContaining({ type: "unresolved" }),
  });

  // The vocabulary stays fail-closed outside its exact contract: the same
  // retained provenance accepts a well-formed target-scope rule and rejects
  // every malformed variant at the canonical D1 boundary.
  const base = {
    supported_game: "gundam",
    region: "EN-ASIA",
    format: "standard",
    event_tier: null,
    official_wording: "Malformed target-scope variant.",
    source_lineage: "gundam-en-asia",
    source_snapshot_id: requiredString(rule!, "source_snapshot_id"),
    source_observation_set_id: requiredString(
      rule!,
      "source_observation_set_id",
    ),
    source_observation_id: requiredString(rule!, "source_observation_id"),
  };
  const insertScopedRule = (
    id: string,
    variant: {
      scope: unknown;
      effect: unknown;
      effectiveFrom: string | null;
      cardIds: readonly string[];
    },
  ) =>
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO legality_rules (
         id, official_id, supported_game, region, format, event_tier,
         effective_from, effective_until, unresolved_scope_json,
         official_wording, effect_json,
         card_ids_json, direct_card_ids_json, source_lineage,
         source_snapshot_id, source_observation_set_id,
         source_observation_id, source_observation_pointer,
         source_field_pointers_json, first_revision_id,
         last_observed_revision_id, current, last_missing_revision_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, 1, NULL)`,
    ).bind(
      id,
      id,
      base.supported_game,
      base.region,
      base.format,
      base.event_tier,
      variant.effectiveFrom,
      JSON.stringify(variant.scope),
      base.official_wording,
      JSON.stringify(variant.effect),
      JSON.stringify(variant.cardIds),
      JSON.stringify(variant.cardIds),
      base.source_lineage,
      base.source_snapshot_id,
      base.source_observation_set_id,
      base.source_observation_id,
      "/observations/0/value/legality_rules/0",
      JSON.stringify({}),
      revisionId,
      revisionId,
    ).run();

  // Control: a canonical target-scope rule with the same provenance inserts.
  await insertScopedRule("legality_rule_target_scope_control", {
    scope: { dimensions: ["target_scope"] },
    effect: { type: "unresolved", reason: "Control variant." },
    effectiveFrom: "2026-01-01",
    cardIds: ["card_scope_direct"],
  });

  const malformed = [
    {
      // target_scope requires the unresolved effect.
      scope: { dimensions: ["target_scope"] },
      effect: { type: "eligible" },
      effectiveFrom: "2026-01-01",
      cardIds: ["card_scope_direct"],
    },
    {
      // Unknown dimensions stay rejected.
      scope: { dimensions: ["card_pool"] },
      effect: { type: "unresolved", reason: "Unknown dimension." },
      effectiveFrom: "2026-01-01",
      cardIds: ["card_scope_direct"],
    },
    {
      // Dimensions must stay canonically ordered.
      scope: { dimensions: ["target_scope", "effective_interval"] },
      effect: { type: "unresolved", reason: "Unsorted dimensions." },
      effectiveFrom: null,
      cardIds: ["card_scope_direct"],
    },
    {
      // An unresolved effective interval still forbids explicit dates.
      scope: { dimensions: ["effective_interval", "target_scope"] },
      effect: { type: "unresolved", reason: "Invented date." },
      effectiveFrom: "2026-01-01",
      cardIds: ["card_scope_direct"],
    },
    {
      // A target-scope rule still requires enumerated Cards.
      scope: { dimensions: ["target_scope"] },
      effect: { type: "unresolved", reason: "No enumerated matches." },
      effectiveFrom: "2026-01-01",
      cardIds: [],
    },
  ] as const;
  const errors = await Promise.all(malformed.map((variant, index) =>
    rejectedError(insertScopedRule(
      `legality_rule_target_scope_malformed_${index}`,
      variant,
    ))
  ));
  for (const error of errors) {
    expect(String(error)).toMatch(/legality_rule_scope_invalid/u);
  }
}, 60_000);
