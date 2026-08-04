import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { canonicalJson, sha256Text } from "../../../src/catalogue/serialization";
import type { CatalogueCard } from "../../../src/catalogue/catalogue-candidate";
import {
  applyPinnedCuratedRevisions,
  pinCuratedRevisionsForRun,
  stripCuratedRevisionEffects,
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
  game_data: { profile: "one-piece@1", attributes: {} },
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
      releases: [],
      observed: true,
      withdrawal: null,
      included: [],
      provenance: {},
      disagreements: [],
    }],
    product_relationships: [],
  };
  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL, recovery_health = 'healthy' WHERE singleton = 1",
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
      kind: "field",
      entity_type: "card",
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

  const applied = await applyPinnedCuratedRevisions(env.CATALOGUE_DB, runId, {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [card],
    printings: [],
  }, now);
  expect(applied.cards[0]).toMatchObject({
    name: "Curated Name",
    curated_provenance: [{ curated_revision_id: revision.curated_revision_id }],
  });
  const stripped = stripCuratedRevisionEffects(applied);
  expect(stripped.cards[0]).toMatchObject({ name: "Official Name" });
  expect(stripped.cards[0]).not.toHaveProperty("curated_provenance");
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

test("exact reaffirmation, supersession, and retirement recover lifecycle without rewriting history", async () => {
  const authoredProposal = await proposal("/name", "Curated Name");
  const createdResponse = await adminRequest("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: authoredProposal,
    proposal_digest: await sha256Text(canonicalJson(authoredProposal)),
    idempotency_key: `lifecycle-create-${sequence}`,
  });
  const created = await createdResponse.json() as { curated_revision_id: string };
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

  const conflicted = await adminRequest(`/admin/v1/curated-revisions/${created.curated_revision_id}`);
  const conflictDocument = await conflicted.json() as {
    events: { details: { conflict_digest?: string } }[];
  };
  const conflictDigest = conflictDocument.events.at(-1)!.details.conflict_digest!;
  const reaffirmed = await adminRequest(
    `/admin/v1/curated-revisions/${created.curated_revision_id}/reaffirm`,
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      expected_event_version: 2,
      conflict_digest: conflictDigest,
      rationale: "The owner accepts the new Official Source value.",
      idempotency_key: `reaffirm-${sequence}`,
    },
  );
  expect(reaffirmed.status).toBe(200);
  await expect(reaffirmed.json()).resolves.toMatchObject({
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
  const superseded = await adminRequest(
    `/admin/v1/curated-revisions/${created.curated_revision_id}/supersede`,
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
  );
  expect(superseded.status).toBe(201);
  const replacementResult = await superseded.json() as { curated_revision_id: string };

  const retired = await adminRequest(
    `/admin/v1/curated-revisions/${replacementResult.curated_revision_id}/retire`,
    {
      environment: "production",
      expected_current_revision_id: currentRevision,
      expected_event_version: 1,
      conflict_digest: null,
      rationale: "The exception is no longer required.",
      idempotency_key: `retire-${sequence}`,
    },
  );
  expect(retired.status).toBe(200);
  await expect(retired.json()).resolves.toMatchObject({
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
  const created = await adminRequest("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: currentRevision,
    proposal: relationshipProposal,
    proposal_digest: await sha256Text(canonicalJson(relationshipProposal)),
    idempotency_key: `relationship-${sequence}`,
  });
  expect(created.status).toBe(201);
  const mutation = await created.json() as { curated_revision_id: string };
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

async function proposal(path: string, value: unknown) {
  return {
    game: "one-piece",
    target: {
      kind: "field",
      entity_type: "card",
      entity_id: card.id,
      path,
    },
    assertion: { kind: "field", value },
    rationale: "The owner reviewed an authoritative correction.",
    evidence: [{
      kind: "owner_reference",
      uri: "https://owner.example/review/1",
      content_digest: "a".repeat(64),
    }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson(
      path === "/name" ? card.name : card.official_identity.value,
    )),
    supersedes_revision_id: null,
  };
}

function adminRequest(pathname: string, body?: unknown): Promise<Response> {
  return exports.default.fetch(new Request(`https://card-keepr.invalid${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer vitest-administration-key",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-keepr-test-now": now,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
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
