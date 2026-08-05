#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

export function assertReleaseInputs(input) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.releaseId ?? "") ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(input.expectedRevision ?? "") ||
      !/^[0-9a-f]{40}$/.test(input.expectedHeadSha ?? "") ||
      !/^[0-9a-f]{64}$/.test(input.productionTargetDigest ?? "") ||
      !Number.isSafeInteger(input.expectedMigrationLevel) || input.expectedMigrationLevel < 1) {
    throw new Error("invalid_release_input");
  }
  return input;
}

export async function writeReplacementConfigs(databaseId, apiOutput, ingestionOutput) {
  if (!/^[0-9a-f-]{36}$/.test(databaseId) && !/^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/.test(databaseId)) throw new Error("invalid_replacement_database_id");
  await Promise.all([
    replaceDatabase("apps/api/wrangler.jsonc", databaseId, apiOutput, false),
    replaceDatabase("apps/ingestion/wrangler.jsonc", databaseId, ingestionOutput, true),
  ]);
}

async function replaceDatabase(source, databaseId, output, ingestion) {
  const document = JSON.parse(await readFile(source, "utf8"));
  const binding = document.d1_databases.find((item) => item.binding === "CATALOGUE_DB");
  if (!binding) throw new Error("catalogue_binding_missing");
  binding.database_id = databaseId;
  if (ingestion) document.vars.CATALOGUE_D1_DATABASE_ID = databaseId;
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[2] === "replacement-configs") {
  await writeReplacementConfigs(process.argv[3], process.argv[4], process.argv[5]);
}
