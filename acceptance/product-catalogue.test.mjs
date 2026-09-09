import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
} from "./fixtures/catalogue-runtime-harness.mjs";
import { persistedDatabaseDirectory } from "./helpers/acceptance-runtime.mjs";
import {
  inspectNativeCollection,
  nativeCheckpointTransport,
  nativeExportRecords,
  publishNativeCollection,
  waitForNativeCollection,
} from "./helpers/native-catalogue-runtime.mjs";
import * as schemaQueries from "./helpers/query-helpers/schema.mjs";
import * as sourceEvidenceQueries from "./helpers/query-helpers/source-evidence.mjs";

const root = resolve(import.meta.dirname, "..");

test("native publication: the CLI publishes separated Product catalogue data consumed through authenticated HTTP", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-product-boundary-"));
  const statePath = join(directory, "shared-state");
  const administrationKey = randomUUID();
  const apiKey = randomUUID();
  const ingestionEnv = join(directory, "ingestion.env");
  const apiEnv = join(directory, "api.env");
  const ingestionConfig = join(directory, "ingestion.wrangler.json");
  const initialPlanPath = join(directory, "initial-source-plan.json");
  const multiPlanPath = join(directory, "multi-source-plan.json");
  const carryPlanPath = join(directory, "carry-source-plan.json");
  await Promise.all([
    writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`, {
      mode: 0o600,
    }),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(
      initialPlanPath,
      JSON.stringify({
        plans: [officialPlan("digimon", "digimon-en", "digimon-en@7")],
      }),
      { mode: 0o600 },
    ),
    writeFile(
      multiPlanPath,
      JSON.stringify({
        plans: [
          officialPlan("digimon", "digimon-en", "digimon-en@7"),
          officialPlan("one-piece", "one-piece-en", "one-piece-en@6"),
          officialPlan("fusion-world", "fusion-world-en", "fusion-world-en@9"),
          officialPlan("gundam", "gundam-en-asia", "gundam-en-asia@7"),
          officialPlan("gundam", "gundam-en-us", "gundam-en-us@7"),
        ],
      }),
      { mode: 0o600 },
    ),
    writeFile(
      carryPlanPath,
      JSON.stringify({
        plans: [
          officialPlan("one-piece", "one-piece-en", "one-piece-en@6", {
            accept: "text/html",
            "user-agent": "card-keepr-acceptance-product/codeless",
          }),
        ],
      }),
      { mode: 0o600 },
    ),
  ]);
  await applyMigrations(statePath);
  const config = JSON.parse(await readFile(resolve(root, "apps/ingestion/wrangler.jsonc"), "utf8"));
  delete config.$schema;
  config.main = resolve(root, "apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  config.ratelimits[0].simple.limit = 300;
  config.services = [
    {
      binding: "OFFICIAL_SOURCE_TRANSPORT",
      service: "card-keepr-fusion-world-official-source",
    },
  ];
  await writeFile(ingestionConfig, JSON.stringify(config));

  const source = await startWorker({
    config: "acceptance/fixtures/fusion-world-official-source.wrangler.jsonc",
    statePath: join(directory, "source-state"),
  });
  t.after(() => stopWorker(source));
  const checkpointTransport = await nativeCheckpointTransport(t, statePath, directory, ingestionConfig);
  const ingestion = await startWorker({
    ...checkpointTransport,
    config: ingestionConfig,
    envFile: ingestionEnv,
    statePath,
  });
  t.after(async () => {
    await Promise.all([stopWorker(source), stopWorker(ingestion)]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForHealth(`${source.url}/catalogue-discovery`, "", source),
    waitForHealth(`${ingestion.url}/health`, administrationKey, ingestion),
  ]);
  const cliEnvironment = {
    KEEPR_INGESTION_URL: ingestion.url,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "250",
  };
  const collected = await runCli(
    ["source", "collect", "--plan-file", initialPlanPath, "--idempotency-key", "acceptance-product-collect", "--json"],
    cliEnvironment,
  );
  assert.equal(collected.code, 0, `${collected.stdout}\n${collected.stderr}\n${ingestion.getOutput()}`);
  const collectedRun = JSON.parse(collected.stdout);
  const resumed = await runCli(["source", "resume", "--run-id", collectedRun.id, "--json"], cliEnvironment);
  assert.equal(resumed.code, 0, resumed.stderr);
  await waitForRunState(collectedRun.id, "sealed", cliEnvironment, ingestion, statePath);
  const inspected = await inspectNativeCollection(collectedRun.id, cliEnvironment);
  const inspection = inspected;
  assert.equal(inspection.run_id, collectedRun.id);
  assert.equal(inspection.counts.cards.added, 1);
  assert.equal(inspection.counts.printings.added, 1);
  assert.ok(
    inspection.warnings.some(
      ({ code, path, raw_value }) =>
        code === "unknown_source_field" &&
        path === "source_sidecar.raw.products[0].campaign_note" &&
        raw_value === "Optional Official Source marketing copy",
    ),
  );
  assert.ok(
    inspection.warnings.some(
      ({ code, path, raw_value }) =>
        code === "unknown_source_field" &&
        path === "source_sidecar.raw.products[0].vendor_metadata.merchandising.channel_code" &&
        raw_value === "official-web",
    ),
  );
  const [printingId] = inspection.changes
    .filter((c) => c.entity_class === "printings" && c.change === "added")
    .map((c) => c.entity_id);
  const approved = await publishNativeCollection(inspection, "acceptance-product-approve", cliEnvironment, ingestion);
  const published = approved;
  let revisionId = published.resulting_revision_id;
  assert.match(revisionId, /^catrev_/u);

  const multiCollected = await runCli(
    ["source", "collect", "--plan-file", multiPlanPath, "--idempotency-key", "acceptance-product-multi-plan", "--json"],
    cliEnvironment,
  );
  assert.equal(multiCollected.code, 0, `${multiCollected.stdout}\n${multiCollected.stderr}\n${ingestion.getOutput()}`);
  const multiRun = JSON.parse(multiCollected.stdout);
  const multiShownResult = await runCli(["source", "show", "--run-id", multiRun.id, "--json"], cliEnvironment);
  assert.equal(multiShownResult.code, 0, multiShownResult.stderr);
  const multiShown = JSON.parse(multiShownResult.stdout);
  assert.deepEqual(
    multiShown.evidence_plans.map(({ supported_game, source_lineage, adapter_version, requests }) => ({
      supported_game,
      source_lineage,
      adapter_version,
      request_ids: requests.map(({ id }) => id),
    })),
    [
      {
        supported_game: "digimon",
        source_lineage: "digimon-en",
        adapter_version: "digimon-en@7",
        request_ids: officialPlan("digimon", "digimon-en", "digimon-en@7").requests.map(({ id }) => id),
      },
      {
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "one-piece-en@6",
        request_ids: officialPlan("one-piece", "one-piece-en", "one-piece-en@6").requests.map(({ id }) => id),
      },
      {
        supported_game: "fusion-world",
        source_lineage: "fusion-world-en",
        adapter_version: "fusion-world-en@9",
        request_ids: officialPlan("fusion-world", "fusion-world-en", "fusion-world-en@9").requests.map(({ id }) => id),
      },
      {
        supported_game: "gundam",
        source_lineage: "gundam-en-asia",
        adapter_version: "gundam-en-asia@7",
        request_ids: officialPlan("gundam", "gundam-en-asia", "gundam-en-asia@7").requests.map(({ id }) => id),
      },
      {
        supported_game: "gundam",
        source_lineage: "gundam-en-us",
        adapter_version: "gundam-en-us@7",
        request_ids: officialPlan("gundam", "gundam-en-us", "gundam-en-us@7").requests.map(({ id }) => id),
      },
    ],
  );
  for (const scalar of ["supported_game", "game_profile_version", "source_lineage", "adapter_version"]) {
    assert.equal(Object.hasOwn(multiShown, scalar), false);
  }
  const multiResumed = await runCli(["source", "resume", "--run-id", multiRun.id, "--json"], cliEnvironment);
  assert.equal(multiResumed.code, 0, multiResumed.stderr);
  await waitForRunState(multiRun.id, "sealed", cliEnvironment, ingestion, statePath);
  const multiInspectionResult = await inspectNativeCollection(multiRun.id, cliEnvironment);
  const multiInspection = multiInspectionResult;
  assert.equal(multiInspection.ready, true);
  assert.deepEqual(
    Object.fromEntries(
      multiInspection.candidates.map((candidate) => [candidate.supported_game, candidate.expected_game_revision_id]),
    ),
    {
      digimon: revisionId,
      "one-piece": "catrev_spine_000",
      "fusion-world": "catrev_spine_000",
      gundam: "catrev_spine_000",
    },
  );
  const multiApproved = await publishNativeCollection(
    multiInspection,
    "acceptance-product-multi-approve",
    cliEnvironment,
    ingestion,
  );
  const multiPublished = multiApproved;
  assert.notEqual(multiPublished.resulting_revision_id, revisionId);
  const allFiveRevisionId = multiPublished.resulting_revision_id;
  const observedDigimonRevisionId = multiPublished.publications.find(
    (publication) => publication.supported_game === "digimon",
  ).resulting_revision_id;
  revisionId = allFiveRevisionId;

  const carryCollected = await runCli(
    [
      "source",
      "collect",
      "--plan-file",
      carryPlanPath,
      "--idempotency-key",
      "acceptance-product-carry-collect",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(carryCollected.code, 0, carryCollected.stderr);
  const carryRun = JSON.parse(carryCollected.stdout);
  assert.equal((await runCli(["source", "resume", "--run-id", carryRun.id, "--json"], cliEnvironment)).code, 0);
  await waitForRunState(carryRun.id, "sealed", cliEnvironment, ingestion, statePath);
  const carryInspectionResult = await inspectNativeCollection(carryRun.id, cliEnvironment);
  const carryInspection = carryInspectionResult;
  const carryApproved = await publishNativeCollection(
    carryInspection,
    "acceptance-product-carry-approve",
    cliEnvironment,
    ingestion,
  );
  revisionId = carryApproved.resulting_revision_id;
  await stopWorker(ingestion);

  const api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    statePath,
  });
  t.after(() => stopWorker(api));
  await waitForHealth(`${api.url}/health`, apiKey, api);
  const headers = { authorization: `Bearer ${apiKey}` };
  const catalogueResponse = await fetch(`${api.url}/v1/catalogue`, { headers });
  assert.equal(catalogueResponse.status, 200);
  const catalogueDocument = await catalogueResponse.json();
  assert.equal(Object.hasOwn(catalogueDocument.data, "last_successful_checks"), false);
  const publishedProducts = await nativeExportRecords(api.url, apiKey, revisionId, "products");
  const productOnly = publishedProducts.find(({ official_code }) => official_code === "BT-PRODUCT-ONLY");
  const cardBearing = publishedProducts.find(({ official_code }) => official_code === "BT-CARD-BEARING");
  assert.ok(productOnly);
  assert.ok(cardBearing);
  const productId = productOnly.id;
  const productResponse = await fetch(`${api.url}/v1/products/${productId}`, { headers });
  assert.equal(productResponse.status, 200);
  const productDocument = await productResponse.json();
  const apiSchema = JSON.parse(
    await readFile(resolve(root, "prototype/formalize-implementation-contracts/schemas/api.schema.json"), "utf8"),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validateProduct = ajv.compile({
    ...apiSchema,
    $ref: "#/$defs/ProductDocument",
  });
  assert.equal(validateProduct(productDocument), true, ajv.errorsText(validateProduct.errors));
  assert.equal(productDocument.data.releases[0].region, "unknown");
  assert.equal(productDocument.data.releases[0].status, "announced");
  assert.equal(productDocument.data.lifecycle.last_observed_revision_id, observedDigimonRevisionId);

  assert.equal(Object.hasOwn(productDocument, "provenance"), false);
  const printingResponse = await fetch(`${api.url}/v1/printings/${printingId}`, { headers });
  assert.equal(printingResponse.status, 200);
  const printingDocument = await printingResponse.json();
  assert.equal(printingDocument.data.lifecycle.last_observed_revision_id, observedDigimonRevisionId);
  assert.equal(printingDocument.data.products.length, 1);
  assert.equal(printingDocument.data.products[0].id, cardBearing.id);
  assert.equal(Object.hasOwn(printingDocument.data.products[0], "evidence_category"), false);
  assert.equal(printingDocument.data.distribution_contexts[0].kind, "tournament_pack");
  assert.equal(printingDocument.data.distribution_contexts[0].product_id, cardBearing.id);

  const [products, releases, contexts, relationships, cards, printings] = await Promise.all(
    ["products", "releases", "distribution-contexts", "relationships", "cards", "printings"].map((component) =>
      nativeExportRecords(api.url, apiKey, revisionId, component),
    ),
  );
  const exportSchema = JSON.parse(
    await readFile(
      resolve(root, "prototype/formalize-implementation-contracts/schemas/catalogue-export-record-v5.schema.json"),
      "utf8",
    ),
  );
  const validatePrintingExport = ajv.compile({
    ...exportSchema,
    $ref: "#/$defs/PrintingRecord",
  });
  for (const printing of printings) {
    assert.equal(validatePrintingExport(printing), true, ajv.errorsText(validatePrintingExport.errors));
  }
  assert.equal(
    cards.find(({ official_identity }) => official_identity?.value === "BT99-001").lifecycle.last_observed_revision_id,
    observedDigimonRevisionId,
  );
  assert.equal(
    printings.find(({ id }) => id === printingId).lifecycle.last_observed_revision_id,
    observedDigimonRevisionId,
  );
  const currentOnePiece = products.find(({ official_code }) => official_code === "OP-RAW-01");
  assert.ok(currentOnePiece, JSON.stringify(products.map(({ name, official_code }) => ({ name, official_code }))));
  assert.equal(currentOnePiece.lifecycle.last_observed_revision_id, revisionId);
  const establishedOnePiece = currentOnePiece;
  const establishedOnePieceResponse = await fetch(`${api.url}/v1/products/${establishedOnePiece.id}`, {
    headers,
  });
  assert.equal(establishedOnePieceResponse.status, 200);
  const establishedOnePieceDocument = await establishedOnePieceResponse.json();
  assert.equal(Object.hasOwn(establishedOnePieceDocument, "provenance"), false);
  assert.equal(products.length, 5);
  assert.equal(releases.length, 5);
  // fusion-world-en@9 Card details name no publisher product code, so the
  // Fusion World Printing binds to its source bucket rather than a Product
  // distribution context. The fifth context is the Gundam accessory page the
  // product listing links: the restructured adapters fetch it and retain it as
  // explicit non-card evidence instead of dropping it by URL vocabulary.
  assert.equal(contexts.length, 5, JSON.stringify(contexts));
  const accessoryContexts = contexts.filter(({ label }) => label === "accessory");
  assert.deepEqual(
    accessoryContexts.map(({ game, kind, label, product_id }) => ({
      game,
      kind,
      label,
      product_id,
    })),
    [
      {
        game: "gundam",
        kind: "other",
        label: "accessory",
        product_id: null,
      },
    ],
    JSON.stringify(contexts),
  );
  assert.equal(
    products.some(({ name }) => name === "Official Card Case Set 02"),
    false,
    "an accessory publication must not be promoted to a Product",
  );
  assert.ok(products.some(({ id }) => id === productId));
  assert.ok(products.every(({ releases: value }) => value === undefined));
  assert.ok(releases.some((release) => release.product_id === productId && release.region === "unknown"));
  assert.ok(contexts.some((context) => context.product_id === productId));
  // Four game Cards plus the Fusion World Energy Marker; the two Gundam
  // lineages converge on the same Card.
  assert.equal(cards.length, 5);
  assert.ok(relationships.some(({ kind }) => kind === "distribution-context-product"));
  for (const projection of [...printingDocument.data.products, ...printingDocument.data.distribution_contexts]) {
    assert.ok(
      relationships.some((relationship) => relationship.from.id === printingId && relationship.to.id === projection.id),
    );
  }
  for (const code of ["OP-RAW-01", "FB-RAW-01", "GD-RAW-01"]) {
    assert.ok(products.some(({ official_code }) => official_code === code));
  }
  const onePieceCard = cards.find(({ official_identity }) => official_identity?.value === "OP99-001");
  assert.ok(onePieceCard);
  const onePiecePrinting = printings.find(({ card_id }) => card_id === onePieceCard.id);
  assert.ok(onePiecePrinting);
  // Public filtering consumes the actual publication's Printing and profile
  // projections, including carried-forward Cards from every Supported Game.
  const validateCardQuery = ajv.getSchema(`${apiSchema.$id}#/$defs/CardCollectionQuery`);
  const validateCardCollection = ajv.getSchema(`${apiSchema.$id}#/$defs/CardCollection`);
  for (const [game, identity, attribute] of [
    ["one-piece", "OP99-001", "cost"],
    ["digimon", "BT99-001", "level"],
    ["gundam", "GD99-001", "level"],
    ["fusion-world", "FB99-001", "cost"],
  ]) {
    const expected = cards.find((card) => card.game === game && card.official_identity.value === identity);
    assert.ok(expected, `${game} published Card is missing`);
    const query = {
      game,
      card_number: identity,
      [`attribute.${attribute}`]: String(expected.game_data.attributes[attribute]),
      "attribute.colours": expected.game_data.attributes.colours[0],
      ...(game === "one-piece"
        ? { product_id: establishedOnePiece.id, rarity: onePiecePrinting.rarity.normalized }
        : {}),
    };
    assert.equal(validateCardQuery(query), true, ajv.errorsText(validateCardQuery.errors));
    const filteredResponse = await fetch(`${api.url}/v1/cards?${new URLSearchParams(query)}`, { headers });
    assert.equal(filteredResponse.status, 200, await filteredResponse.clone().text());
    const filtered = await filteredResponse.json();
    assert.equal(validateCardCollection(filtered), true, ajv.errorsText(validateCardCollection.errors));
    assert.deepEqual(
      filtered.data.map(({ id }) => id),
      [expected.id],
    );
    assert.equal(filtered.meta.catalogue_revision_id, revisionId);
  }
  assert.equal(validateCardQuery({ "attribute.cost": "3" }), false);
  const invalidAttribute = await fetch(`${api.url}/v1/cards?game=one-piece&attribute.level=3`, { headers });
  assert.equal(invalidAttribute.status, 400);
  assert.equal((await invalidAttribute.json()).code, "invalid_parameter");

  assert.equal(Object.hasOwn(onePiecePrinting, "source_lineages"), false);

  assert.equal(Object.hasOwn(onePiecePrinting, "locator_evidence"), false);
  const gundam = products.find(({ official_code }) => official_code === "GD-RAW-01");
  assert.ok(gundam);
  const gundamCard = cards.find(({ official_identity }) => official_identity?.value === "GD99-001");

  assert.equal(Object.hasOwn(gundamCard, "source_lineages"), false);
  const gundamPrinting = printings.find(({ card_id }) => card_id === gundamCard.id);

  assert.equal(Object.hasOwn(gundamPrinting, "source_lineages"), false);
  const gundamPrintingResponse = await fetch(`${api.url}/v1/printings/${gundamPrinting.id}`, {
    headers,
  });
  assert.equal(gundamPrintingResponse.status, 200);
  const gundamPrintingDocument = await gundamPrintingResponse.json();

  assert.equal(Object.hasOwn(gundamPrintingDocument.data, "source_lineages"), false);
  assert.equal(Object.hasOwn(gundamPrintingDocument, "included"), false);
  assert.deepEqual(
    releases
      .filter(({ product_id }) => product_id === gundam.id)
      .map(({ region }) => region)
      .sort(),
    ["EN-ASIA", "EN-US"],
  );
  assert.ok(
    relationships.some(
      ({ kind, from, to }) =>
        kind === "product-card" && from.id === cardBearing.id && cards.some(({ id }) => id === to.id),
    ),
  );

  await stopWorker(api);
  const provenanceIngestion = await startWorker({
    ...checkpointTransport,
    config: ingestionConfig,
    envFile: ingestionEnv,
    inspectorPort: ingestion.inspectorPort,
    port: ingestion.port,
    statePath,
  });
  t.after(() => stopWorker(provenanceIngestion));
  await waitForHealth(`${provenanceIngestion.url}/health`, administrationKey, provenanceIngestion);
  const provenanceCollected = await runCli(
    [
      "source",
      "collect",
      "--plan-file",
      carryPlanPath,
      "--idempotency-key",
      "acceptance-product-code-less-provenance-collect",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(provenanceCollected.code, 0, provenanceCollected.stderr);
  const provenanceRun = JSON.parse(provenanceCollected.stdout);
  assert.equal((await runCli(["source", "resume", "--run-id", provenanceRun.id, "--json"], cliEnvironment)).code, 0);
  await waitForRunState(provenanceRun.id, "sealed", cliEnvironment, provenanceIngestion, statePath);
  const provenanceInspectionResult = await inspectNativeCollection(provenanceRun.id, cliEnvironment);
  const provenanceInspection = provenanceInspectionResult;
  const provenanceApproved = await publishNativeCollection(
    provenanceInspection,
    "acceptance-product-code-less-provenance-approve",
    cliEnvironment,
    provenanceIngestion,
  );
  assert.equal(provenanceApproved.state, "published", JSON.stringify(provenanceApproved));

  const codeLessRevisionId = provenanceApproved.resulting_revision_id;
  await stopWorker(provenanceIngestion);

  const provenanceApi = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: api.inspectorPort,
    port: api.port,
    statePath,
  });
  t.after(() => stopWorker(provenanceApi));
  await waitForHealth(`${provenanceApi.url}/health`, apiKey, provenanceApi);
  const codeLessProducts = await nativeExportRecords(provenanceApi.url, apiKey, codeLessRevisionId, "products");
  const codeLessOnePiece = codeLessProducts.find(({ official_code }) => official_code === "OP-RAW-01");
  assert.equal(
    codeLessOnePiece.id,
    establishedOnePiece.id,
    "the R2 export keeps the established Product identity across a code-less refresh",
  );
  const codeLessOnePieceResponse = await fetch(`${provenanceApi.url}/v1/products/${codeLessOnePiece.id}`, { headers });
  assert.equal(codeLessOnePieceResponse.status, 200);
  const codeLessOnePieceDocument = await codeLessOnePieceResponse.json();

  assert.equal(Object.hasOwn(codeLessOnePieceDocument, "provenance"), false);

  assert.equal(Object.hasOwn(codeLessOnePieceDocument, "provenance"), false);
});

// A run that never reaches its expected state is diagnosed against the
// persisted collection tables, which record why each request stalled.
async function waitForRunState(runId, expectedState, environment, worker, statePath) {
  try {
    return await waitForNativeCollection(runId, expectedState, environment, worker, {
      deadlineMs: 40_000,
    });
  } catch (error) {
    error.message += `\npersisted: ${JSON.stringify(await persistedRunDiagnostics(statePath, runId))}`;
    throw error;
  }
}

async function persistedRunDiagnostics(statePath, runId) {
  const sqliteFiles = await sqliteFilesUnder(await persistedDatabaseDirectory(statePath));
  const failures = [];
  for (const path of sqliteFiles) {
    let database;
    try {
      database = new DatabaseSync(path, { readOnly: true });
      const hasRequests = schemaQueries.sourceRequestTableExists(database).get();
      if (hasRequests === undefined) continue;
      const hasRun = sourceEvidenceQueries.runHasSourceRequests(database).get(runId);
      if (hasRun === undefined) continue;

      return {
        source_requests: sourceEvidenceQueries.runSourceRequestsDiagnostics(database).all(runId),
        fetch_attempts: sourceEvidenceQueries.runFetchAttemptsDiagnostics(database).all(runId),
        captures: sourceEvidenceQueries.runCapturesDiagnostics(database).all(runId),
        snapshots: sourceEvidenceQueries.runSnapshotsDiagnostics(database).all(runId),
        parses: sourceEvidenceQueries.runParsesDiagnostics(database).all(runId),
        discovery_children: sourceEvidenceQueries.runDiscoveryChildrenDiagnostics(database).all(runId),
      };
    } catch (error) {
      failures.push({ path, error: String(error) });
    } finally {
      database?.close();
    }
  }
  return { sqlite_files: sqliteFiles, inspection_failures: failures };
}

async function sqliteFilesUnder(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const child = join(path, entry.name);
      return entry.isDirectory() ? sqliteFilesUnder(child) : entry.name.endsWith(".sqlite") ? [child] : [];
    }),
  );
  return nested.flat();
}

const officialDiscoveryUrls = {
  "one-piece-en": "https://en.onepiece-cardgame.com/cardlist/?series=569116",
  "fusion-world-en": "https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&category%5B0%5D=583301",
  "digimon-en": "https://world.digimoncard.com/cards/index.php?search=true",
  "gundam-en-asia": "https://www.gundam-gcg.com/asia-en/cards/index.php",
  "gundam-en-us": "https://www.gundam-gcg.com/en/cards/index.php",
};

function officialPlan(
  game,
  lineage,
  adapter,
  headers = lineage === "digimon-en"
    ? {
        accept: "text/html",
        "user-agent": "card-keepr-acceptance-product/default",
      }
    : { accept: "text/html" },
) {
  return {
    supported_game: game,
    source_lineage: lineage,
    adapter_version: adapter,
    requests: [
      {
        id: `${lineage}:discovery`,
        url: officialDiscoveryUrls[lineage],
        headers,
      },
    ],
  };
}
