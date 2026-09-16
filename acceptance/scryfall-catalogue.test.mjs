import { fixtureAcquisitionBudgetPath } from "./helpers/acquisition-budget.mjs";
import * as responseValidators from "../test/support/http-response-validators.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import {
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
import { assertIdentityCliDocument, assertIdentityDocument } from "./helpers/identity-http-contract.mjs";

test("retained Scryfall Cards publish with stable finish identities, private evidence and actual SQL restore", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-scryfall-"));
  const statePath = join(directory, "state");
  const pack = "acceptance/fixtures/real-sources/2026-09-14-scryfall";
  const manifest = JSON.parse(await readFile(`${pack}/manifest.json`, "utf8"));
  const responses = new Map();
  const evidenceBytes = new Map();
  for (const entry of manifest.captures) {
    const bytes = await readFile(`${pack}/${entry.body}`);
    assert.equal(bytes.length, entry.bytes);
    assert.equal(digest(bytes), entry.sha256);
    assert.equal(digest(await readFile(`${pack}/${entry.headers}`)), entry.headersSha256);
    if (["delver", "art-chillerpillar", "chillerpillar", "token"].includes(entry.id)) {
      // Replay the returned stable UUID URI. The manifest preserves the actual
      // acquisition aliases and original bytes; no new capture is fabricated.
      responses.set(JSON.parse(bytes).uri, { bytes, media: "application/json" });
      evidenceBytes.set(entry.sha256, bytes);
    } else if (entry.contentType === "image/jpeg") {
      responses.set(entry.url, { bytes, media: "image/jpeg" });
      evidenceBytes.set(entry.sha256, bytes);
    }
  }
  assert.equal(responses.size, 10);
  const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  delete config.$schema;
  config.main = resolve("apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  const key = crypto.randomUUID();
  const fetched = [];
  const runtime = {
    ...checkpoint,
    config: configPath,
    statePath,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService(request) {
      if (isNativeCheckpointRequest(request)) return checkpoint.outboundService(request);
      const response = responses.get(request.url);
      assert.ok(response, `Unplanned source request ${request.url}`);
      assert.match(request.headers.get("user-agent"), /Card-Keepr/u);
      assert.equal(request.headers.get("accept"), response.media);
      fetched.push(request.url);
      return new Response(response.bytes, { headers: { "content-type": response.media } });
    },
  };
  let ingestion,
    api,
    passed = false;
  t.after(async () => {
    if (api) await stopWorker(api);
    if (ingestion) await stopWorker(ingestion);
    if (passed) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained Scryfall journey state: ${directory}`);
  });
  ingestion = await startWorker({ ...runtime, migrate: true });
  await waitForHealth(`${ingestion.url}/health`, key, ingestion);
  const environment = { KEEPR_INGESTION_URL: ingestion.url, KEEPR_ADMINISTRATION_KEY: key };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr + ingestion.getOutput());
    const document = JSON.parse(result.stdout);
    assertIdentityCliDocument(args, document);
    return document;
  };
  const collect = async (intent) => {
    const run = await cli([
      "source",
      "collect",
      "--budget-file",
      fixtureAcquisitionBudgetPath,
      "--plan-file",
      "docs/examples/scryfall-magic-pilot-plan.json",
      "--idempotency-key",
      intent,
    ]);
    await cli(["source", "resume", "--run-id", run.id]);
    const collection = await waitForAdministrationDocument(
      `/v1/ingestion-runs/${run.id}/game-candidates`,
      (d) =>
        d.candidates.some((c) => ["failed", "paused"].includes(c.state))
          ? JSON.stringify(d)
          : d.candidates.length === 1 && d.candidates[0].state === "sealed",
      environment,
      ingestion,
      { deadlineMs: 120000 },
    );
    return {
      run,
      candidates: collection.candidates,
      inspection: await inspectNativeCollection(run.id, environment, {
        candidates: collection.candidates,
        partitionKinds: ["cards", "printings", "printing_images", "errata", "warnings"],
      }),
    };
  };
  const candidateDesignEvidence = async (candidate) => {
    const evidence = {};
    const validator =
      responseValidators[
        responseValidators.responseValidators[
          "admin get /v1/game-candidates/{candidate}/inspection/evidence/{kind} 200 application/json"
        ]
      ];
    assert.equal(typeof validator, "function");
    // One actual key-bearing record in each strict branch. The separate
    // candidate HTTP whole file owns pagination and historical-absence coverage.
    for (const kind of ["identity", "admission"]) {
      const response = await fetch(
        `${environment.KEEPR_INGESTION_URL}/v1/game-candidates/${candidate.id}/inspection/evidence/${kind}?manifest=${candidate.manifest_digest}`,
        { headers: { authorization: `Bearer ${key}` } },
      );
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json();
      assert.equal(validator(body), true, JSON.stringify(validator.errors));
      assert.equal(body.records.length, 1);
      const record = body.records[0];
      assert.match((kind === "identity" ? record.evidence : record.decision).card_design_key, /^oracle:/u);
      evidence[kind] = body.records;
    }
    return evidence;
  };
  const preparationDesignEvidence = async (cardId, preparationId) => {
    const response = await fetch(
      `${environment.KEEPR_INGESTION_URL}/v1/reconciliation/identities/${cardId}?preparation_id=${preparationId}`,
      { headers: { authorization: `Bearer ${key}` } },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const document = await response.json();
    assertIdentityDocument("/v1/reconciliation/identities/{identity}", "get", 200, document);
    assert.ok(document.mappings.length > 0);
    for (const mapping of document.mappings) {
      assert.equal(mapping.preparation_id, preparationId);
      assert.equal(mapping.publication_state, "published");
      assert.match(mapping.evidence.card_design_key, /^oracle:/u);
    }
    return document;
  };
  const first = await collect("scryfall-pilot");
  const privateEvidence = await candidateDesignEvidence(first.candidates[0]);
  assert.equal(fetched.length, 10);
  assert.equal(first.inspection.records.cards.length, 4);
  assert.equal(first.inspection.records.printings.length, 7);
  const art = first.inspection.records.cards.find((card) => card.category === "art");
  const gameplay = first.inspection.records.cards.find((card) => card.name === "Chillerpillar");
  assert.notEqual(art.id, gameplay.id);
  assert.equal(art.related_cards.length, 1);
  assert.equal(art.related_cards[0].card_id, gameplay.id);
  assert.equal(art.related_cards[0].evidence.length, 1);
  assert.equal((first.inspection.records.errata ?? []).length, 0);
  const proposals = await cli(["entity-proposal", "list", "--game", "magic"]);
  assert.equal(proposals.proposals.length, 7);
  const histories = new Map();
  for (const proposal of proposals.proposals) {
    assert.equal(proposal.status, "admitted");
    const detail = await cli(["entity-proposal", "inspect", "--proposal-id", proposal.id]);
    assert.equal(detail.history[0].actor, "automation");
    histories.set(proposal.id, detail.history);
  }
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  const headers = { authorization: `Bearer ${key}` };
  const get = async (path) => {
    const response = await fetch(`${api.url}${path}`, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  assert.equal((await fetch(`${api.url}/v1/cards/${art.id}`, { headers })).status, 404);
  assert.deepEqual((await get("/v1/games")).data, []);
  assert.equal((await fetch(`${api.url}/v1/games`)).status, 401);
  const publication = await publishNativeCollection(first, "scryfall-publish", environment, ingestion, 120000);
  assert.equal(publication.checkpoint.state, "verified");
  const cards = (await get("/v1/cards?game=magic")).data;
  const printings = (await get("/v1/printings?game=magic")).data;
  const games = (await get("/v1/games")).data;
  assert.equal(cards.length, 4);
  assert.equal(printings.length, 7);
  assert.equal(games[0].game_profile.id, "magic@1");
  assert.deepEqual(games[0].supported_locales, ["EN"]);
  assert.ok(games[0].filters.cards.includes("attribute.layout"));
  assert.deepEqual(
    (await get("/v1/cards?game=magic&category=art")).data.map((c) => c.id),
    [art.id],
  );
  assert.equal((await get("/v1/cards?game=magic&attribute.layout=transform")).data.length, 1);
  assert.equal((await get("/v1/printings?game=magic&category=token")).data.length, 2);
  for (const card of cards) {
    const detail = (await get(`/v1/cards/${card.id}`)).data;
    assert.deepEqual(detail.official_identity, { kind: "unknown", value: null });
    assert.equal(JSON.stringify(detail).includes("oracle:"), false);
  }
  const imageBytes = new Map();
  for (const printing of printings) {
    const detail = (await get(`/v1/printings/${printing.id}`)).data;
    assert.equal(detail.printed_rules_text, null);
    assert.equal(detail.game_data.attributes.finish_image, null);
    for (const image of detail.printing_images) {
      const response = await fetch(image.links.content, { headers });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(digest(bytes), image.content_sha256);
      assert.deepEqual(bytes, evidenceBytes.get(image.content_sha256));
      imageBytes.set(image.content_sha256, bytes);
    }
  }
  assert.equal(imageBytes.size, 6);
  const reader = nativeExportReader(0);
  const exportedCards = await reader.records(api.url, key, publication.resulting_revision_id, "cards");
  const exportedPrintings = await reader.records(api.url, key, publication.resulting_revision_id, "printings");
  assert.deepEqual(exportedCards.map((c) => c.id).sort(), cards.map((c) => c.id).sort());
  assert.deepEqual(
    exportedPrintings.map((p) => [p.id, p.card_id, p.game_data]).sort(),
    printings.map((p) => [p.id, p.card_id, p.game_data]).sort(),
  );
  const repeated = await collect("scryfall-duplicate-replay");
  assert.equal(fetched.length, 20);
  assert.deepEqual(repeated.inspection.records.cards.map((c) => c.id).sort(), cards.map((c) => c.id).sort());
  assert.deepEqual(repeated.inspection.records.printings.map((p) => p.id).sort(), printings.map((p) => p.id).sort());
  for (const [id, history] of histories)
    assert.deepEqual((await cli(["entity-proposal", "inspect", "--proposal-id", id])).history, history);
  const preparedEvidence = await preparationDesignEvidence(art.id, first.candidates[0].id);
  await stopWorker(api);
  await stopWorker(ingestion);
  await verifiedBackupApiState(statePath, directory);
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  ingestion = await startWorker(runtime);
  await waitForHealth(`${ingestion.url}/health`, key, ingestion);
  environment.KEEPR_INGESTION_URL = ingestion.url;
  reader.clear();
  assert.deepEqual(await candidateDesignEvidence(first.candidates[0]), privateEvidence);
  assert.deepEqual(await preparationDesignEvidence(art.id, first.candidates[0].id), preparedEvidence);
  assert.deepEqual(await reader.records(api.url, key, publication.resulting_revision_id, "cards"), exportedCards);
  assert.deepEqual(
    await reader.records(api.url, key, publication.resulting_revision_id, "printings"),
    exportedPrintings,
  );
  for (const [id, history] of histories)
    assert.deepEqual((await cli(["entity-proposal", "inspect", "--proposal-id", id])).history, history);
  const restoredSource = await cli(["source", "show", "--run-id", first.run.id]);
  assert.equal(restoredSource.snapshots.length, 10);
  for (const snapshot of restoredSource.snapshots) {
    const response = await fetch(`${ingestion.url}/v1/source-snapshots/${snapshot.id}/content`, { headers });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, evidenceBytes.get(digest(bytes)));
  }
  for (const printing of (await get("/v1/printings?game=magic")).data)
    for (const image of printing.printing_images) {
      const response = await fetch(image.links.content, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), imageBytes.get(image.content_sha256));
    }
  passed = true;
});

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
