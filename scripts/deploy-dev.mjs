#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { verifyDevCommit, verifyReleaseCommit } from "../src/http/dev-workflow-identity.mjs";
import { verifyEnvironmentWorkflows } from "./dev-workflows.mjs";
import { environmentNames } from "../src/http/environment-target.mjs";
import { restoreEnvironmentWorkerShells } from "./dev-worker-shell.mjs";
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
  const { environment, head_sha, release_id, evidence_directory } = await deployEnvironment(input, executeCommand);
  return { environment, head_sha, release_id, evidence_directory };
}

export async function deployEnvironment(input, executeCommand = promisify(execFile)) {
  const target = input.RELEASE_ENVIRONMENT;
  if (!["dev", "staging"].includes(target)) throw new Error("isolated_environment_required");
  const names = environmentNames(target);
  const configPath = (app) => `apps/${app}/wrangler.${target}.json`;
  const environment = { ...input, RELEASE_STATE_CONFIG: configPath("ingestion") };
  const head = (await executeCommand("git", ["rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
  if (head !== environment.EXPECTED_HEAD_SHA) throw new Error(`${target}_checkout_mismatch`);
  await (target === "dev" ? verifyDevCommit : verifyReleaseCommit)(environment.GH_TOKEN, {
    head_sha: head,
    ci_run_id: environment.CI_RUN_ID,
  });
  await verifyProductionTarget(environment);
  await verifyEnvironmentWorkflows(environment);
  const directory = await mkdtemp(join(tmpdir(), `keepr-${target}-release-`));
  await validateDispatchAndWriteSql(environment, directory);
  const sql = (name) =>
    executeSqlFile(environment, { configPath: environment.RELEASE_STATE_CONFIG, sqlPath: `${directory}/${name}.sql` });
  const requireResult = (rows, field) => {
    if (rows.at(-1)?.results[0]?.[field] !== 1) throw new Error(`${target}_gate_failed:${field}`);
  };
  const run = async (command, args) => {
    try {
      await executeCommand(command, args, { env: environment, encoding: "utf8", maxBuffer: 4_000_000 });
    } catch {
      throw new Error(`${target}_command_failed:${args[0]}`);
    }
  };
  const wrangler = (args) => run(resolve("node_modules/.bin/wrangler"), args);
  let leaseClaimed = false;
  try {
    requireResult(await sql("live-preflight"), "ready");
    requireResult(await sql("claim"), "claimed");
    leaseClaimed = true;
    requireResult(await sql("migration-started"), "migration_started");
    if (environment[`${target.toUpperCase()}_FIRST_INSTALL_RETRY_OF`] !== undefined) {
      if (environment.BOOTSTRAP !== "true") throw new Error("first_install_retry_not_safe");
      await restoreEnvironmentWorkerShells(environment);
    }
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
      { name: names.workers[0], app: "api" },
      { name: names.workers[1], app: "ingestion" },
    ];
    await verifyEnvironmentWorkflows(environment);
    const uploadedVersions = [];
    for (const worker of workers) {
      const config = configPath(worker.app);
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
    await verifyEnvironmentWorkflows(environment);
    requireResult(await sql("deploying"), "transitioned");
    for (const worker of workers) {
      const config = configPath(worker.app);
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
    await verifyEnvironmentWorkflows(environment);
    for (const worker of workers) await wrangler(["triggers", "deploy", "--config", configPath(worker.app)]);
    const activation = await observeReleaseActivation(
      environment,
      uploadedVersions,
      workers.map((worker) => configPath(worker.app)),
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
      apiUrl: `https://${names.host}/api`,
      ingestionUrl: `https://${names.host}/ingest`,
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
    return {
      environment: target,
      head_sha: head,
      release_id: environment.RELEASE_ID,
      evidence_directory: directory,
      activation,
      smoke,
    };
  } catch (error) {
    if (!leaseClaimed) throw error;
    try {
      await run("bash", ["scripts/production-release-failure.sh", directory]);
    } catch {
      throw new Error(`${target}_release_failed_and_requires_recovery:${directory}`);
    }
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(`${JSON.stringify(await deployDev(process.env))}\n`);
