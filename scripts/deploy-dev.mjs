#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { verifyDevCommit } from "../src/http/dev-workflow-identity.mjs";
import { verifyDevWorkflows } from "./dev-workflows.mjs";
import { validateDispatchAndWriteSql, writeEvidenceSql } from "./production-release.mjs";
import { executeSqlFile } from "./production-release-d1.mjs";
import {
  observeCatalogueBindings,
  observeReleaseActivation,
  verifyProductionTarget,
  verifyUploadedVersion,
} from "./production-release-provider.mjs";
import { runBootstrapSmoke, runProductionSmoke } from "./production-smoke.mjs";

/** Shared guarded executor for initial installation and automatic dev updates. */
export async function deployDev(input, executeCommand = promisify(execFile)) {
  if (input.RELEASE_ENVIRONMENT !== "dev") throw new Error("dev_target_required");
  const environment = { ...input, RELEASE_STATE_CONFIG: "apps/ingestion/wrangler.dev.json" };
  const head = (await executeCommand("git", ["rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
  if (head !== environment.EXPECTED_HEAD_SHA) throw new Error("dev_checkout_mismatch");
  await verifyDevCommit(environment.GH_TOKEN, { head_sha: head, ci_run_id: environment.CI_RUN_ID });
  await verifyProductionTarget(environment);
  await verifyDevWorkflows(environment);
  const directory = await mkdtemp(join(tmpdir(), "keepr-dev-release-"));
  await validateDispatchAndWriteSql(environment, directory);
  const sql = (name) =>
    executeSqlFile(environment, { configPath: environment.RELEASE_STATE_CONFIG, sqlPath: `${directory}/${name}.sql` });
  const requireResult = (rows, field) => {
    if (rows.at(-1)?.results[0]?.[field] !== 1) throw new Error(`dev_gate_failed:${field}`);
  };
  const run = async (command, args) => {
    try {
      await executeCommand(command, args, { env: environment, encoding: "utf8", maxBuffer: 4_000_000 });
    } catch {
      throw new Error(`dev_command_failed:${args[0]}`);
    }
  };
  const wrangler = (args) => run(resolve("node_modules/.bin/wrangler"), args);
  try {
    requireResult(await sql("live-preflight"), "ready");
    requireResult(await sql("claim"), "claimed");
    requireResult(await sql("migration-started"), "migration_started");
    await wrangler([
      "d1",
      "migrations",
      "apply",
      "CATALOGUE_DB",
      "--remote",
      "--config",
      environment.RELEASE_STATE_CONFIG,
    ]);
    requireResult(await sql("materialize"), "transferred");
    const workers = [
      { name: "card-keepr-api-dev", app: "api" },
      { name: "card-keepr-ingestion-dev", app: "ingestion" },
    ];
    await verifyDevWorkflows(environment);
    const uploadedVersions = [];
    for (const worker of workers) {
      const config = `apps/${worker.app}/wrangler.dev.json`;
      const tag = `release-${environment.RELEASE_ID}-${worker.app}`;
      await wrangler([
        "versions",
        "upload",
        "--strict",
        "--config",
        config,
        "--tag",
        tag,
        "--message",
        `${environment.RELEASE_ID} ${head}`,
      ]);
      uploadedVersions.push(
        await verifyUploadedVersion({
          ...environment,
          RELEASE_WORKER: worker.name,
          RELEASE_VERSION_TAG: tag,
          RELEASE_WORKER_CONFIG: config,
        }),
      );
    }
    await verifyDevWorkflows(environment);
    requireResult(await sql("deploying"), "transitioned");
    for (const worker of workers) {
      const config = `apps/${worker.app}/wrangler.dev.json`;
      await wrangler([
        "versions",
        "deploy",
        "--yes",
        "--config",
        config,
        "--version-tag",
        `release-${environment.RELEASE_ID}-${worker.app}@100%`,
      ]);
    }
    await verifyDevWorkflows(environment);
    for (const worker of workers)
      await wrangler(["triggers", "deploy", "--config", `apps/${worker.app}/wrangler.dev.json`]);
    const activation = await observeReleaseActivation(
      environment,
      uploadedVersions,
      workers.map((worker) => `apps/${worker.app}/wrangler.dev.json`),
    );
    await writeFile(`${directory}/activation.json`, `${JSON.stringify(activation)}\n`, { mode: 0o600 });
    const binding = await observeCatalogueBindings(environment);
    await writeEvidenceSql(
      "binding",
      environment.RELEASE_ID,
      JSON.stringify(binding),
      `${directory}/binding.sql`,
      environment,
    );
    requireResult(await sql("binding"), "transitioned");
    const common = {
      apiUrl: "https://dev.card.keepr.digital/api",
      ingestionUrl: "https://dev.card.keepr.digital/ingest",
      apiKey: environment.API_TRAFFIC_TOKEN,
      currentRevisionId: environment.EXPECTED_CURRENT_REVISION,
    };
    const targets = JSON.parse(environment.SMOKE_TARGETS_JSON);
    const smoke =
      environment.BOOTSTRAP === "true"
        ? await runBootstrapSmoke(common)
        : await runProductionSmoke({
            ...common,
            revisions: targets.revisions,
            printingImageId: targets.printing_image_id,
            staleCursor: targets.stale_cursor,
            staleRevisionId: targets.stale_revision_id,
          });
    await writeEvidenceSql(
      "smoke",
      environment.RELEASE_ID,
      JSON.stringify(smoke),
      `${directory}/smoke.sql`,
      environment,
    );
    requireResult(await sql("smoke"), "fence_released");
    return { environment: "dev", head_sha: head, release_id: environment.RELEASE_ID, evidence_directory: directory };
  } catch (error) {
    try {
      await run("bash", ["scripts/production-release-failure.sh", directory]);
    } catch {
      throw new Error(`dev_release_failed_and_requires_recovery:${directory}`);
    }
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(`${JSON.stringify(await deployDev(process.env))}\n`);
