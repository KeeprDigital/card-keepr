import { readWorkerConfig } from "../cli/lib/config.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { applyMigrations, startWorker, stopWorker } from "../acceptance/helpers/acceptance-runtime.mjs";

// A successful command means a usable diagnostic was written. Memory usage is
// an observation; incomplete sampling must remain visible, never a budget pass.
export function summarizeReconciliationMemory(result, report) {
  assert.equal(result.candidate.state, "sealed", "The reconciliation workload must complete");
  const ingestion = report.isolates.find((isolate) => isolate.target === "core:user:card-keepr-ingestion");
  assert.ok(ingestion, "The report must contain the ingestion isolate");
  assert.ok(ingestion.heap_samples.length > 0, "A memory report requires actual heap samples");
  assert.ok(
    ingestion.heap_samples.every((sample) => Number.isFinite(sample.usedSize) && sample.usedSize > 0),
    "Heap samples must be finite positive byte counts",
  );
  const maximum = Math.max(...ingestion.heap_samples.map((sample) => sample.usedSize));
  const reference = 64 * 1024 ** 2;
  return {
    purpose: "Manual reconciliation memory diagnostic; no memory or elapsed-time pass/fail requirement",
    workload_state: result.candidate.state,
    measurement_status: report.errors.length || report.skipped_sampling_intervals > 0 ? "incomplete" : "sampled",
    elapsed_ms: result.elapsed_ms,
    sampled_used_heap_maximum: maximum,
    heap_samples: ingestion.heap_samples.length,
    historical_heap_reference_bytes: reference,
    exceeds_historical_heap_reference: maximum > reference,
    observer_errors: report.errors,
    skipped_sampling_intervals: report.skipped_sampling_intervals,
    limitation:
      "Samples include profiling and fixture overhead. They are not an exhaustive peak or a production-capacity verdict.",
  };
}

async function runDiagnostic() {
  const prefix = process.env.KEEPR_CAPACITY_OUTPUT_PREFIX;
  assert.ok(prefix, "An external report prefix must preserve measurements on failure");
  const directory = await mkdtemp(join(tmpdir(), "keepr-reconciliation-memory-"));
  const statePath = join(directory, "state");
  let completed = false;
  let worker;
  let server;
  console.error(`Diagnostic state: ${directory}`);
  try {
    // Generate independent expected bytes in Node. The default transport also
    // generates this fixture inside the application isolate; the external-source
    // variant serves these Node bytes instead. Both exercise real streamed capture.
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
    const declaredLength = Boolean(process.env.KEEPR_RECONCILIATION_CONTENT_LENGTH);
    assert.ok(!declaredLength || externalSource, "Content-Length variant requires the external source");
    let sourceUrl;
    if (externalSource) {
      server = createServer((_request, response) => {
        response.writeHead(200, {
          "content-type": "application/json",
          ...(declaredLength ? { "content-length": String(sourceBytes.length) } : {}),
        });
        response.end(sourceBytes);
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      sourceUrl = `http://127.0.0.1:${server.address().port}/source`;
    }
    await applyMigrations(statePath);
    const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
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
    const { candidate, params, captured_source: capturedSource } = await setup.json();
    const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
    assert.deepEqual(capturedSource, [{ content_digest: sourceDigest, content_byte_length: sourceBytes.length }]);
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
          captured_source: capturedSource,
          generated_source: {
            generation: externalSource ? "external-node" : "application-isolate",
            declared_content_length: declaredLength ? sourceBytes.length : null,
            bytes: sourceBytes.length,
            sha256: sourceDigest,
          },
          ...result,
        },
        null,
        2,
      ) + "\n",
    );
    await stopWorker(worker);
    worker = undefined;
    const report = JSON.parse(await readFile(`${prefix}-isolate-1.json`, "utf8"));
    const summary = summarizeReconciliationMemory(result, report);
    await writeFile(`${prefix}-summary.json`, JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify(summary, null, 2));
    console.error(`Reports: ${prefix}-{summary,workload,isolate-1}.json`);
    completed = true;
  } finally {
    try {
      if (worker) await stopWorker(worker);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (completed) await rm(directory, { recursive: true, force: true });
      else console.error(`Diagnostic state retained at ${directory}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Bound startup, workload, measurement and cleanup together. On a hard hang,
  // already-written reports and the printed state directory remain available.
  const timeout = setTimeout(() => {
    console.error("Reconciliation memory diagnostic exceeded its 120-second hang limit; state retained.");
    process.exit(1);
  }, 120_000);
  try {
    await runDiagnostic();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}
