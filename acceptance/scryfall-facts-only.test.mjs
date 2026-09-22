import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
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
import { isNativeCheckpointRequest } from "./helpers/native-checkpoint-hosts.mjs";

const pack = "acceptance/fixtures/real-sources/2026-09-14-scryfall";
const metadataUrl = "https://api.scryfall.com/bulk-data";
const archiveUrl = "https://data.scryfall.io/default-cards/default-cards-20260914090527.jsonl.gz";
// Exact retained records: six admitted Cards, one excluded non-card insert, one
// excluded deck indicator, one incomplete reversible design and one record
// without an illustration identity.
const records = [
  "normal.json",
  "token.json",
  "art_series.json",
  "token-layout-gameplay.json",
  "manifest-reminder.json",
  "front_card.json",
  "reversible-adventure.json",
  "etched.json",
  "split-three.json",
  "unknown-illustration.json",
];

test("tranche 0 imports Scryfall facts with zero image requests and publishes explicit image gaps", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-scryfall-facts-"));
  const statePath = join(directory, "state");
  const lines = await Promise.all(records.map((name) => readFile(`${pack}/bulk/${name}`)));
  const archive = gzipSync(Buffer.concat(lines));
  // The retained metadata keeps its shape and timestamp; only the advertised size
  // names this small offline archive of unmodified source records.
  const metadata = JSON.parse(await readFile(`${pack}/raw/bulk-metadata.json`, "utf8"));
  metadata.data.find((entry) => entry.type === "default_cards").compressed_size = archive.length;
  const responses = new Map([
    [metadataUrl, { bytes: Buffer.from(JSON.stringify(metadata)), media: "application/json" }],
    [archiveUrl, { bytes: archive, media: "application/gzip" }],
  ]);
  // The live run's exact budget shape: two dispatches needed, retries allowed.
  const budgetPath = join(directory, "tranche-0-budget.json");
  await writeFile(
    budgetPath,
    JSON.stringify({
      max_dispatches: 10,
      max_source_bytes: 536870912,
      dispatch_deadline: new Date(Date.now() + 2 * 86400000).toISOString(),
    }),
  );
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
      fetched.push(request.url);
      return new Response(response.bytes, {
        headers: { "content-type": response.media, "content-length": String(response.bytes.length) },
      });
    },
  };
  let ingestion,
    api,
    passed = false;
  t.after(async () => {
    if (api) await stopWorker(api);
    if (ingestion) await stopWorker(ingestion);
    if (passed) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained Scryfall facts-only state: ${directory}`);
  });
  ingestion = await startWorker({ ...runtime, migrate: true });
  await waitForHealth(`${ingestion.url}/health`, key, ingestion);
  const environment = { KEEPR_INGESTION_URL: ingestion.url, KEEPR_ADMINISTRATION_KEY: key };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr + ingestion.getOutput());
    return JSON.parse(result.stdout);
  };
  const run = await cli([
    "source",
    "collect",
    "--plan-file",
    "docs/examples/scryfall-magic-facts-plan.json",
    "--budget-file",
    budgetPath,
    "--idempotency-key",
    "scryfall-tranche-0",
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
  assert.deepEqual(fetched, [metadataUrl, archiveUrl]);
  const source = await cli(["source", "show", "--run-id", run.id]);
  assert.equal(source.acquisition.charged_dispatches, 2);
  assert.equal(source.acquisition.limiting_dimension, null);
  const inspection = await inspectNativeCollection(run.id, environment, {
    candidates: collection.candidates,
    partitionKinds: ["cards", "printings", "printing_images"],
  });
  assert.deepEqual(inspection.records.cards.map((card) => [card.name, card.category]).sort(), [
    ["Fell Beast's Shriek // Fell Beast's Shriek", "art"],
    ["Forest", "gameplay"],
    ["Maddened Oread", "gameplay"],
    ["Miara, Thorn of the Glade", "gameplay"],
    ["Smelt // Herd // Saw", "gameplay"],
    ["Spirit", "token"],
  ]);
  assert.equal(inspection.records.printings.length, 7);
  assert.deepEqual(inspection.records.printing_images ?? [], []);
  const proposals = (await cli(["entity-proposal", "list", "--game", "magic"])).proposals;
  assert.equal(proposals.filter((proposal) => proposal.status === "admitted").length, 7);
  assert.equal(proposals.filter((proposal) => proposal.status === "unresolved").length, 3);
  const publication = await publishNativeCollection(inspection, "scryfall-tranche-0", environment, ingestion, 120000);
  assert.equal(publication.checkpoint.state, "verified");
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  const get = async (path) => {
    const response = await fetch(`${api.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const printings = (await get("/v1/printings?game=magic")).data;
  assert.equal(printings.length, 7);
  for (const printing of printings) {
    const detail = (await get(`/v1/printings/${printing.id}`)).data;
    assert.deepEqual(detail.printing_images, []);
    // Each image gap serves the claimed Scryfall image as an unverified, attributed link (#425).
    assert.equal(detail.source_image.verified, false);
    assert.equal(detail.source_image.source, "scryfall");
    assert.match(detail.source_image.url, /^https:\/\/cards\.scryfall\.io\/normal\/front\/.+\.jpg\?\d+$/u);
    assert.equal(detail.source_image.attribution.policy_url, "https://company.wizards.com/en/legal/fancontentpolicy");
    assert.deepEqual(printing.source_image, detail.source_image);
  }
  passed = true;
});
