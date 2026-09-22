import { fixtureAcquisitionBudgetPath } from "./helpers/acquisition-budget.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import {
  applyMigrations,
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
import {
  riftboundDbRetainedProposals,
  riftboundDbEvidenceCounts,
  riftboundDbDecisions,
} from "./helpers/query-helpers/riftbound-db-pilot.mjs";

// Riftbound DB responses and all four image bodies are unchanged captures.
// Only the Riot predecessor's pagination envelope is synthetic: it wraps one
// unchanged publisher record to keep this two-source publication test bounded.
test("Riftbound DB retains unresolved real promos and links the Riot overlap through publication and SQL restore", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-riftbound-db-"));
  const statePath = join(directory, "state");
  const fixture = "acceptance/fixtures/real-sources/2026-09-14-riftbound-db";
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const captures = new Map();
  for (const capture of manifest.captures) {
    const bytes = await readFile(join(fixture, capture.body));
    assert.equal(bytes.length, capture.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), capture.sha256);
    const headers = Object.fromEntries(
      Object.entries(capture.response_headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    if (headers["content-type"].startsWith("image/") || capture.url.includes("/api/"))
      captures.set(capture.url, { bytes, type: headers["content-type"], digest: capture.sha256 });
  }
  assert.equal(captures.size, 7);
  const riot = JSON.parse(
    await readFile("acceptance/fixtures/real-sources/2026-09-08-riftbound/raw/cards-200.json", "utf8"),
  );
  riot.data = riot.data.filter((card) => card.id === "ogn-059-298");
  assert.equal(riot.data.length, 1);
  riot.metadata.from = 0;
  riot.metadata.totalItems = 1;
  riot.metadata.totalPages = 1;
  riot.linkdata.self = riot.linkdata.first;
  riot.linkdata.last = riot.linkdata.first;
  delete riot.linkdata.next;
  delete riot.linkdata.previous;
  const riotUrl = new URL(riot.linkdata.first, "https://content.publishing.riotgames.com").href;
  const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  delete config.$schema;
  config.main = resolve("apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  await applyMigrations(statePath);
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  const key = crypto.randomUUID();
  const requested = [];
  const worker = await startWorker({
    ...checkpoint,
    config: configPath,
    statePath,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService(request) {
      if (isNativeCheckpointRequest(request)) return checkpoint.outboundService(request);
      requested.push(request.url);
      if (request.url === riotUrl) return Response.json(riot);
      const capture = captures.get(request.url);
      assert.ok(capture, `Unexpected source acquisition: ${request.url}`);
      return new Response(capture.bytes, { headers: { "content-type": capture.type } });
    },
  });
  let api,
    passed = false;
  t.after(async () => {
    if (api) await stopWorker(api);
    await stopWorker(worker);
    if (passed) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained Riftbound DB pilot state: ${directory}`);
  });
  await waitForHealth(`${worker.url}/health`, key, worker);
  const environment = {
    KEEPR_INGESTION_URL: worker.url,
    KEEPR_ADMINISTRATION_KEY: key,
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "2200",
  };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    const expected = args[0] === "game-candidate" && ["prepare", "abandon"].includes(args[1]) ? 10 : 0;
    assert.equal(result.code, expected, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const collect = async (plan, idempotency) => {
    const path = join(directory, `${idempotency}.json`);
    await writeFile(path, JSON.stringify(plan));
    const run = await cli([
      "source",
      "collect",
      "--budget-file",
      fixtureAcquisitionBudgetPath,
      "--plan-file",
      path,
      "--idempotency-key",
      idempotency,
    ]);
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
    return { run, collection };
  };
  const predecessor = await collect(
    {
      plans: [
        {
          supported_game: "riftbound",
          source_lineage: "riftbound-en",
          adapter_version: "riftbound-en@1",
          subset: "public-english-inventory",
          requests: [{ id: "riftbound-en:catalogue", url: riotUrl }],
        },
      ],
    },
    "riot-overlap-control",
  );
  const first = await publishNativeCollection(
    predecessor.collection,
    "riot-overlap-control",
    environment,
    worker,
    120000,
  );
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  const headers = { authorization: `Bearer ${key}` };
  const get = async (path) => {
    const response = await fetch(`${api.url}${path}`, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const originalCards = (await get("/v1/cards?game=riftbound")).data;
  const originalPrintings = (await get("/v1/printings?game=riftbound")).data;
  assert.deepEqual(
    originalCards.map((card) => card.name),
    ["Eclipse Herald"],
  );
  assert.equal(originalPrintings.length, 1);
  requested.length = 0;
  const pilot = await collect(
    JSON.parse(await readFile("docs/examples/riftbound-db-pilot-plan.json", "utf8")),
    "riftbound-db-pilot",
  );
  assert.deepEqual(
    [...requested].sort(),
    [...captures.keys()].sort(),
    "One request per distinct image, including the identical Bird duplicate",
  );
  const retained = await cli(["source", "show", "--full", "--run-id", pilot.run.id]);
  assert.equal(retained.snapshots.length, 7);
  for (const snapshot of retained.snapshots)
    assert.equal(snapshot.content.digest, captures.get(snapshot.request.url).digest);
  const intake = await inspectNativeCollection(pilot.run.id, environment, {
    candidates: pilot.collection.candidates,
    partitionKinds: ["cards", "printings"],
  });
  assert.deepEqual(
    intake.records.cards.map((card) => card.id),
    originalCards.map((card) => card.id),
  );
  assert.deepEqual(
    intake.records.printings.map((printing) => printing.id),
    originalPrintings.map((printing) => printing.id),
  );
  const proposals = (await cli(["entity-proposal", "list", "--game", "riftbound"])).proposals.filter(
    (proposal) => proposal.source_lineage === "riftbound-db-en",
  );
  assert.equal(proposals.length, 5, "Six query records contain five unique source IDs");
  assert.ok(proposals.every((proposal) => proposal.status === "unresolved"));
  const eclipse = proposals.find((proposal) => JSON.parse(proposal.reference)[0] === "69bc5bc9d308c64675ca86f6");
  const bird = proposals.find(
    (proposal) => JSON.parse(proposal.reference)[0] === "openrift-019e1fea-0113-7f38-b59d-23cab5997383",
  );
  assert.ok(eclipse && bird);
  const birdDetail = await cli(["entity-proposal", "inspect", "--proposal-id", bird.id]);
  assert.deepEqual(birdDetail.content.target, { kind: "unresolved_record" });
  assert.equal(birdDetail.evidence.source_images.length, 1);
  assert.equal(
    birdDetail.evidence.source_images[0].content_sha256,
    "7017a24aedbfefa54ada92f08b0a257b6b41fd7af1f2403ef0688bb055bc510b",
  );
  assert.equal(birdDetail.evidence.source_images[0].association, "source_record");
  const decisionPath = join(directory, "decision.json");
  await writeFile(
    decisionPath,
    JSON.stringify({
      expected_generation: "0",
      idempotency_key: "unqualified-bird",
      rationale:
        "Disposable negative control: an identity exception cannot invent the missing Card and Printing structure.",
      exception: {
        scope: ["identity"],
        attestation: "This negative test does not establish physical issuance or identity.",
      },
    }),
  );
  const denied = await runCli(
    ["entity-proposal", "admit", "--proposal-id", bird.id, "--decision", decisionPath, "--yes", "--json"],
    environment,
  );
  assert.notEqual(denied.code, 0);
  assert.match(denied.stdout + denied.stderr, /admission_structure_invalid/u);
  assert.equal((await cli(["entity-proposal", "inspect", "--proposal-id", bird.id])).history.length, 0);
  const initial = pilot.collection.candidates[0];
  await cli([
    "game-candidate",
    "abandon",
    "--candidate-id",
    initial.id,
    "--generation",
    String(initial.generation),
    "--idempotency-key",
    "riftbound-db-unreviewed",
    "--yes",
  ]);
  await writeFile(
    decisionPath,
    JSON.stringify({
      expected_generation: "0",
      idempotency_key: "riftbound-db-eclipse-link",
      printing_id: originalPrintings[0].id,
      rationale:
        "The retained Riot record and exact publisher asset show Eclipse Herald OGN-059/298, matching name, artwork, frame, markings and stats. This is attributable upstream overlap, not independent corroboration.",
      exception: {
        scope: ["identity"],
        attestation:
          "Disposable pilot owner links only the inspected Eclipse Herald Printing. Promo identities, foil, back and distribution associations remain unresolved.",
      },
    }),
  );
  const linked = await cli([
    "entity-proposal",
    "link",
    "--proposal-id",
    eclipse.id,
    "--decision",
    decisionPath,
    "--yes",
  ]);
  assert.equal(linked.history[0].actor, "owner");
  assert.equal(linked.history[0].decision.printing.id, originalPrintings[0].id);
  const prepared = await cli([
    "game-candidate",
    "prepare",
    "--run-id",
    pilot.run.id,
    "--game",
    "riftbound",
    "--expected-game-revision-id",
    first.resulting_revision_id,
    "--idempotency-key",
    "riftbound-db-reviewed",
    "--yes",
  ]);
  const candidate = await waitForAdministrationDocument(
    `/v1/game-candidates/${prepared.id}`,
    (document) =>
      document.state === "sealed" || (["failed", "paused"].includes(document.state) ? JSON.stringify(document) : false),
    environment,
    worker,
    { deadlineMs: 120000 },
  );
  const publication = await publishNativeCollection(
    { candidates: [candidate] },
    "riftbound-db-reviewed",
    environment,
    worker,
    120000,
  );
  assert.equal(
    publication.resulting_revision_id,
    first.resulting_revision_id,
    "Identical overlap preserves the immutable consumer revision",
  );
  assert.notEqual(
    publication.backup_attempt_id,
    first.backup_attempt_id,
    "Fresh accepted evidence receives its own verified SQL backup",
  );
  const cards = (await get("/v1/cards?game=riftbound")).data;
  const printings = (await get("/v1/printings?game=riftbound")).data;
  assert.deepEqual(
    cards.map((card) => card.id),
    originalCards.map((card) => card.id),
  );
  assert.deepEqual(
    printings.map((printing) => printing.id),
    originalPrintings.map((printing) => printing.id),
  );
  assert.equal(cards[0].category, "gameplay");
  assert.equal(cards[0].gameplay_applicability, "applicable");
  assert.equal(printings[0].game_data.attributes.finish, null);
  assert.equal(printings[0].game_data.attributes.reverse_face, null);
  assert.equal(printings[0].printed_rules_text, null);
  assert.equal(printings[0].printing_images.length, 1);
  const reader = nativeExportReader(250);
  const exported = {};
  for (const kind of ["cards", "printings"])
    exported[kind] = await reader.records(api.url, key, publication.resulting_revision_id, kind);
  assert.deepEqual(
    exported.cards.map((card) => [card.id, card.game_data, card.category]),
    cards.map((card) => [card.id, card.game_data, card.category]),
  );
  assert.deepEqual(
    exported.printings.map((printing) => [printing.id, printing.card_id, printing.game_data]),
    printings.map((printing) => [printing.id, printing.card_id, printing.game_data]),
  );
  const verifyImage = async (printing) => {
    const image = printing.printing_images[0];
    const response = await fetch(image.links.content, { headers });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), image.content_sha256);
    assert.deepEqual(bytes, captures.get(riot.data[0].cardImage.url).bytes);
    assert.equal((await fetch(image.links.content)).status, 401);
  };
  await verifyImage(printings[0]);
  const privateProposals = proposals.filter((proposal) => proposal.id !== eclipse.id);
  for (const proposal of privateProposals)
    assert.equal((await cli(["entity-proposal", "inspect", "--proposal-id", proposal.id])).status, "unresolved");
  const consumer = JSON.stringify({ cards, printings, exported });
  for (const field of ["source_lineage", "source_record_json", "openrift", "source_images", "artwork_fingerprint"])
    assert.equal(consumer.includes(field), false, field);
  await stopWorker(api);
  await stopWorker(worker);
  const imports = (await readdir(directory))
    .filter((name) => /^restore-\d+\.sqlite$/u.test(name))
    .sort((a, b) => Number(a.match(/\d+/u)[0]) - Number(b.match(/\d+/u)[0]));
  assert.equal(imports.length, 2, "Both publications completed actual isolated SQL imports");
  const restoredDatabase = new DatabaseSync(join(directory, imports.at(-1)), { readOnly: true });
  try {
    const restoredProposals = riftboundDbRetainedProposals(restoredDatabase).all();
    assert.equal(restoredProposals.length, 5);
    const counts = riftboundDbEvidenceCounts(restoredDatabase).all();
    assert.equal(
      counts.find((row) => row.proposal_id === bird.id).observations,
      2,
      "Both duplicate observations remain attributed after restore",
    );
    assert.equal(counts.filter((row) => row.observations === 1).length, 4);
    const decisions = riftboundDbDecisions(restoredDatabase).all();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].action, "link");
    assert.equal(decisions[0].actor, "owner");
    assert.equal(JSON.parse(decisions[0].decision_json).printing.id, originalPrintings[0].id);
  } finally {
    restoredDatabase.close();
  }
  const restored = await verifiedBackupApiState(statePath, directory);
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath: restored, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  reader.clear();
  for (const kind of ["cards", "printings"])
    assert.deepEqual(await reader.records(api.url, key, publication.resulting_revision_id, kind), exported[kind]);
  const restoredPrintings = (await get("/v1/printings?game=riftbound")).data;
  assert.deepEqual(
    restoredPrintings.map((printing) => printing.id),
    originalPrintings.map((printing) => printing.id),
  );
  await verifyImage(restoredPrintings[0]);
  passed = true;
});
