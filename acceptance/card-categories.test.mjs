import assert from "node:assert/strict";
import readContract from "../contracts/read-openapi.json" with { type: "json" };
import * as wireValidators from "../test/support/http-response-validators.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import { cardCategorySource } from "./fixtures/card-categories.mjs";
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
import { syntheticSourceAdapterMigrations } from "./helpers/synthetic-source-adapters.mjs";
import { nativeExportReader } from "./helpers/native-export-reader.mjs";
import { verifiedBackupApiState } from "./helpers/verified-backup-api-state.mjs";
import { isNativeCheckpointRequest } from "./helpers/native-checkpoint-hosts.mjs";

test("categories retain distinct identities, evidenced associations and applicability through publication and SQL restore", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-card-categories-"));
  const statePath = join(directory, "state");
  const key = crypto.randomUUID();
  const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  delete config.$schema;
  config.main = resolve("acceptance/fixtures/native-retained-evidence-harness.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  config.ratelimits.find(({ name }) => name === "ADMINISTRATION_RATE_LIMIT").simple.limit = 500;
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  const source = cardCategorySource();
  const ingestion = await startWorker({
    ...checkpoint,
    config: configPath,
    statePath,
    migrate: true,
    testMigrations: await syntheticSourceAdapterMigrations(),
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService: (request) => {
      if (isNativeCheckpointRequest(request)) return checkpoint.outboundService(request);
      assert.equal(request.url, "https://category-source.invalid/cards");
      return Response.json(source);
    },
  });
  let api,
    passed = false;
  t.after(async () => {
    if (api) await stopWorker(api);
    await stopWorker(ingestion);
    if (passed) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained category proof state: ${directory}`);
  });
  await waitForHealth(`${ingestion.url}/health`, key, ingestion);
  const environment = { KEEPR_INGESTION_URL: ingestion.url, KEEPR_ADMINISTRATION_KEY: key };
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
      "Synthetic shared model proof",
      "--idempotency-key",
      area,
    ]);
  const planPath = join(directory, "plan.json");
  await writeFile(
    planPath,
    JSON.stringify({
      plans: [
        {
          supported_game: "riftbound",
          source_lineage: "riftbound-en",
          adapter_version: "fixture-riftbound-json@1",
          requests: [{ id: "riftbound-en:discovery", url: "https://category-source.invalid/cards" }],
        },
      ],
    }),
  );
  const run = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", "category-source"]);
  const prepare = async (key, sourceRun = run.id, predecessor = "catrev_spine_000", expected = "sealed") => {
    const result = await cli([
      "game-candidate",
      "prepare",
      "--run-id",
      sourceRun,
      "--game",
      "riftbound",
      "--expected-game-revision-id",
      predecessor,
      "--idempotency-key",
      key,
      "--yes",
    ]);
    return waitForAdministrationDocument(
      `/v1/game-candidates/${result.id}`,
      (d) => d.state === expected || (["failed", "paused"].includes(d.state) ? JSON.stringify(d) : false),
      environment,
      ingestion,
      { deadlineMs: 120000 },
    );
  };
  // The registered synthetic adapter supplies complete identity evidence; this
  // does not qualify the production Riot adapter or change its admission gate.
  const candidate = await prepare("reviewed");
  const inspected = await inspectNativeCollection(run.id, environment, { partitionKinds: ["cards", "printings"] });
  const inspectedCards = inspected.records.cards.map((record) => record.value ?? record);
  assert.equal(inspectedCards.length, 3);
  const admittedCards = new Map(inspectedCards.map((card) => [card.category, card.id]));
  const admittedPrintings = inspected.records.printings.map((record) => (record.value ?? record).id);
  assert.notEqual(admittedCards.get("art"), admittedCards.get("gameplay"));
  const retainedArt = inspectedCards.find((card) => card.category === "art");
  assert.equal(retainedArt.related_cards[0].evidence.length, 1);
  assert.ok(retainedArt.related_cards[0].evidence[0].source_observation_id);
  assert.ok(admittedPrintings.includes(retainedArt.related_cards[0].evidence[0].printing_id));
  assert.ok(admittedPrintings.includes(retainedArt.related_cards[0].evidence[0].related_printing_id));
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  const unpublishedDiscovery = await fetch(`${api.url}/v1/games`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(unpublishedDiscovery.status, 200);
  assert.deepEqual((await unpublishedDiscovery.json()).data, []);
  assert.equal(
    (await fetch(`${api.url}/v1/cards/${retainedArt.id}`, { headers: { authorization: `Bearer ${key}` } })).status,
    404,
  );
  const publication = await publishNativeCollection(
    { candidates: [candidate] },
    "publish-categories",
    environment,
    ingestion,
    120000,
  );
  const get = async (path) => {
    const response = await fetch(`${api.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200, await response.clone().text());
    const document = await response.json();
    const pathname = new URL(path, api.url).pathname;
    const segments = pathname.split("/");
    const definition = segments.length === 4 ? `/v1/${segments[2]}/{${segments[2].slice(0, -1)}}` : pathname;
    const branch = readContract.paths[definition].get.responses[200];
    for (const [name, header] of Object.entries(branch.headers ?? {}))
      if (header.required) assert.ok(response.headers.has(name), name);
    const validate = wireValidators[wireValidators.responseValidators[`read get ${definition} 200 application/json`]];
    assert.equal(validate(document), true, JSON.stringify(validate.errors));
    return document;
  };
  const cards = (await get("/v1/cards")).data;
  const discovery = await get("/v1/games");
  assert.deepEqual(
    discovery.data.map((game) => game.key),
    ["riftbound"],
  );
  const publishedGame = discovery.data[0];
  assert.equal(publishedGame.game_profile.id, "riftbound@1");
  assert.deepEqual(
    publishedGame.game_profile.card_fields.find((field) => field.path === "might"),
    { path: "might", type: "integer", nullable: true, multiple: false },
  );
  assert.ok(publishedGame.filters.cards.includes("attribute.supertypes"));
  assert.ok(publishedGame.filters.printings.includes("category"));
  assert.equal(JSON.stringify(discovery).includes("source_lineage"), false);
  assert.deepEqual(cards.map((c) => c.category).sort(), ["art", "gameplay", "token"]);
  for (const category of ["art", "gameplay", "token"]) {
    const filtered = (await get(`/v1/cards?category=${category}`)).data;
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, admittedCards.get(category));
  }
  const art = (await get(`/v1/cards/${admittedCards.get("art")}`)).data;
  const gameplay = (await get(`/v1/cards/${admittedCards.get("gameplay")}`)).data;
  const token = (await get(`/v1/cards/${admittedCards.get("token")}`)).data;
  assert.equal(art.gameplay_applicability, "inapplicable");
  assert.deepEqual(art.game_data.attributes, {});
  assert.equal(art.effective_rules_text, null);
  assert.deepEqual(art.related_cards, [{ kind: "shared_artwork", card_id: gameplay.id }]);
  assert.equal(gameplay.gameplay_applicability, "applicable");
  assert.equal(gameplay.game_data.attributes.power, null);
  assert.equal(token.gameplay_applicability, "applicable");
  assert.equal(token.game_data.attributes.might, 3);
  assert.equal(art.printing_ids.length, 3);
  const printings = (await get("/v1/printings")).data;
  assert.deepEqual(printings.map((p) => p.id).sort(), admittedPrintings.sort());
  const artPrintings = printings.filter((p) => p.card_id === art.id);
  assert.deepEqual(
    (await get("/v1/printings?category=art")).data.map((printing) => printing.id).sort(),
    artPrintings.map((printing) => printing.id).sort(),
  );
  for (const printing of printings)
    assert.equal(
      printing.category,
      printing.card_id === art.id ? "art" : printing.card_id === token.id ? "token" : "gameplay",
    );
  assert.deepEqual(artPrintings.map((p) => p.game_data.attributes.finish).sort(), ["foil", "ordinary", "stamped"]);
  assert.equal(JSON.stringify(printings).includes("artwork_fingerprint"), false);
  assert.equal(JSON.stringify(printings).includes("source_observation_id"), false);
  const cliCards = await runCli(
    [
      "cards",
      "search",
      "--game",
      "riftbound",
      "--category",
      "art",
      "--revision",
      publication.resulting_revision_id,
      "--json",
    ],
    { ...environment, KEEPR_API_URL: api.url, KEEPR_API_KEY: key },
  );
  assert.equal(cliCards.code, 0, cliCards.stdout + cliCards.stderr);
  assert.deepEqual(
    JSON.parse(cliCards.stdout).data.map((card) => card.id),
    [art.id],
  );
  for (const printing of printings) {
    assert.equal(printing.printed_rules_text, null);
    assert.equal(printing.gameplay_applicability, printing.card_id === art.id ? "inapplicable" : "applicable");
  }
  const reader = nativeExportReader(0);
  const exportedCards = await reader.records(api.url, key, publication.resulting_revision_id, "cards");
  const exportedPrintings = await reader.records(api.url, key, publication.resulting_revision_id, "printings");
  assert.equal(exportedCards.find((c) => c.id === art.id).gameplay_applicability, "inapplicable");
  assert.deepEqual(exportedCards.find((c) => c.id === art.id).related_cards, art.related_cards);
  assert.deepEqual(
    exportedPrintings.map((p) => [p.id, p.gameplay_applicability, p.printed_rules_text]).sort(),
    printings.map((p) => [p.id, p.gameplay_applicability, p.printed_rules_text]).sort(),
  );
  const refreshRun = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", "category-refresh"]);
  const refreshed = await prepare("refresh", refreshRun.id, publication.resulting_revision_id);
  const refreshInspection = await inspectNativeCollection(refreshRun.id, environment, {
    partitionKinds: ["cards", "printings"],
  });
  assert.deepEqual(
    refreshInspection.records.cards.map((card) => card.id).sort(),
    inspectedCards.map((card) => card.id).sort(),
  );
  assert.deepEqual(refreshInspection.records.printings.map((printing) => printing.id).sort(), admittedPrintings);
  const acceptedRefresh = await publishNativeCollection(
    { candidates: [refreshed] },
    "accept-category-refresh",
    environment,
    ingestion,
    120000,
  );
  assert.equal(
    acceptedRefresh.resulting_revision_id,
    publication.resulting_revision_id,
    "new relationship evidence alone preserves the public revision",
  );
  for (const locator of ["art-ordinary", "missing-printing"]) {
    source.cards[1].card_relationships[0].target.locator = locator;
    const rejectedRun = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", locator]);
    const rejected = await prepare(locator, rejectedRun.id, publication.resulting_revision_id, "failed");
    assert.equal(rejected.failure_code, "printing_reconciliation_blocked");
    assert.ok(rejected.outcome.diagnostics.some((diagnostic) => /Shared artwork/u.test(diagnostic.detail)));
  }
  // Four art Cards each resolve the full eight-association allowance through
  // real bounded Workflow callbacks; ordinary Card batching must not overrun it.
  const relatedTargets = [source.cards[0]];
  for (let index = 1; index < 8; index++) {
    const target = structuredClone(source.cards[0]);
    target.card.name = target.card.official_identity.value = `Shared illustration ${index}`;
    target.identity_evidence.locator = `related-gameplay-${index}`;
    relatedTargets.push(target);
    source.cards.push(target);
  }
  source.cards[1].card_relationships = relatedTargets.map((target) => ({
    kind: "shared_artwork",
    target: { source_lineage: "riftbound-en", locator: target.identity_evidence.locator, variant_key: "ordinary" },
  }));
  for (let index = 1; index < 4; index++) {
    const additionalArt = structuredClone(source.cards[1]);
    additionalArt.card.name = additionalArt.card.official_identity.value = `Additional art Card ${index}`;
    additionalArt.identity_evidence.locator = `additional-art-${index}`;
    source.cards.push(additionalArt);
  }
  const associatedRun = await cli([
    "source",
    "collect",
    "--plan-file",
    planPath,
    "--idempotency-key",
    "bounded-associations",
  ]);
  const associatedCandidate = await prepare(
    "bounded-associations",
    associatedRun.id,
    publication.resulting_revision_id,
  );
  assert.equal(associatedCandidate.state, "sealed");
  const associations = await inspectNativeCollection(associatedRun.id, environment, { partitionKinds: ["cards"] });
  const relatedArt = associations.records.cards.filter((card) => card.category === "art");
  assert.equal(relatedArt.length, 4);
  for (const card of relatedArt) assert.equal(card.related_cards.length, 8);
  assert.deepEqual((await get("/v1/cards")).data, cards);
  await stopWorker(api);
  await stopWorker(ingestion);
  const restored = await verifiedBackupApiState(statePath, directory);
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath: restored, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  const withoutLinks = (records) => records.map(({ links, ...record }) => record);
  assert.deepEqual(withoutLinks((await get("/v1/cards")).data), withoutLinks(cards));
  assert.equal((await get("/v1/cards?category=art")).data[0].id, art.id);
  assert.deepEqual(
    (await get("/v1/games")).data.map(({ links, ...game }) => game),
    discovery.data.map(({ links, ...game }) => game),
  );
  reader.clear();
  assert.deepEqual(await reader.records(api.url, key, publication.resulting_revision_id, "cards"), exportedCards);
  assert.deepEqual(
    await reader.records(api.url, key, publication.resulting_revision_id, "printings"),
    exportedPrintings,
  );
  passed = true;
});
