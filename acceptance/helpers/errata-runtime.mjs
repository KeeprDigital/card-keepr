import { readWorkerConfig } from "../../cli/lib/config.mjs";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCli } from "./acceptance-runtime.mjs";
import {
  inspectNativeCollection,
  nativeExportRecords,
  publishNativeCollection,
  waitForNativeCollection,
} from "./native-catalogue-runtime.mjs";
import { withNativeRequestPacing } from "./native-request-pacing.mjs";

const root = resolve(import.meta.dirname, "../..");

export function digimonOfficialPlan() {
  return {
    supported_game: "digimon",
    source_lineage: "digimon-en",
    adapter_version: "digimon-en@7",
    requests: [
      {
        id: "digimon-en:discovery",
        url: "https://world.digimoncard.com/cards/index.php?search=true",
        headers: { accept: "text/html" },
      },
    ],
  };
}

export async function collectSource(input, environment, runtime) {
  const result = await runCli(
    [
      "source",
      "collect",
      "--game",
      "one-piece",
      "--lineage",
      "one-piece-en",
      "--adapter",
      input.adapter,
      "--request-id",
      input.requestId,
      "--url",
      input.url,
      "--idempotency-key",
      input.idempotencyKey,
      "--json",
    ],
    environment,
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}\n${runtime.getOutput()}`);
  return JSON.parse(result.stdout);
}

const injectedFixtureRuns = new Set();

export async function collectFixtureSource(input, environment) {
  const response = await administrationFetch(
    environment,
    new URL("/acceptance/synthetic-evidence", environment.KEEPR_INGESTION_URL),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${environment.KEEPR_ADMINISTRATION_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: input.adapter,
        idempotency_key: input.idempotencyKey,
        requests: [
          {
            id: input.requestId,
            method: "GET",
            url: input.url,
            headers: { accept: "application/json" },
          },
        ],
      }),
    },
  );
  const document = await response.json();
  assert.equal(response.status, 201, JSON.stringify(document));
  injectedFixtureRuns.add(document.id);
  return document;
}

export async function representRetainedSnapshotAdapter(sourceSnapshotId, adapterVersion, environment) {
  const response = await administrationFetch(
    environment,
    new URL("/acceptance/retained-snapshot-adapter", environment.KEEPR_INGESTION_URL),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${environment.KEEPR_ADMINISTRATION_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        source_snapshot_id: sourceSnapshotId,
        adapter_version: adapterVersion,
      }),
    },
  );
  const document = await response.json();
  assert.equal(response.status, 201, JSON.stringify(document));
  assert.equal(typeof document.source_snapshot_id, "string");
  return document.source_snapshot_id;
}

export async function resumeAndWait(runId, environment, runtime) {
  const headers = { authorization: `Bearer ${environment.KEEPR_ADMINISTRATION_KEY}` };
  const sourceResponse = await administrationFetch(environment, `${runtime.url}/v1/ingestion-runs/${runId}/evidence`, {
    headers,
  });
  assert.equal(sourceResponse.status, 200);
  const source = await sourceResponse.json();
  if (!injectedFixtureRuns.has(runId)) {
    if (source.state !== "collecting")
      return waitForNativeCollection(runId, "sealed", environment, runtime, { deadlineMs: 20_000 });
    const resumed = await runCli(["source", "resume", "--run-id", runId, "--json"], environment);
    assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  } else {
    // Synthetic source fixtures already captured and parsed their retained
    // evidence. Enter the shipped native candidate owner directly.
    assert.equal(source.state, "parsing");
    const status = await runCli(["status", "--json"], environment);
    assert.equal(status.code, 0, status.stderr);
    const response = await administrationFetch(environment, `${runtime.url}/v1/game-candidates`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        ingestion_run_id: runId,
        supported_game: "one-piece",
        expected_game_revision_id: JSON.parse(status.stdout).safe_state.current_revision_id,
        idempotency_key: `native-fixture-${runId}`,
      }),
    });
    assert.equal(response.status, 201, await response.clone().text());
  }
  try {
    return await waitForNativeCollection(runId, "sealed", environment, runtime, { deadlineMs: 20_000 });
  } catch (error) {
    const collection = await (
      await administrationFetch(environment, `${runtime.url}/v1/ingestion-runs/${runId}/game-candidates`, { headers })
    ).json();
    const diagnostics = [];
    for (const candidate of collection.candidates) {
      const partitions = await (
        await administrationFetch(environment, `${runtime.url}/v1/game-candidates/${candidate.id}/partitions`, {
          headers,
        })
      ).json();
      for (const partition of partitions.partitions.filter((p) => ["warnings", "shared_warnings"].includes(p.kind)))
        diagnostics.push(
          await (
            await administrationFetch(
              environment,
              `${runtime.url}/v1/game-candidates/${candidate.id}/partitions/${partition.ordinal}`,
              {
                headers,
              },
            )
          ).json(),
        );
    }
    error.message = `${JSON.stringify(diagnostics)}\n${error.message}`;
    throw error;
  }
}

export async function reconcileAndWait(runId, expectedRevision, _idempotencyKey, environment, runtime) {
  await waitForNativeCollection(runId, "sealed", environment, runtime, { deadlineMs: 20_000 });
  const inspection = await inspectNativeCollection(runId, environment);
  const status = await runCli(["status", "--json"], environment);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).safe_state.current_revision_id, expectedRevision);
  return { ...inspection, ...inspection.records };
}

export async function approveCandidate(runId, idempotencyKey, environment, runtime) {
  const publication = await publishNativeCollection(runId, idempotencyKey, environment, runtime, 20_000);
  return publication.resulting_revision_id;
}

export async function writeRuntimeConfig(destination, sourceEntrypoint = "AcceptanceOfficialSourceTransport") {
  const config = await readWorkerConfig(resolve(root, "apps/ingestion/wrangler.jsonc"));
  const apiConfig = await readWorkerConfig(resolve(root, "apps/api/wrangler.jsonc"));
  delete config.$schema;
  config.name = "card-keepr-combined-acceptance-runtime";
  config.main = resolve(root, "acceptance/fixtures/native-combined-card-keepr-runtime.ts");
  config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  config.services = [
    {
      binding: "OFFICIAL_SOURCE_TRANSPORT",
      service: config.name,
      entrypoint: sourceEntrypoint,
    },
  ];
  config.ratelimits.find(({ name }) => name === "ADMINISTRATION_RATE_LIMIT").simple.limit = 300;
  config.ratelimits.push(...apiConfig.ratelimits);
  config.vars.CORS_ALLOWED_ORIGINS = apiConfig.vars.CORS_ALLOWED_ORIGINS;
  await writeFile(destination, JSON.stringify(config));
}

export async function apiJson(baseUrl, pathname, apiKey) {
  const response = await fetch(`${baseUrl}${pathname}`, { headers: { authorization: `Bearer ${apiKey}` } });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

export async function exportComponent(baseUrl, revisionId, component, apiKey) {
  const records = await nativeExportRecords(baseUrl, apiKey, revisionId, component);
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

export function administrationFetch(environment, url, init) {
  return withNativeRequestPacing(environment, () => fetch(url, init));
}
