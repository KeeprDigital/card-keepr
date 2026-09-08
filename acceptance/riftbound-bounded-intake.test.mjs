import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
  waitForAdministrationDocument,
} from "./helpers/acceptance-runtime.mjs";
import { nativeCheckpointTransport, publishNativeCollection } from "./helpers/native-catalogue-runtime.mjs";
import { nativeExportReader } from "./helpers/native-export-reader.mjs";
import { verifiedBackupApiState } from "./helpers/verified-backup-api-state.mjs";
import { isNativeCheckpointRequest } from "./helpers/native-checkpoint-hosts.mjs";

// Compact synthetic page metadata around two retained publisher records and real
// image URLs/bytes. This proves the vertical storage contract, not source coverage.
test("bounded Riftbound records retain owner review, native publication and actual SQL restore", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-bounded-riftbound-"));
  const statePath = join(directory, "state");
  const page = JSON.parse(
    await readFile("acceptance/fixtures/real-sources/2026-09-08-riftbound/raw/cards-0.json", "utf8"),
  );
  const selected = ["ogn-001-298", "ogn-066a-298"];
  page.data = page.data.filter((card) => selected.includes(card.id));
  assert.equal(page.data.length, 2);
  // Accepted, unmapped publisher text forces independently addressed field
  // chunks while preserving the two records' Card and Printing semantics.
  page.data[0].bounded_intake_validation_text = "retained publisher field ".repeat(1800);
  page.metadata.totalItems = 2;
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
  const config = JSON.parse(await readFile("apps/ingestion/wrangler.jsonc", "utf8"));
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
    passed = false;
  t.after(async () => {
    if (api) await stopWorker(api);
    await stopWorker(worker);
    if (passed) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained bounded intake state: ${directory}`);
  });
  await waitForHealth(`${worker.url}/health`, key, worker);
  const environment = { KEEPR_INGESTION_URL: worker.url, KEEPR_ADMINISTRATION_KEY: key };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const area of ["card_facts", "printing_details"])
    await cli([
      "source",
      "designate",
      "--game",
      "riftbound",
      "--locale",
      "en",
      "--release-region",
      "US",
      "--source-lineage",
      "riftbound-en",
      "--area",
      area,
      "--expected-generation",
      "0",
      "--rationale",
      "Compact bounded intake regression",
      "--idempotency-key",
      `bounded-${area}`,
    ]);
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
  const run = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", "bounded-source"]);
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
  assert.equal(proposals.proposals.length, 2);
  const ids = [];
  for (const proposal of proposals.proposals) {
    const decision = join(directory, "decision.json");
    await writeFile(
      decision,
      JSON.stringify({
        expected_generation: "0",
        idempotency_key: `bounded-${proposal.id}`,
        rationale: "Synthetic regression accepts the retained Printing evidence.",
        exception: {
          scope: ["identity"],
          attestation: "Test-only review decision for the two retained image fixtures; no production admission.",
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
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: apiKey } });
  await waitForHealth(`${api.url}/health`, apiKey, api);
  const reader = nativeExportReader(250);
  const printings = await reader.records(api.url, apiKey, publication.resulting_revision_id, "printings");
  assert.deepEqual(printings.map((p) => p.id).sort(), ids.sort());
  await stopWorker(api);
  await stopWorker(worker);
  const imports = (await readdir(directory))
    .filter((name) => /^restore-\d+\.sqlite$/u.test(name))
    .sort((a, b) => Number(a.match(/\d+/u)[0]) - Number(b.match(/\d+/u)[0]));
  const restoredDb = new DatabaseSync(join(directory, imports.at(-1)), { readOnly: true });
  try {
    assert.equal(restoredDb.prepare("SELECT COUNT(*) AS n FROM source_record_pages").get().n, 2);
    assert.deepEqual(
      { ...restoredDb.prepare("SELECT next_ordinal,sealed FROM source_record_progress").get() },
      { next_ordinal: 2, sealed: 1 },
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
      3,
    );
    assert.equal(restoredDb.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    restoredDb.close();
  }
  const restored = await verifiedBackupApiState(statePath, directory);
  reader.clear();
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath: restored, vars: { API_BEARER_KEY: apiKey } });
  await waitForHealth(`${api.url}/health`, apiKey, api);
  assert.deepEqual(await reader.records(api.url, apiKey, publication.resulting_revision_id, "printings"), printings);
  passed = true;
});
