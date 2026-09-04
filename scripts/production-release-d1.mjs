#!/usr/bin/env node
import { readWorkerConfig } from "../cli/lib/config.mjs";
import { request as httpRequest } from "../cli/lib/http-client.mjs";
// Runs one validator-generated SQL file against the release's catalogue D1
// through the D1 query endpoint and prints each statement's result in order.
//
// Issue #148: `wrangler d1 execute --remote --file` executes the file through
// the D1 import API, which streams progress to stdout even under --json,
// returns an import summary instead of the query's rows, and can make the
// database unavailable while it runs. Every evidence check in the guarded
// Production Release reads `.[-1].results[0].<field>`, so the release state
// statements go through the query endpoint here, keeping the SQL in the
// immutable generated files rather than in workflow arguments.
import { readFile } from "node:fs/promises";

const defaultApi = "https://api.cloudflare.com/client/v4";

export async function executeSqlFile(environment, { configPath, sqlPath }, fetchImpl = fetch) {
  const token = required(environment, "CLOUDFLARE_API_TOKEN");
  const accountId = required(environment, "CLOUDFLARE_ACCOUNT_ID");
  const api = environment.CLOUDFLARE_API_URL ?? defaultApi;
  const databaseId = await catalogueDatabaseId(configPath);
  const sql = await readFile(sqlPath, "utf8");
  if (sql.trim().length === 0) throw new Error(`empty_sql_file:${sqlPath}`);
  const response = await httpRequest(
    `${api}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(60_000),
    },
    fetchImpl,
  );
  let document;
  try {
    document = await response.json();
  } catch {
    throw new Error("d1_malformed_response");
  }
  if (!response.ok || !record(document) || document.success !== true || !Array.isArray(document.result)) {
    const errors = Array.isArray(document?.errors) ? document.errors : [];
    const detail = errors.map((error) => `${error?.code ?? "unknown"}:${error?.message ?? ""}`).join(";");
    throw new Error(`d1_query_failed:${detail === "" ? String(response.status) : detail}`);
  }
  for (const entry of document.result) {
    if (!record(entry) || entry.success !== true || !Array.isArray(entry.results))
      throw new Error("d1_statement_failed");
  }
  return document.result;
}

// The release binds the catalogue database through the wrangler config it is
// given (the checked-in one, or an ephemeral replacement-handoff config), so
// the identity comes from that file's CATALOGUE_DB binding and nowhere else.
async function catalogueDatabaseId(configPath) {
  let config;
  try {
    config = await readWorkerConfig(configPath);
  } catch {
    throw new Error(`invalid_wrangler_config:${configPath}`);
  }
  const binding = (Array.isArray(config?.d1_databases) ? config.d1_databases : []).find(
    (entry) => record(entry) && entry.binding === "CATALOGUE_DB",
  );
  if (!binding || typeof binding.database_id !== "string" || binding.database_id.length === 0)
    throw new Error("missing_catalogue_database_binding");
  return binding.database_id;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function parseArguments(argv) {
  if (argv[0] !== "execute") return null;
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if ((name !== "--config" && name !== "--file") || typeof value !== "string" || name in values) return null;
    values[name] = value;
  }
  return "--config" in values && "--file" in values
    ? { configPath: values["--config"], sqlPath: values["--file"] }
    : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === null) {
    process.stderr.write(
      "usage: production-release-d1.mjs execute --config <wrangler.jsonc> --file <statements.sql>\n",
    );
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(await executeSqlFile(process.env, parsed))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
