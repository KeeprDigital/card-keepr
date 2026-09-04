import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { renderRunFixtureSql } from "./helpers/query-helpers/run-event-fixture.mjs";
import test from "node:test";
import {
  applyMigrations,
  executeSql,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
} from "./helpers/acceptance-runtime.mjs";

const currentRevisionId = "catrev_cli_source_baseline";
const sourceRunId = "run_cli_source_changed";
const observedAt = "2026-08-05T05:06:07.000Z";
const card = {
  id: "card_cli_source_change",
  game: "one-piece",
  official_identity: { kind: "card_number", value: "OP99-041" },
  name: "Official Name",
  effective_rules_text: "Official rules text.",
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
const product = {
  id: "product_cli_source_change",
  reference: { kind: "official_code", value: "OP-99" },
  game: "one-piece",
  official_code: "OP-99",
  name: "CLI Source Change Booster",
  releases: [],
  observed: true,
  withdrawal: null,
  included: [],
  provenance: {},
  disagreements: [],
};
const officialRelationship = {
  id: "relationship_cli_source_change",
  game: "one-piece",
  kind: "product-card",
  from: { type: "product", id: product.id },
  to: { type: "card", id: card.id },
  evidence_category: "explicit",
  resolution: "canonical",
  source_lineage: "one-piece-en",
  source_observation_ids: ["srcobs_cli_source_change"],
  relationship_value: card.official_identity.value,
  observed: true,
};

test("the repository CLI resolves a source conflict through the emulated ingestion Worker", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-curated-source-"));
  const statePath = join(directory, "state");
  const environmentFile = join(directory, "ingestion.env");
  const proposalFile = join(directory, "proposal.json");
  const administrationKey = randomUUID();
  await writeFile(environmentFile, `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`, {
    mode: 0o600,
  });
  const vite = await createServer({
    root: resolve(import.meta.dirname, ".."),
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());
  await applyMigrations(statePath);
  await seedSql(statePath, directory, "baseline.sql", await baselineSql(vite));

  let ingestion = await startWorker({
    config: "apps/ingestion/wrangler.jsonc",
    envFile: environmentFile,
    statePath,
  });
  t.after(async () => {
    await stopWorker(ingestion);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(`${ingestion.url}/health`, administrationKey, ingestion);
  const cliEnvironment = {
    KEEPR_INGESTION_URL: ingestion.url,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
  };
  const statusResult = await runCli(["status", "--json"], cliEnvironment);
  assert.equal(statusResult.code, 0, `${statusResult.stdout}\n${statusResult.stderr}\n${ingestion.getOutput()}`);
  const status = JSON.parse(statusResult.stdout);
  assert.equal(status.safe_state.current_revision_id, currentRevisionId);

  const proposal = {
    game: "one-piece",
    target: {
      kind: "relationship",
      relationship_kind: "product-card",
      from: officialRelationship.from,
      to: officialRelationship.to,
    },
    assertion: { kind: "relationship", presence: "absent" },
    rationale: "The owner reviewed the official product-card relationship as absent.",
    evidence: [
      {
        kind: "owner_reference",
        uri: "https://owner.example/review/cli-source-change",
        content_digest: "a".repeat(64),
      },
    ],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: digest("present"),
    supersedes_revision_id: null,
  };
  const proposalDigest = digest(proposal);
  await writeFile(proposalFile, JSON.stringify(proposal), { mode: 0o600 });
  const createIdempotencyKey = "cli-worker-curated-create";
  const createConfirmation = JSON.stringify({
    production_target: status.production_target,
    operation: "create",
    current_catalogue_revision_id: currentRevisionId,
    affected_supported_game: proposal.game,
    target: proposal.target,
    content_digest: proposalDigest,
    idempotency_key: createIdempotencyKey,
  });
  const createdResult = await runCli(
    [
      "curated-revision",
      "create",
      "--proposal",
      proposalFile,
      "--proposal-digest",
      proposalDigest,
      "--expected-current-revision",
      currentRevisionId,
      "--idempotency-key",
      createIdempotencyKey,
      "--environment",
      "production",
      "--confirm",
      createConfirmation,
      "--secrets-stdin-fd",
      "3",
      "--yes",
      "--json",
    ],
    cliEnvironment,
    {
      secrets: { administration_key: administrationKey },
    },
  );
  assert.equal(createdResult.code, 0, `${createdResult.stdout}\n${createdResult.stderr}\n${ingestion.getOutput()}`);
  const created = JSON.parse(createdResult.stdout);
  assert.equal(created.status, "active");

  const restartedPort = ingestion.port;
  const restartedInspectorPort = ingestion.inspectorPort;
  await stopWorker(ingestion);
  await seedSql(statePath, directory, "source-change.sql", await sourceRunSql(vite));
  // The restart keeps the ports the CLI environment already points at.
  ingestion = await startWorker({
    config: "apps/ingestion/wrangler.jsonc",
    envFile: environmentFile,
    inspectorPort: restartedInspectorPort,
    port: restartedPort,
    statePath,
  });
  await waitForHealth(`${ingestion.url}/health`, administrationKey, ingestion);

  const conflictedResult = await runCli(
    ["run", "retry", "--run-id", sourceRunId, "--idempotency-key", "cli-worker-detect-source-change", "--json"],
    cliEnvironment,
  );
  assert.equal(conflictedResult.code, 0, conflictedResult.stderr);
  const conflictedRun = JSON.parse(conflictedResult.stdout);
  assert.equal(conflictedRun.state, "failed");
  assert.equal(conflictedRun.failure_code, "curated_revision_reconfirmation_required");
  assert.equal(conflictedRun.linked_run_id, sourceRunId);

  const shownResult = await runCli(
    ["curated-revision", "show", "--revision-id", created.curated_revision_id, "--secrets-stdin-fd", "3", "--json"],
    cliEnvironment,
    {
      secrets: { administration_key: administrationKey },
    },
  );
  assert.equal(shownResult.code, 0, shownResult.stderr);
  const shown = JSON.parse(shownResult.stdout).revision;
  assert.equal(shown.status, "reconfirmation_required");
  assert.equal(shown.event_version, 2);
  assert.equal(shown.pending_conflict.run_id, conflictedRun.id);
  assert.equal(shown.pending_conflict.previous_source_digest, proposal.reviewed_source_digest);
  assert.equal(shown.pending_conflict.observed_source_digest, digest("absent"));

  const blockedResult = await runCli(
    ["run", "retry", "--run-id", sourceRunId, "--idempotency-key", "cli-worker-block-before-resolution", "--json"],
    cliEnvironment,
  );
  assert.notEqual(blockedResult.code, 0);
  assert.equal(JSON.parse(blockedResult.stdout).code, "curated_revision_reconfirmation_required");

  const reaffirmIdempotencyKey = "cli-worker-reaffirm-source-change";
  const reaffirmConfirmation = JSON.stringify({
    production_target: status.production_target,
    operation: "reaffirm",
    current_catalogue_revision_id: currentRevisionId,
    curated_revision_id: created.curated_revision_id,
    expected_event_version: 2,
    conflict_digest: shown.pending_conflict.digest,
    idempotency_key: reaffirmIdempotencyKey,
    affected_supported_game: proposal.game,
    current_content_digest: created.content_digest,
    target: shown.content.target,
    conflict_id: shown.pending_conflict.id,
  });
  const reaffirmedResult = await runCli(
    [
      "curated-revision",
      "reaffirm",
      "--revision-id",
      created.curated_revision_id,
      "--event-version",
      "2",
      "--conflict-digest",
      shown.pending_conflict.digest,
      "--rationale",
      "The exception remains necessary after source review.",
      "--expected-current-revision",
      currentRevisionId,
      "--idempotency-key",
      reaffirmIdempotencyKey,
      "--environment",
      "production",
      "--confirm",
      reaffirmConfirmation,
      "--secrets-stdin-fd",
      "3",
      "--yes",
      "--json",
    ],
    cliEnvironment,
    {
      secrets: { administration_key: administrationKey },
    },
  );
  assert.equal(
    reaffirmedResult.code,
    0,
    `${reaffirmedResult.stdout}\n${reaffirmedResult.stderr}\n${ingestion.getOutput()}`,
  );
  const reaffirmed = JSON.parse(reaffirmedResult.stdout);
  assert.match(reaffirmed.operation_id, /^curop_/u);
  assert.deepEqual(
    { ...reaffirmed, operation_id: "<opaque>" },
    {
      operation_id: "<opaque>",
      curated_revision_id: created.curated_revision_id,
      status: "active",
      event_version: 3,
      content_digest: created.content_digest,
      current_catalogue_revision_id: currentRevisionId,
      code: "curated_revision_reaffirmed",
    },
  );

  const freshResult = await runCli(
    ["run", "retry", "--run-id", sourceRunId, "--idempotency-key", "cli-worker-retry-after-reaffirmation", "--json"],
    cliEnvironment,
  );
  assert.equal(freshResult.code, 0, freshResult.stderr);
  const fresh = JSON.parse(freshResult.stdout);
  assert.equal(fresh.state, "awaiting_approval");
  assert.equal(fresh.linked_run_id, sourceRunId);
  const inspectedResult = await runCli(["candidate", "inspect", "--run-id", fresh.id, "--json"], cliEnvironment);
  assert.equal(inspectedResult.code, 0, inspectedResult.stderr);
  const inspected = JSON.parse(inspectedResult.stdout);
  assert.deepEqual(inspected.curated_revision_ids, [created.curated_revision_id]);
  assert.ok(
    inspected.diff.curated_effects.some(
      (effect) =>
        effect.revision_id === created.curated_revision_id &&
        effect.assertion?.presence === proposal.assertion.presence,
    ),
  );
  const rejectedResult = await runCli(
    [
      "run",
      "reject",
      "--run-id",
      fresh.id,
      "--candidate-digest",
      fresh.candidate_digest,
      "--idempotency-key",
      "cli-worker-reject-fresh-run",
      "--yes",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(rejectedResult.code, 0, rejectedResult.stderr);
});

async function baselineSql(vite) {
  const candidate = {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [card],
    printings: [],
    products: [product],
    product_relationships: [officialRelationship],
  };
  const candidateDigest = digest(candidate);
  const approval = {
    action: "approved",
    approved_at: observedAt,
    candidate_digest: candidateDigest,
    expected_current_revision_id: "catrev_spine_000",
  };
  const runSql = await renderRunFixtureSql(vite, {
    id: "run_cli_source_baseline",
    state: "published",
    selected_games_json: '["one-piece"]',
    started_at: observedAt,
    expected_current_revision_id: "catrev_spine_000",
    idempotency_key: "cli-source-baseline",
    candidate_digest: candidateDigest,
    candidate_catalogue_digest: candidateDigest,
    candidate_created_at: observedAt,
    approval_deadline: "2026-08-12T05:06:07.000Z",
    candidate_json: JSON.stringify(candidate),
    approval_json: JSON.stringify(approval),
    warnings_json: "[]",
    approval_history_json: JSON.stringify([approval]),
    publication_revision_id: currentRevisionId,
    publication_started_at: observedAt,
    publication_reconcile_after: "2026-08-05T05:11:07.000Z",
    publication_manifest_digest: candidateDigest,
    publication_writer_token: `writer:${currentRevisionId}`,
    published_revision_id: currentRevisionId,
    export_manifest_digest: candidateDigest,
    terminal_at: observedAt,
    publication_outcome: "revision",
    resulting_revision_id: currentRevisionId,
    freshness_checked_at: observedAt,
    progress_json: JSON.stringify({
      completed_stages: ["planning", "collecting", "parsing", "reconciling", "awaiting_approval", "publishing"],
      current_stage: "published",
    }),
  });
  return `
    ${runSql}
    UPDATE operation_state
    SET active_ingestion_run_id = 'run_cli_source_baseline'
    WHERE singleton = 1;
    INSERT INTO catalogue_revisions (
      id, ingestion_run_id, published_at, content_digest,
      expected_previous_revision_id, approved_candidate_digest
    ) VALUES (
      '${currentRevisionId}', 'run_cli_source_baseline', '${observedAt}',
      '${candidateDigest}', 'catrev_spine_000', '${candidateDigest}'
    );
    INSERT INTO revision_cards (
      catalogue_revision_id, card_id, document_json
    ) VALUES ('${currentRevisionId}', '${card.id}', ${sqlJson(card)});
    UPDATE catalogue_state
    SET current_revision_id = '${currentRevisionId}', published_at = '${observedAt}'
    WHERE singleton = 1;
    UPDATE operation_state
    SET active_ingestion_run_id = NULL
    WHERE singleton = 1;
  `;
}

async function sourceRunSql(vite) {
  const candidate = {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: ["one-piece"],
    cards: [card],
    printings: [],
    products: [product],
    product_relationships: [],
  };
  const candidateDigest = digest(candidate);
  return renderRunFixtureSql(vite, {
    id: sourceRunId,
    state: "failed",
    selected_games_json: '["one-piece"]',
    started_at: observedAt,
    expected_current_revision_id: currentRevisionId,
    idempotency_key: "cli-source-changed-fixture",
    candidate_digest: candidateDigest,
    candidate_catalogue_digest: candidateDigest,
    candidate_created_at: observedAt,
    approval_deadline: "2026-08-12T05:06:07.000Z",
    terminal_at: observedAt,
    candidate_json: JSON.stringify(candidate),
    failure_code: "fixture_source_changed",
    warnings_json: "[]",
    approval_history_json: "[]",
    progress_json: JSON.stringify({
      completed_stages: ["planning", "collecting", "parsing", "reconciling"],
      current_stage: "failed",
    }),
  });
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function sqlJson(value) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
}

async function seedSql(statePath, directory, filename, sql) {
  const file = join(directory, filename);
  await writeFile(file, sql, { mode: 0o600 });
  await executeSql(statePath, file);
}
