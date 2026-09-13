#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { verifyDevCapacity } from "./dev-capacity.mjs";
import { devConfigurations } from "./dev-environment.mjs";
import { verifyDevCommit } from "../src/http/dev-workflow-identity.mjs";
import { environmentNames } from "../src/http/environment-target.mjs";
import { verifyDevWorkflows } from "./dev-workflows.mjs";

/** Provision only new dev resources; never adopt, delete or reset an existing target. */
export async function provisionDev(environment, evidence, apply = false) {
  const accountId = environment.DEV_CLOUDFLARE_ACCOUNT_ID;
  if (!/^[0-9a-f]{32}$/u.test(accountId ?? "") || evidence.account_id !== accountId)
    throw new Error("dev_account_mismatch");
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
    if (!response.ok || document.success !== true) throw new Error(`dev_provision_provider_failed:${response.status}`);
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
    throw new Error("incomplete_dev_inventory");
  // Re-observe counts immediately; a previously recorded count is never a quota lease.
  const checked = verifyDevCapacity({
    ...evidence,
    d1_count: databases.length,
    d1_total_bytes: databases.reduce((sum, database) => sum + database.file_size, 0),
    d1_max_bytes: Math.max(0, ...databases.map((database) => database.file_size)),
    worker_count: workers.length,
    r2_count: buckets.buckets.length,
  });
  const names = environmentNames("dev");
  if (
    databases.some((entry) => [names.catalogue, names.disposable].includes(entry.name)) ||
    workers.some((entry) => names.workers.includes(entry.id)) ||
    buckets.buckets.some((entry) => names.buckets.includes(entry.name))
  )
    throw new Error("dev_resources_already_exist_review_receipt");
  const plan = { ...checked, names, observed_at: new Date().toISOString(), created: [] };
  await verifyDevWorkflows(environment, { mustBeAbsent: true });
  if (!apply) return plan;
  const secretFiles = [environment.DEV_API_SECRETS_FILE, environment.DEV_INGESTION_SECRETS_FILE];
  const expectedSecrets = [
    ["API_BEARER_KEY", "API_BEARER_KEY_REPLACEMENT"],
    ["ADMINISTRATION_KEY", "ADMINISTRATION_KEY_REPLACEMENT", "D1_EXPORT_TOKEN", "D1_VERIFICATION_TOKEN"],
  ];
  const secrets = await Promise.all(
    secretFiles.map(async (path, index) => {
      if (!path) throw new Error("dev_secret_files_required");
      const value = JSON.parse(await readFile(path, "utf8"));
      if (
        Object.keys(value).sort().join("|") !== expectedSecrets[index].sort().join("|") ||
        Object.values(value).some((secret) => typeof secret !== "string" || secret.length < 16)
      )
        throw new Error("invalid_dev_secret_inventory");
      return value;
    }),
  );
  if (new Set(secrets.flatMap(Object.values)).size !== 6) throw new Error("dev_secrets_must_be_distinct");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== environment.EXPECTED_HEAD_SHA) throw new Error("dev_checkout_mismatch");
  await verifyDevCommit(environment.GH_TOKEN, { head_sha: head, ci_run_id: environment.CI_RUN_ID });
  if (!environment.DEV_PROVISION_RECEIPT) throw new Error("dev_provision_receipt_path_required");
  const retain = () =>
    writeFile(environment.DEV_PROVISION_RECEIPT, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
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
  const configs = await devConfigurations({
    accountId,
    catalogueId: plan.created[0].id,
    disposableId: plan.created[1].id,
  });
  for (const [app, config] of Object.entries(configs))
    await writeFile(`apps/${app}/wrangler.dev.json`, `${JSON.stringify(config, null, 2)}\n`);
  // Provision deny-only Worker shells: no routes or data/service/Workflow
  // bindings, and no usable application. Versions upload requires a script to
  // exist; only the guarded first-install executor activates the application.
  for (const [index, name] of names.workers.entries()) {
    const form = new FormData();
    form.set(
      "metadata",
      JSON.stringify({
        main_module: "deny.mjs",
        compatibility_date: "2026-07-29",
        bindings: Object.entries(secrets[index]).map(([name, text]) => ({ name, text, type: "secret_text" })),
      }),
    );
    form.set(
      "deny.mjs",
      new File(
        ["export default { fetch() { return new Response('Dev installation pending', {status:503}); } };"],
        "deny.mjs",
        { type: "application/javascript+module" },
      ),
    );
    await api(`/workers/scripts/${name}`, "PUT", form);
    await api(`/workers/scripts/${name}/subdomain`, "POST", { enabled: false, previews_enabled: false });
    plan.created.push({ kind: "worker-shell", name });
    await retain();
  }
  // These are newly created, still unbound databases. No existing catalogue is migrated here.
  execFileSync(
    "node_modules/.bin/wrangler",
    ["d1", "migrations", "apply", "CATALOGUE_DB", "--remote", "--config", "apps/ingestion/wrangler.dev.json"],
    { env: { ...environment, CLOUDFLARE_ACCOUNT_ID: accountId }, stdio: "inherit" },
  );
  return plan;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!["plan", "apply"].includes(process.argv[2]) || !process.argv[3])
    throw new Error("usage: provision-dev.mjs plan|apply capacity-evidence.json");
  process.stdout.write(
    `${JSON.stringify(await provisionDev(process.env, JSON.parse(await readFile(process.argv[3], "utf8")), process.argv[2] === "apply"), null, 2)}\n`,
  );
}
