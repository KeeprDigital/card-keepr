#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { devConfigurations } from "./dev-environment.mjs";
import { verifyDevCommit } from "../src/http/dev-workflow-identity.mjs";
import { environmentNames } from "../src/http/environment-target.mjs";

/** D1's documented batch query API preserves the canonical repository transaction. */
export function remoteDevDatabase(environment) {
  const statements = new WeakMap();
  const execute = async (batch) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${environment.DEV_CLOUDFLARE_ACCOUNT_ID}/d1/database/${environment.DEV_CATALOGUE_DATABASE_ID}/query`,
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
      throw new Error("dev_d1_query_failed");
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
  const configs = await devConfigurations({
    accountId: environment.DEV_CLOUDFLARE_ACCOUNT_ID,
    catalogueId: environment.DEV_CATALOGUE_DATABASE_ID,
    disposableId: environment.DEV_DISPOSABLE_DATABASE_ID,
  });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== environment.EXPECTED_HEAD_SHA) throw new Error("first_install_checkout_mismatch");
  await verifyDevCommit(environment.GH_TOKEN, { head_sha: head, ci_run_id: environment.CI_RUN_ID });
  const names = environmentNames("dev");
  for (const [id, name] of [
    [environment.DEV_CATALOGUE_DATABASE_ID, names.catalogue],
    [environment.DEV_DISPOSABLE_DATABASE_ID, names.disposable],
  ]) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${environment.DEV_CLOUDFLARE_ACCOUNT_ID}/d1/database/${id}`,
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
  const db = remoteDevDatabase(environment);
  const empty = await db
    .prepare(
      "SELECT migration_level FROM catalogue_schema_state WHERE singleton=1 AND NOT EXISTS (SELECT 1 FROM catalogue_revisions) AND NOT EXISTS (SELECT 1 FROM ingestion_runs) AND NOT EXISTS (SELECT 1 FROM administration_idempotency)",
    )
    .first();
  if (!Number.isSafeInteger(empty?.migration_level)) throw new Error("first_install_requires_unused_dev_baseline");
  const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true } });
  try {
    const { prepareProductionRelease } = await vite.ssrLoadModule("/src/catalogue/ingestion/production-release.ts");
    const { catalogueStore, canonicalJson, sha256Text } = await vite.ssrLoadModule("/src/catalogue/shared/index.ts");
    const target = {
      cloudflare_account_id: environment.DEV_CLOUDFLARE_ACCOUNT_ID,
      worker_scripts: names.workers,
      d1_databases: [
        { name: names.catalogue, id: environment.DEV_CATALOGUE_DATABASE_ID },
        { name: names.disposable, id: environment.DEV_DISPOSABLE_DATABASE_ID },
      ],
      r2_buckets: names.buckets,
    };
    const prepared = await prepareProductionRelease(
      catalogueStore(db),
      {
        release_id: `dev-first-${head}`,
        idempotency_key: `dev-first:${head}`,
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
    return { ...prepared, environment: "dev", configs };
  } finally {
    await vite.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prepared = await prepareFirstDevInstall(process.env);
  for (const [app, config] of Object.entries(prepared.configs))
    await writeFile(`apps/${app}/wrangler.dev.json`, `${JSON.stringify(config, null, 2)}\n`);
  const { deployDev } = await import("./deploy-dev.mjs");
  await deployDev({
    ...process.env,
    ...Object.fromEntries(Object.entries(prepared.dispatch_inputs).map(([key, value]) => [key.toUpperCase(), value])),
    RELEASE_ENVIRONMENT: "dev",
    CLOUDFLARE_ACCOUNT_ID: process.env.DEV_CLOUDFLARE_ACCOUNT_ID,
  });
}
