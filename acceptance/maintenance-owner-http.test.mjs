import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import * as validators from "../test/support/http-response-validators.mjs";
import {
  runCli,
  startWorker,
  stopWorker,
  waitForResponse,
  waitForAdministrationDocument,
} from "./helpers/acceptance-runtime.mjs";

function check(path, method, status, document, media = "application/json") {
  const validate = validators[validators.responseValidators[`admin ${method} ${path} ${status} ${media}`]];
  assert.equal(typeof validate, "function", `${method} ${path} ${status}`);
  assert.equal(validate(document), true, JSON.stringify(validate.errors));
}

test("owner CLI resolves targets and completes native evidence cleanup with retained replay, status and retry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-maintenance-owner-"));
  const key = crypto.randomUUID();
  let worker;
  t.after(async () => {
    if (worker) await stopWorker(worker);
    await rm(directory, { recursive: true, force: true });
  });
  const config = await readWorkerConfig(resolve("apps/ingestion/wrangler.jsonc"));
  delete config.$schema;
  config.main = resolve("acceptance/fixtures/cleanup-native-runtime.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  config.services = [];
  const configPath = join(directory, "ingestion.json"),
    envFile = join(directory, "ingestion.env");
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(envFile, `ADMINISTRATION_KEY=${key}\n`, { mode: 0o600 });
  worker = await startWorker({ config: configPath, envFile, statePath: join(directory, "state"), migrate: true });
  await waitForResponse(`${worker.url}/healthz`, worker, "maintenance owner Worker");
  const environment = { KEEPR_INGESTION_URL: worker.url, KEEPR_ADMINISTRATION_KEY: key };
  const cli = async (args, code = 0) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, code, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const call = async (path, body, status = 200) => {
    const response = await fetch(`${worker.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, status, await response.clone().text());
    const document = await response.json();
    if (path.startsWith("/v1/")) assert.equal(response.headers.get("cache-control"), "no-store");
    return document;
  };
  const initial = await cli(["status"]);
  check("/v1/status", "get", 200, initial);
  const resolved = await call("/v1/administration-targets/resolve", {
    expected_current_revision_id: initial.safe_state.current_revision_id,
  });
  check("/v1/administration-targets/resolve", "post", 200, resolved);
  assert.equal(resolved.resolved_target.confirmation, JSON.stringify(initial.production_target));
  const unconfirmed = await cli(
    [
      "backup",
      "create",
      "--expected-current-revision",
      initial.safe_state.current_revision_id,
      "--idempotency-key",
      "owner-target-preview",
      "--environment",
      "production",
      "--yes",
    ],
    3,
  );
  assert.equal(unconfirmed.code, "confirmation_required");
  const stale = await call("/v1/administration-targets/resolve", { expected_current_revision_id: "catrev_stale" }, 409);
  check("/v1/administration-targets/resolve", "post", 409, stale, "application/problem+json");
  const fixture = await call("/acceptance/unused-cleanup-capture", {});
  const scopeKey = "owner cleanup / " + "x".repeat(240);
  const args = ["evidence-cleanup", "start", "--run-id", fixture.run, "--idempotency-key", scopeKey];
  const accepted = await cli(args);
  check("/v1/ingestion-runs/{run}/evidence-cleanup", "post", 202, accepted);
  assert.equal(accepted.idempotency_key, scopeKey);
  const complete = await waitForAdministrationDocument(
    `/v1/evidence-cleanups/${accepted.id}`,
    (d) => d.state === "completed",
    environment,
    worker,
  );
  assert.equal(complete.deleted_objects, 1);
  check("/v1/evidence-cleanups/{cleanup}", "get", 200, complete);
  const status = await cli(["evidence-cleanup", "status", "--cleanup-id", accepted.id]);
  assert.deepEqual(status, complete);
  const replay = await cli(args);
  assert.deepEqual(replay, complete);
  const retry = await cli([
    "evidence-cleanup",
    "retry",
    "--cleanup-id",
    accepted.id,
    "--expected-generation",
    String(complete.generation),
  ]);
  assert.deepEqual(retry, complete);
  check("/v1/evidence-cleanups/{cleanup}/retry", "post", 202, retry);
  const objects = await cli(["evidence-cleanup", "objects", "--cleanup-id", accepted.id]);
  check("/v1/evidence-cleanups/{cleanup}/objects", "get", 200, objects);
  assert.deepEqual(objects, {
    objects: [{ object_key: fixture.key, state: "deleted", reason: null }],
    next_after: null,
  });
  const changed = await call(
    `/v1/ingestion-runs/${fixture.run}/evidence-cleanup`,
    { idempotency_key: scopeKey, retention_days: 31 },
    409,
  );
  assert.equal(changed.code, "idempotency_conflict");
  check("/v1/ingestion-runs/{run}/evidence-cleanup", "post", 409, changed, "application/problem+json");
  const invalid = await call(`/v1/evidence-cleanups/${accepted.id}/retry`, { expected_generation: "0" }, 422);
  check("/v1/evidence-cleanups/{cleanup}/retry", "post", 422, invalid, "application/problem+json");
  const evidence = await fetch(`${worker.url}/v1/source-snapshots/${fixture.id}/content`, {
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(evidence.status, 410);
  const final = await cli(["status"]);
  check("/v1/status", "get", 200, final);
  assert.equal(final.safe_state.current_revision_id, initial.safe_state.current_revision_id);
  assert.equal(final.recent_runs[0].id, fixture.run);
});
