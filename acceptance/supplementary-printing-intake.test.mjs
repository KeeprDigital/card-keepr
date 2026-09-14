import { readWorkerConfig } from "../cli/lib/config.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
  waitForAdministrationDocument,
} from "./helpers/acceptance-runtime.mjs";
import { inspectNativeCollection } from "./helpers/native-catalogue-runtime.mjs";

// Reuses the retained #219 comparison: Limitless v4's WINNER appearance is
// absent from the seven-record Bandai P-001 catalogue. The declared source
// contracts require those seven records and all eight Limitless variants.
test("a real supplementary-only Printing remains excluded until the owner explicitly admits its identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-supplementary-intake-"));
  const statePath = join(directory, "state");
  const root = resolve("acceptance/fixtures/real-sources/2026-09-06");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const captures = new Map(
    await Promise.all(
      manifest.captures
        .filter((capture) => /^(?:bandai-p001|limitless-p001)/u.test(capture.id))
        .map(async (capture) => [capture.url, { ...capture, bytes: await readFile(join(root, capture.body)) }]),
    ),
  );
  const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  delete config.$schema;
  config.main = resolve("apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  await applyMigrations(statePath);
  const key = crypto.randomUUID();
  const worker = await startWorker({
    config: configPath,
    statePath,
    vars: { ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService: (request) => {
      const capture = captures.get(request.url);
      assert.ok(capture, `Unexpected source request ${request.url}`);
      return new Response(capture.bytes, { headers: { "content-type": capture.contentType } });
    },
  });
  let passed = false;
  t.after(async () => {
    await stopWorker(worker);
    if (passed) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained supplementary intake state: ${directory}`);
  });
  await waitForHealth(`${worker.url}/health`, key, worker);
  const environment = {
    KEEPR_INGESTION_URL: worker.url,
    KEEPR_ADMINISTRATION_KEY: key,
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "2200",
  };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const planPath = join(directory, "plan.json");
  await writeFile(
    planPath,
    JSON.stringify({
      plans: [
        {
          supported_game: "one-piece",
          source_lineage: "one-piece-en",
          adapter_version: "one-piece-en@6",
          subset: "p-001-catalogue",
          requests: [
            { id: "one-piece-en:p-001-catalogue", url: "https://en.onepiece-cardgame.com/cardlist/?freewords=P-001" },
          ],
        },
        {
          supported_game: "one-piece",
          source_lineage: "limitless-one-piece-en",
          adapter_version: "limitless-one-piece-en@1",
          subset: "p-001-catalogue",
          requests: [
            { id: "limitless-one-piece-en:p-001-catalogue", url: "https://onepiece.limitlesstcg.com/cards/en/P-001" },
          ],
        },
      ],
    }),
  );
  const run = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", "supplementary-source"]);
  await cli(["source", "resume", "--run-id", run.id]);
  const collection = await waitForAdministrationDocument(
    `/v1/ingestion-runs/${run.id}/game-candidates`,
    (document) =>
      document.candidates.some((candidate) => ["failed", "paused"].includes(candidate.state))
        ? JSON.stringify(document)
        : document.candidates.length === 1 && document.candidates[0].state === "sealed",
    environment,
    worker,
    { deadlineMs: 120000 },
  );
  const intake = await inspectNativeCollection(run.id, environment, {
    partitionKinds: ["cards", "printings", "warnings", "shared_warnings"],
  });
  assert.equal((intake.records.cards ?? []).length, 0);
  assert.equal((intake.records.printings ?? []).length, 0);
  const proposals = (await cli(["entity-proposal", "list", "--game", "one-piece"])).proposals;
  assert.equal(proposals.filter((proposal) => proposal.source_lineage === "one-piece-en").length, 7);
  assert.equal(proposals.filter((proposal) => proposal.source_lineage === "limitless-one-piece-en").length, 8);
  const winner = proposals.find(
    (proposal) => proposal.source_lineage === "limitless-one-piece-en" && JSON.parse(proposal.reference)[1] === "v4",
  );
  assert.ok(winner);
  assert.equal(winner.status, "unresolved");
  assert.ok(
    intake.warnings.some((warning) => warning.code === "entity_proposal_excluded" && warning.proposal_id === winner.id),
  );
  const candidate = collection.candidates[0];
  await cli([
    "game-candidate",
    "abandon",
    "--candidate-id",
    candidate.id,
    "--generation",
    String(candidate.generation),
    "--idempotency-key",
    "retain-supplementary-intake",
    "--yes",
  ]);
  const decisionPath = join(directory, "decision.json");
  await writeFile(
    decisionPath,
    JSON.stringify({
      expected_generation: "0",
      idempotency_key: "review-winner",
      rationale:
        "Replay of the retained #219 P-001 comparison: harbour Luffy artwork and championship WINNER stamp are absent from the bounded Bandai catalogue.",
      exception: {
        scope: ["identity"],
        attestation:
          "The retained Limitless v4 image establishes the issued appearance reviewed in the 2026-09-06 evidence pack. No physical finish or original printed wording is inferred.",
      },
    }),
  );
  const admitted = await cli([
    "entity-proposal",
    "admit",
    "--proposal-id",
    winner.id,
    "--decision",
    decisionPath,
    "--yes",
  ]);
  assert.equal(admitted.status, "admitted");
  assert.equal(admitted.history[0].actor, "owner");
  const prepared = await cli([
    "game-candidate",
    "prepare",
    "--run-id",
    run.id,
    "--game",
    "one-piece",
    "--expected-game-revision-id",
    "catrev_spine_000",
    "--idempotency-key",
    "reviewed-winner",
    "--yes",
  ]);
  await waitForAdministrationDocument(
    `/v1/game-candidates/${prepared.id}`,
    (document) =>
      document.state === "sealed" || (["failed", "paused"].includes(document.state) ? JSON.stringify(document) : false),
    environment,
    worker,
    { deadlineMs: 120000 },
  );
  const inspection = await cli(["game-candidate", "inspect", "--candidate-id", prepared.id]);
  assert.equal(inspection.ready, true);
  const records = { cards: [], printings: [] };
  let after = null;
  do {
    const page = await cli([
      "game-candidate",
      "partitions",
      "--candidate-id",
      prepared.id,
      ...(after ? ["--after", after] : []),
    ]);
    for (const partition of page.partitions) {
      if (!(partition.kind in records)) continue;
      const content = await cli([
        "game-candidate",
        "partition",
        "--candidate-id",
        prepared.id,
        "--ordinal",
        String(partition.ordinal),
        "--manifest",
        inspection.manifest_digest,
      ]);
      records[partition.kind].push(...content.records);
    }
    after = page.next_cursor;
  } while (after);
  assert.equal(records.cards.length, 1);
  assert.equal(records.cards[0].name, "Monkey.D.Luffy");
  assert.equal(records.cards[0].game_data.attributes.power, 7000);
  assert.equal(records.printings.length, 1);
  assert.equal(records.printings[0].id, admitted.history[0].decision.printing.id);
  assert.equal(records.printings[0].printed_rules_text, null);
  passed = true;
});
