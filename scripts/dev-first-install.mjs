#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { environmentConfigurations } from "./dev-environment.mjs";
import { verifyDevCommit, verifyReleaseCommit } from "../src/http/dev-workflow-identity.mjs";
import { environmentNames } from "../src/http/environment-target.mjs";
import { verifyEnvironmentWorkerShells } from "./dev-worker-shell.mjs";

/** D1's documented batch query API preserves the canonical repository transaction. */
export function remoteDevDatabase(environment) {
  return remoteEnvironmentDatabase({ ...environment, RELEASE_ENVIRONMENT: "dev" });
}

export function remoteEnvironmentDatabase(environment) {
  const target = environment.RELEASE_ENVIRONMENT;
  if (!["dev", "staging"].includes(target)) throw new Error("isolated_environment_required");
  const prefix = target.toUpperCase();
  const statements = new WeakMap();
  const execute = async (batch) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${environment[`${prefix}_CLOUDFLARE_ACCOUNT_ID`]}/d1/database/${environment[`${prefix}_CATALOGUE_DATABASE_ID`]}/query`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ batch }),
      },
    );
    const document = await response.json();
    if (
      !response.ok ||
      document.success !== true ||
      !Array.isArray(document.result) ||
      document.result.some((row) => row.success !== true || !Array.isArray(row.results))
    )
      throw new Error(`${target}_d1_query_failed`);
    return document.result;
  };
  return {
    batch: (batch) => execute(batch.map((statement) => statements.get(statement))),
    prepare(sql) {
      const query = { sql, params: [] };
      const statement = {
        bind(...params) {
          query.params = params;
          return statement;
        },
        async all() {
          return (await execute([query]))[0];
        },
        async first() {
          return (await execute([query]))[0].results[0] ?? null;
        },
      };
      statements.set(statement, query);
      return statement;
    },
  };
}

/** Owner invocation only: same server plan validator, atomic preparation and lease.
 * The target must already contain the fresh baseline, never production data.
 */
export async function prepareFirstDevInstall(environment) {
  return prepareFirstEnvironmentInstall({ ...environment, RELEASE_ENVIRONMENT: "dev" });
}

export async function prepareFirstEnvironmentInstall(environment) {
  const isolatedEnvironment = environment.RELEASE_ENVIRONMENT;
  if (!["dev", "staging"].includes(isolatedEnvironment)) throw new Error("isolated_environment_required");
  const prefix = isolatedEnvironment.toUpperCase();
  const configs = await environmentConfigurations(isolatedEnvironment, {
    accountId: environment[`${prefix}_CLOUDFLARE_ACCOUNT_ID`],
    catalogueId: environment[`${prefix}_CATALOGUE_DATABASE_ID`],
    disposableId: environment[`${prefix}_DISPOSABLE_DATABASE_ID`],
  });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== environment.EXPECTED_HEAD_SHA) throw new Error("first_install_checkout_mismatch");
  await (isolatedEnvironment === "dev" ? verifyDevCommit : verifyReleaseCommit)(environment.GH_TOKEN, {
    head_sha: head,
    ci_run_id: environment.CI_RUN_ID,
  });
  const names = environmentNames(isolatedEnvironment);
  for (const [id, name] of [
    [environment[`${prefix}_CATALOGUE_DATABASE_ID`], names.catalogue],
    [environment[`${prefix}_DISPOSABLE_DATABASE_ID`], names.disposable],
  ]) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${environment[`${prefix}_CLOUDFLARE_ACCOUNT_ID`]}/d1/database/${id}`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}` },
      },
    );
    const value = await response.json();
    if (!response.ok || value.success !== true || value.result?.uuid !== id || value.result?.name !== name)
      throw new Error("first_install_database_identity_mismatch");
  }
  const db = remoteEnvironmentDatabase(environment);
  const retryOf = environment[`${prefix}_FIRST_INSTALL_RETRY_OF`];
  const empty = await db
    .prepare(
      "SELECT migration_level FROM catalogue_schema_state WHERE singleton=1 AND NOT EXISTS (SELECT 1 FROM catalogue_revisions) AND NOT EXISTS (SELECT 1 FROM ingestion_runs) AND (? = 1 OR NOT EXISTS (SELECT 1 FROM administration_idempotency))",
    )
    .bind(retryOf === undefined ? 0 : 1)
    .first();
  if (!Number.isSafeInteger(empty?.migration_level))
    throw new Error(`first_install_requires_unused_${isolatedEnvironment}_baseline`);
  const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true } });
  try {
    const { prepareProductionRelease, validatedPlan } = await vite.ssrLoadModule(
      "/src/catalogue/ingestion/production-release.ts",
    );
    const { catalogueStore, canonicalJson, sha256Text } = await vite.ssrLoadModule("/src/catalogue/shared/index.ts");
    const target = {
      cloudflare_account_id: environment[`${prefix}_CLOUDFLARE_ACCOUNT_ID`],
      worker_scripts: names.workers,
      d1_databases: [
        { name: names.catalogue, id: environment[`${prefix}_CATALOGUE_DATABASE_ID`] },
        { name: names.disposable, id: environment[`${prefix}_DISPOSABLE_DATABASE_ID`] },
      ],
      r2_buckets: names.buckets,
    };
    let suffix = "";
    if (retryOf !== undefined) {
      const refuse = () => {
        throw new Error("first_install_retry_not_safe");
      };
      const idle = await db
        .prepare(
          "SELECT 1 AS idle FROM operation_state WHERE singleton=1 AND active_production_release_id IS NULL AND active_ingestion_run_id IS NULL AND active_recovery_id IS NULL AND recovery_health='healthy' AND recovery_restore_guard='clear' AND NOT EXISTS (SELECT 1 FROM production_releases)",
        )
        .first();
      const rows = (
        await db
          .prepare(
            "SELECT idempotency_key,operation,request_json,response_json,http_status,outcome FROM administration_idempotency ORDER BY created_at,idempotency_key LIMIT 101",
          )
          .all()
      ).results;
      if (!idle || typeof retryOf !== "string" || rows.length === 0 || rows.length > 100) refuse();
      const groups = new Map();
      try {
        for (const row of rows) {
          const plan = validatedPlan(JSON.parse(row.request_json), target);
          if (
            !plan.bootstrap ||
            !plan.release_id.startsWith(`${isolatedEnvironment}-first-`) ||
            !plan.idempotency_key.startsWith(`${isolatedEnvironment}-first:`) ||
            canonicalJson(plan) !== row.request_json
          )
            refuse();
          const group = groups.get(plan.release_id) ?? { plan, request: row.request_json, rows: [] };
          if (group.request !== row.request_json) refuse();
          group.rows.push({ ...row, response: JSON.parse(row.response_json) });
          groups.set(plan.release_id, group);
        }
        for (const group of groups.values()) {
          const digest = await sha256Text(group.request);
          if (group.plan.production_target_digest !== (await sha256Text(canonicalJson(target)))) refuse();
          const expected = [
            ["prepare_production_release", group.plan.idempotency_key, 201, "success"],
            ["claim_production_release", `release-dispatch:${digest}`, 201, "success"],
            ["production_release_migration_started", `release-migration-started:${digest}`, 201, "success"],
            ["production_release_migration_failed", `release-migration-failed:${digest}`, 500, "problem"],
          ];
          if (group.rows.length !== expected.length) refuse();
          for (const [operation, key, status, outcome] of expected) {
            const matches = group.rows.filter(
              (row) =>
                row.operation === operation &&
                row.idempotency_key === key &&
                row.http_status === status &&
                row.outcome === outcome &&
                row.response.release_id === group.plan.release_id &&
                row.response.dispatch_digest === digest,
            );
            if (matches.length !== 1) refuse();
          }
          const prepared = group.rows.find((row) => row.operation === "prepare_production_release").response;
          const failed = group.rows.find((row) => row.operation === "production_release_migration_failed").response;
          if (
            prepared.prepared_plan_json !== group.request ||
            failed.state !== "failed" ||
            failed.roll_forward_required !== true ||
            failed.migration_started_key !== `release-migration-started:${digest}`
          )
            refuse();
        }
      } catch {
        refuse();
      }
      const previous = groups.get(retryOf);
      if (!previous || [...groups.keys()].at(-1) !== retryOf) refuse();
      suffix = `-retry-${(await sha256Text(previous.request)).slice(0, 12)}`;
      await verifyEnvironmentWorkerShells(environment);
    }
    const prepared = await prepareProductionRelease(
      catalogueStore(db),
      {
        release_id: `${isolatedEnvironment}-first-${head}${suffix}`,
        idempotency_key: `${isolatedEnvironment}-first:${head}${suffix}`,
        expected_head_sha: head,
        expected_actor: "github-actions[bot]",
        expected_current_revision_id: "catrev_spine_000",
        expected_migration_level: empty.migration_level,
        production_target: target,
        production_target_digest: await sha256Text(canonicalJson(target)),
        bootstrap: true,
        recovery_bookmark: null,
        recovery_backup_attempt_id: null,
        smoke_targets: null,
        retained_revision_evidence: null,
        replacement_handoff: null,
      },
      target,
      new Date().toISOString(),
    );
    return { ...prepared, environment: isolatedEnvironment, configs };
  } finally {
    await vite.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const environment = { ...process.env, RELEASE_ENVIRONMENT: process.env.RELEASE_ENVIRONMENT ?? "dev" };
  const prepared = await prepareFirstEnvironmentInstall(environment);
  for (const [app, config] of Object.entries(prepared.configs))
    await writeFile(`apps/${app}/wrangler.${prepared.environment}.json`, `${JSON.stringify(config, null, 2)}\n`);
  const { deployEnvironment } = await import("./deploy-dev.mjs");
  await deployEnvironment({
    ...process.env,
    ...Object.fromEntries(Object.entries(prepared.dispatch_inputs).map(([key, value]) => [key.toUpperCase(), value])),
    RELEASE_ENVIRONMENT: prepared.environment,
    CLOUDFLARE_ACCOUNT_ID: process.env[`${prepared.environment.toUpperCase()}_CLOUDFLARE_ACCOUNT_ID`],
  });
}
