import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { applyMigrations, startWorker, stopWorker } from "./helpers/acceptance-runtime.mjs";

test("bounded synthetic Product reconciliation isolates memory from the Vitest runner", {
  skip: !process.env.KEEPR_RECONCILIATION_CAPACITY_PROBE,
}, async (t) => {
  const prefix = process.env.KEEPR_CAPACITY_OUTPUT_PREFIX;
  assert.ok(prefix, "An external report prefix must preserve measurements on failure");
  const directory = await mkdtemp(join(tmpdir(), "keepr-reconciliation-memory-"));
  const statePath = join(directory, "state");
  let passed = false;
  let worker;
  t.after(async () => {
    if (worker) await stopWorker(worker);
    if (passed) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Probe state retained at ${directory}`);
  });
  // Same pure fixture generator and JSON encoding as Response.json in workerd.
  // Generation and serving buffers live in Node; application capture owns the response stream.
  const outfile = join(directory, "source.mjs");
  await build({
    entryPoints: ["test/support/fake-publisher/reconciliation-documents.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  const { reconciliationSourceDocument } = await import(pathToFileURL(outfile).href);
  const sourceBytes = Buffer.from(
    JSON.stringify(
      reconciliationSourceDocument(
        "scale-1001-products",
        "",
        "https://official-source.invalid/reconciliation/scale-1001-products",
      ),
    ),
  );
  const externalSource = Boolean(process.env.KEEPR_RECONCILIATION_EXTERNAL_SOURCE);
  let sourceUrl;
  if (externalSource) {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(sourceBytes);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    sourceUrl = `http://127.0.0.1:${server.address().port}/source`;
  }
  await applyMigrations(statePath);
  const config = JSON.parse(await readFile("apps/ingestion/wrangler.jsonc", "utf8"));
  delete config.$schema;
  config.main = resolve("acceptance/fixtures/reconciliation-capacity-probe.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  const configPath = join(directory, "probe.json");
  await writeFile(configPath, JSON.stringify(config));
  worker = await startWorker({
    config: configPath,
    statePath,
    vars: { ADMINISTRATION_KEY: "probe-owner", SOURCE_HOST_PACING_MODE: "immediate" },
  });
  const setup = await fetch(`${worker.url}/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source_url: sourceUrl }),
  });
  assert.equal(setup.status, 200, await setup.clone().text());
  const { candidate, params } = await setup.json();
  const response = await fetch(`${worker.url}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: candidate.id, params }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  await writeFile(
    `${prefix}-workload.json`,
    JSON.stringify(
      {
        scope:
          "Synthetic 1001 Products; real retained collection and reconciliation, direct test Workflow driver, no publication/backup. Driver phase receipt markers are labelled probe-driver.",
        source: {
          generation: externalSource ? "external-node" : "application-isolate",
          bytes: sourceBytes.length,
          sha256: createHash("sha256").update(sourceBytes).digest("hex"),
        },
        ...result,
      },
      null,
      2,
    ) + "\n",
  );
  await stopWorker(worker);
  const report = JSON.parse(await readFile(`${prefix}-isolate-1.json`, "utf8"));
  const ingestion = report.isolates.find((isolate) => isolate.target === "core:user:card-keepr-ingestion");
  const maximum = Math.max(...ingestion.heap_samples.map((sample) => sample.usedSize));
  t.diagnostic(
    JSON.stringify({
      elapsed_ms: result.elapsed_ms,
      sampled_used_heap_maximum: maximum,
      heap_samples: ingestion.heap_samples.length,
      errors: report.errors.length,
    }),
  );
  assert.equal(result.candidate.state, "sealed");
  assert.ok(result.elapsed_ms < 15000, `Reconciliation took ${result.elapsed_ms} ms`);
  const failures = [];
  if (maximum > 64 * 1024 ** 2) failures.push(`Sampled used heap ${maximum} exceeds the initial 64 MiB target`);
  if (report.errors.length) failures.push(`Observer errors: ${report.errors.join("; ")}`);
  assert.deepEqual(failures, [], failures.join("\n"));
  passed = true;
});
