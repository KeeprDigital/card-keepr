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
  supplementaryRetainedProposals,
  supplementaryEvidenceCounts,
  supplementaryDecisions,
} from "./helpers/query-helpers/riftbound-supplementary-pilot.mjs";

const lineage = "hexdeck-en";
const fixture = "acceptance/fixtures/real-sources/2026-09-21-hexdeck";
const riotImageUrl =
  "https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/15ed971e4029a92b362a81ccadf309fb81e40b81-744x1039.png?accountingTag=RB";
const blazingArt = "https://imagedelivery.net/hLYQStpAJ2Sj9NgyRRqPTQ/3c5370d6-4818-4270-041a-7590b83f8d00/standard";

// Both HexDeck search pages and both fronts are unchanged captures. Only the
// Riot predecessor's pagination envelope is synthetic: it wraps the one
// unchanged publisher record for OGN-001 and its retained publisher image.
test("HexDeck retains its listings as unresolved review records without touching Riot's Printing through publication and SQL restore", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-hexdeck-"));
  const statePath = join(directory, "state");
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const captures = new Map();
  for (const capture of manifest.captures) {
    const bytes = await readFile(join(fixture, capture.body));
    assert.equal(bytes.length, capture.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), capture.sha256);
    if (capture.run === "stage-3")
      captures.set(capture.url, { bytes, type: capture.response_headers["content-type"], digest: capture.sha256 });
  }
  assert.equal(captures.size, 4);
  const riot = JSON.parse(
    await readFile("acceptance/fixtures/real-sources/2026-09-08-riftbound/raw/cards-0.json", "utf8"),
  );
  riot.data = riot.data.filter((card) => card.id === "ogn-001-298");
  assert.equal(riot.data.length, 1);
  riot.metadata.from = 0;
  riot.metadata.totalItems = 1;
  riot.metadata.totalPages = 1;
  riot.linkdata.self = riot.linkdata.first;
  riot.linkdata.last = riot.linkdata.first;
  delete riot.linkdata.next;
  delete riot.linkdata.previous;
  const riotUrl = new URL(riot.linkdata.first, "https://content.publishing.riotgames.com").href;
  const riotImage = await readFile("acceptance/fixtures/real-sources/2026-09-06/raw/riftbound-image-ogn-001-298.png");
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
      if (request.url === riotImageUrl) return new Response(riotImage, { headers: { "content-type": "image/png" } });
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
    else t.diagnostic(`Retained HexDeck pilot state: ${directory}`);
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
    ["Blazing Scorcher"],
  );
  assert.equal(originalPrintings.length, 1);
  requested.length = 0;
  const pilot = await collect(
    JSON.parse(await readFile("docs/examples/hexdeck-pilot-plan.json", "utf8")),
    "hexdeck-pilot",
  );
  assert.deepEqual(
    [...requested].sort(),
    [...captures.keys()].sort(),
    "Exactly two search pages and two pinned fronts",
  );
  const retained = await cli(["source", "show", "--full", "--run-id", pilot.run.id]);
  assert.equal(retained.snapshots.length, 4);
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
    (proposal) => proposal.source_lineage === lineage,
  );
  assert.equal(proposals.length, 2, "The pinned Blazing Scorcher listing and the OGN T01 Buff token");
  assert.ok(proposals.every((proposal) => proposal.status === "unresolved"));
  const blazing = proposals.find((proposal) => JSON.parse(proposal.reference)[0] === "cmpmw79dv00wuqg6x47fpe8yb");
  const buff = proposals.find((proposal) => JSON.parse(proposal.reference)[0] === "cmpmw7kdx016hqg6xq59srhe8");
  assert.ok(blazing && buff);
  for (const [proposal, digest] of [
    [blazing, "f0655cf3301d0778b42245b27b648f9c4a49b5db9f3e71a9ae5919a6a0a72119"],
    [buff, "58da926e840907f0907f5858beecd27019c8274551b8282116f36d1c1a19f0c7"],
  ]) {
    const detail = await cli(["entity-proposal", "inspect", "--proposal-id", proposal.id]);
    assert.deepEqual(detail.content.target, { kind: "unresolved_record" });
    assert.deepEqual(
      detail.evidence.issues.map((issue) => issue.code),
      ["card_facts_incomplete", "printing_treatment_unresolved", "physical_issuance_unresolved"],
    );
    assert.equal(detail.evidence.source_images.length, 1);
    assert.equal(detail.evidence.source_images[0].association, "source_record");
    assert.equal(detail.evidence.source_images[0].content_sha256, digest);
  }
  const decisionPath = join(directory, "decision.json");
  await writeFile(
    decisionPath,
    JSON.stringify({
      expected_generation: "0",
      idempotency_key: "unqualified-hexdeck-ogn-001",
      printing_id: originalPrintings[0].id,
      rationale:
        "Disposable negative control: the listing shows the same OGN 001 front as Riot but carries no rules text or artist, so it has no Card and Printing structure to link.",
      exception: {
        scope: ["identity"],
        attestation: "This negative test does not establish identity, finish or issuance.",
      },
    }),
  );
  const denied = await runCli(
    ["entity-proposal", "link", "--proposal-id", blazing.id, "--decision", decisionPath, "--yes", "--json"],
    environment,
  );
  assert.notEqual(denied.code, 0);
  assert.match(denied.stdout + denied.stderr, /admission_structure_invalid/u);
  assert.equal((await cli(["entity-proposal", "inspect", "--proposal-id", blazing.id])).history.length, 0);
  const candidate = pilot.collection.candidates[0];
  const publication = await publishNativeCollection(
    { candidates: [candidate] },
    "hexdeck-pilot",
    environment,
    worker,
    120000,
  );
  assert.equal(
    publication.resulting_revision_id,
    first.resulting_revision_id,
    "Review records alone change no accepted Catalogue Data",
  );
  assert.notEqual(publication.backup_attempt_id, first.backup_attempt_id);
  const cards = (await get("/v1/cards?game=riftbound")).data;
  const printings = (await get("/v1/printings?game=riftbound")).data;
  assert.deepEqual(cards, originalCards);
  assert.deepEqual(printings, originalPrintings);
  assert.equal(printings[0].printing_images.length, 1, "HexDeck's front is private evidence, not a Printing Image");
  const reader = nativeExportReader(250);
  const exported = {};
  for (const kind of ["cards", "printings"])
    exported[kind] = await reader.records(api.url, key, publication.resulting_revision_id, kind);
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
    assert.deepEqual(bytes, riotImage);
    assert.notDeepEqual(bytes, captures.get(blazingArt).bytes, "Riot's PNG and HexDeck's WebP are separate assets");
    assert.equal((await fetch(image.links.content)).status, 401);
  };
  await verifyImage(printings[0]);
  const consumer = JSON.stringify({ cards, printings, exported });
  for (const field of ["source_lineage", "source_record_json", "imagedelivery", "source_images", "searchTags"])
    assert.equal(consumer.includes(field), false, field);
  await stopWorker(api);
  await stopWorker(worker);
  const imports = (await readdir(directory))
    .filter((name) => /^restore-\d+\.sqlite$/u.test(name))
    .sort((a, b) => Number(a.match(/\d+/u)[0]) - Number(b.match(/\d+/u)[0]));
  assert.equal(imports.length, 2, "Both publications completed actual isolated SQL imports");
  const restoredDatabase = new DatabaseSync(join(directory, imports.at(-1)), { readOnly: true });
  try {
    const restoredProposals = supplementaryRetainedProposals(restoredDatabase).all(lineage);
    assert.equal(restoredProposals.length, 2);
    assert.deepEqual(
      supplementaryEvidenceCounts(restoredDatabase)
        .all(lineage)
        .map((row) => row.observations),
      [1, 1],
    );
    assert.equal(supplementaryDecisions(restoredDatabase).all(lineage).length, 0);
    for (const proposal of restoredProposals) {
      const evidence = JSON.parse(proposal.evidence_json);
      assert.equal(evidence.source_images.length, 1);
      assert.ok(evidence.source_images[0].content_object_key, "Retained front bytes remain referenced after restore");
    }
  } finally {
    restoredDatabase.close();
  }
  const restored = await verifiedBackupApiState(statePath, directory);
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath: restored, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  reader.clear();
  for (const kind of ["cards", "printings"])
    assert.deepEqual(await reader.records(api.url, key, publication.resulting_revision_id, kind), exported[kind]);
  await verifyImage((await get("/v1/printings?game=riftbound")).data[0]);
  passed = true;
});
