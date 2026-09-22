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
import { syntheticPiltoverGalleryPage } from "../test/support/synthetic-flight-pages.mjs";

const fixture = "acceptance/fixtures/real-sources/2026-09-21-piltover-archive";
const lineage = "piltover-archive-en";

// Offline rehearsal of the #330 live census through the owner CLI: the shipped
// census plan, a finite budget file, and `source show` receipts. The 48 records
// are the unchanged rows of the retained page 1; only the two-page pagination
// envelope is synthetic. The two pinned fronts are the retained real bytes;
// every other front is an injected outage retained as an explicit image gap.
test("Piltover Archive census rehearsal collects every reported page and front under a finite budget and retains every row for review", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-piltover-census-"));
  const statePath = join(directory, "state");
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const fronts = new Map();
  let galleryHtml;
  for (const capture of manifest.captures) {
    const bytes = await readFile(join(fixture, capture.body));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), capture.sha256);
    if (capture.url === "https://piltoverarchive.com/cards") galleryHtml = bytes.toString("utf8");
    else fronts.set(capture.url, { bytes, type: capture.response_headers["content-type"] });
  }
  const vite = await import("vite");
  const server = await vite.createServer({ logLevel: "silent", server: { middlewareMode: true } });
  t.after(() => server.close());
  const { parsePiltoverGalleryPage } = await server.ssrLoadModule(
    "/src/catalogue/adapters/piltover-archive-gallery.ts",
  );
  const records = parsePiltoverGalleryPage(galleryHtml, "https://piltoverarchive.com/cards").rows.map(
    (row) => row.record,
  );
  const pages = new Map(
    [records.slice(0, 24), records.slice(24)].map((page, index) => [
      `https://piltoverarchive.com/cards?page=${index + 1}`,
      syntheticPiltoverGalleryPage({ page: index + 1, pages: 2, total: 48, variants: page }),
    ]),
  );
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
      if (page) return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      const front = fronts.get(request.url);
      if (front) return new Response(front.bytes, { headers: { "content-type": front.type } });
      const url = new URL(request.url);
      assert.ok(
        ["cdn.piltoverarchive.com", "piltoverarchive.b-cdn.net"].includes(url.hostname),
        `Unexpected source acquisition: ${request.url}`,
      );
      return new Response("Injected front outage", { status: 404 });
    },
  });
  let passed = false;
  t.after(async () => {
    await stopWorker(worker);
    if (passed) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained Piltover Archive census state: ${directory}`);
  });
  await waitForHealth(`${worker.url}/health`, key, worker);
  const environment = { KEEPR_INGESTION_URL: worker.url, KEEPR_ADMINISTRATION_KEY: key };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  // The live procedure's budget shape, sized for this two-page rehearsal.
  const budgetPath = join(directory, "budget.json");
  await writeFile(
    budgetPath,
    JSON.stringify({
      max_dispatches: 60,
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
    "docs/examples/piltover-archive-census-plan.json",
    "--idempotency-key",
    "piltover-archive-census-rehearsal",
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
    requested.filter((url) => pages.has(url)),
    [...pages.keys()],
    "Page 1, then the one page it reports",
  );
  assert.equal(requested.filter((url) => !pages.has(url)).length, 48, "One front per row");
  const shown = await cli(["source", "show", "--run-id", run.id]);
  assert.equal(shown.acquisition.budget.max_dispatches, 60);
  const hosts = new Map(shown.collection.pacing.limits.map((limit) => [limit.hostname, limit]));
  assert.deepEqual([...hosts.keys()].sort(), [
    "cdn.piltoverarchive.com",
    "piltoverarchive.b-cdn.net",
    "piltoverarchive.com",
  ]);
  assert.deepEqual(
    [hosts.get("piltoverarchive.com").kind, hosts.get("piltoverarchive.com").source],
    ["page", "registration"],
  );
  assert.equal(hosts.get("cdn.piltoverarchive.com").maximum_concurrency, 4);
  assert.equal(shown.collection.failed_images.count, 46, "Only the two pinned fronts have retained bytes");
  const proposals = (await cli(["entity-proposal", "list", "--game", "riftbound"])).proposals.filter(
    (proposal) => proposal.source_lineage === lineage,
  );
  assert.equal(proposals.length, 48, "Every census row, including the pinned overlap, awaits owner review");
  assert.ok(proposals.every((proposal) => proposal.status === "unresolved"));
  passed = true;
});
