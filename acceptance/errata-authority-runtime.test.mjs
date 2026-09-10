import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runCli, startWorker, stopWorker, waitForHealth, waitForRunState } from "./helpers/acceptance-runtime.mjs";
import {
  nativeCheckpointTransport,
} from "./helpers/native-catalogue-runtime.mjs";
import { syntheticSourceAdapterMigrations } from "./helpers/synthetic-source-adapters.mjs";

const root = resolve(import.meta.dirname, "..");

import {
  collectSource,
  collectFixtureSource,
  representRetainedSnapshotAdapter,
  resumeAndWait,
  writeRuntimeConfig,
} from "./helpers/errata-runtime.mjs";

test("the repository CLI rejects Official Errata authority outside the documented Bandai surface", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-errata-authority-"));
  const statePath = join(directory, "shared-state");
  const apiKey = crypto.randomUUID();
  const administrationKey = crypto.randomUUID();
  const environmentFile = join(directory, "runtime.env");
  const runtimeConfig = join(directory, "runtime.wrangler.json");
  await Promise.all([
    writeFile(environmentFile, `API_BEARER_KEY=${apiKey}\nADMINISTRATION_KEY=${administrationKey}\n`, { mode: 0o600 }),
    writeRuntimeConfig(runtimeConfig),
  ]);
  const checkpointTransport = await nativeCheckpointTransport(t, statePath, directory, runtimeConfig);
  const runtime = await startWorker({
    ...checkpointTransport,
    config: runtimeConfig,
    envFile: environmentFile,
    migrate: true,
    testMigrations: await syntheticSourceAdapterMigrations(),
    statePath,
  });
  t.after(async () => {
    await stopWorker(runtime);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(`${runtime.url}/health`, apiKey, runtime);
  const environment = {
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_INGESTION_URL: runtime.url,
  };
  const result = await runCli(
    [
      "source",
      "collect",
      "--game",
      "one-piece",
      "--lineage",
      "one-piece-en",
      "--adapter",
      "one-piece-official-errata-html@1",
      "--request-id",
      "untrusted-errata",
      "--url",
      "https://publisher.example/claims/official-errata.json",
      "--idempotency-key",
      "reject-untrusted-errata-authority",
      "--json",
    ],
    environment,
  );
  assert.equal(result.code, 8, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "official_source_surface_mismatch",
    detail: "The Official Errata adapter accepts only https://en.onepiece-cardgame.com/rules/errata_card/.",
  });

  const untrustedRun = await collectFixtureSource(
    {
      adapter: "fixture-one-piece-json@3",
      idempotencyKey: "retain-untrusted-generic-surface",
      requestId: "untrusted-generic",
      url: "https://publisher.example/claims/untrusted-card-list.json",
    },
    environment,
  );
  const completed = await resumeAndWait(untrustedRun.id, environment, runtime);
  const capturedSnapshotId = completed.snapshots?.[0]?.id;
  assert.equal(typeof capturedSnapshotId, "string");
  const snapshotId = await representRetainedSnapshotAdapter(
    capturedSnapshotId,
    "one-piece-official-errata-html@1",
    environment,
  );
  const reparse = await runCli(
    [
      "snapshot",
      "reparse",
      "--snapshot-id",
      snapshotId,
      "--adapter",
      "one-piece-official-errata-html@1",
      "--idempotency-key",
      "reject-retained-untrusted-errata-authority",
      "--json",
    ],
    environment,
  );
  assert.equal(reparse.code, 8, reparse.stderr);
  assert.deepEqual(JSON.parse(reparse.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "official_source_surface_mismatch",
    detail: "The Official Errata adapter accepts only https://en.onepiece-cardgame.com/rules/errata_card/.",
  });
});

test("Bandai Errata HTML shape drift fails closed through the CLI and Worker seam", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-errata-drift-"));
  const statePath = join(directory, "shared-state");
  const apiKey = crypto.randomUUID();
  const administrationKey = crypto.randomUUID();
  const environmentFile = join(directory, "runtime.env");
  const runtimeConfig = join(directory, "runtime.wrangler.json");
  await Promise.all([
    writeFile(environmentFile, `API_BEARER_KEY=${apiKey}\nADMINISTRATION_KEY=${administrationKey}\n`, { mode: 0o600 }),
    writeRuntimeConfig(runtimeConfig, "AcceptanceShapeDriftOfficialSourceTransport"),
  ]);
  const checkpointTransport = await nativeCheckpointTransport(t, statePath, directory, runtimeConfig);
  const runtime = await startWorker({
    ...checkpointTransport,
    config: runtimeConfig,
    envFile: environmentFile,
    migrate: true,
    testMigrations: await syntheticSourceAdapterMigrations(),
    statePath,
  });
  t.after(async () => {
    await stopWorker(runtime);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(`${runtime.url}/health`, apiKey, runtime);
  const environment = {
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_INGESTION_URL: runtime.url,
  };
  const run = await collectSource(
    {
      adapter: "one-piece-official-errata-html@1",
      idempotencyKey: "reject-bandai-errata-shape-drift",
      requestId: "one-piece-en:errata",
      url: "https://en.onepiece-cardgame.com/rules/errata_card/",
    },
    environment,
    runtime,
  );
  const resumed = await runCli(["source", "resume", "--run-id", run.id, "--json"], environment);
  assert.equal(resumed.code, 0, resumed.stderr);
  const failed = await waitForRunState(run.id, "failed", environment, runtime, { deadlineMs: 20_000 });
  assert.equal(failed.failure_code, "source_parse_failed");
  assert.equal(failed.observation_sets.length, 0);
});
