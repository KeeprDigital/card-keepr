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
// Exact retained records in archive order with the normal JPEG images each
// admitted record claims (by set): blb 1, tmm2 1, altc 2, tdag 1, tdm 2,
// cmr 1, cmb2 1, unk 1. Two excluded records claim none. Ten image requests.
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

test("image tranches publish selected Scryfall images, defer the rest and skip earlier tranches", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-scryfall-tranches-"));
  const statePath = join(directory, "state");
  const cards = await Promise.all(records.map(async (name) => readFile(`${pack}/bulk/${name}`)));
  const archive = gzipSync(Buffer.concat(cards));
  const metadata = JSON.parse(await readFile(`${pack}/raw/bulk-metadata.json`, "utf8"));
  metadata.data.find((entry) => entry.type === "default_cards").compressed_size = archive.length;
  const metadataBytes = Buffer.from(JSON.stringify(metadata));
  // Offline Scryfall: the archive's own image URLs answer with a retained
  // JPEG made distinct per URL after its end-of-image marker.
  const jpeg = await readFile(`${pack}/raw/chillerpillar-front.jpg`);
  const imageUrls = new Map();
  for (const line of cards) {
    const card = JSON.parse(line);
    const faces = card.image_uris ? [card] : card.card_faces;
    for (const face of faces) imageUrls.set(face.image_uris.normal, card.set);
  }
  assert.equal(imageUrls.size, 12);
  const responses = new Map([
    [metadataUrl, { bytes: metadataBytes, media: "application/json" }],
    [archiveUrl, { bytes: archive, media: "application/gzip" }],
    ...[...imageUrls.keys()].map((url) => [
      url,
      { bytes: Buffer.concat([jpeg, Buffer.from(`\n${url}`)]), media: "image/jpeg" },
    ]),
  ]);
  const imagesOf = (...sets) => [...imageUrls].filter(([, set]) => sets.includes(set)).map(([url]) => url);
  const budgetPath = join(directory, "budget.json");
  await writeFile(
    budgetPath,
    JSON.stringify({
      max_dispatches: 10,
      max_source_bytes: 536870912,
      dispatch_deadline: new Date(Date.now() + 2 * 86400000).toISOString(),
    }),
  );
  const example = JSON.parse(await readFile("docs/examples/scryfall-magic-images-tranche-plan.json", "utf8"));
  const tranchePlan = async (name, discovery_selection) => {
    const path = join(directory, `${name}.json`);
    await writeFile(path, JSON.stringify({ plans: [{ ...example.plans[0], discovery_selection }] }));
    return path;
  };
  const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  delete config.$schema;
  // Three tranches poll collection, preparation and publication in one minute.
  config.ratelimits.find(({ name }) => name === "ADMINISTRATION_RATE_LIMIT").simple.limit = 500;
  config.main = resolve("apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  const key = crypto.randomUUID();
  let fetched = [];
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
    else t.diagnostic(`Retained Scryfall tranche state: ${directory}`);
  });
  ingestion = await startWorker({ ...runtime, migrate: true });
  await waitForHealth(`${ingestion.url}/health`, key, ingestion);
  const environment = { KEEPR_INGESTION_URL: ingestion.url, KEEPR_ADMINISTRATION_KEY: key };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr + ingestion.getOutput());
    return JSON.parse(result.stdout);
  };
  const printingImages = new Map();
  // One owner tranche: collect, resume, publish the sealed candidate.
  const tranche = async (name, planFile) => {
    fetched = [];
    const run = await cli([
      "source",
      "collect",
      "--plan-file",
      planFile,
      "--budget-file",
      budgetPath,
      "--idempotency-key",
      name,
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
    const source = await cli(["source", "show", "--run-id", run.id]);
    const inspection = await inspectNativeCollection(run.id, environment, {
      candidates: collection.candidates,
      partitionKinds: ["printings", "printing_images"],
    });
    const publication = await publishNativeCollection(inspection, name, environment, ingestion, 120000);
    assert.equal(publication.checkpoint.state, "verified");
    return { run, source, fetched: [...fetched], inspection };
  };

  // Tranche 0: every fact, no image request, every Printing an explicit gap.
  const zero = await tranche("scryfall-tranche-0", "docs/examples/scryfall-magic-facts-plan.json");
  assert.deepEqual(zero.fetched, [metadataUrl, archiveUrl]);
  assert.equal(zero.source.collection.deferred_requests.count, 0);
  const printings = zero.inspection.records.printings.map(({ id }) => id).sort();
  assert.equal(printings.length, 7);
  assert.deepEqual(zero.inspection.records.printing_images ?? [], []);

  // Tranche 1 selects the first two image requests in the retained discovery
  // order and defers the other eight, which stay explicit gaps.
  const one = await tranche(
    "scryfall-tranche-1",
    await tranchePlan("tranche-1", { role: "image", maximum_requests: 2 }),
  );
  const firstImages = imagesOf("blb", "tmm2");
  assert.deepEqual(one.fetched, [metadataUrl, archiveUrl, ...firstImages]);
  const bytesOf = (urls) => urls.reduce((total, url) => total + responses.get(url).bytes.length, 0);
  assert.deepEqual(
    {
      charged: one.source.acquisition.charged_dispatches,
      bytes: one.source.acquisition.charged_source_bytes,
      reserved: one.source.acquisition.reserved_source_bytes,
      skipped: one.source.collection.evidence.skipped_request_count,
      images: one.source.collection.requests.by_role.image,
    },
    { charged: 4, bytes: bytesOf(one.fetched), reserved: 0, skipped: 0, images: 2 },
  );
  assert.deepEqual(one.source.collection.deferred_requests, {
    count: 8,
    selections: [{ source_lineage: "scryfall-magic-en", role: "image", group_count: null, maximum_requests: 2 }],
    by_lineage: [{ source_lineage: "scryfall-magic-en", role: "image", count: 8 }],
    group_count: 6,
    detail_limit: 20,
    groups_truncated: false,
    groups: [
      { group: "altc", count: 2 },
      { group: "tdm", count: 2 },
      { group: "cmb2", count: 1 },
      { group: "cmr", count: 1 },
      { group: "tdag", count: 1 },
      { group: "unk", count: 1 },
    ],
  });
  const summary = await runCli(["source", "show", "--run-id", one.run.id], environment);
  assert.match(summary.stdout, /Deferred: 8 discovered requests not selected by this plan across 6 groups/u);
  // Images attach to the already-published Printings without changing identity.
  assert.deepEqual(one.inspection.records.printings.map(({ id }) => id).sort(), printings);
  for (const image of one.inspection.records.printing_images) printingImages.set(image.id, image);
  assert.deepEqual(
    new Set(one.inspection.records.printing_images.map(({ source_url }) => source_url)),
    new Set(firstImages),
  );
  assert.equal(printingImages.size, 3, "blb's two finishes and the tmm2 token");

  // Tranche 2 selects by set: blb is re-selected and skipped unchanged, altc
  // is new, and tmm2 is not selected yet stays published from tranche 1.
  const two = await tranche(
    "scryfall-tranche-2",
    await tranchePlan("tranche-2", { role: "image", groups: ["altc", "blb"] }),
  );
  const secondImages = imagesOf("altc");
  assert.deepEqual(two.fetched, [metadataUrl, archiveUrl, ...secondImages]);
  assert.deepEqual(
    {
      charged: two.source.acquisition.charged_dispatches,
      bytes: two.source.acquisition.charged_source_bytes,
      skipped: two.source.collection.evidence.skipped_request_count,
      deferred: two.source.collection.deferred_requests.count,
    },
    { charged: 4, bytes: bytesOf(two.fetched), skipped: 1, deferred: 7 },
  );
  assert.deepEqual(two.inspection.records.printings.map(({ id }) => id).sort(), printings);
  const published = new Map(two.inspection.records.printing_images.map((image) => [image.id, image]));
  for (const [id, image] of printingImages) assert.deepEqual(published.get(id), image);
  assert.equal(published.size, 5, "tranche 1's three and altc's front and back");

  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  const get = async (path) => {
    const response = await fetch(`${api.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const served = await Promise.all(
    printings.map(async (id) => (await get(`/v1/printings/${id}`)).data.printing_images.length),
  );
  // Five images on three Printings; the other four keep explicit image gaps.
  assert.deepEqual(served.filter((count) => count > 0).sort(), [1, 1, 1, 2]);
  assert.equal(served.filter((count) => count === 0).length, 3);
  passed = true;
});
