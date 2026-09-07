import {
  inspectNativeCollection,
  publishNativeCollection,
  waitForNativeCollection,
  nativeCheckpointTransport,
  nativeExportRecords,
} from "./helpers/native-catalogue-runtime.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
} from "./fixtures/catalogue-runtime-harness.mjs";

const root = resolve(import.meta.dirname, "..");

// Gundam is published from two Source Lineages (EN-ASIA and EN-US) that
// describe the same Cards; a complete run collects both and reconciles them
// onto one Card and one Printing whose provenance names both lineages.
const lineages = {
  "gundam-en-asia": { locale: "asia-en", region: "EN-ASIA" },
  "gundam-en-us": { locale: "en", region: "EN-US" },
};

function lineageUrls(locale) {
  const base = `https://www.gundam-gcg.com/${locale}`;
  return {
    discovery: `${base}/cards/index.php`,
    packageLeaf: `${base}/cards/?package=all`,
    // The gundam-en-*@7 collection walks the publisher's navigation from the
    // card search root (the cards hub, the product listing,
    // and the news hub), then captures each surface: a URL that serves
    // several surfaces is a distinct Source Request per surface, so the
    // cards hub is retained as a navigation stage and as the packages
    // surface, the product listing as a stage plus the products and releases
    // surfaces, and the linked accessory once per product surface.
    retained: [
      `${base}/cards/index.php`,
      `${base}/cards/`,
      `${base}/cards/`,
      `${base}/products/list.php`,
      `${base}/products/list.php`,
      `${base}/products/list.php`,
      `${base}/news/`,
      `${base}/news/?subcategory=news&tag=all&page=1`,
      `${base}/cards/?package=all`,
      `${base}/products/deck-case02.html`,
      `${base}/products/deck-case02.html`,
      `${base}/images/GD99-001.png`,
    ],
  };
}

test("native publication: the owner publishes a complete Gundam catalogue from both English lineages", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-gundam-"));
  const statePath = join(directory, "shared-state");
  const administrationKey = randomUUID();
  const apiKey = randomUUID();
  const ingestionEnv = join(directory, "ingestion.env");
  const apiEnv = join(directory, "api.env");
  const ingestionConfig = join(directory, "ingestion.wrangler.json");
  const planPath = join(directory, "gundam-source-plan.json");
  await Promise.all([
    writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`, {
      mode: 0o600,
    }),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(planPath, JSON.stringify(gundamPlan()), { mode: 0o600 }),
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
      service: "card-keepr-synthetic-official-source",
    },
  ];
  await writeFile(ingestionConfig, JSON.stringify(config));

  const source = await startWorker({
    config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
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
  let api = null;
  t.after(async () => {
    await Promise.all([stopWorker(source), stopWorker(ingestion), api === null ? Promise.resolve() : stopWorker(api)]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForHealth(`${source.url}/catalogue-discovery`, "", source),
    waitForHealth(`${ingestion.url}/health`, administrationKey, ingestion),
  ]);
  const cliEnvironment = {
    KEEPR_INGESTION_URL: ingestion.url,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
  };

  const collected = await runCli(
    ["source", "collect", "--plan-file", planPath, "--idempotency-key", "gundam-complete-collect", "--json"],
    cliEnvironment,
  );
  assert.equal(collected.code, 0, `${collected.stdout}\n${collected.stderr}\n${ingestion.getOutput()}`);
  const run = JSON.parse(collected.stdout);
  const resumed = await runCli(["source", "resume", "--run-id", run.id, "--json"], cliEnvironment);
  assert.equal(resumed.code, 0, resumed.stderr);
  const completed = await waitForRunState(run.id, "sealed", cliEnvironment, {
    getOutput: () => `${ingestion.getOutput()}\n${source.getOutput()}`,
  });
  assert.deepEqual(
    completed.evidence_plans.map(({ source_lineage, adapter_version }) => ({
      source_lineage,
      adapter_version,
    })),
    Object.keys(lineages).map((lineage) => ({
      source_lineage: lineage,
      adapter_version: `${lineage}@7`,
    })),
    "one run carries an immutable Evidence Plan per Gundam lineage",
  );
  assert.ok(
    completed.snapshots.every(({ content }) => /^[0-9a-f]{64}$/u.test(content.digest)),
    "every collected surface is retained with its content digest",
  );
  const retainedUrls = completed.snapshots.map(({ request }) => request.url);
  for (const { locale } of Object.values(lineages)) {
    const prefix = `https://www.gundam-gcg.com/${locale}/`;
    assert.deepEqual(
      retainedUrls.filter((url) => url.startsWith(prefix)).sort(),
      [...lineageUrls(locale).retained].sort(),
      `the ${locale} lineage retains every navigation stage, surface, and image`,
    );
  }
  const observationCount = (url) => {
    const snapshot = completed.snapshots.find(({ request }) => request.url === url);
    return completed.observation_sets.find(({ source_snapshot_id }) => source_snapshot_id === snapshot.id)
      ?.observation_count;
  };
  for (const { locale } of Object.values(lineages)) {
    assert.equal(
      observationCount(lineageUrls(locale).packageLeaf),
      1,
      "the package leaf supplies exactly the one published Card record",
    );
  }

  const inspected = await inspectNativeCollection(run.id, cliEnvironment);
  const inspection = inspected;
  assert.equal(inspection.counts.cards.added, 1, "both lineages converge on one Card");
  assert.equal(inspection.counts.printings.added, 1, "both lineages converge on one Printing");
  assert.ok(
    inspection.warnings.some(
      ({ code, raw_value }) =>
        code === "unknown_source_field" && raw_value === "Optional Official Source marketing copy",
    ),
    "unknown publisher Product fields remain visible for schema review",
  );

  const approved = await publishNativeCollection(inspection, "gundam-complete-approve", cliEnvironment, ingestion);
  const revisionId = approved.resulting_revision_id;
  assert.match(revisionId, /^catrev_/u);
  await stopWorker(ingestion);

  api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    statePath,
  });
  await waitForHealth(`${api.url}/health`, apiKey, api);
  const headers = { authorization: `Bearer ${apiKey}` };
  const manifestResponse = await fetch(`${api.url}/v1/catalogue-exports/${revisionId}`, { headers });
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();

  assert.equal(Object.hasOwn(manifest.data, "source_freshness"), false);

  const cardsResponse = await fetch(`${api.url}/v1/cards?game=gundam&card_number=GD99-001`, { headers });
  assert.equal(cardsResponse.status, 200);
  const cardsDocument = await cardsResponse.json();
  assert.equal(cardsDocument.data.length, 1);
  const detailResponse = await fetch(`${api.url}/v1/cards/${cardsDocument.data[0].id}?include=printings`, { headers });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.data.name, "Gundam Cross-region Raw Product Card");

  assert.equal(Object.hasOwn(detail.data, "source_lineages"), false);
  assert.deepEqual(detail.data.game_data, {
    profile: "gundam@1",
    attributes: {
      card_type: "unit",
      colours: ["blue"],
      level: 4,
      cost: 3,
      block_icon: "1",
      effect_text: "Official effective rules",
      zone: "space",
      traits: ["Earth Federation"],
      link_condition: null,
      ap: 3,
      hp: 4,
      series_titles: ["Mobile Suit Gundam"],
    },
  });
  assert.equal(detail.included.length, 1);
  const [printing] = detail.included;
  assert.deepEqual(printing.game_data, {
    profile: "gundam@1",
    attributes: { alternate_art: false },
  });
  assert.equal(Object.hasOwn(printing, "source_lineages"), false);
  const printingResponse = await fetch(`${api.url}/v1/printings/${printing.id}`, { headers });
  assert.equal(printingResponse.status, 200);
  const printingDocument = await printingResponse.json();
  assert.equal(Object.hasOwn(printingDocument, "included"), false);

  const [cards, printings, products, releases, contexts, relationships] = await Promise.all(
    ["cards", "printings", "products", "releases", "distribution-contexts", "relationships"].map((component) =>
      nativeExportRecords(api.url, apiKey, revisionId, component),
    ),
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].game_data.profile, "gundam@1");
  assert.equal(printings.length, 1);
  assert.equal(printings[0].printed_rules_text, "Official printed rules");
  assert.deepEqual(
    products.map(({ official_code }) => official_code),
    ["GD-RAW-01"],
    "the shared Product publishes once across lineages",
  );
  assert.equal(
    products.some(({ name }) => name === "Official Card Case Set 02"),
    false,
    "an accessory publication must not be promoted to a Product",
  );
  assert.deepEqual(
    contexts
      .filter(({ label }) => label === "accessory")
      .map(({ game, kind, product_id }) => ({ game, kind, product_id })),
    [{ game: "gundam", kind: "other", product_id: null }],
    "the accessory publication is retained as explicit non-card evidence",
  );
  assert.deepEqual(
    releases
      .filter(({ product_id }) => product_id === products[0].id)
      .map(({ region }) => region)
      .sort(),
    Object.values(lineages).map(({ region }) => region),
    "each lineage publishes its own regional release of the shared Product",
  );
  assert.ok(
    relationships.some(
      ({ kind, from, to }) => kind === "printing-product" && from.id === printings[0].id && to.id === products[0].id,
    ),
  );
  assert.ok(relationships.every((relationship) => !Object.hasOwn(relationship, "source_lineage")));
});

function gundamPlan() {
  return {
    plans: Object.entries(lineages).map(([lineage, { locale }]) => ({
      supported_game: "gundam",
      source_lineage: lineage,
      adapter_version: `${lineage}@7`,
      requests: [
        {
          id: `${lineage}:discovery`,
          url: lineageUrls(locale).discovery,
          headers: { accept: "text/html" },
        },
      ],
    })),
  };
}

// A run that never reaches its expected state is diagnosed with the candidate
// inspection the CLI would have produced, which names the blocking evidence.
async function waitForRunState(runId, expectedState, environment, worker) {
  try {
    return await waitForNativeCollection(runId, expectedState, environment, worker, {
      deadlineMs: 40_000,
    });
  } catch (error) {
    const inspected = await runCli(["game-candidate", "list", "--run-id", runId, "--json"], environment);
    error.message += `\ncandidate status: ${inspected.stdout} ${inspected.stderr}`;
    throw error;
  }
}
