import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
import { pokemonAdmissionHistory, pokemonRetainedProposals } from "./helpers/query-helpers/pokemon-pilot.mjs";

test("the real Pokémon pilot preserves treatments and official correction through admission, publication and SQL restore", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-pokemon-pilot-"));
  const statePath = join(directory, "state");
  const fixture = "acceptance/fixtures/real-sources/2026-09-14-pokemon";
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const captures = new Map();
  for (const capture of manifest.captures) {
    const bytes = await readFile(join(fixture, capture.body));
    assert.equal(bytes.length, capture.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), capture.sha256);
    if (capture.status !== 200 || capture.classification === "source-repository-publication") continue;
    const contentType = capture.responseHeaders.find(([key]) => key.toLowerCase() === "content-type")[1];
    captures.set(capture.finalUrl, { bytes, contentType });
  }
  assert.equal(captures.size, 8);
  const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  delete config.$schema;
  config.main = resolve("apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  await applyMigrations(statePath);
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  const key = crypto.randomUUID();
  const requested = new Set();
  const worker = await startWorker({
    ...checkpoint,
    config: configPath,
    statePath,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService(request) {
      if (isNativeCheckpointRequest(request)) return checkpoint.outboundService(request);
      const capture = captures.get(request.url);
      assert.ok(capture, `Unexpected out-of-scope source request: ${request.url}`);
      requested.add(request.url);
      return new Response(capture.bytes, { headers: { "content-type": capture.contentType } });
    },
  });
  let api,
    passed = false;
  t.after(async () => {
    if (api) await stopWorker(api);
    await stopWorker(worker);
    if (passed) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained Pokémon pilot state: ${directory}`);
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
  const planPath = join(directory, "cards-products.json");
  await writeFile(planPath, await readFile("docs/examples/pokemon-card-product-plan.json"));
  const run = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", "pokemon-pilot-capture"]);
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
    candidates: collection.candidates,
    partitionKinds: ["cards", "printings"],
  });
  assert.equal(requested.size, 7);
  assert.deepEqual(intake.records.cards.map((card) => card.name).sort(), ["Charizard", "Snorlax"]);
  assert.equal(intake.records.printings.length, 2);
  const proposals = await cli(["entity-proposal", "list", "--game", "pokemon"]);
  const unresolved = proposals.proposals.filter((proposal) => proposal.status === "unresolved");
  assert.equal(unresolved.length, 5);
  assert.equal(proposals.proposals.filter((proposal) => proposal.status === "admitted").length, 2);
  const automaticCardIds = new Map(intake.records.cards.map((card) => [card.name, card.id]));
  const printingIds = intake.records.printings.map((printing) => printing.id);
  const decisions = new Map();
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  const headers = { authorization: `Bearer ${key}` };
  const get = async (path) => {
    const response = await fetch(`${api.url}${path}`, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  for (const id of automaticCardIds.values())
    assert.equal((await fetch(`${api.url}/v1/cards/${id}`, { headers })).status, 404);
  const first = collection.candidates[0];
  await cli([
    "game-candidate",
    "abandon",
    "--candidate-id",
    first.id,
    "--generation",
    String(first.generation),
    "--idempotency-key",
    "pokemon-initial",
    "--yes",
  ]);
  const admit = async (proposal, cardId) => {
    const inspected = await cli(["entity-proposal", "inspect", "--proposal-id", proposal.id]);
    const decisionPath = join(directory, `${proposal.id}.json`);
    await writeFile(
      decisionPath,
      JSON.stringify({
        expected_generation: String(inspected.generation),
        idempotency_key: `pokemon-admit-${proposal.id}`,
        rationale:
          "Disposable pilot review of the exact retained source treatment; missing precise scans remain explicit.",
        ...(cardId === undefined ? {} : { card_id: cardId }),
        exception: {
          scope: ["identity"],
          attestation:
            proposal.source_lineage === "pokemon-official-en"
              ? "Pilot owner admits the supplemental publisher Garchomp Brilliant Stars 109/172 original Sonic Slip Printing from the retained page and exact front image."
              : `Pilot owner accepts this detailed issued treatment of ${inspected.content.card.name}; the shared catalogue image is not evidence depicting this precise variant.`,
        },
      }),
    );
    const admitted = await cli([
      "entity-proposal",
      "admit",
      "--proposal-id",
      proposal.id,
      "--decision",
      decisionPath,
      "--yes",
    ]);
    assert.equal(admitted.status, "admitted");
    assert.equal(admitted.history[0].actor, "owner");
    decisions.set(proposal.id, admitted.history);
    printingIds.push(admitted.history[0].decision.printing.id);
    return admitted.history[0].decision;
  };
  const supplemental = unresolved.filter((proposal) => proposal.source_lineage === "pokemon-official-en");
  assert.equal(supplemental.length, 1);
  const garchompAdmission = await admit(supplemental[0]);
  const garchompId = garchompAdmission.card.id;
  assert.equal((await fetch(`${api.url}/v1/cards/${garchompId}`, { headers })).status, 404);
  const prepared = await cli([
    "game-candidate",
    "prepare",
    "--run-id",
    run.id,
    "--game",
    "pokemon",
    "--expected-game-revision-id",
    "catrev_spine_000",
    "--idempotency-key",
    "pokemon-reviewed",
    "--yes",
  ]);
  const originalCandidate = await waitForAdministrationDocument(
    `/v1/game-candidates/${prepared.id}`,
    (document) =>
      document.state === "sealed" || (["failed", "paused"].includes(document.state) ? JSON.stringify(document) : false),
    environment,
    worker,
    { deadlineMs: 120000 },
  );
  const originalPublication = await publishNativeCollection(
    { candidates: [originalCandidate] },
    "pokemon-original",
    environment,
    worker,
    120000,
  );
  const originalCards = (await get("/v1/cards?game=pokemon")).data;
  assert.deepEqual(originalCards.map((card) => card.name).sort(), ["Charizard", "Garchomp", "Snorlax"]);
  const originalGarchomp = (await get(`/v1/cards/${garchompId}`)).data;
  assert.equal(originalGarchomp.effective_rules_text, garchompAdmission.printing.printed_rules_text);
  assert.match(originalGarchomp.effective_rules_text, /effects of attacks done to this Pokémon/u);
  for (const proposal of unresolved.filter((proposal) => proposal.source_lineage === "tcgdex-pokemon-en")) {
    const [locator] = JSON.parse(proposal.reference);
    const name = locator.startsWith("svp-051:") ? "Snorlax" : "Charizard";
    await admit(proposal, automaticCardIds.get(name));
  }
  // The second complete scope introduces the dated correction; it also retains
  // the first run's exact treatments and the intervening owner decisions.
  const correctionPath = join(directory, "correction.json");
  await writeFile(correctionPath, await readFile("docs/examples/pokemon-correction-plan.json"));
  const correctionRun = await cli([
    "source",
    "collect",
    "--plan-file",
    correctionPath,
    "--idempotency-key",
    "pokemon-correction",
  ]);
  await cli(["source", "resume", "--run-id", correctionRun.id]);
  const correctionCollection = await waitForAdministrationDocument(
    `/v1/ingestion-runs/${correctionRun.id}/game-candidates`,
    (document) =>
      document.candidates.some((candidate) => ["failed", "paused"].includes(candidate.state))
        ? JSON.stringify(document)
        : document.candidates.length === 1 && document.candidates[0].state === "sealed",
    environment,
    worker,
    { deadlineMs: 120000 },
  );
  assert.equal(correctionCollection.candidates[0].expected_game_revision_id, originalPublication.resulting_revision_id);
  assert.equal((await get(`/v1/cards/${garchompId}`)).data.effective_rules_text, originalGarchomp.effective_rules_text);
  const publication = await publishNativeCollection(
    correctionCollection,
    "pokemon-corrected",
    environment,
    worker,
    120000,
  );
  assert.notEqual(publication.resulting_revision_id, originalPublication.resulting_revision_id);
  assert.equal(requested.size, 8);
  const discovery = (await get("/v1/games")).data;
  assert.equal(discovery.length, 1);
  assert.equal(discovery[0].key, "pokemon");
  assert.deepEqual(discovery[0].supported_locales, ["EN"]);
  assert.equal(discovery[0].game_profile.id, "pokemon@1");
  assert.ok(discovery[0].filters.cards.includes("attribute.hp"));
  const cards = (await get("/v1/cards?game=pokemon")).data;
  const cardDetails = await Promise.all(cards.map(async (card) => (await get(`/v1/cards/${card.id}`)).data));
  assert.deepEqual(cards.map((card) => card.id).sort(), originalCards.map((card) => card.id).sort());
  const snorlax = cards.find((card) => card.name === "Snorlax");
  assert.equal(snorlax.category, "gameplay");
  assert.equal(snorlax.gameplay_applicability, "applicable");
  assert.deepEqual(snorlax.official_identity, { kind: "unknown", value: null });
  assert.deepEqual(
    (await get("/v1/cards?game=pokemon&attribute.hp=150")).data.map((card) => card.id),
    [snorlax.id],
  );
  const corrected = cardDetails.find((card) => card.id === garchompId);
  assert.match(corrected.effective_rules_text, /effects of attacks from your opponent’s Pokémon done/u);
  assert.ok(corrected.effective_rules_text.endsWith("Dragonblade: Discard the top 2 cards of your deck."));
  assert.match(
    corrected.game_data.attributes.abilities[0].text,
    /effects of attacks from your opponent’s Pokémon done/u,
  );
  assert.deepEqual(corrected.game_data.attributes.attacks, originalGarchomp.game_data.attributes.attacks);
  assert.deepEqual(cards.find((card) => card.id === garchompId).game_data, corrected.game_data);
  const printings = (await get("/v1/printings?game=pokemon")).data;
  assert.deepEqual(printings.map((printing) => printing.id).sort(), printingIds.sort());
  assert.equal(new Set(printingIds).size, 7);
  const snorlaxPrintings = printings.filter((printing) => printing.card_id === snorlax.id);
  assert.deepEqual(snorlaxPrintings.map((printing) => printing.game_data.attributes.stamps).sort(), [
    [],
    ["pokemon-center"],
  ]);
  const charizard = cards.find((card) => card.name === "Charizard");
  const charizardTreatments = printings
    .filter((printing) => printing.card_id === charizard.id)
    .map((printing) => printing.game_data.attributes);
  assert.deepEqual(charizardTreatments.map((attributes) => [attributes.edition, attributes.stamps]).sort(), [
    ["1999-2000-copyright", []],
    ["shadowless", []],
    ["shadowless", ["1st-edition"]],
    ["unlimited", []],
  ]);
  assert.equal(
    printings.find((printing) => printing.card_id === garchompId).printed_rules_text,
    originalGarchomp.effective_rules_text,
  );
  for (const printing of printings.filter((printing) => printing.card_id !== garchompId))
    assert.equal(printing.printed_rules_text, null);
  assert.equal(printings.filter((printing) => printing.printing_images.length === 0).length, 4);
  assert.equal(printings.flatMap((printing) => printing.printing_images).length, 3);
  for (const printing of printings) {
    const attributes = printing.game_data.attributes;
    const depicted =
      printing.card_id === garchompId ||
      (printing.card_id === snorlax.id && attributes.stamps.length === 0) ||
      (printing.card_id === charizard.id &&
        attributes.edition === "shadowless" &&
        attributes.stamps.includes("1st-edition"));
    assert.equal(printing.printing_images.length, depicted ? 1 : 0);
    assert.equal(attributes.reverse_face, null);
    assert.deepEqual(printing.products, [], "The Product's text does not prove an exact Printing membership");
  }
  const products = (await get("/v1/products?game=pokemon")).data;
  assert.equal(products.length, 1);
  assert.equal(products[0].name, "Pokémon TCG: Scarlet & Violet—151 Pokémon Center Elite Trainer Box");
  for (const release of products[0].releases) assert.equal(release.region, "unknown");
  const reader = nativeExportReader(250);
  const exported = {};
  for (const kind of ["cards", "printings", "products", "errata"])
    exported[kind] = await reader.records(api.url, key, publication.resulting_revision_id, kind);
  assert.deepEqual(
    exported.cards.map((card) => [card.id, card.effective_rules_text]).sort(),
    cardDetails.map((card) => [card.id, card.effective_rules_text]).sort(),
  );
  for (const card of cards) {
    const record = exported.cards.find((entry) => entry.id === card.id);
    assert.deepEqual(record.game_data, card.game_data);
    assert.deepEqual(record.official_identity, card.official_identity);
    assert.equal(record.category, card.category);
    assert.equal(record.gameplay_applicability, card.gameplay_applicability);
  }
  assert.deepEqual(
    exported.printings.map((printing) => [printing.id, printing.card_id, printing.printed_rules_text]).sort(),
    printings.map((printing) => [printing.id, printing.card_id, printing.printed_rules_text]).sort(),
  );
  for (const printing of printings) {
    const record = exported.printings.find((entry) => entry.id === printing.id);
    assert.deepEqual(record.game_data, printing.game_data);
    assert.deepEqual(record.rarity, printing.rarity);
  }
  assert.deepEqual(
    exported.products.map((product) => [product.id, product.name]).sort(),
    products.map((product) => [product.id, product.name]).sort(),
  );
  assert.equal(exported.errata.length, 1);
  assert.equal(exported.errata[0].target_id, garchompId);
  assert.equal(exported.errata[0].effective_from, "2022-02-09");
  assert.equal(exported.errata[0].corrected_value, corrected.effective_rules_text);
  const imageBytes = new Map();
  for (const capture of captures.values())
    if (capture.contentType.startsWith("image/"))
      imageBytes.set(createHash("sha256").update(capture.bytes).digest("hex"), capture.bytes);
  const verifyImages = async (records) => {
    for (const image of records.flatMap((printing) => printing.printing_images)) {
      const response = await fetch(image.links.content, { headers });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, image.content_byte_length);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), image.content_sha256);
      assert.deepEqual(bytes, imageBytes.get(image.content_sha256));
      assert.equal((await fetch(image.links.content)).status, 401);
    }
  };
  await verifyImages(printings);
  const publicText = JSON.stringify({ cards, printings, products, exported });
  for (const privateField of [
    "source_design_key",
    "card_design_key",
    "variant_id",
    "source_lineage",
    "source_record_json",
    "artwork_fingerprint",
  ])
    assert.equal(publicText.includes(`"${privateField}"`), false, privateField);
  await stopWorker(api);
  await stopWorker(worker);
  const imports = (await readdir(directory))
    .filter((name) => /^restore-\d+\.sqlite$/u.test(name))
    .sort((left, right) => Number(left.match(/\d+/u)[0]) - Number(right.match(/\d+/u)[0]));
  assert.ok(imports.length >= 2, "Both publications produce actual independently imported SQL");
  const restoredDatabase = new DatabaseSync(join(directory, imports.at(-1)), { readOnly: true });
  try {
    const history = pokemonAdmissionHistory(restoredDatabase)
      .all()
      .map(({ request_json, decision_json, ...row }) => ({
        ...row,
        decision: JSON.parse(decision_json),
      }));
    for (const [proposalId, expected] of decisions)
      assert.deepEqual(
        history.filter((row) => row.proposal_id === proposalId),
        expected,
      );
    assert.equal(history.filter((row) => row.actor === "automation").length, 2);
    const retained = pokemonRetainedProposals(restoredDatabase).all();
    assert.equal(retained.length, 7);
    assert.equal(retained.filter((row) => row.source_lineage === "pokemon-official-en").length, 1);
    assert.deepEqual(
      new Set(
        retained
          .filter((row) => row.source_lineage === "tcgdex-pokemon-en")
          .map((row) => JSON.parse(row.evidence_json).card_design_key),
      ),
      new Set(["svp-051", "base1-4"]),
    );
  } finally {
    restoredDatabase.close();
  }
  const restored = await verifiedBackupApiState(statePath, directory);
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath: restored, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  const withoutLinks = (records) =>
    JSON.parse(JSON.stringify(records, (name, value) => (name === "links" ? undefined : value)));
  assert.deepEqual(withoutLinks((await get("/v1/cards?game=pokemon")).data), withoutLinks(cards));
  for (const card of cardDetails)
    assert.deepEqual(withoutLinks((await get(`/v1/cards/${card.id}`)).data), withoutLinks(card));
  const restoredPrintings = (await get("/v1/printings?game=pokemon")).data;
  assert.deepEqual(withoutLinks(restoredPrintings), withoutLinks(printings));
  assert.deepEqual(withoutLinks((await get("/v1/products?game=pokemon")).data), withoutLinks(products));
  assert.deepEqual(withoutLinks((await get("/v1/games")).data), withoutLinks(discovery));
  await verifyImages(restoredPrintings);
  reader.clear();
  for (const kind of Object.keys(exported))
    assert.deepEqual(await reader.records(api.url, key, publication.resulting_revision_id, kind), exported[kind]);
  passed = true;
});
