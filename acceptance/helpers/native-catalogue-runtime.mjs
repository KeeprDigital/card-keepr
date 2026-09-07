import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isWranglerSmokeFile } from "./smoke-tier.mjs";
import { nativeCloudflareHttp } from "./native-cloudflare-http.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  runCli,
  administrationPollInterval,
  waitForAdministrationDocument,
  waitForRunState as waitForSourceState,
  persistedDatabaseDirectory,
} from "./acceptance-runtime.mjs";
import { nativeRecoveryCloudflare } from "./native-recovery-cloudflare.mjs";

async function get(path, environment) {
  const response = await fetch(`${environment.KEEPR_INGESTION_URL}${path}`, {
    headers: { authorization: `Bearer ${environment.KEEPR_ADMINISTRATION_KEY}` },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function cli(args, environment) {
  const response = await runCli([...args, "--json"], environment);
  assert.equal(response.code, 0, `${response.stdout}\n${response.stderr}`);
  return JSON.parse(response.stdout);
}

export async function nativeCheckpointTransport(t, statePath, directory, configFile) {
  const cloudflare = nativeRecoveryCloudflare({
    databaseDirectory: await persistedDatabaseDirectory(statePath),
    directory,
  });
  t.after(() => cloudflare.close());
  if (isWranglerSmokeFile(process.argv[1])) {
    const proxy = await nativeCloudflareHttp(t, cloudflare);
    const config = JSON.parse(await readFile(configFile, "utf8"));
    config.main = resolve("acceptance/fixtures/native-ingestion-cloudflare-transport.ts");
    config.define = { ...config.define, NATIVE_CLOUDFLARE_REST_PROXY: JSON.stringify(proxy) };
    await writeFile(configFile, JSON.stringify(config));
    return { vars: { D1_EXPORT_TOKEN: "local-export", D1_VERIFICATION_TOKEN: "local-verify" } };
  }

  return {
    outboundService: (request) => cloudflare.fetch(request),
    vars: { D1_EXPORT_TOKEN: "local-export", D1_VERIFICATION_TOKEN: "local-verify" },
  };
}

export async function waitForNativeCollection(runId, expected, environment, worker, options = {}) {
  if (expected === "failed") {
    const deadline = Date.now() + (options.deadlineMs ?? 90_000);
    let source, collection;
    while (Date.now() < deadline) {
      source = await get(`/v1/ingestion-runs/${runId}/evidence`, environment);
      if (source.state === "failed") return source;
      collection = await get(`/v1/ingestion-runs/${runId}/game-candidates`, environment);
      const failed = collection.candidates.find((candidate) => candidate.state === "failed");
      // Native collection and preparation have separate failure owners. Return
      // the actual failed owner, without inventing a legacy collection state.
      if (failed) return failed;
      await new Promise((resolve) => setTimeout(resolve, administrationPollInterval(worker)));
    }
    throw new Error(`No native failure for ${runId}: ${JSON.stringify({ source, collection })}\n${worker.getOutput()}`);
  }
  if (expected !== "sealed") return waitForSourceState(runId, expected, environment, worker, options);
  const source = await get(`/v1/ingestion-runs/${runId}/evidence`, environment);
  const games = new Set(source.evidence_plans.map((p) => p.supported_game));
  await waitForAdministrationDocument(
    `/v1/ingestion-runs/${runId}/game-candidates`,
    (document) =>
      (document.candidates.length === games.size && document.candidates.every((c) => c.state === "sealed")) ||
      (document.candidates.some((c) => c.state === "failed") ? JSON.stringify(document) : false),
    environment,
    worker,
    options,
  );
  return get(`/v1/ingestion-runs/${runId}/evidence`, environment);
}

/** Aggregate assertion data from the shipped per-game inspection and partition APIs. */
export async function inspectNativeCollection(runId, environment) {
  const collection = await get(`/v1/ingestion-runs/${runId}/game-candidates`, environment);
  assert.ok(collection.candidates.length > 0, "Native collection must prepare game candidates");
  const candidates = [],
    changes = [],
    warnings = [],
    counts = {},
    records = {};
  for (const member of collection.candidates) {
    const candidate = await get(`/v1/game-candidates/${member.id}`, environment);
    const inspection = await get(`/v1/game-candidates/${member.id}/inspection`, environment);
    assert.equal(inspection.ready, true, JSON.stringify(inspection));
    assert.equal(inspection.manifest_digest, candidate.manifest_digest);
    candidates.push(candidate);
    for (const [kind, entries] of Object.entries(inspection.counts))
      for (const [change, count] of Object.entries(entries)) {
        counts[kind] ??= {};
        counts[kind][change] = (counts[kind][change] ?? 0) + count;
      }
    let after = null;
    do {
      const page = await get(
        `/v1/game-candidates/${member.id}/partitions${after ? `?after=${encodeURIComponent(after)}` : ""}`,
        environment,
      );
      for (const partition of page.partitions) {
        const content = await get(`/v1/game-candidates/${member.id}/partitions/${partition.ordinal}`, environment);
        if (partition.kind === "inspection") changes.push(...content.records);
        else if (["warnings", "shared_warnings"].includes(partition.kind)) warnings.push(...content.records);
        else {
          records[partition.kind] ??= [];
          records[partition.kind].push(...content.records);
        }
      }
      after = page.next_cursor;
    } while (after);
  }
  return {
    ready: true,
    records,
    run_id: runId,
    candidates,
    manifest_digests: candidates.map((c) => c.manifest_digest),
    counts,
    changes,
    warnings,
  };
}

/** Invoke native owner preparation, approval and real retained checkpoint verification. */
export async function publishNativeCollection(runId, idempotencyKey, environment, worker, deadlineMs = 30000) {
  const inspection = typeof runId === "string" ? await inspectNativeCollection(runId, environment) : runId;
  let publication;
  for (const candidate of inspection.candidates) {
    const key = `${idempotencyKey}-${candidate.supported_game}`;
    await cli(
      [
        "publication-preparation",
        "start",
        "--candidate-id",
        candidate.id,
        "--manifest-digest",
        candidate.manifest_digest,
        "--generation",
        String(candidate.generation),
        "--sequence",
        "0",
        "--idempotency-key",
        `${key}-artifacts`,
      ],
      environment,
    );
    const prepared = await waitForAdministrationDocument(
      `/v1/game-candidates/${candidate.id}/publication-preparation`,
      (document) =>
        document.state === "verified" ||
        (["failed", "retry_paused"].includes(document.state) ? JSON.stringify(document) : false),
      environment,
      worker,
      { deadlineMs },
    );
    assert.equal(prepared.deadline, candidate.deadline);
    const approved = await cli(
      [
        "publication",
        "approve",
        "--candidate-id",
        candidate.id,
        "--manifest-digest",
        candidate.manifest_digest,
        "--expected-game-revision-id",
        candidate.expected_game_revision_id,
        "--generation",
        String(candidate.generation),
        "--idempotency-key",
        key,
      ],
      environment,
    );
    publication = await waitForAdministrationDocument(
      `/v1/publications/${approved.id}`,
      (document) =>
        document.state === "published" ||
        (["failed", "retry_paused"].includes(document.state) ? JSON.stringify(document) : false),
      environment,
      worker,
      { deadlineMs },
    );
    assert.equal(publication.deadline, candidate.deadline);
    const checkpoint = await waitForAdministrationDocument(
      `/v1/backups/${publication.backup_attempt_id}`,
      (document) => document.state === "verified" || (document.state === "failed" ? JSON.stringify(document) : false),
      environment,
      worker,
      { deadlineMs },
    );
    assert.equal(checkpoint.catalogue_revision_id, publication.resulting_revision_id);
  }
  return publication;
}

/** Follow the current paged manifest and verify both compressed and public NDJSON bytes. */
const exportLoads = new Map();
export async function nativeExportRecords(baseUrl, apiKey, revisionId, kind) {
  const key = `${baseUrl}:${apiKey}:${revisionId}`;
  if (!exportLoads.has(key))
    exportLoads.set(
      key,
      loadNativeExport(baseUrl, apiKey, revisionId).finally(() => exportLoads.delete(key)),
    );
  return (await exportLoads.get(key)).filter((entry) => entry.kind === kind).map((entry) => entry.value);
}
async function loadNativeExport(baseUrl, apiKey, revisionId) {
  const records = [],
    headers = { authorization: `Bearer ${apiKey}` };
  let after = null;
  do {
    const response = await fetch(
      `${baseUrl}/v1/catalogue-exports/${revisionId}${after ? `?after=${encodeURIComponent(after)}` : ""}`,
      { headers },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const index = await response.json();
    assert.equal(index.data.export_schema_major, 5);
    for (const component of index.data.components) {
      const content = await fetch(index.links.components[component.name], { headers });
      assert.equal(content.status, 200);
      const bytes = Buffer.from(await content.arrayBuffer()),
        raw = gunzipSync(bytes);
      assert.equal(bytes.length, component.compressed_bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), component.compressed_sha256);
      assert.equal(raw.length, component.uncompressed_bytes);
      assert.equal(createHash("sha256").update(raw).digest("hex"), component.content_sha256);
      const values = raw
        .toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(values.length, component.records);
      records.push(...values.map((value) => ({ kind: component.kind, value })));
    }
    after = index.data.page.next_cursor;
  } while (after);
  return records;
}
