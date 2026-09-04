import { insertLegalityRules } from "./query-helpers/source-evidence";
import { guardRevisionLegalityRulesStatement } from "../../../src/catalogue/legality/legality-guard-repository";
import {
  storedLegalityProjection,
  storedLegalityEvidence,
  storedLegalityApplicability,
  insertLegalityProjectionWithoutRetrievedAt,
} from "./query-helpers/legality-guards";
import {
  canonicalLegalityCardIdInvariantErrors,
  canonicalLegalityEffectInvariantErrors,
  canonicalLegalityScopeInvariantErrors,
} from "./contextual-legality-helpers";
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  publishLegalityRuleFactsStatement,
  publishRevisionLegalityRulesStatement,
} from "../../../src/catalogue/legality/legality-publication-repository";
import { seedApiRevision, legalitySourceStatements } from "../../api/test/api-fixtures";
import { disableLegalityPublicationTriggers, storedLegalityRule } from "./query-helpers/legality-guards";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const database = catalogueStore(testEnv.CATALOGUE_DB);
const revisionId = "catrev_legality_repository_guards";

beforeAll(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  await seedApiRevision({ revisionId, runId: "run_legality_repository_guards", cards: [] });
  await testEnv.CATALOGUE_DB.batch(
    legalitySourceStatements({
      runId: "run_legality_repository_guards",
      key: "legality_repository_guards",
      game: "one-piece",
      profile: "one-piece@1",
      lineage: "one-piece-en",
      adapter: "fixture-one-piece-json@3",
      snapshotId: "srcsnap_legality_repository_guards",
      observationSetId: "srcobsset_legality_repository_guards",
    }),
  );
  await disableLegalityPublicationTriggers(testEnv.CATALOGUE_DB);
});

test("a malformed Legality Rule effect aborts every row in its publication batch without triggers", async () => {
  const valid = rule("rollback-control");
  const invalid = { ...rule("invalid-effect"), effect_json: JSON.stringify({ type: "copy_limit", maximum_copies: 0 }) };
  await expect(
    database.batch([publishLegalityRuleFactsStatement(database, JSON.stringify([valid, invalid]))]),
  ).rejects.toThrow("legality_rule_effect_invalid");
  await expect(storedLegalityRule(testEnv.CATALOGUE_DB).bind(valid.id).first()).resolves.toBeNull();
  await expect(storedLegalityRule(testEnv.CATALOGUE_DB).bind(invalid.id).first()).resolves.toBeNull();
});

function rule(suffix: string) {
  return {
    id: `legality_rule_${suffix}`,
    official_id: suffix,
    game: "one-piece",
    region: "EN-OCEANIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    official_wording: "An official eligibility rule.",
    unresolved_scope_json: "null",
    effect_json: JSON.stringify({ type: "eligible" }),
    card_ids_json: "[]",
    direct_card_ids_json: "[]",
    source_lineage: "one-piece-en",
    source_snapshot_id: "srcsnap_legality_repository_guards",
    source_observation_set_id: "srcobsset_legality_repository_guards",
    source_observation_id: `srcobs_${suffix}`,
    source_observation_pointer: "/observations/0",
    source_field_pointers_json: JSON.stringify({ official_wording: "/observations/0/official_wording" }),
    first_revision_id: revisionId,
    last_observed_revision_id: revisionId,
    current: 1,
    last_missing_revision_id: null,
  };
}

test("canonical Card IDs, effect families, and unresolved scope retain their complete rejection matrices", async () => {
  const canonical = rule("matrix-source");
  const cardIds = await canonicalLegalityCardIdInvariantErrors(testEnv.CATALOGUE_DB, canonical, "repository-card-ids");
  expect(cardIds).toHaveLength(13);
  expect(cardIds.map(String)).toEqual(
    cardIds.map(() => expect.stringContaining("legality_rule_card_ids_not_canonical")),
  );
  const effects = await canonicalLegalityEffectInvariantErrors(testEnv.CATALOGUE_DB, canonical, "repository-effects");
  expect(effects).toHaveLength(9);
  expect(effects.map(String)).toEqual(effects.map(() => expect.stringContaining("legality_rule_effect_invalid")));
  const scopes = await canonicalLegalityScopeInvariantErrors(testEnv.CATALOGUE_DB, canonical, "repository-scopes");
  expect(scopes).toHaveLength(6);
  expect(scopes.map(String)).toEqual(scopes.map(() => expect.stringContaining("legality_rule_scope_invalid")));
});

test.each(["game", "source_lineage", "source_snapshot_id", "source_observation_set_id"])(
  "Legality Rule source ownership rejects a mismatched %s even for an existing canonical ID",
  async (field) => {
    const canonical = rule(`owner-${field}`);
    await publishLegalityRuleFactsStatement(database, JSON.stringify([canonical])).run();
    const invalid = { ...canonical, [field]: field === "game" ? "gundam" : "mismatched-owner" };
    await expect(publishLegalityRuleFactsStatement(database, JSON.stringify([invalid])).run()).rejects.toThrow(
      "legality_rule_provenance_owner_mismatch",
    );
    await expect(storedLegalityRule(testEnv.CATALOGUE_DB).bind(canonical.id).first()).resolves.toMatchObject({
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      source_snapshot_id: canonical.source_snapshot_id,
      source_observation_set_id: canonical.source_observation_set_id,
    });
  },
);

test("empty legality publication payloads remain valid atomic no-ops", async () => {
  await expect(
    database.batch([
      publishLegalityRuleFactsStatement(database, "[]"),
      publishRevisionLegalityRulesStatement(database, { revisionId, payload: "[]" }),
    ]),
  ).resolves.toHaveLength(2);
});

test.each([
  {
    name: "effect",
    marker: "revision_legality_rule_canonical_mismatch",
    mutate: (document: Record<string, unknown>) => {
      document.effect = { type: "copy_limit", maximum_copies: 0 };
    },
  },
  {
    name: "scope",
    marker: "revision_legality_rule_scope_invalid",
    mutate: (document: Record<string, unknown>) => {
      document.unresolved_scope = { dimensions: ["target_scope"] };
    },
  },
  {
    name: "extra-field",
    marker: "revision_legality_rule_canonical_mismatch",
    mutate: (document: Record<string, unknown>) => {
      document.attacker = true;
    },
  },
  {
    name: "missing-nullable",
    marker: "revision_legality_rule_canonical_mismatch",
    mutate: (document: Record<string, unknown>) => {
      delete document.event_tier;
    },
  },
  {
    name: "wrong-format",
    marker: "revision_legality_rule_canonical_mismatch",
    mutate: (document: Record<string, unknown>) => {
      document.format = "another-format";
    },
  },
])("invalid projected $name rolls back canonical facts and retained evidence", async ({ name, marker, mutate }) => {
  const canonical = rule(`projected-${name}`);
  const document = ruleDocument(canonical);
  mutate(document);
  await expect(
    database.batch([
      publishLegalityRuleFactsStatement(database, JSON.stringify([canonical])),
      publishRevisionLegalityRulesStatement(database, {
        revisionId,
        payload: JSON.stringify([{ id: canonical.id, document_json: JSON.stringify(document) }]),
      }),
    ]),
  ).rejects.toThrow(marker);
  await expect(storedLegalityRule(testEnv.CATALOGUE_DB).bind(canonical.id).first()).resolves.toBeNull();
  await expect(
    storedLegalityProjection(testEnv.CATALOGUE_DB).bind(revisionId, canonical.id).first(),
  ).resolves.toBeNull();
  await expect(
    storedLegalityEvidence(testEnv.CATALOGUE_DB).bind(canonical.source_observation_id).first(),
  ).resolves.toBeNull();
});

test("a missing projected capture instant rejects and rolls back the entire guarded repository batch", async () => {
  const canonical = rule("missing-capture");
  const control = rule("missing-capture-control");
  await publishLegalityRuleFactsStatement(database, JSON.stringify([canonical])).run();
  await expect(
    database.batch([
      publishLegalityRuleFactsStatement(database, JSON.stringify([control])),
      insertLegalityProjectionWithoutRetrievedAt(testEnv.CATALOGUE_DB).bind(
        revisionId,
        JSON.stringify(ruleDocument(canonical)),
        canonical.id,
      ),
      guardRevisionLegalityRulesStatement(database, { revisionId, payload: JSON.stringify([{ id: canonical.id }]) }),
    ]),
  ).rejects.toThrow("revision_legality_rule_source_retrieved_at_missing");
  await expect(storedLegalityRule(testEnv.CATALOGUE_DB).bind(control.id).first()).resolves.toBeNull();
  await expect(
    storedLegalityProjection(testEnv.CATALOGUE_DB).bind(revisionId, canonical.id).first(),
  ).resolves.toBeNull();
});

test.each([
  {
    name: "all",
    direct: [],
    all: [],
    effect: { type: "eligible" },
    scope: null,
    expected: [{ applicability_kind: "all_cards", card_id: "" }],
  },
  {
    name: "card",
    direct: ["card_a"],
    all: ["card_a"],
    effect: { type: "eligible" },
    scope: null,
    expected: [{ applicability_kind: "card", card_id: "card_a" }],
  },
  {
    name: "combination",
    direct: ["card_a"],
    all: ["card_a", "card_b"],
    effect: { type: "prohibited_combination", with_card_ids: ["card_b"] },
    scope: null,
    expected: [
      { applicability_kind: "card", card_id: "card_a" },
      { applicability_kind: "card", card_id: "card_b" },
    ],
  },
  {
    name: "open",
    direct: ["card_a"],
    all: ["card_a"],
    effect: { type: "unresolved", reason: "The publisher has an open target predicate." },
    scope: { dimensions: ["target_scope"] },
    expected: [
      { applicability_kind: "all_cards", card_id: "" },
      { applicability_kind: "card", card_id: "card_a" },
    ],
  },
])(
  "publication retains evidence and materializes $name applicability without triggers",
  async ({ name, direct, all, effect, scope, expected }) => {
    const canonical = {
      ...rule(`applicability-${name}`),
      direct_card_ids_json: JSON.stringify(direct),
      card_ids_json: JSON.stringify(all),
      effect_json: JSON.stringify(effect),
      unresolved_scope_json: JSON.stringify(scope),
    };
    const results = await database.batch([
      publishLegalityRuleFactsStatement(database, JSON.stringify([canonical])),
      publishRevisionLegalityRulesStatement(database, {
        revisionId,
        payload: JSON.stringify([{ id: canonical.id, document_json: JSON.stringify(ruleDocument(canonical)) }]),
      }),
    ]);
    expect(results).toHaveLength(2);
    expect(results.map(({ meta }) => meta.changes)).toEqual([1, 1]);
    await expect(
      storedLegalityEvidence(testEnv.CATALOGUE_DB).bind(canonical.source_observation_id).first(),
    ).resolves.toEqual({
      source_observation_id: canonical.source_observation_id,
      retained_by_table: "legality_rules",
      retained_record_id: canonical.id,
    });
    expect(
      (await storedLegalityApplicability(testEnv.CATALOGUE_DB).bind(revisionId, canonical.id).all()).results,
    ).toEqual(expected);
  },
);

function ruleDocument(canonical: ReturnType<typeof rule>): Record<string, unknown> {
  return {
    id: canonical.id,
    official_id: canonical.official_id,
    game: canonical.game,
    region: canonical.region,
    format: canonical.format,
    event_tier: canonical.event_tier,
    effective_from: canonical.effective_from,
    effective_until: canonical.effective_until,
    unresolved_scope: JSON.parse(canonical.unresolved_scope_json),
    card_ids: JSON.parse(canonical.direct_card_ids_json),
    official_wording: canonical.official_wording,
    effect: JSON.parse(canonical.effect_json),
    source_lineage: canonical.source_lineage,
    source_snapshot_id: canonical.source_snapshot_id,
    source_observation_set_id: canonical.source_observation_set_id,
    source_observation_id: canonical.source_observation_id,
    source_observation_pointer: canonical.source_observation_pointer,
    source_field_pointers: JSON.parse(canonical.source_field_pointers_json),
    first_revision_id: canonical.first_revision_id,
    last_observed_revision_id: canonical.last_observed_revision_id,
    current: canonical.current === 1,
    last_missing_revision_id: canonical.last_missing_revision_id,
  };
}

test("NULL legacy predicates remain no-ops for incomplete internal payloads", async () => {
  // The former SQLite WHEN predicates evaluate to NULL for this one-key
  // unknown effect. Public/domain validation rejects it before repository use;
  // this regression keeps the trigger-to-repository move behavior-preserving.
  const canonical = { ...rule("null-predicate"), effect_json: '{"unexpected":true}' };
  await expect(publishLegalityRuleFactsStatement(database, JSON.stringify([canonical])).run()).resolves.toBeDefined();
});

test("a corrupt canonical effect cannot be projected and rolls back sibling facts", async () => {
  const canonical = { ...rule("corrupt-effect"), effect_json: '{"type":"copy_limit","maximum_copies":0}' };
  await insertLegalityRules(testEnv.CATALOGUE_DB)
    .bind(
      canonical.id,
      canonical.official_id,
      canonical.game,
      canonical.region,
      canonical.format,
      canonical.event_tier,
      canonical.effective_from,
      canonical.effective_until,
      canonical.unresolved_scope_json,
      canonical.official_wording,
      canonical.effect_json,
      canonical.card_ids_json,
      canonical.direct_card_ids_json,
      canonical.source_lineage,
      canonical.source_snapshot_id,
      canonical.source_observation_set_id,
      canonical.source_observation_id,
      canonical.source_observation_pointer,
      canonical.source_field_pointers_json,
      canonical.first_revision_id,
      canonical.last_observed_revision_id,
    )
    .run();
  const control = rule("corrupt-effect-control");
  await expect(
    database.batch([
      publishLegalityRuleFactsStatement(database, JSON.stringify([control])),
      publishRevisionLegalityRulesStatement(database, {
        revisionId,
        payload: JSON.stringify([{ id: canonical.id, document_json: JSON.stringify(ruleDocument(canonical)) }]),
      }),
    ]),
  ).rejects.toThrow("revision_legality_rule_effect_invalid");
  expect(await storedLegalityRule(testEnv.CATALOGUE_DB).bind(control.id).first()).toBeNull();
  expect(await storedLegalityProjection(testEnv.CATALOGUE_DB).bind(revisionId, canonical.id).first()).toBeNull();
});
