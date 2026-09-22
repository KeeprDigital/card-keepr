import { fixtureAcquisitionBudgetPath } from "./helpers/acquisition-budget.mjs";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyMigrations,
  persistedDatabaseDirectory,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
  waitForAdministrationDocument,
} from "./helpers/acceptance-runtime.mjs";
import {
  inspectNativeCollection,
  nativeCheckpointTransport,
  publishNativeCollection,
} from "./helpers/native-catalogue-runtime.mjs";
import { nativeExportReader } from "./helpers/native-export-reader.mjs";
import { verifiedBackupApiState } from "./helpers/verified-backup-api-state.mjs";
import { isNativeCheckpointRequest } from "./helpers/native-checkpoint-hosts.mjs";

// Compact synthetic page metadata around three retained publisher records and real
// image URLs/bytes. This proves the vertical storage contract, not source coverage.
test("qualified Riot intake keeps explicit exceptions through publication, refresh and actual SQL restore", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-bounded-riftbound-"));
  const statePath = join(directory, "state");
  const page = JSON.parse(
    await readFile("acceptance/fixtures/real-sources/2026-09-08-riftbound/raw/cards-0.json", "utf8"),
  );
  const selected = ["ogn-001-298", "ogn-066a-298", "ogn-067-298"];
  page.data = page.data.filter((card) => selected.includes(card.id));
  assert.equal(page.data.length, 3);
  // Controlled incomplete identity: the retained record and image remain available,
  // but this observation cannot establish a Printing code automatically.
  page.data.find((card) => card.id === "ogn-067-298").publicCode = null;
  // Accepted, unmapped publisher text forces independently addressed field
  // chunks while preserving the records' Card and Printing semantics.
  page.data[0].bounded_intake_validation_text = "retained publisher field ".repeat(1800);
  page.metadata.totalItems = 3;
  page.metadata.totalPages = 1;
  page.linkdata.last = page.linkdata.first;
  delete page.linkdata.next;
  const url = new URL(page.linkdata.first, "https://content.publishing.riotgames.com").href;
  const images = new Map(
    await Promise.all(
      page.data.map(async (card) => [
        card.cardImage.url,
        await readFile(`acceptance/fixtures/real-sources/2026-09-06/raw/riftbound-image-${card.id}.png`),
      ]),
    ),
  );
  const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  delete config.$schema;
  config.main = resolve("apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  await applyMigrations(statePath);
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  const key = crypto.randomUUID(),
    apiKey = crypto.randomUUID();
  const worker = await startWorker({
    ...checkpoint,
    config: configPath,
    statePath,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService: (request) => {
      if (isNativeCheckpointRequest(request)) return checkpoint.outboundService(request);
      if (request.url === url) return Response.json(page);
      assert.ok(images.has(request.url), `Unexpected request ${request.url}`);
      return new Response(images.get(request.url), { headers: { "content-type": "image/png" } });
    },
  });
  let api,
    restoredAdmin,
    passed = false;
  t.after(async () => {
    if (api) await stopWorker(api);
    if (restoredAdmin) await stopWorker(restoredAdmin);
    await stopWorker(worker);
    if (passed) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained bounded intake state: ${directory}`);
  });
  await waitForHealth(`${worker.url}/health`, key, worker);
  const environment = {
    KEEPR_INGESTION_URL: worker.url,
    KEEPR_ADMINISTRATION_KEY: key,
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "2200",
  };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(
      result.code,
      args[0] === "game-candidate" && ["prepare", "pause", "resume", "abandon"].includes(args[1]) ? 10 : 0,
      result.stdout + result.stderr,
    );
    return JSON.parse(result.stdout);
  };
  const planPath = join(directory, "plan.json");
  await writeFile(
    planPath,
    JSON.stringify({
      plans: [
        {
          supported_game: "riftbound",
          source_lineage: "riftbound-en",
          adapter_version: "riftbound-en@1",
          subset: "public-english-inventory",
          requests: [{ id: "riftbound-en:catalogue", url }],
        },
      ],
    }),
  );
  const run = await cli([
    "source",
    "collect",
    "--budget-file",
    fixtureAcquisitionBudgetPath,
    "--plan-file",
    planPath,
    "--idempotency-key",
    "bounded-source",
  ]);
  await cli(["source", "resume", "--run-id", run.id]);
  const collection = await waitForAdministrationDocument(
    `/v1/ingestion-runs/${run.id}/game-candidates`,
    (d) =>
      d.candidates.some((c) => ["failed", "paused"].includes(c.state))
        ? JSON.stringify(d)
        : d.candidates.length === 1 && d.candidates[0].state === "sealed",
    environment,
    worker,
    { deadlineMs: 120000 },
  );
  const intake = await inspectNativeCollection(run.id, environment, {
    candidates: collection.candidates,
    partitionKinds: ["cards", "printings", "errata", "warnings", "shared_warnings"],
  });
  assert.equal((intake.records.cards ?? []).length, 2);
  assert.equal((intake.records.printings ?? []).length, 2);
  assert.deepEqual(intake.records.cards.map((card) => card.name).sort(), ["Ahri, Alluring", "Blazing Scorcher"]);
  assert.ok(intake.warnings.some((warning) => warning.code === "entity_proposal_excluded"));
  assert.equal((intake.records.errata ?? []).length, 0);
  for (const printing of intake.records.printings) {
    assert.equal(printing.printed_rules_text, null);
    assert.equal(printing.game_data.attributes.finish, null);
    assert.equal(printing.game_data.attributes.reverse_face, null);
  }
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: apiKey } });
  await waitForHealth(`${api.url}/health`, apiKey, api);
  const headers = { authorization: `Bearer ${apiKey}` };
  for (const card of intake.records.cards) {
    const response = await fetch(`${api.url}/v1/cards/${card.id}`, { headers });
    assert.equal(response.status, 404, "Automatic admission must not publish a Card");
  }
  const first = collection.candidates[0];
  await cli([
    "game-candidate",
    "abandon",
    "--candidate-id",
    first.id,
    "--generation",
    String(first.generation),
    "--idempotency-key",
    "bounded-initial",
    "--yes",
  ]);
  const proposals = await cli(["entity-proposal", "list", "--game", "riftbound"]);
  assert.equal(proposals.proposals.length, 3);
  assert.equal(proposals.proposals.filter((proposal) => proposal.status === "admitted").length, 2);
  const unresolved = proposals.proposals.filter((proposal) => proposal.status === "unresolved");
  assert.equal(unresolved.length, 1);
  assert.equal(JSON.parse(unresolved[0].reference)[0], "ogn-067-298");
  const ids = intake.records.printings.map((printing) => printing.id);
  const cardIds = intake.records.cards.map((card) => card.id);
  const decisions = new Map();
  for (const proposal of proposals.proposals.filter((proposal) => proposal.status === "admitted")) {
    const admitted = await cli(["entity-proposal", "inspect", "--proposal-id", proposal.id]);
    assert.equal(admitted.history.length, 1);
    assert.equal(admitted.history[0].actor, "automation");
    decisions.set(proposal.id, admitted.history);
  }
  for (const proposal of unresolved) {
    const decision = join(directory, "decision.json");
    await writeFile(
      decision,
      JSON.stringify({
        expected_generation: "0",
        idempotency_key: `bounded-${proposal.id}`,
        rationale: "Synthetic regression accepts the retained Printing evidence.",
        exception: {
          scope: ["identity"],
          attestation:
            "Test-only review of the retained Blitzcrank image establishes identity despite the missing code; no production admission.",
        },
      }),
    );
    const admitted = await cli([
      "entity-proposal",
      "admit",
      "--proposal-id",
      proposal.id,
      "--decision",
      decision,
      "--yes",
    ]);
    ids.push(admitted.history[0].decision.printing.id);
    cardIds.push(admitted.history[0].decision.card.id);
    decisions.set(proposal.id, admitted.history);
    assert.equal(admitted.history[0].actor, "owner");
  }
  const prepared = await cli([
    "game-candidate",
    "prepare",
    "--run-id",
    run.id,
    "--game",
    "riftbound",
    "--expected-game-revision-id",
    "catrev_spine_000",
    "--idempotency-key",
    "bounded-reviewed",
    "--yes",
  ]);
  const candidate = await waitForAdministrationDocument(
    `/v1/game-candidates/${prepared.id}`,
    (d) => d.state === "sealed" || (["failed", "paused"].includes(d.state) ? JSON.stringify(d) : false),
    environment,
    worker,
    { deadlineMs: 120000 },
  );
  const publication = await publishNativeCollection(
    { candidates: [candidate] },
    "bounded-publication",
    environment,
    worker,
    120000,
  );
  const reader = nativeExportReader(250);
  const printings = await reader.records(api.url, apiKey, publication.resulting_revision_id, "printings");
  assert.deepEqual(printings.map((p) => p.id).sort(), ids.sort());
  // A Disposable Restore still contains the exporting Backup Attempt's fence.
  // Use the same owner recovery lifecycle as the composed-recovery journey;
  // only its explicit acceptance permits subsequent source collection.
  const mutate = async (args) => {
    const full = [...args, "--environment", "production", "--yes", "--json"];
    const preview = await runCli(full, environment);
    assert.equal(preview.code, 3, preview.stdout + preview.stderr);
    const confirmation = JSON.parse(preview.stdout).detail.match(/--confirm '(.+)'/)[1];
    const result = await runCli([...full, "--confirm", confirmation], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const backup = publication.checkpoint;
  assert.equal(backup.idempotency_key, publication.backup_attempt_id);
  const recoveryId = "bounded-admission-recovery";
  const recovery = await mutate([
    "recovery",
    "begin",
    "--recovery-id",
    recoveryId,
    "--method",
    "replacement_database",
    "--target-revision",
    publication.resulting_revision_id,
    "--target-bookmark",
    backup.d1_bookmark,
    "--target-digest",
    backup.manifest_sha256,
    "--backup-attempt-id",
    backup.idempotency_key,
    "--expected-current-revision",
    publication.resulting_revision_id,
    "--idempotency-key",
    "bounded-recovery-begin",
  ]);
  assert.equal(recovery.state, "validating");
  const verified = await mutate([
    "recovery",
    "verify",
    "--recovery-id",
    recoveryId,
    "--target-digest",
    backup.manifest_sha256,
    "--idempotency-key",
    "bounded-recovery-verify",
  ]);
  assert.equal(verified.state, "awaiting_acceptance");
  await stopWorker(api);
  await stopWorker(worker);
  const imports = (await readdir(directory))
    .filter((name) => /^restore-\d+\.sqlite$/u.test(name))
    .sort((a, b) => Number(a.match(/\d+/u)[0]) - Number(b.match(/\d+/u)[0]));
  const restoredDb = new DatabaseSync(join(directory, imports.at(-1)), { readOnly: true });
  try {
    assert.equal(restoredDb.prepare("SELECT COUNT(*) AS n FROM source_record_pages").get().n, 3);
    assert.deepEqual(
      { ...restoredDb.prepare("SELECT next_ordinal,sealed FROM source_record_progress").get() },
      { next_ordinal: 3, sealed: 1 },
    );
    assert.equal(
      restoredDb
        .prepare(
          "SELECT COUNT(*) AS n FROM reconciliation_source_byte_chunks c JOIN source_record_progress p ON c.observation_set_id=p.observation_set_id",
        )
        .get().n,
      0,
    );
    assert.equal(
      restoredDb
        .prepare(
          "SELECT COUNT(*) AS n FROM reconciliation_source_observations c JOIN source_record_progress p ON c.observation_set_id=p.observation_set_id",
        )
        .get().n,
      0,
    );
    const auxiliary = restoredDb.prepare("SELECT kind,content,sha256 FROM source_record_auxiliary").all();
    assert.ok(auxiliary.some((row) => row.kind === "text"));
    assert.ok(auxiliary.some((row) => row.kind === "manifest"));
    for (const row of auxiliary) assert.equal(createHash("sha256").update(row.content).digest("hex"), row.sha256);
    assert.equal(
      restoredDb
        .prepare(
          "SELECT COUNT(*) AS n FROM source_record_progress WHERE sealed=1 AND manifest_digest IS NOT NULL AND requests_complete=1",
        )
        .get().n,
      4,
    );
    assert.equal(restoredDb.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    restoredDb.close();
  }
  const restored = statePath;
  // Create the actual replacement binding while retaining the same R2 objects.
  // Select its newly created database file, never the original catalogue file.
  const databaseDirectory = await persistedDatabaseDirectory(restored);
  const originalFiles = new Set(await readdir(databaseDirectory, { recursive: true }));
  const restoredConfig = await readWorkerConfig(configPath);
  restoredConfig.d1_databases[0].database_id = recovery.restored_database_id;
  restoredConfig.vars = { ...restoredConfig.vars, CATALOGUE_D1_DATABASE_ID: recovery.restored_database_id };
  const restoredConfigPath = join(directory, "restored-ingestion.json");
  await writeFile(restoredConfigPath, JSON.stringify(restoredConfig));
  await applyMigrations(restored, restoredConfigPath);
  const replacementFiles = (await readdir(databaseDirectory, { recursive: true })).filter(
    (file) => file.endsWith(".sqlite") && !originalFiles.has(file),
  );
  assert.equal(replacementFiles.length, 1);
  await verifiedBackupApiState(restored, directory, join(databaseDirectory, replacementFiles[0]));
  const restoredApiConfig = await readWorkerConfig("apps/api/wrangler.jsonc");
  delete restoredApiConfig.$schema;
  restoredApiConfig.main = resolve("apps/api/src/index.ts");
  restoredApiConfig.d1_databases[0].database_id = recovery.restored_database_id;
  const restoredApiConfigPath = join(directory, "restored-api.json");
  await writeFile(restoredApiConfigPath, JSON.stringify(restoredApiConfig));
  reader.clear();
  api = await startWorker({ config: restoredApiConfigPath, statePath: restored, vars: { API_BEARER_KEY: apiKey } });
  await waitForHealth(`${api.url}/health`, apiKey, api);
  assert.deepEqual(await reader.records(api.url, apiKey, publication.resulting_revision_id, "printings"), printings);
  // Unchanged image URLs are reused without a request on refresh (#389), so the
  // refresh publishes a changed URL for one front to exercise a current outage.
  const refreshPage = structuredClone(page);
  const outageCard = refreshPage.data.find((card) => card.id === "ogn-001-298");
  const unavailableImageUrl = `${outageCard.cardImage.url}${outageCard.cardImage.url.includes("?") ? "&" : "?"}refresh-outage=1`;
  outageCard.cardImage.url = unavailableImageUrl;
  let imageOutages = 0;
  restoredAdmin = await startWorker({
    ...checkpoint,
    config: restoredConfigPath,
    statePath: restored,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService: (request) => {
      if (request.url === url) return Response.json(refreshPage);
      if (request.url === unavailableImageUrl) {
        imageOutages++;
        return new Response(null, { status: 404 });
      }
      assert.ok(images.has(request.url), `Unexpected refresh request ${request.url}`);
      return new Response(images.get(request.url), { headers: { "content-type": "image/png" } });
    },
  });
  await waitForHealth(`${restoredAdmin.url}/health`, key, restoredAdmin);
  environment.KEEPR_INGESTION_URL = restoredAdmin.url;
  const accepted = await mutate([
    "recovery",
    "accept",
    "--recovery-id",
    recoveryId,
    "--expected-restored-revision",
    publication.resulting_revision_id,
    "--target-digest",
    backup.manifest_sha256,
    "--confirmation-recovery-id",
    recoveryId,
    "--idempotency-key",
    "bounded-recovery-accept",
  ]);
  assert.equal(accepted.state, "accepted");
  const refreshed = await cli([
    "source",
    "collect",
    "--budget-file",
    fixtureAcquisitionBudgetPath,
    "--plan-file",
    planPath,
    "--idempotency-key",
    "restored-refresh",
  ]);
  assert.notEqual(refreshed.id, run.id);
  await cli(["source", "resume", "--run-id", refreshed.id]);
  const refreshedCollection = await waitForAdministrationDocument(
    `/v1/ingestion-runs/${refreshed.id}/game-candidates`,
    (d) =>
      d.candidates.some((candidate) => ["failed", "paused"].includes(candidate.state))
        ? JSON.stringify(d)
        : d.candidates.length === 1 && d.candidates[0].state === "sealed",
    environment,
    restoredAdmin,
    { deadlineMs: 120000 },
  );
  const refreshedIntake = await inspectNativeCollection(refreshed.id, environment, {
    candidates: refreshedCollection.candidates,
    partitionKinds: ["cards", "printings", "warnings", "shared_warnings"],
  });
  assert.ok(imageOutages > 0, "Refresh must exercise an actual current image failure");
  assert.ok(
    refreshedIntake.warnings.some(
      (warning) => warning.code === "printing_image_unavailable" && warning.source_url === unavailableImageUrl,
    ),
  );
  assert.deepEqual(refreshedIntake.records.printings.map((printing) => printing.id).sort(), ids.sort());
  assert.deepEqual(refreshedIntake.records.cards.map((card) => card.id).sort(), cardIds.sort());
  for (const [proposalId, history] of decisions)
    assert.deepEqual((await cli(["entity-proposal", "inspect", "--proposal-id", proposalId])).history, history);
  assert.deepEqual(await reader.records(api.url, apiKey, publication.resulting_revision_id, "printings"), printings);
  passed = true;
});
