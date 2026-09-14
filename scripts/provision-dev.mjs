#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { verifyEnvironmentCapacity } from "./dev-capacity.mjs";
import { environmentConfigurations } from "./dev-environment.mjs";
import { verifyDevCommit, verifyReleaseCommit } from "../src/http/dev-workflow-identity.mjs";
import { environmentNames } from "../src/http/environment-target.mjs";
import { verifyEnvironmentWorkflows } from "./dev-workflows.mjs";
import { validateEnvironmentSecretFiles, writeEnvironmentWorkerShell } from "./dev-worker-shell.mjs";

/** Provision only new isolated resources; never adopt, delete or reset an existing target. */
export async function provisionDev(environment, evidence, apply = false) {
  return provisionEnvironment({ ...environment, RELEASE_ENVIRONMENT: "dev" }, evidence, apply);
}

export async function provisionEnvironment(environment, evidence, apply = false) {
  const target = environment.RELEASE_ENVIRONMENT;
  if (!["dev", "staging"].includes(target)) throw new Error("isolated_environment_required");
  const prefix = target.toUpperCase();
  const accountId = environment[`${prefix}_CLOUDFLARE_ACCOUNT_ID`];
  if (!/^[0-9a-f]{32}$/u.test(accountId ?? "") || evidence.account_id !== accountId)
    throw new Error(`${target}_account_mismatch`);
  const api = async (path, method = "GET", body) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}`,
        ...(body instanceof FormData ? {} : { "content-type": "application/json" }),
      },
      ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
    });
    const document = await response.json();
    if (!response.ok || document.success !== true)
      throw new Error(`${target}_provision_provider_failed:${response.status}`);
    return document.result;
  };
  const databases = [];
  for (let page = 1; page <= 500; page++) {
    const entries = await api(`/d1/database?per_page=100&page=${page}`);
    if (!Array.isArray(entries)) throw new Error("invalid_d1_inventory");
    databases.push(...entries);
    if (entries.length < 100) break;
    if (page === 500) throw new Error("d1_inventory_not_bounded");
  }
  const workers = await api("/workers/scripts");
  const buckets = await api("/r2/buckets");
  if (!Array.isArray(workers) || !Array.isArray(buckets?.buckets) || buckets.cursor)
    throw new Error(`incomplete_${target}_inventory`);
  // Re-observe counts immediately; a previously recorded count is never a quota lease.
  const checked = verifyEnvironmentCapacity(target, {
    ...evidence,
    d1_count: databases.length,
    d1_total_bytes: databases.reduce((sum, database) => sum + database.file_size, 0),
    d1_max_bytes: Math.max(0, ...databases.map((database) => database.file_size)),
    worker_count: workers.length,
    r2_count: buckets.buckets.length,
  });
  const names = environmentNames(target);
  if (
    databases.some((entry) => [names.catalogue, names.disposable].includes(entry.name)) ||
    workers.some((entry) => names.workers.includes(entry.id)) ||
    buckets.buckets.some((entry) => names.buckets.includes(entry.name))
  )
    throw new Error(`${target}_resources_already_exist_review_receipt`);
  const plan = { ...checked, names, observed_at: new Date().toISOString(), created: [] };
  await verifyEnvironmentWorkflows(environment, { mustBeAbsent: true });
  if (!apply) return plan;
  await validateEnvironmentSecretFiles(environment);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== environment.EXPECTED_HEAD_SHA) throw new Error(`${target}_checkout_mismatch`);
  await (target === "dev" ? verifyDevCommit : verifyReleaseCommit)(environment.GH_TOKEN, {
    head_sha: head,
    ci_run_id: environment.CI_RUN_ID,
  });
  if (!environment[`${prefix}_PROVISION_RECEIPT`]) throw new Error(`${target}_provision_receipt_path_required`);
  const retain = () =>
    writeFile(environment[`${prefix}_PROVISION_RECEIPT`], `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  await retain();
  for (const name of [names.catalogue, names.disposable]) {
    const database = await api("/d1/database", "POST", { name });
    plan.created.push({ kind: "d1", name, id: database.uuid });
    await retain();
  }
  for (const name of names.buckets) {
    await api("/r2/buckets", "POST", { name });
    plan.created.push({ kind: "r2", name });
    await retain();
  }
  const configs = await environmentConfigurations(target, {
    accountId,
    catalogueId: plan.created[0].id,
    disposableId: plan.created[1].id,
  });
  for (const [app, config] of Object.entries(configs))
    await writeFile(`apps/${app}/wrangler.${target}.json`, `${JSON.stringify(config, null, 2)}\n`);
  // Provision deny-only Worker shells: no routes or data/service/Workflow
  // bindings, and no usable application. Versions upload requires a script to
  // exist; only the guarded first-install executor activates the application.
  for (const name of names.workers) {
    await writeEnvironmentWorkerShell(environment, name);
    plan.created.push({ kind: "worker-shell", name });
    await retain();
  }
  // These are newly created, still unbound databases. No existing catalogue is migrated here.
  execFileSync(
    "node_modules/.bin/wrangler",
    ["d1", "migrations", "apply", "CATALOGUE_DB", "--remote", "--config", `apps/ingestion/wrangler.${target}.json`],
    { env: { ...environment, CLOUDFLARE_ACCOUNT_ID: accountId }, stdio: "inherit" },
  );
  return plan;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!["plan", "apply"].includes(process.argv[2]) || !process.argv[3])
    throw new Error("usage: provision-dev.mjs plan|apply capacity-evidence.json");
  process.stdout.write(
    `${JSON.stringify(await provisionEnvironment({ ...process.env, RELEASE_ENVIRONMENT: process.env.RELEASE_ENVIRONMENT ?? "dev" }, JSON.parse(await readFile(process.argv[3], "utf8")), process.argv[2] === "apply"), null, 2)}\n`,
  );
}
