import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeSql, runCli, startWorker, stopWorker, waitForHealth } from "./helpers/acceptance-runtime.mjs";
import { validateDispatchAndWriteSql } from "../scripts/production-release.mjs";
import { cancellationSql, phaseSql, renewHandoffSql } from "../scripts/fresh-baseline-handoff.mjs";

for (const action of ["cancel", "correct"])
  test(`shipped owner CLI and authenticated Worker prepare, fence, restart and ${action} fresh handoff`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "keepr-native-fresh-owner-"));
    const statePath = join(directory, "state");
    const adminKey = randomUUID();
    const apiKey = randomUUID();
    const adminEnv = join(directory, "admin.env"),
      apiEnv = join(directory, "api.env");
    await writeFile(adminEnv, `ADMINISTRATION_KEY=${adminKey}\n`, { mode: 0o600 });
    await writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 });
    const workers = [];
    t.after(async () => {
      for (const worker of workers) await stopWorker(worker);
      await rm(directory, { recursive: true, force: true });
    });
    const ingestion = await startWorker({
      config: "apps/ingestion/wrangler.jsonc",
      envFile: adminEnv,
      migrate: true,
      statePath,
    });
    workers.push(ingestion);
    const api = await startWorker({ config: "apps/api/wrangler.jsonc", envFile: apiEnv, statePath });
    workers.push(api);
    await waitForHealth(`${ingestion.url}/health`, adminKey, ingestion);
    const dispatches = [];
    const github = createServer(async (request, response) => {
      let bytes = "";
      for await (const chunk of request) bytes += chunk;
      dispatches.push(JSON.parse(bytes));
      response.writeHead(204);
      response.end();
    });
    await new Promise((resolve) => github.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => github.close(resolve)));
    const environment = {
      KEEPR_INGESTION_URL: ingestion.url,
      KEEPR_ADMINISTRATION_KEY: adminKey,
      KEEPR_GITHUB_RELEASE_ACTOR: "native-owner[bot]",
      KEEPR_GITHUB_RELEASE_TOKEN: "synthetic-local-dispatch-token",
      KEEPR_GITHUB_API_URL: `http://127.0.0.1:${github.address().port}`,
    };
    const status = async () => {
      const result = await runCli(["status", "--json"], environment);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    };
    const initial = await status();
    const args = [
      "release",
      "production",
      "--release-id",
      "native_fresh_239",
      "--expected-current-revision",
      initial.safe_state.current_revision_id,
      "--expected-head-sha",
      "a".repeat(40),
      "--expected-migration-level",
      String(initial.release_preflight.schema_migration_level),
      "--idempotency-key",
      "native_fresh_239_prepare",
      "--environment",
      "production",
      "--bootstrap",
      "--fresh-database-id",
      "native_fresh_destination",
      "--baseline-sha256",
      "b".repeat(64),
      "--yes",
      "--json",
    ];
    const confirm = async (command) => {
      const preview = await runCli(command, environment);
      assert.equal(preview.code, 3, preview.stdout + preview.stderr);
      const problem = JSON.parse(preview.stdout);
      assert.equal(problem.code, "confirmation_required");
      const confirmation = problem.detail.slice("Confirmation must exactly equal ".length);
      const result = await runCli([...command, "--confirm", confirmation], environment);
      assert.equal(result.code, 10, result.stdout + result.stderr);
      return confirmation;
    };
    const confirmation = await confirm(args);
    assert.equal(dispatches.length, 1);
    const input = dispatches[0].inputs;
    assert.equal(
      JSON.parse(input.prepared_plan_json).fresh_baseline_handoff.destination_database_id,
      "native_fresh_destination",
    );
    assert.equal(JSON.parse(confirmation).fresh_baseline_handoff.baseline_sha256, "b".repeat(64));
    const workflow = Object.fromEntries(Object.entries(input).map(([key, value]) => [key.toUpperCase(), value]));
    workflow.HANDOFF_EXECUTION_ID = "native_execution_239";
    await validateDispatchAndWriteSql(workflow, directory);
    await executeSql(statePath, join(directory, "fresh-claim.sql"), "apps/ingestion/wrangler.jsonc");
    const claimed = await status();
    assert.equal(claimed.fresh_baseline_handoff.phase, 1);
    assert.equal(claimed.safe_state.mutation_safe, false);
    const rejected = await fetch(`${ingestion.url}/v1/game-candidates`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, "fresh_baseline_mutation_fenced");
    const current = await fetch(`${api.url}/v1/catalogue`, { headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(current.status, 200);
    assert.equal((await current.json()).meta.catalogue_revision_id, "catrev_spine_000");
    assert.equal((await fetch(`${api.url}/v1/catalogue`)).status, 401);
    if (action === "correct") {
      // Provider/baseline observations are synthetic; approval and SQL fencing
      // execute through the shipped authenticated owner route and native D1.
      const intentPath = join(directory, "intent.sql");
      for (const from of [1, 2, 3]) {
        await writeFile(intentPath, phaseSql(workflow, "source", from, { synthetic_native_owner_boundary: true }));
        await executeSql(statePath, intentPath, "apps/ingestion/wrangler.jsonc");
      }
      const repairArgs = [...args, "--correct-handoff-sha", "c".repeat(40), "--correction-key", "native_fresh_repair"];
      const repairConfirmation = await confirm(repairArgs);
      assert.equal(JSON.parse(repairConfirmation).correction.expected_head_sha, "c".repeat(40));
      assert.equal(dispatches[1].inputs.operation, "correct_fresh_baseline_handoff");
      assert.equal(dispatches[1].inputs.expected_head_sha, "c".repeat(40));
      assert.equal(dispatches[1].inputs.prepared_plan_json, input.prepared_plan_json);
      const renewalPath = join(directory, "stale-renew.sql");
      await writeFile(renewalPath, renewHandoffSql(workflow, "source"));
      await assert.rejects(executeSql(statePath, renewalPath, "apps/ingestion/wrangler.jsonc"));
      await stopWorker(ingestion);
      workers.splice(workers.indexOf(ingestion), 1);
      const restarted = await startWorker({ config: "apps/ingestion/wrangler.jsonc", envFile: adminEnv, statePath });
      workers.push(restarted);
      environment.KEEPR_INGESTION_URL = restarted.url;
      await waitForHealth(`${restarted.url}/health`, adminKey, restarted);
      const after = await status();
      assert.equal(after.fresh_baseline_handoff.phase, 4);
      assert.equal(after.fresh_baseline_handoff.correction.request.expected_head_sha, "c".repeat(40));
      assert.equal(after.safe_state.mutation_safe, false);
      await confirm(repairArgs);
      assert.deepEqual(dispatches[2].inputs, dispatches[1].inputs);
      return;
    }
    await confirm([...args, "--cancel-fresh-handoff"]);
    assert.equal(dispatches[1].inputs.operation, "cancel_fresh_baseline_handoff");
    // Only provider observation is synthetic here. The independent provider tests
    // validate active-version, exact-binding, and route failures through its API adapter.
    const cancel = join(directory, "cancel.sql");
    await writeFile(
      cancel,
      cancellationSql(workflow, "source", {
        source_still_active: true,
        observation: { synthetic: true, both_workers: "source" },
      }),
    );
    await executeSql(statePath, cancel, "apps/ingestion/wrangler.jsonc");
    const cancelled = await status();
    assert.equal(cancelled.fresh_baseline_handoff.phase, 7);
    assert.equal(cancelled.safe_state.mutation_safe, true);
    await stopWorker(ingestion);
    workers.splice(workers.indexOf(ingestion), 1);
    const restarted = await startWorker({ config: "apps/ingestion/wrangler.jsonc", envFile: adminEnv, statePath });
    workers.push(restarted);
    environment.KEEPR_INGESTION_URL = restarted.url;
    await waitForHealth(`${restarted.url}/health`, adminKey, restarted);
    assert.equal((await status()).fresh_baseline_handoff.phase, 7);
  });
