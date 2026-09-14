#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import { environmentNames } from "../src/http/environment-target.mjs";

/** Existing automatic dev caller retains its explicit target. */
export async function devConfigurations({ accountId, catalogueId, disposableId }) {
  return environmentConfigurations("dev", { accountId, catalogueId, disposableId });
}

/** Fully flatten isolated bindings only after observed database identities are supplied. */
export async function environmentConfigurations(environment, { accountId, catalogueId, disposableId }) {
  if (!["dev", "staging"].includes(environment)) throw new Error("isolated_environment_required");
  const [api, ingestion] = await Promise.all(
    ["api", "ingestion"].map((app) => readWorkerConfig(`apps/${app}/wrangler.jsonc`)),
  );
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
  if (!/^[0-9a-f]{32}$/u.test(accountId ?? "") || !uuid.test(catalogueId ?? "") || !uuid.test(disposableId ?? ""))
    throw new Error(`${environment}_resource_identity_required`);
  const productionIds = [
    ingestion.vars.CATALOGUE_D1_DATABASE_ID,
    ingestion.vars.DISPOSABLE_D1_DATABASE_ID,
    api.d1_databases[0].database_id,
  ];
  if (catalogueId === disposableId || [catalogueId, disposableId].some((id) => productionIds.includes(id)))
    throw new Error(`${environment}_database_isolation_required`);
  const names = environmentNames(environment);
  const bucketNames = new Map(environmentNames().buckets.map((name, index) => [name, names.buckets[index]]));
  for (const [index, config] of [api, ingestion].entries()) {
    delete config.env;
    config.name = names.workers[index];
    config.account_id = accountId;
    config.workers_dev = false;
    config.preview_urls = false;
    config.routes = config.routes.map((route) => ({
      ...route,
      pattern: route.pattern.replace("card.keepr.digital", names.host),
    }));
    config.vars.PUBLIC_BASE_URL = `https://${names.host}/${index === 0 ? "api" : "ingest"}`;
    config.d1_databases[0].database_id = catalogueId;
    config.d1_databases[0].database_name = names.catalogue;
    for (const binding of config.r2_buckets) {
      const name = bucketNames.get(binding.bucket_name);
      if (!name) throw new Error("unknown_bucket_binding");
      binding.bucket_name = name;
    }
    for (const limit of config.ratelimits)
      limit.namespace_id = String(Number(limit.namespace_id) + (environment === "dev" ? 1000 : 2000));
  }
  ingestion.vars.KEEPR_ENVIRONMENT = environment;
  ingestion.vars.CLOUDFLARE_ACCOUNT_ID = accountId;
  ingestion.vars.CATALOGUE_D1_DATABASE_ID = catalogueId;
  ingestion.vars.DISPOSABLE_D1_DATABASE_ID = disposableId;
  ingestion.workflows.forEach((workflow, index) => {
    workflow.name = names.workflows[index];
  });
  ingestion.services[0].service = names.workers[1];
  return { api, ingestion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const environment = process.env.RELEASE_ENVIRONMENT ?? "dev";
  const prefix = environment.toUpperCase();
  const configs = await environmentConfigurations(environment, {
    accountId: process.env[`${prefix}_CLOUDFLARE_ACCOUNT_ID`],
    catalogueId: process.env[`${prefix}_CATALOGUE_DATABASE_ID`],
    disposableId: process.env[`${prefix}_DISPOSABLE_DATABASE_ID`],
  });
  for (const [app, config] of Object.entries(configs))
    await writeFile(`apps/${app}/wrangler.${environment}.json`, `${JSON.stringify(config, null, 2)}\n`);
}
