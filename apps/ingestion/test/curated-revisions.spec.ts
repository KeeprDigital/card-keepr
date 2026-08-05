import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { canonicalJson, sha256Text } from "../../../src/catalogue/serialization";
import type { CatalogueCard } from "../../../src/catalogue/catalogue-candidate";
import { buildCatalogueExport } from "../../../src/catalogue/export";
import {
  applyPinnedCuratedRevisions,
  createCuratedRevision,
  pinCuratedRevisionsForRun,
  prepareCuratedRevisionRunStart,
  reaffirmCuratedRevision,
  retireCuratedRevision,
  showCuratedRevision,
  stripCuratedRevisionEffects,
  supersedeCuratedRevision,
} from "../../../src/catalogue/curated-revisions";

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
  const previousRevision = await env.CATALOGUE_DB.prepare(
    "SELECT current_revision_id FROM catalogue_state WHERE singleton = 1",
  ).first<{ current_revision_id: string }>();
  currentRevision = `catrev_curated_seed_${sequence}`;
  const runId = `run_curated_seed_${sequence}`;
  card = { ...card, id: `card_op01_001_${sequence}` };
  const candidate = {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [card],
    printings: [{
      id: `printing_${sequence}`,
      card_id: card.id,
      rarity: { normalized: "common", raw: "C" },
      printed_rules_text: null,
      game_data: null,
    }],
    products: [{
      id: `product_${sequence}`,
      reference: { kind: "official_code", value: "OP-01" },
      game: "one-piece",
      official_code: "OP-01",
      name: "Booster",
      releases: [{
        id: `release_${sequence}`,
        event_key: `event_${sequence}`,
        product_id: `product_${sequence}`,
        region: "EN-OCEANIA",
        date: { precision: "day", value: "2026-08-05" },
        status: "announced",
      }],
      observed: true,
      withdrawal: null,
      included: [],
      provenance: {},
      disagreements: [],
    }],
    product_relationships: [{
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
    }],
    legality_rules: [{
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
      source_lineage: "one-piece-legality",
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
    }],
  };
  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL, active_release_id = NULL, active_release_expires_at = NULL, recovery_health = 'healthy' WHERE singleton = 1",
  ).run();
  await env.CATALOGUE_DB.prepare(
    "UPDATE curated_revisions SET status = 'retired', event_version = event_version + 1 WHERE status IN ('active', 'reconfirmation_required')",
  ).run();
  await env.CATALOGUE_DB.batch([
    env.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, idempotency_key, candidate_digest,
        candidate_catalogue_digest, candidate_created_at, approval_deadline,
        candidate_json, approval_json, progress_json, warnings_json, approval_history_json
      ) VALUES (
        ?, 'publishing', '["one-piece"]', ?,
        ?, ?, 'seed-digest', 'seed-digest', ?,
        '2099-01-01T00:00:00.000Z', ?,
        ?,
        '{"completed_stages":[],"current_stage":"publishing"}', '[]', '[]'
      )`,
    ).bind(runId, now, previousRevision!.current_revision_id,
      `curated-seed-${sequence}`, now, canonicalJson(candidate),
      canonicalJson({ candidate_digest: "seed-digest", expected_current_revision_id: previousRevision!.current_revision_id })),
    env.CATALOGUE_DB.prepare(
      "UPDATE operation_state SET active_ingestion_run_id = ? WHERE singleton = 1",
    ).bind(runId),
    env.CATALOGUE_DB.prepare(
      `INSERT INTO catalogue_revisions (
        id, ingestion_run_id, published_at, content_digest,
        expected_previous_revision_id, approved_candidate_digest
      ) VALUES (?, ?, ?, 'seed-digest', ?, 'seed-digest')`,
    ).bind(currentRevision, runId, now, previousRevision!.current_revision_id),
    env.CATALOGUE_DB.prepare(
      "UPDATE catalogue_state SET current_revision_id = ?, published_at = ? WHERE singleton = 1",
    ).bind(currentRevision, now),
    env.CATALOGUE_DB.prepare(
      `INSERT INTO revision_cards (catalogue_revision_id, card_id, document_json)
       VALUES (?, ?, ?)`,
    ).bind(currentRevision, card.id, canonicalJson(card)),
    env.CATALOGUE_DB.prepare(
      `INSERT INTO revision_printings (catalogue_revision_id, printing_id, card_id, document_json)
       VALUES (?, ?, ?, ?)`,
    ).bind(currentRevision, `printing_${sequence}`, card.id, canonicalJson(candidate.printings[0])),
    env.CATALOGUE_DB.prepare(
      "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
    ),
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

  const protectedField = await adminRequest(
    "/admin/v1/curated-revisions/validate",
    {
      proposal: await proposal("/official_identity/value", "OP99-999"),
      catalogue_revision_id: currentRevision,
    },
  );
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
  const malformedOwnerReference = await adminRequest(
    "/admin/v1/curated-revisions/validate",
    {
      proposal: {
        ...malformedEvidence,
        evidence: [{
          kind: "owner_reference",
          uri: "not an absolute URI",
          content_digest: "a".repeat(64),
        }],
      },
      catalogue_revision_id: currentRevision,
    },
  );
  expect(malformedOwnerReference.status).toBe(422);
  await expect(malformedOwnerReference.json()).resolves.toMatchObject({
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

  const ownerReference = await adminRequest(
    "/admin/v1/curated-revisions/validate",
    { proposal: complete, catalogue_revision_id: currentRevision },
  );
  expect(ownerReference.status).toBe(200);
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

  await env.CATALOGUE_DB.prepare(
    `UPDATE revision_printings SET document_json = json_set(
       document_json, '$.game_data', json('{"profile":"one-piece@1","attributes":{}}')
     ) WHERE catalogue_revision_id = ? AND printing_id = ?`,
  ).bind(currentRevision, `printing_${sequence}`).run();
  const optionalProposal = {
    ...(await proposal("/name", "unused")),
    target: {
      kind: "field",
      entity_type: "printing",
      entity_id: `printing_${sequence}`,
      path: "/game_data/attributes/illustration_types",
    },
    assertion: { kind: "field", value: [] },
    reviewed_source_digest: await sha256Text(canonicalJson(null)),
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
  const invalidNullControl = await adminRequest(
    "/admin/v1/curated-revisions/validate",
    {
      proposal: invalidEffectiveFrom,
      catalogue_revision_id: currentRevision,
    },
  );
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
    evidence: [{
      kind: "owner_reference",
      uri: "https://owner.example/review/closed-endpoint",
      content_digest: "e".repeat(64),
    }],
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
  const mutation = await created.json() as Record<string, unknown>;
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

  const listed = await adminRequest(
    "/admin/v1/curated-revisions?game=one-piece&status=active",
  );
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
  await expect(env.CATALOGUE_DB.prepare(
    "UPDATE curated_revision_idempotency SET response_status = 202 WHERE idempotency_key = ?",
  ).bind(input.idempotency_key).run()).rejects.toThrow(
    "curated_revision_idempotency_immutable",
  );
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO catalogue_curated_provenance (
       catalogue_revision_id, curated_revision_id, target_key,
       content_digest, provenance_json
     ) VALUES (?, ?, 'target', ?, '{}')`,
  ).bind(
    currentRevision,
    mutation.curated_revision_id,
    mutation.content_digest,
  ).run();
  await expect(env.CATALOGUE_DB.prepare(
    "DELETE FROM catalogue_curated_provenance WHERE catalogue_revision_id = ? AND curated_revision_id = ?",
  ).bind(currentRevision, mutation.curated_revision_id).run()).rejects.toThrow(
    "catalogue_curated_provenance_immutable",
  );
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
  const wrongEnvironment = await adminRequest(
    "/admin/v1/curated-revisions",
    base,
  );
  expect(wrongEnvironment.status).toBe(422);
  await expect(wrongEnvironment.json()).resolves.toMatchObject({
    code: "production_target_required",
  });

  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'blocked' WHERE singleton = 1",
  ).run();
  const blocked = await adminRequest("/admin/v1/curated-revisions", {
    ...base,
    environment: "production",
    idempotency_key: "guard-2",
  });
  expect(blocked.status).toBe(409);
  await expect(blocked.json()).resolves.toMatchObject({
    code: "recovery_in_progress",
  });

  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'healthy', active_release_id = 'release_active', active_release_expires_at = '2099-01-01T00:00:00.000Z' WHERE singleton = 1",
  ).run();
  const releaseBlocked = await adminRequest("/admin/v1/curated-revisions", {
    ...base,
    environment: "production",
    idempotency_key: "guard-3",
  });
  expect(releaseBlocked.status).toBe(409);
  await expect(releaseBlocked.json()).resolves.toMatchObject({
    code: "release_not_idle",
  });
  await expect(insertParsingRun(
    `run_release_blocked_${sequence}`,
  )).rejects.toThrow("active_ingestion_run_or_release");
});

test("the atomic mutation boundary rechecks the current Catalogue Revision", async () => {
  const authored = await proposal("/name", "Curated Name");
  await expect(env.CATALOGUE_DB.prepare(
    `INSERT INTO curated_revisions (
       id, game, target_key, target_kind, proposal_json, content_digest,
       reviewed_source_digest, schema_binding_json, author, created_at,
       status, event_version
     ) VALUES ('currev_stale_atomic', 'one-piece', 'stale-target', 'field',
       ?, ?, ?, ?, 'owner', ?, 'active', 1)`,
  ).bind(
    canonicalJson(authored),
    await sha256Text(canonicalJson(authored)),
    authored.reviewed_source_digest,
    canonicalJson({ catalogue_revision_id: "catrev_stale", game_profile: "one-piece@1" }),
    now,
  ).run()).rejects.toThrow("curated_revision_current_revision_mismatch");

  const created = await createCuratedRevision(env.CATALOGUE_DB, {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: authored,
    proposal_digest: await sha256Text(canonicalJson(authored)),
    idempotency_key: `atomic-current-${sequence}`,
  }, now);
  await expect(env.CATALOGUE_DB.prepare(
    `INSERT INTO curated_revision_events (
       revision_id, event_version, kind, event_json, created_at, author
     ) VALUES (?, 2, 'retired', ?, ?, 'owner')`,
  ).bind(
    created.document.curated_revision_id,
    canonicalJson({ expected_current_revision_id: "catrev_stale" }),
    now,
  ).run()).rejects.toThrow("curated_revision_current_revision_mismatch");
});

test("release leases reclaim stale owners and fence cleanup and renewal", async () => {
  const insertBootstrap = async (id: string) => env.CATALOGUE_DB.prepare(
    `INSERT INTO ingestion_runs (
       id, state, selected_games_json, started_at,
       expected_current_revision_id, idempotency_key, candidate_json
     ) VALUES (
       ?, 'planning', '[]', ?, ?, ?,
       '{"production_release_bootstrap":true}'
     )`,
  ).bind(id, now, currentRevision, id).run();
  const claimBootstrap = async (id: string) => env.CATALOGUE_DB.prepare(
    `UPDATE operation_state SET active_ingestion_run_id = ?
     WHERE singleton = 1 AND active_ingestion_run_id IS NULL
       AND recovery_health = 'healthy'`,
  ).bind(id).run();
  const failBootstrap = async (id: string, failureCode: string) =>
    env.CATALOGUE_DB.prepare(
      `UPDATE ingestion_runs
       SET state = 'failed', terminal_at = ?, failure_code = ?,
           progress_json =
             '{"completed_stages":[],"current_stage":"failed"}'
       WHERE id = ? AND state = 'planning'
         AND EXISTS (
           SELECT 1 FROM operation_state
           WHERE singleton = 1 AND active_ingestion_run_id = ?
         )`,
    ).bind(now, failureCode, id, id).run();
  const clearBootstrap = async (id: string) => env.CATALOGUE_DB.prepare(
    `UPDATE operation_state SET active_ingestion_run_id = NULL
     WHERE singleton = 1 AND active_ingestion_run_id = ?`,
  ).bind(id).run();
  const deleteBootstrap = async (id: string) => {
    const [, result] = await env.CATALOGUE_DB.batch([
      env.CATALOGUE_DB.prepare(
        `DELETE FROM ingestion_run_transitions
         WHERE ingestion_run_id = ?`,
      ).bind(id),
      env.CATALOGUE_DB.prepare(
        `DELETE FROM ingestion_runs
         WHERE id = ? AND idempotency_key = id
           AND selected_games_json = '[]'
           AND candidate_json = '{"production_release_bootstrap":true}'
           AND state IN ('planning', 'failed')
           AND NOT EXISTS (
             SELECT 1 FROM operation_state
             WHERE singleton = 1
               AND active_ingestion_run_id = ingestion_runs.id
           )`,
      ).bind(id),
    ]);
    if (result === undefined) {
      throw new Error("The bootstrap cleanup batch did not return a result.");
    }
    return result;
  };

  const firstFence = `release_first_${sequence}`;
  const firstBootstrap =
    `release-bootstrap|2099-01-01T00:00:00.000Z|${firstFence}`;
  await insertBootstrap(firstBootstrap);
  const firstClaim = await claimBootstrap(firstBootstrap);
  expect(firstClaim.meta.changes).toBe(1);

  // This is the cleanup query used by the previously deployed ingestion
  // worker. A matching active planning row prevents it from dropping the
  // pre-migration release fence as an orphan.
  await env.CATALOGUE_DB.prepare(
    `UPDATE operation_state SET active_ingestion_run_id = NULL
     WHERE singleton = 1 AND active_ingestion_run_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM ingestion_runs
         WHERE id = operation_state.active_ingestion_run_id
           AND state IN (
             'planning', 'collecting', 'parsing', 'reconciling',
             'awaiting_approval', 'publishing'
           )
       )`,
  ).run();
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT active_ingestion_run_id FROM operation_state WHERE singleton = 1",
  ).first()).toEqual({ active_ingestion_run_id: firstBootstrap });

  const blockedBootstrap =
    `release-bootstrap|2099-01-01T00:00:00.000Z|release_blocked_${sequence}`;
  await expect(insertBootstrap(blockedBootstrap))
    .rejects.toThrow("active_ingestion_run_or_release");

  // Failure cleanup retains an immutable audit on the legacy schema, while
  // the migrated schema can remove this exact non-domain marker and retry.
  expect((await failBootstrap(
    firstBootstrap,
    "production_release_bootstrap_abandoned",
  )).meta.changes).toBeGreaterThan(0);
  expect((await clearBootstrap(firstBootstrap)).meta.changes).toBe(1);
  expect((await deleteBootstrap(firstBootstrap)).meta.changes).toBe(1);
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT id FROM ingestion_runs WHERE id = ?",
  ).bind(firstBootstrap).first()).toBeNull();

  const staleBootstrap =
    `release-bootstrap|2000-01-01T00:00:00.000Z|${firstFence}`;
  await insertBootstrap(staleBootstrap);
  expect((await claimBootstrap(staleBootstrap)).meta.changes).toBe(1);
  expect((await failBootstrap(
    staleBootstrap,
    "production_release_bootstrap_expired",
  )).meta.changes).toBeGreaterThan(0);
  expect((await clearBootstrap(staleBootstrap)).meta.changes).toBe(1);

  const secondFence = `release_second_${sequence}`;
  const secondBootstrap =
    `release-bootstrap|2099-01-01T00:00:00.000Z|${secondFence}`;
  await insertBootstrap(secondBootstrap);
  const reclaimed = await claimBootstrap(secondBootstrap);
  expect(reclaimed.meta.changes).toBe(1);
  const transferred = await env.CATALOGUE_DB.prepare(
    `UPDATE operation_state
     SET active_release_id = ?, active_release_expires_at = ?,
         active_ingestion_run_id = NULL
     WHERE singleton = 1 AND active_ingestion_run_id = ?
       AND (active_release_id IS NULL OR active_release_expires_at <= ?)`,
  ).bind(secondFence, "2099-01-01T00:00:00.000Z", secondBootstrap, now).run();
  expect(transferred.meta.changes).toBe(1);
  expect((await deleteBootstrap(secondBootstrap)).meta.changes).toBe(1);
  expect((await deleteBootstrap(staleBootstrap)).meta.changes).toBe(1);
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT count(*) AS bootstrap_count FROM ingestion_runs
     WHERE id IN (?, ?)`,
  ).bind(staleBootstrap, secondBootstrap).first()).toEqual({
    bootstrap_count: 0,
  });

  const staleCleanup = await env.CATALOGUE_DB.prepare(
    `UPDATE operation_state
     SET active_release_id = NULL, active_release_expires_at = NULL
     WHERE singleton = 1 AND active_release_id = ?`,
  ).bind(firstFence).run();
  expect(staleCleanup.meta.changes).toBe(0);
  const renewed = await env.CATALOGUE_DB.prepare(
    `UPDATE operation_state SET active_release_expires_at = ?
     WHERE singleton = 1 AND active_release_id = ?
       AND active_release_expires_at > ?`,
  ).bind("2099-01-01T00:15:00.000Z", secondFence, now).run();
  expect(renewed.meta.changes).toBe(1);
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT active_release_id, active_release_expires_at
     FROM operation_state WHERE singleton = 1`,
  ).first()).toEqual({
    active_release_id: secondFence,
    active_release_expires_at: "2099-01-01T00:15:00.000Z",
  });

  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_release_expires_at = ? WHERE singleton = 1 AND active_release_id = ?",
  ).bind("2000-01-01T00:00:00.000Z", secondFence).run();
  const thirdFence = `release_third_${sequence}`;
  const thirdBootstrap =
    `release-bootstrap|2099-01-01T00:00:00.000Z|${thirdFence}`;
  await insertBootstrap(thirdBootstrap);
  expect((await claimBootstrap(thirdBootstrap)).meta.changes).toBe(1);
  expect((await env.CATALOGUE_DB.prepare(
    `UPDATE operation_state
     SET active_release_id = ?, active_release_expires_at = ?,
         active_ingestion_run_id = NULL
     WHERE singleton = 1 AND active_ingestion_run_id = ?
       AND active_release_expires_at <= ?`,
  ).bind(
    thirdFence,
    "2099-01-01T00:00:00.000Z",
    thirdBootstrap,
    now,
  ).run()).meta.changes).toBe(1);
  expect((await deleteBootstrap(thirdBootstrap)).meta.changes).toBe(1);
  expect((await env.CATALOGUE_DB.prepare(
    `UPDATE operation_state SET active_release_expires_at = ?
     WHERE singleton = 1 AND active_release_id = ?`,
  ).bind("2099-01-01T00:30:00.000Z", secondFence).run()).meta.changes)
    .toBe(0);
  expect((await env.CATALOGUE_DB.prepare(
    `UPDATE operation_state
     SET active_release_id = NULL, active_release_expires_at = NULL
     WHERE singleton = 1 AND active_release_id = ?`,
  ).bind(secondFence).run()).meta.changes).toBe(0);
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT active_release_id FROM operation_state WHERE singleton = 1",
  ).first()).toEqual({ active_release_id: thirdFence });
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
  expect((await adminRequest("/admin/v1/curated-revisions", first)).status)
    .toBe(201);
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
  const revision = await created.json() as { curated_revision_id: string };
  const runId = `run_curated_apply_${sequence}`;
  await insertParsingRun(runId);

  const pin = await pinCuratedRevisionsForRun(env.CATALOGUE_DB, runId, now);
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
    curated_provenance: [{
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
    }],
  };
  const applied = await applyPinnedCuratedRevisions(env.CATALOGUE_DB, runId, {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece", "digimon"],
    cards: [card, unselected],
    printings: [],
  }, now);
  expect(applied.cards[0]).toMatchObject({
    name: "Curated Name",
    curated_provenance: [{ curated_revision_id: revision.curated_revision_id }],
  });
  expect(applied.cards[1]).toEqual(unselected);
  const stripped = stripCuratedRevisionEffects(applied);
  expect(stripped.cards[0]).toMatchObject({ name: "Official Name" });
  expect(stripped.cards[0]).not.toHaveProperty("curated_provenance");
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
  const revision = await created.json() as { curated_revision_id: string };
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
    curated_provenance: [{
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
    }],
  };
  const prepared = await prepareCuratedRevisionRunStart(
    env.CATALOGUE_DB,
    runId,
    ["one-piece"],
    {
      contract: "card-keepr-catalogue-candidate@1",
      selected_games: ["one-piece"],
      cards: [
        {
          ...card,
          name: "Old Curated Name",
          curated_provenance: [{
            curated_revision_id: "currev_old",
            content_digest: "a".repeat(64),
            target: authoredProposal.target,
            rationale: "Prior effect.",
            evidence: authoredProposal.evidence,
            author: "owner",
            reviewed_source_value: card.name,
          }],
        },
        unselectedCard,
      ],
      printings: [],
    },
    now,
  );
  expect(prepared.candidate.cards[0]).toMatchObject({
    name: "Current Curated Name",
    curated_provenance: [{
      curated_revision_id: revision.curated_revision_id,
    }],
  });
  expect(prepared.candidate.cards[1]).toEqual(unselectedCard);
  await env.CATALOGUE_DB.batch([
    env.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, idempotency_key, candidate_json,
         progress_json, warnings_json, approval_history_json
       ) VALUES (?, 'planning', '["one-piece"]', ?, ?, ?, '{}',
         '{"completed_stages":[],"current_stage":"planning"}', '[]', '[]')`,
    ).bind(runId, now, currentRevision, `prepared-${sequence}`),
    ...prepared.statements,
  ]);
  const pin = await env.CATALOGUE_DB.prepare(
    `SELECT revision_ids_json, set_digest
     FROM ingestion_run_curated_revision_sets WHERE ingestion_run_id = ?`,
  ).bind(runId).first<{ revision_ids_json: string; set_digest: string }>();
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
    evidence: [{
      kind: "owner_reference" as const,
      uri: "https://owner.example/review/event-tier",
      content_digest: "d".repeat(64),
    }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson(null)),
    supersedes_revision_id: null,
  };
  const created = await createCuratedRevision(env.CATALOGUE_DB, {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: legalityProposal,
    proposal_digest: await sha256Text(canonicalJson(legalityProposal)),
    idempotency_key: `companion-drift-${sequence}`,
  }, now);
  const runId = `run_companion_drift_${sequence}`;
  await insertParsingRun(runId);
  await pinCuratedRevisionsForRun(env.CATALOGUE_DB, runId, now);
  const officialRule = {
    ...((JSON.parse((await env.CATALOGUE_DB.prepare(
      `SELECT candidate_json FROM ingestion_runs
       WHERE idempotency_key = ?`,
    ).bind(`curated-seed-${sequence}`).first<{ candidate_json: string }>())!
      .candidate_json) as { legality_rules: Record<string, unknown>[] })
      .legality_rules[0]!),
    event_tier: null,
    effective_from: "2026-08-05",
    effective_until: null,
    unresolved_scope: { dimensions: ["event_tier"] },
    effect: { type: "unresolved" },
  };
  await expect(applyPinnedCuratedRevisions(env.CATALOGUE_DB, runId, {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [card],
    printings: [],
    legality_rules: [officialRule as never],
  }, now)).rejects.toThrow("curated_revision_composed_candidate_invalid");
  const run = await env.CATALOGUE_DB.prepare(
    "SELECT state, failure_code FROM ingestion_runs WHERE id = ?",
  ).bind(runId).first<{ state: string; failure_code: string | null }>();
  expect(run).toEqual({
    state: "failed",
    failure_code: "curated_revision_composed_candidate_invalid",
  });
  expect(created.document.status).toBe("active");
});

test("a prepared retry persists its failed run and every source-change conflict", async () => {
  const authored = await proposal("/name", "Curated Name");
  const created = await createCuratedRevision(env.CATALOGUE_DB, {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: authored,
    proposal_digest: await sha256Text(canonicalJson(authored)),
    idempotency_key: `prepared-conflict-create-${sequence}`,
  }, now);
  const authoredRules = await proposal(
    "/effective_rules_text",
    "Curated rules text",
  );
  const createdRules = await createCuratedRevision(env.CATALOGUE_DB, {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: authoredRules,
    proposal_digest: await sha256Text(canonicalJson(authoredRules)),
    idempotency_key: `prepared-conflict-rules-${sequence}`,
  }, now);
  const sourceRunId = `run_prepared_conflict_source_${sequence}`;
  const failedCandidate = {
    contract: "card-keepr-catalogue-candidate@1" as const,
    selected_games: ["one-piece" as const],
    cards: [{
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
    }],
    printings: [],
  };
  const sourceDigest = await sha256Text(canonicalJson(failedCandidate));
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO ingestion_runs (
       id, state, selected_games_json, started_at,
       expected_current_revision_id, idempotency_key, candidate_digest,
       candidate_catalogue_digest, candidate_created_at, terminal_at,
       candidate_json, failure_code, progress_json, warnings_json,
       approval_history_json
     ) VALUES (?, 'failed', '["one-piece"]', ?, ?, ?, ?, ?, ?, ?, ?,
       'prior_failure',
       '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"failed"}',
       '[]', '[]')`,
  ).bind(
    sourceRunId,
    now,
    currentRevision,
    `prepared-conflict-source-${sequence}`,
    sourceDigest,
    sourceDigest,
    now,
    now,
    canonicalJson(failedCandidate),
  ).run();

  const retried = await adminRequest(`/v1/ingestion-runs/${sourceRunId}/retry`, {
    idempotency_key: `prepared-conflict-retry-${sequence}`,
  });
  expect(retried.status, JSON.stringify(await retried.clone().json())).toBe(201);
  const document = await retried.json() as { id: string };
  await expect(env.CATALOGUE_DB.prepare(
    "SELECT state, failure_code FROM ingestion_runs WHERE id = ?",
  ).bind(document.id).first()).resolves.toEqual({
    state: "failed",
    failure_code: "curated_revision_reconfirmation_required",
  });
  const conflictedIds = [
    created.document.curated_revision_id,
    createdRules.document.curated_revision_id,
  ];
  const statuses = await env.CATALOGUE_DB.prepare(
    "SELECT status, event_version FROM curated_revisions WHERE id IN (SELECT value FROM json_each(?))",
  ).bind(canonicalJson(conflictedIds)).all<{ status: string; event_version: number }>();
  expect(statuses.results).toHaveLength(2);
  expect(statuses.results.every(({ status, event_version }) =>
    status === "reconfirmation_required" && event_version === 2
  )).toBe(true);
  await expect(env.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM curated_revision_events WHERE revision_id IN (SELECT value FROM json_each(?)) AND kind = 'source_change_detected'",
  ).bind(canonicalJson(conflictedIds)).first()).resolves.toEqual({ count: 2 });
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
  const revision = await created.json() as { curated_revision_id: string };
  const runId = `run_curated_source_change_${sequence}`;
  await insertParsingRun(runId);
  await pinCuratedRevisionsForRun(env.CATALOGUE_DB, runId, now);

  await expect(applyPinnedCuratedRevisions(env.CATALOGUE_DB, runId, {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [{ ...card, name: "New Official Name" }],
    printings: [],
  }, now)).rejects.toThrow("curated_revision_reconfirmation_required");
  await expect(env.CATALOGUE_DB.prepare(
    "SELECT status, event_version FROM curated_revisions WHERE id = ?",
  ).bind(revision.curated_revision_id).first()).resolves.toMatchObject({
    status: "reconfirmation_required",
    event_version: 2,
  });
  await expect(applyPinnedCuratedRevisions(env.CATALOGUE_DB, runId, {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [{ ...card, name: "New Official Name" }],
    printings: [],
  }, now)).rejects.toThrow("curated_revision_reconfirmation_required");
  await expect(env.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM curated_revision_events WHERE revision_id = ? AND kind = 'source_change_detected'",
  ).bind(revision.curated_revision_id).first()).resolves.toEqual({ count: 1 });
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
    createdIds.push(String((await response.json() as {
      curated_revision_id: string;
    }).curated_revision_id));
  }
  const runId = `run_all_conflicts_${sequence}`;
  await insertParsingRun(runId);
  await pinCuratedRevisionsForRun(env.CATALOGUE_DB, runId, now);
  await expect(applyPinnedCuratedRevisions(env.CATALOGUE_DB, runId, {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [{
      ...card,
      name: "Changed Official Name",
      effective_rules_text: "Changed Official Text",
    }],
    printings: [],
  }, now)).rejects.toThrow("curated_revision_reconfirmation_required");
  const statuses = await env.CATALOGUE_DB.prepare(
    "SELECT id, status FROM curated_revisions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
  ).bind(JSON.stringify(createdIds)).all<{ id: string; status: string }>();
  expect(statuses.results).toHaveLength(2);
  expect(statuses.results.every(({ status }) =>
    status === "reconfirmation_required"
  )).toBe(true);
});

test("retargeted supersession binds the old conflict and the replacement target's official digest", async () => {
  const authored = await proposal("/name", "Curated Name");
  const created = await createCuratedRevision(env.CATALOGUE_DB, {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: authored,
    proposal_digest: await sha256Text(canonicalJson(authored)),
    idempotency_key: `retarget-create-${sequence}`,
  }, now);
  const runId = `run_retarget_${sequence}`;
  await insertParsingRun(runId);
  await pinCuratedRevisionsForRun(env.CATALOGUE_DB, runId, now);
  await expect(applyPinnedCuratedRevisions(env.CATALOGUE_DB, runId, {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [{ ...card, name: "Changed Official Name" }],
    printings: [],
  }, now)).rejects.toThrow("curated_revision_reconfirmation_required");
  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
  ).run();
  const shown = await adminRequest(
    `/admin/v1/curated-revisions/${created.document.curated_revision_id}`,
  );
  const inspected = await shown.json() as {
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
  const createdResult = await createCuratedRevision(env.CATALOGUE_DB, {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: authoredProposal,
    proposal_digest: await sha256Text(canonicalJson(authoredProposal)),
    idempotency_key: `lifecycle-create-${sequence}`,
  }, now);
  const created = createdResult.document;
  const runId = `run_curated_lifecycle_${sequence}`;
  await insertParsingRun(runId);
  await pinCuratedRevisionsForRun(env.CATALOGUE_DB, runId, now);
  await expect(applyPinnedCuratedRevisions(env.CATALOGUE_DB, runId, {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [{ ...card, name: "New Official Name" }],
    printings: [],
  }, now)).rejects.toThrow("curated_revision_reconfirmation_required");
  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
  ).run();

  const conflictDocument = await showCuratedRevision(
    env.CATALOGUE_DB,
    created.curated_revision_id,
  ) as {
    events: { details: { conflict_digest?: string } }[];
  };
  const conflictDigest = conflictDocument.events.at(-1)!.details.conflict_digest!;
  const reaffirmed = await reaffirmCuratedRevision(
    env.CATALOGUE_DB,
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
    evidence: [{
      kind: "source_observation" as const,
      id: `srcobs_missing_replacement_${sequence}`,
    }],
  };
  await expect(supersedeCuratedRevision(
    env.CATALOGUE_DB,
    created.curated_revision_id,
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      expected_event_version: 3,
      conflict_digest: null,
      proposal: replacementWithMissingEvidence,
      proposal_digest: await sha256Text(canonicalJson(
        replacementWithMissingEvidence,
      )),
      rationale: "Reject unresolved replacement evidence.",
      idempotency_key: `supersede-missing-evidence-${sequence}`,
    },
    now,
  )).rejects.toMatchObject({
    code: "curated_revision_evidence_not_retained",
  });
  const superseded = await supersedeCuratedRevision(
    env.CATALOGUE_DB,
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
    env.CATALOGUE_DB,
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

test("an empty curated revision set is still pinned with its digest", async () => {
  const runId = `run_curated_empty_${sequence}`;
  await insertParsingRun(runId);
  const pin = await pinCuratedRevisionsForRun(env.CATALOGUE_DB, runId, now);
  expect(pin.revision_ids).toEqual([]);
  await expect(env.CATALOGUE_DB.prepare(
    "SELECT revision_ids_json, set_digest, pinned_at FROM ingestion_run_curated_revision_sets WHERE ingestion_run_id = ?",
  ).bind(runId).first()).resolves.toEqual({
    revision_ids_json: "[]",
    set_digest: pin.set_digest,
    pinned_at: now,
  });

  await expect(env.CATALOGUE_DB.prepare(
    "UPDATE ingestion_run_curated_revision_sets SET set_digest = ? WHERE ingestion_run_id = ?",
  ).bind("f".repeat(64), runId).run()).rejects.toThrow(
    "curated_revision_pin_set_immutable",
  );
  const replay = await pinCuratedRevisionsForRun(
    env.CATALOGUE_DB,
    runId,
    "2026-08-06T00:00:00.000Z",
  );
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
    evidence: [{
      kind: "owner_reference",
      uri: "https://owner.example/review/relationship",
      content_digest: "d".repeat(64),
    }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson("absent")),
    supersedes_revision_id: null,
  };
  const created = await createCuratedRevision(env.CATALOGUE_DB, {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: relationshipProposal,
    proposal_digest: await sha256Text(canonicalJson(relationshipProposal)),
    idempotency_key: `relationship-${sequence}`,
  }, now);
  expect(created.created).toBe(true);
  const mutation = created.document;
  const runId = `run_relationship_${sequence}`;
  await insertParsingRun(runId);
  await pinCuratedRevisionsForRun(env.CATALOGUE_DB, runId, now);
  const applied = await applyPinnedCuratedRevisions(env.CATALOGUE_DB, runId, {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [card],
    printings: [{
      id: `printing_${sequence}`,
      card_id: card.id,
      rarity: { normalized: "common", raw: "C" },
      printed_rules_text: null,
      game_data: null,
    }],
    products: [{
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
    }],
    product_relationships: [],
  }, now);
  expect(applied.product_relationships).toEqual([
    expect.objectContaining({
      evidence_category: "curated",
      curated_provenance: [expect.objectContaining({
        curated_revision_id: mutation.curated_revision_id,
        rationale: relationshipProposal.rationale,
      })],
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
    evidence: [{
      kind: "owner_reference",
      uri: "https://owner.example/review/relationship-absence",
      content_digest: "e".repeat(64),
    }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson("present")),
    supersedes_revision_id: null,
  };
  const created = await createCuratedRevision(env.CATALOGUE_DB, {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: relationshipProposal,
    proposal_digest: await sha256Text(canonicalJson(relationshipProposal)),
    idempotency_key: `relationship-absence-${sequence}`,
  }, now);
  expect(created.created).toBe(true);
  const runId = `run_relationship_absence_${sequence}`;
  await insertParsingRun(runId);
  await pinCuratedRevisionsForRun(env.CATALOGUE_DB, runId, now);
  const applied = await applyPinnedCuratedRevisions(env.CATALOGUE_DB, runId, {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [card],
    printings: [{
      id: `printing_${sequence}`,
      card_id: card.id,
      rarity: { normalized: "common", raw: "C" },
      printed_rules_text: null,
      game_data: null,
    }],
    products: [{
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
    }],
    product_relationships: [official, corroboratingOfficial],
  }, now);
  expect(applied.product_relationships).toHaveLength(2);
  expect(applied.product_relationships).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: official.id, observed: false }),
    expect.objectContaining({ id: corroboratingOfficial.id, observed: false }),
  ]));
  expect(applied.product_relationships!.every((relationship) =>
    relationship.curated_provenance?.at(-1)?.reviewed_source_value === "present"
  )).toBe(true);
  expect(stripCuratedRevisionEffects(applied).product_relationships).toEqual([
    official,
    corroboratingOfficial,
  ]);
  const built = await buildCatalogueExport(
    applied,
    await sha256Text(canonicalJson(applied)),
    `catrev_curated_relationship_${sequence}`,
    now,
  );
  expect(built.manifest).toMatchObject({
    format: "card-keepr-catalogue-export-manifest@4",
    export_schema_major: 4,
  });
  expect(built.manifest.components.find(({ name }) =>
    name === "relationships"
  )?.record_schema).toBe(
    "https://card-keepr.invalid/schemas/catalogue-export-record@4#/$defs/RelationshipRecord",
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
    evidence: [{
      kind: "owner_reference" as const,
      uri: "https://owner.example/review/1",
      content_digest: "a".repeat(64),
    }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson(
      path === "/name"
        ? card.name
        : path === "/effective_rules_text"
        ? card.effective_rules_text
        : card.official_identity.value,
    )),
    supersedes_revision_id: null,
  };
}

function adminRequest(pathname: string, body?: unknown): Promise<Response> {
  return exports.default.fetch(new Request(`https://card-keepr.invalid${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer vitest-administration-key",
      "cf-connecting-ip": `203.0.113.${(sequence % 250) + 1}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-keepr-test-now": now,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
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

async function insertParsingRun(runId: string) {
  await env.CATALOGUE_DB.batch([
    env.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, idempotency_key, candidate_json,
        progress_json, warnings_json, approval_history_json
      ) VALUES (?, 'parsing', '["one-piece"]', ?, ?, ?, '{}',
        '{"completed_stages":["planning","collecting"],"current_stage":"parsing"}', '[]', '[]')`,
    ).bind(runId, now, currentRevision, `parse-${runId}`),
    env.CATALOGUE_DB.prepare(
      "UPDATE operation_state SET active_ingestion_run_id = ? WHERE singleton = 1",
    ).bind(runId),
  ]);
}
