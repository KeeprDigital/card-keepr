import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { canonicalJson, sha256Text } from "../../../src/catalogue/serialization";
import type { CatalogueCard } from "../../../src/catalogue/catalogue-candidate";
import {
  applyPinnedCuratedRevisions,
  pinCuratedRevisionsForRun,
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
    printings: [],
  };
  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL, recovery_health = 'healthy' WHERE singleton = 1",
  ).run();
  await env.CATALOGUE_DB.prepare(
    "UPDATE curated_revisions SET status = 'retired', event_version = event_version + 1 WHERE status = 'active'",
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
      "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
    ),
  ]);
});

test("validate derives a canonical proposal digest and rejects protected identity fields", async () => {
  const valid = await adminRequest("/admin/v1/curated-revisions/validate", {
    proposal: await proposal("/name", "Curated Name"),
    expected_current_revision_id: currentRevision,
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
      expected_current_revision_id: currentRevision,
    },
  );
  expect(protectedField.status).toBe(422);
  await expect(protectedField.json()).resolves.toMatchObject({
    code: "curated_revision_identity_forbidden",
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
  const document = await created.json() as Record<string, unknown>;
  expect(document).toMatchObject({
    contract: "card-keepr-curated-revision@1",
    game: "one-piece",
    author: "owner",
    status: "active",
    created_at: now,
  });
  expect(document).not.toHaveProperty("proposal.author");

  const replay = await adminRequest("/admin/v1/curated-revisions", input);
  expect(replay.status).toBe(200);
  await expect(replay.json()).resolves.toEqual(document);

  const listed = await adminRequest(
    "/admin/v1/curated-revisions?game=one-piece&status=active",
  );
  expect(listed.status).toBe(200);
  await expect(listed.json()).resolves.toMatchObject({
    contract: "card-keepr-curated-revision-list@1",
    revisions: [document],
  });

  const shown = await adminRequest(
    `/admin/v1/curated-revisions/${encodeURIComponent(String(document.id))}`,
  );
  expect(shown.status).toBe(200);
  await expect(shown.json()).resolves.toEqual(document);
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
  const revision = await created.json() as { id: string };
  const runId = `run_curated_apply_${sequence}`;
  await insertParsingRun(runId);

  const pin = await pinCuratedRevisionsForRun(env.CATALOGUE_DB, runId, now);
  expect(pin.revision_ids).toContain(revision.id);
  expect(pin.set_digest).toMatch(/^[a-f0-9]{64}$/);

  const applied = await applyPinnedCuratedRevisions(env.CATALOGUE_DB, runId, {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [card],
    printings: [],
  }, now);
  expect(applied.cards[0]).toMatchObject({
    name: "Curated Name",
    curated_provenance: [{ curated_revision_id: revision.id }],
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
  const revision = await created.json() as { id: string };
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
  ).bind(revision.id).first()).resolves.toMatchObject({
    status: "reconfirmation_required",
    event_version: 2,
  });
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
