import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
} from "./helpers/acceptance-runtime.mjs";

test("synthetic fixture publication is unavailable through the production Worker and CLI seams", async (t) => {
  const testDirectory = await mkdtemp(
    join(tmpdir(), "card-keepr-publication-boundary-"),
  );
  const statePath = join(testDirectory, "shared-state");
  const administrationKey = randomUUID();
  const ingestionEnv = join(testDirectory, "ingestion.env");
  await writeFile(
    ingestionEnv,
    `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`,
    { mode: 0o600 },
  );

  const ingestion = await startWorker({
    config: "apps/ingestion/wrangler.jsonc",
    envFile: ingestionEnv,
    migrate: true,
    statePath,
  });
  t.after(() => stopWorker(ingestion));
  await waitForHealth(`${ingestion.url}/health`, administrationKey, ingestion);

  const response = await fetch(`${ingestion.url}/v1/ingestion-runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${administrationKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      fixture: "first-catalogue",
      selected_games: ["one-piece"],
      idempotency_key: "production-fixture-publication-bypass",
    }),
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "not_found");

  const cliEnvironment = {
    KEEPR_INGESTION_URL: ingestion.url,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
  };
  const started = await runCli(
    [
      "run",
      "start",
      "--fixture",
      "first-catalogue",
      "--games",
      "one-piece",
      "--idempotency-key",
      "production-fixture-cli-bypass",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(started.code, 6, started.stderr);
  assert.deepEqual(JSON.parse(started.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "not_found",
    detail: "The requested administration operation does not exist.",
  });

  const status = await runCli(["status", "--json"], cliEnvironment);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).active_ingestion_run, null);
});
