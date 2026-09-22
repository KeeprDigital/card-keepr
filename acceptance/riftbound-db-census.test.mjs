import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { nativeCheckpointTransport } from "./helpers/native-catalogue-runtime.mjs";
import { isNativeCheckpointRequest } from "./helpers/native-checkpoint-hosts.mjs";
import {
  syntheticRiftboundDbCardsPage,
  syntheticRiftboundDbRecords,
} from "../test/support/synthetic-riftbound-db-pages.mjs";

const fixture = "acceptance/fixtures/real-sources/2026-09-14-riftbound-db";
const lineage = "riftbound-db-en";
const census = (set, page) => `https://www.riftbound-db.com/api/cards?set=${set}&page=${page}&pageSize=80`;

// Offline rehearsal of the #333 live census through the owner CLI: the shipped
// census plan, a finite budget file and `source show` receipts. The facets and
// the five retained records are unchanged real bytes, and the four fronts are
// the retained real images. Only the page envelopes are synthetic, and the OGN
// bucket adds 80 labelled synthetic copies of Anivia so it spans two pages;
// the other nine buckets are empty.
test("Riftbound DB census rehearsal follows every facet bucket and page under a finite budget and retains every record for review", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-riftbound-db-census-"));
  const statePath = join(directory, "state");
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const retained = new Map();
  for (const capture of manifest.captures) {
    const bytes = await readFile(join(fixture, capture.body));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), capture.sha256);
    const type = Object.entries(capture.response_headers).find(([key]) => key.toLowerCase() === "content-type")[1];
    retained.set(capture.url, { bytes, type });
  }
  const json = (url) => JSON.parse(retained.get(url).bytes.toString("utf8"));
  const facetsUrl = "https://www.riftbound-db.com/api/facets";
  const promo = json("https://www.riftbound-db.com/api/cards?set=PR&page=1&pageSize=3").cards;
  const [eclipse, anivia] = json("https://www.riftbound-db.com/api/cards?q=Bird&page=1&pageSize=3").cards.slice(1);
  const synthetic = syntheticRiftboundDbRecords(anivia, 80, "ogn");
  const buckets = { PR: [promo], OGN: [[eclipse, anivia, ...synthetic.slice(0, 78)], synthetic.slice(78)] };
  const pages = new Map([[facetsUrl, retained.get(facetsUrl).bytes]]);
  for (const set of json(facetsUrl).sets) {
    const bucket = buckets[set] ?? [[]];
    const total = bucket.flat().length;
    bucket.forEach((cards, index) =>
      pages.set(census(set, index + 1), syntheticRiftboundDbCardsPage({ page: index + 1, total, cards })),
    );
  }
  assert.equal(pages.size, 13, "Facets, 11 bucket first pages and OGN page 2");
  const fronts = new Map([...retained].filter(([, capture]) => capture.type.startsWith("image/")));
  assert.equal(fronts.size, 4);
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
      const page = pages.get(request.url);
      if (page) return new Response(page, { headers: { "content-type": "application/json" } });
      const front = fronts.get(request.url);
      assert.ok(front, `Unexpected source acquisition: ${request.url}`);
      return new Response(front.bytes, { headers: { "content-type": front.type } });
    },
  });
  let passed = false;
  t.after(async () => {
    await stopWorker(worker);
    if (passed) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained Riftbound DB census state: ${directory}`);
  });
  await waitForHealth(`${worker.url}/health`, key, worker);
  const environment = { KEEPR_INGESTION_URL: worker.url, KEEPR_ADMINISTRATION_KEY: key };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  // The live procedure's budget shape, sized for this rehearsal.
  const budgetPath = join(directory, "budget.json");
  await writeFile(
    budgetPath,
    JSON.stringify({
      max_dispatches: 40,
      max_source_bytes: 16 * 1024 * 1024,
      dispatch_deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    }),
  );
  const run = await cli([
    "source",
    "collect",
    "--budget-file",
    budgetPath,
    "--plan-file",
    "docs/examples/riftbound-db-census-plan.json",
    "--idempotency-key",
    "riftbound-db-census-rehearsal",
  ]);
  await cli(["source", "resume", "--run-id", run.id]);
  await waitForAdministrationDocument(
    `/v1/ingestion-runs/${run.id}/game-candidates`,
    (document) =>
      document.candidates.some((candidate) => ["failed", "paused"].includes(candidate.state))
        ? JSON.stringify(document)
        : document.candidates.length === 1 && document.candidates[0].state === "sealed",
    environment,
    worker,
    { deadlineMs: 120000 },
  );
  assert.deepEqual(
    requested.filter((url) => pages.has(url)).sort(),
    [...pages.keys()].sort(),
    "The facets, every bucket's page 1 and the page its total implies",
  );
  assert.deepEqual(
    requested.filter((url) => !pages.has(url)).sort(),
    [...fronts.keys()].sort(),
    "Only the OpenRift promo fronts and Eclipse Herald's pinned Riot front",
  );
  const shown = await cli(["source", "show", "--run-id", run.id]);
  assert.equal(shown.acquisition.budget.max_dispatches, 40);
  assert.equal(shown.acquisition.charged_dispatches, 17);
  assert.equal(shown.collection.failed_images.count, 0);
  const hosts = new Map(shown.collection.pacing.limits.map((limit) => [limit.hostname, limit]));
  assert.deepEqual(
    [hosts.get("www.riftbound-db.com").kind, hosts.get("www.riftbound-db.com").source],
    ["page", "registration"],
  );
  assert.equal(hosts.get("www.riftbound-db.com").floor_ms, 2000);
  assert.deepEqual([hosts.get("openrift.app").kind, hosts.get("openrift.app").maximum_concurrency], ["asset", 2]);
  const proposals = [];
  let after = null;
  do {
    const page = await cli(["entity-proposal", "list", "--game", "riftbound", ...(after ? ["--after", after] : [])]);
    proposals.push(...page.proposals.filter((proposal) => proposal.source_lineage === lineage));
    after = page.next_cursor;
  } while (after);
  assert.equal(proposals.length, 85, "Every census record, including the Eclipse overlap, awaits owner review");
  assert.ok(proposals.every((proposal) => proposal.status === "unresolved"));
  passed = true;
});
