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

const lineage = "piltover-archive-en";
const fixture = "acceptance/fixtures/real-sources/2026-09-21-piltover-archive";
const riotImageUrl =
  "https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/15ed971e4029a92b362a81ccadf309fb81e40b81-744x1039.png?accountingTag=RB";

// The Piltover gallery page and both front images are unchanged captures. Only
// the Riot predecessor's pagination envelope is synthetic: it wraps the one
// unchanged publisher record for OGN-001 and its retained publisher image.
test("Piltover Archive links its Riot overlap with separate front evidence and retains the Chinese-print promo lead through publication and SQL restore", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-piltover-archive-"));
  const statePath = join(directory, "state");
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const captures = new Map();
  for (const capture of manifest.captures) {
    const bytes = await readFile(join(fixture, capture.body));
    assert.equal(bytes.length, capture.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), capture.sha256);
    captures.set(capture.url, { bytes, type: capture.response_headers["content-type"], digest: capture.sha256 });
  }
  assert.equal(captures.size, 3);
  const riot = JSON.parse(
    await readFile("acceptance/fixtures/real-sources/2026-09-08-riftbound/raw/cards-0.json", "utf8"),
  );
  riot.data = riot.data.filter((card) => card.id === "ogn-001-298");
  assert.equal(riot.data.length, 1);
  assert.equal(riot.data[0].cardImage.url, riotImageUrl);
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
    else t.diagnostic(`Retained Piltover Archive pilot state: ${directory}`);
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
    ["Blazing Scorcher"],
  );
  assert.equal(originalPrintings.length, 1);
  assert.equal(originalPrintings[0].printing_images.length, 1);
  requested.length = 0;
  const pilot = await collect(
    JSON.parse(await readFile("docs/examples/piltover-archive-pilot-plan.json", "utf8")),
    "piltover-archive-pilot",
  );
  assert.deepEqual(
    [...requested].sort(),
    [...captures.keys()].sort(),
    "Exactly the gallery page and two pinned fronts",
  );
  const retained = await cli(["source", "show", "--full", "--run-id", pilot.run.id]);
  assert.equal(retained.snapshots.length, 3);
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
  assert.equal(proposals.length, 2, "One Riot overlap and one supplementary promo lead");
  assert.ok(proposals.every((proposal) => proposal.status === "unresolved"));
  const overlap = proposals.find(
    (proposal) => JSON.parse(proposal.reference)[0] === "15eb5d43-3264-410f-9ba7-2dba0b3a185d",
  );
  const lead = proposals.find(
    (proposal) => JSON.parse(proposal.reference)[0] === "a60d2063-be1a-4ee5-a745-784eef4ed8b1",
  );
  assert.ok(overlap && lead);
  const leadDetail = await cli(["entity-proposal", "inspect", "--proposal-id", lead.id]);
  assert.deepEqual(leadDetail.content.target, { kind: "unresolved_record" });
  assert.deepEqual(
    leadDetail.evidence.issues.map((issue) => issue.code),
    ["printing_locale_unresolved", "printing_treatment_unresolved", "physical_issuance_unresolved"],
  );
  assert.equal(leadDetail.evidence.source_images.length, 1);
  assert.equal(leadDetail.evidence.source_images[0].association, "source_record");
  assert.equal(
    leadDetail.evidence.source_images[0].content_sha256,
    "b96e5881f9ca253550bf2aa124189a32097c3a5caf28adcbb18433f505c2a4df",
  );
  const decisionPath = join(directory, "decision.json");
  await writeFile(
    decisionPath,
    JSON.stringify({
      expected_generation: "0",
      idempotency_key: "unqualified-arc-001",
      rationale:
        "Disposable negative control: the retained ARC-001 front is a Chinese-language print, and an identity exception cannot invent the missing English Card and Printing structure.",
      exception: {
        scope: ["identity"],
        attestation: "This negative test does not establish English issuance, finish or identity.",
      },
    }),
  );
  const denied = await runCli(
    ["entity-proposal", "admit", "--proposal-id", lead.id, "--decision", decisionPath, "--yes", "--json"],
    environment,
  );
  assert.notEqual(denied.code, 0);
  assert.match(denied.stdout + denied.stderr, /admission_structure_invalid/u);
  assert.equal((await cli(["entity-proposal", "inspect", "--proposal-id", lead.id])).history.length, 0);
  const initial = pilot.collection.candidates[0];
  await cli([
    "game-candidate",
    "abandon",
    "--candidate-id",
    initial.id,
    "--generation",
    String(initial.generation),
    "--idempotency-key",
    "piltover-archive-unreviewed",
    "--yes",
  ]);
  await writeFile(
    decisionPath,
    JSON.stringify({
      expected_generation: "0",
      idempotency_key: "piltover-archive-ogn-001-link",
      printing_id: originalPrintings[0].id,
      rationale:
        "The retained Riot record and the retained Piltover English front both show Blazing Scorcher OGN-001/298 with matching name, type, rarity, domain, tags, stats, Accelerate wording and Envar Studio credit. Piltover's WebP is separate front evidence of the same Printing, not independent corroboration of Riot's facts.",
      exception: {
        scope: ["identity"],
        attestation:
          "Disposable pilot owner links only the inspected Blazing Scorcher Printing. ARC-001's locale, finish and issuance remain unresolved.",
      },
    }),
  );
  const linked = await cli([
    "entity-proposal",
    "link",
    "--proposal-id",
    overlap.id,
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
    "piltover-archive-reviewed",
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
    "piltover-archive-reviewed",
    environment,
    worker,
    120000,
  );
  assert.notEqual(
    publication.resulting_revision_id,
    first.resulting_revision_id,
    "A second retained front for the Printing is accepted consumer data",
  );
  assert.notEqual(publication.backup_attempt_id, first.backup_attempt_id);
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
  assert.deepEqual(cards[0].game_data, originalCards[0].game_data, "Riot's Card facts are unchanged by the overlap");
  assert.equal(printings[0].game_data.attributes.finish, null);
  assert.equal(printings[0].printed_rules_text, null);
  assert.equal(printings[0].printing_images.length, 2, "Riot's PNG and Piltover's WebP fronts");
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
  const expectedFronts = new Map([
    [createHash("sha256").update(riotImage).digest("hex"), riotImage],
    [
      captures.get("https://cdn.piltoverarchive.com/cards/OGN-001.webp").digest,
      captures.get("https://cdn.piltoverarchive.com/cards/OGN-001.webp").bytes,
    ],
  ]);
  const verifyImages = async (printing) => {
    assert.deepEqual(
      printing.printing_images.map((image) => image.content_sha256).sort(),
      [...expectedFronts.keys()].sort(),
    );
    for (const image of printing.printing_images) {
      const response = await fetch(image.links.content, { headers });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(createHash("sha256").update(bytes).digest("hex"), image.content_sha256);
      assert.deepEqual(bytes, expectedFronts.get(image.content_sha256));
      assert.equal((await fetch(image.links.content)).status, 401);
    }
  };
  await verifyImages(printings[0]);
  assert.equal((await cli(["entity-proposal", "inspect", "--proposal-id", lead.id])).status, "unresolved");
  const consumer = JSON.stringify({ cards, printings, exported });
  for (const field of [
    "source_lineage",
    "source_record_json",
    "cardmarket",
    "tcgplayer",
    "source_images",
    "artwork_fingerprint",
  ])
    assert.equal(consumer.includes(field), false, field);
  await stopWorker(api);
  await stopWorker(worker);
  const imports = (await readdir(directory))
    .filter((name) => /^restore-\d+\.sqlite$/u.test(name))
    .sort((a, b) => Number(a.match(/\d+/u)[0]) - Number(b.match(/\d+/u)[0]));
  assert.equal(imports.length, 2, "Both publications completed actual isolated SQL imports");
  const restoredDatabase = new DatabaseSync(join(directory, imports.at(-1)), { readOnly: true });
  try {
    assert.equal(supplementaryRetainedProposals(restoredDatabase).all(lineage).length, 2);
    const counts = supplementaryEvidenceCounts(restoredDatabase).all(lineage);
    assert.deepEqual(
      counts.map((row) => row.observations),
      [1, 1],
    );
    const decisions = supplementaryDecisions(restoredDatabase).all(lineage);
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
  await verifyImages(restoredPrintings[0]);
  passed = true;
});
