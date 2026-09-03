import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { executeSqlFile } from "../scripts/production-release-d1.mjs";

const run = promisify(execFile);
const account = "0123456789abcdef0123456789abcdef";
const databaseId = "00000000-0000-0000-0000-000000000001";

// Issue #148: wrangler executes a remote `d1 execute --file` through the D1
// import API, which returns no query rows. The release runner posts the
// generated SQL file to the query endpoint instead and prints the same
// per-statement array shape the workflow's jq reads were written against.
test("the release runner posts a generated SQL file to the D1 query endpoint and returns each statement's rows in order", async (t) => {
  const directory = await releaseDirectory(t);
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    return jsonResponse(200, {
      success: true,
      errors: [],
      result: [
        { results: [], success: true, meta: { changes: 1 } },
        { results: [{ changed_rows: 1, claimed: 1 }], success: true, meta: {} },
      ],
    });
  };
  const result = await executeSqlFile(
    environment(),
    { configPath: join(directory, "wrangler.json"), sqlPath: join(directory, "claim.sql") },
    fetchImpl,
  );
  assert.deepEqual(requests, [{
    url: `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`,
    method: "POST",
    headers: { authorization: "Bearer test-cloudflare-token-0000000000", "content-type": "application/json" },
    body: { sql: "UPDATE operation_state SET active_ingestion_run_id='release' WHERE singleton=1;\nSELECT changes() AS changed_rows, 1 AS claimed;\n" },
  }]);
  assert.deepEqual(result.map((entry) => entry.results), [[], [{ changed_rows: 1, claimed: 1 }]]);
});

test("the release runner fails closed on an API error, a failed statement, or a config without the catalogue binding", async (t) => {
  const directory = await releaseDirectory(t);
  const paths = { configPath: join(directory, "wrangler.json"), sqlPath: join(directory, "claim.sql") };
  await assert.rejects(
    executeSqlFile(environment(), paths, async () => jsonResponse(400, { success: false, errors: [{ code: 7500, message: "no such table: missing" }], result: [] })),
    /d1_query_failed:7500:no such table: missing/u,
  );
  await assert.rejects(
    executeSqlFile(environment(), paths, async () => jsonResponse(200, { success: true, errors: [], result: [{ results: [], success: false, meta: {} }] })),
    /d1_statement_failed/u,
  );
  await assert.rejects(
    executeSqlFile(environment(), paths, async () => new Response("<html>", { status: 502 })),
    /d1_malformed_response/u,
  );
  await writeFile(join(directory, "other.json"), JSON.stringify({ d1_databases: [{ binding: "OTHER_DB", database_id: databaseId }] }));
  await assert.rejects(
    executeSqlFile(environment(), { ...paths, configPath: join(directory, "other.json") }, async () => jsonResponse(200, { success: true, result: [] })),
    /missing_catalogue_database_binding/u,
  );
  await assert.rejects(
    executeSqlFile({ ...environment(), CLOUDFLARE_API_TOKEN: "" }, paths, async () => jsonResponse(200, { success: true, result: [] })),
    /missing_cloudflare_api_token/u,
  );
});

test("the release runner command prints the statement results as JSON on stdout and nothing else", async (t) => {
  const directory = await releaseDirectory(t);
  const calls = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      calls.push({ path: request.url, body: JSON.parse(body) });
      response.setHeader("content-type", "application/json");
      if (calls.length === 1) {
        response.end(JSON.stringify({ success: true, errors: [], result: [{ results: [{ ready: 1 }], success: true, meta: {} }] }));
        return;
      }
      response.statusCode = 401;
      response.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const apiUrl = `http://127.0.0.1:${server.address().port}/client/v4`;
  const env = { ...process.env, ...environment(), CLOUDFLARE_API_URL: apiUrl };
  const arguments_ = ["scripts/production-release-d1.mjs", "execute", "--config", join(directory, "wrangler.json"), "--file", join(directory, "claim.sql")];

  const ok = await run(process.execPath, arguments_, { env });
  assert.equal(ok.stderr, "");
  assert.deepEqual(JSON.parse(ok.stdout), [{ results: [{ ready: 1 }], success: true, meta: {} }]);
  assert.equal(calls[0].path, `/client/v4/accounts/${account}/d1/database/${databaseId}/query`);

  await assert.rejects(run(process.execPath, arguments_, { env }), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.match(error.stderr, /d1_query_failed:10000:Authentication error/u);
    return true;
  });

  await assert.rejects(run(process.execPath, ["scripts/production-release-d1.mjs", "execute", "--config", join(directory, "wrangler.json")], { env }), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /usage/u);
    return true;
  });
});

function environment() {
  return { CLOUDFLARE_API_TOKEN: "test-cloudflare-token-0000000000", CLOUDFLARE_ACCOUNT_ID: account };
}

function jsonResponse(status, document) {
  return new Response(JSON.stringify(document), { status, headers: { "content-type": "application/json" } });
}

async function releaseDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "keepr-release-d1-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({
    name: "card-keepr-ingestion",
    d1_databases: [{ binding: "CATALOGUE_DB", database_name: "card-keepr-catalogue", database_id: databaseId }],
  }));
  await writeFile(
    join(directory, "claim.sql"),
    "UPDATE operation_state SET active_ingestion_run_id='release' WHERE singleton=1;\nSELECT changes() AS changed_rows, 1 AS claimed;\n",
  );
  return directory;
}
