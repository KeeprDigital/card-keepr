import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { runCli, startWorker, stopWorker, waitForHealth } from "./helpers/acceptance-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const apiSchema = JSON.parse(readFileSync(resolve(root, "contracts/schemas/api.schema.json"), "utf8"));
const exportManifestSchemaV5 = JSON.parse(
  readFileSync(resolve(root, "contracts/schemas/catalogue-export-manifest-v5.schema.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(exportManifestSchemaV5);
ajv.addSchema(apiSchema);
const validateProblem = ajv.getSchema(`${apiSchema.$id}#/$defs/Problem`);
const validateCatalogue = ajv.getSchema(`${apiSchema.$id}#/$defs/CatalogueDocument`);
// Reserved migration numbers can leave gaps; readiness reports the highest
// applied migration number, not the number of checked-in files.
const migrationLevel = Math.max(
  ...readdirSync(resolve(root, "migrations"))
    .filter((entry) => /^\d+_.+\.sql$/.test(entry))
    .map((entry) => Number.parseInt(entry, 10)),
);
const ingestionConfig = JSON.parse(readFileSync(resolve(root, "apps/ingestion/wrangler.jsonc"), "utf8"));

const rateLimitWindowSeconds = 60;
const rateLimitBatchSize = 25;
const rateLimitLoopBudgetMs = 30_000;

// Exhausts a fixed-window per-IP limit without depending on request
// throughput: the limiter counts `limit` requests per 60-second window, so the
// requests go out concurrently in bounded batches and the loop is timed against
// a budget well inside the window. A slow runner then fails on the timing
// message rather than on a 200 from a rolled-over window.
async function exhaustRateLimit(request, limit) {
  const total = limit + rateLimitBatchSize;
  const startedAt = performance.now();
  let finalBatch = [];
  for (let sent = 0; sent < total; sent += rateLimitBatchSize) {
    const batchSize = Math.min(rateLimitBatchSize, total - sent);
    finalBatch = await Promise.all(Array.from({ length: batchSize }, () => request()));
    await Promise.all(finalBatch.map((response) => response.arrayBuffer()));
  }
  const elapsedMs = Math.round(performance.now() - startedAt);
  assert.ok(
    elapsedMs < rateLimitLoopBudgetMs,
    `sending ${total} requests took ${elapsedMs} ms, over the ${rateLimitLoopBudgetMs} ms budget; ` +
      `the limiter's ${rateLimitWindowSeconds}-second window may have rolled over, ` +
      "so a 429 after this loop would not prove the limit",
  );
  const statuses = finalBatch.map((response) => response.status);
  assert.ok(
    statuses.includes(429),
    `none of the final ${finalBatch.length} of ${total} requests was rate limited ` +
      `(statuses ${statuses.join(", ")}) after ${elapsedMs} ms`,
  );
  return { elapsedMs, total };
}

test("the CLI reports both locally emulated runtimes as healthy", async (t) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "card-keepr-health-"));
  const apiKey = crypto.randomUUID();
  const administrationKey = crypto.randomUUID();
  const apiEnv = join(testDirectory, "api.env");
  const ingestionEnv = join(testDirectory, "ingestion.env");
  await Promise.all([
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\n`, {
      mode: 0o600,
    }),
  ]);

  const api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    migrate: true,
    statePath: join(testDirectory, "api-state"),
  });
  const ingestion = await startWorker({
    config: "apps/ingestion/wrangler.jsonc",
    envFile: ingestionEnv,
    migrate: true,
    statePath: join(testDirectory, "ingestion-state"),
  });
  t.after(async () => {
    await Promise.all([stopWorker(api), stopWorker(ingestion)]);
  });

  try {
    await Promise.all([
      waitForHealth(`${api.url}/health`, apiKey, api),
      waitForHealth(`${ingestion.url}/health`, administrationKey, ingestion),
    ]);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nAPI:\n${api.getOutput()}\nIngestion:\n${ingestion.getOutput()}`,
      { cause: error },
    );
  }

  const cliEnvironment = {
    KEEPR_API_URL: api.url,
    KEEPR_INGESTION_URL: ingestion.url,
    KEEPR_API_KEY: apiKey,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
  };
  const cli = await runCli(["health", "--json"], cliEnvironment);

  assert.equal(cli.code, 0, cli.stderr);
  const cliDocument = JSON.parse(cli.stdout);
  const apiChecks = cliDocument.runtimes[0].checks;
  const ingestionChecks = cliDocument.runtimes[1].checks;
  assert.deepEqual(cliDocument, {
    contract: "card-keepr-cli-health@1",
    status: "ok",
    runtimes: [
      {
        name: "api",
        status: "ok",
        capabilities: ["catalogue:read", "printing-image:read", "catalogue-export:read"],
        checks: apiChecks,
      },
      {
        name: "ingestion",
        status: "ok",
        capabilities: ["catalogue:write", "evidence:write", "printing-image:write", "export:write", "backup:write"],
        checks: ingestionChecks,
      },
    ],
  });
  // Readiness (issue #144): every check of both runtimes passes against the
  // emulated bindings, and the document names what it proved.
  assert.deepEqual(Object.keys(apiChecks), ["database", "objects", "public_base", "version"]);
  assert.deepEqual(Object.keys(ingestionChecks), ["database", "objects", "workflows", "public_base", "version"]);
  for (const checks of [apiChecks, ingestionChecks]) {
    for (const check of Object.values(checks)) {
      assert.equal(check.status, "pass", JSON.stringify(check));
    }
    assert.equal(checks.database.migration_level, migrationLevel);
    assert.equal(checks.database.current_revision_id, "catrev_spine_000");
    // The in-process HTTP bridge preserves the configured local origin.
    assert.equal(checks.public_base.arrived_through_public_base, true);
    assert.deepEqual(Object.keys(checks.version).sort(), ["id", "status", "tag", "timestamp"]);
  }
  assert.equal(apiChecks.public_base.configured, api.url);
  assert.equal(ingestionChecks.public_base.configured, ingestion.url);
  assert.deepEqual(Object.keys(apiChecks.objects.buckets), ["PRINTING_IMAGES", "CATALOGUE_EXPORTS"]);
  assert.deepEqual(Object.keys(ingestionChecks.objects.buckets), [
    "EVIDENCE_OBJECTS",
    "PRINTING_IMAGES",
    "CATALOGUE_EXPORTS",
    "BACKUPS",
  ]);
  assert.deepEqual(Object.keys(ingestionChecks.workflows.bindings), [
    "EVIDENCE_INGESTION_WORKFLOW",
    "EVIDENCE_HOST_WORKFLOW",
    "RECONCILIATION_WORKFLOW",
    "CATALOGUE_BACKUP_WORKFLOW",
  ]);
  assert.equal(ingestionChecks.database.configured_database_id, ingestionConfig.d1_databases[0].database_id);
  assert.equal(apiChecks.database.configured_database_id, undefined);

  const humanCli = await runCli(["health"], cliEnvironment);
  assert.equal(humanCli.code, 0, humanCli.stderr);
  const versionLine = (checks) => `  version: pass (id ${checks.version.id ?? "unknown"})`;
  assert.equal(
    humanCli.stdout,
    [
      "Card Keepr runtimes are healthy",
      "api: ok (catalogue:read, printing-image:read, catalogue-export:read)",
      `  database: pass (schema level ${migrationLevel}, revision catrev_spine_000)`,
      "  objects: pass (PRINTING_IMAGES pass, CATALOGUE_EXPORTS pass)",
      `  public_base: pass (${api.url}, arrived through it: yes)`,
      versionLine(apiChecks),
      "ingestion: ok (catalogue:write, evidence:write, printing-image:write, export:write, backup:write)",
      `  database: pass (schema level ${migrationLevel}, revision catrev_spine_000, configured database ${ingestionConfig.d1_databases[0].database_id})`,
      "  objects: pass (EVIDENCE_OBJECTS pass, PRINTING_IMAGES pass, CATALOGUE_EXPORTS pass, BACKUPS pass)",
      "  workflows: pass (EVIDENCE_INGESTION_WORKFLOW pass, EVIDENCE_HOST_WORKFLOW pass, RECONCILIATION_WORKFLOW pass, CATALOGUE_BACKUP_WORKFLOW pass)",
      `  public_base: pass (${ingestion.url}, arrived through it: yes)`,
      versionLine(ingestionChecks),
      "",
    ].join("\n"),
  );

  // Liveness (issue #144) needs no credential, says nothing beyond status
  // and runtime, and leaves every sibling route authenticated.
  for (const [runtime, worker] of [
    ["api", api],
    ["ingestion", ingestion],
  ]) {
    const liveness = await fetch(`${worker.url}/healthz`);
    assert.equal(liveness.status, 200);
    assert.equal(liveness.headers.get("cache-control"), "no-store");
    assert.deepEqual(await liveness.json(), { status: "ok", runtime });
    const readiness = await fetch(`${worker.url}/health`);
    assert.equal(readiness.status, 401);
    const unknown = await fetch(`${worker.url}/healthzz`);
    assert.equal(unknown.status, 401);
  }

  const [apiRejectsAdminKey, ingestionRejectsApiKey] = await Promise.all([
    fetch(`${api.url}/health`, {
      headers: { authorization: `Bearer ${administrationKey}` },
    }),
    fetch(`${ingestion.url}/health`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }),
  ]);
  const [apiProblem, ingestionProblem] = await Promise.all([apiRejectsAdminKey.json(), ingestionRejectsApiKey.json()]);
  assert.equal(apiRejectsAdminKey.status, 401);
  assert.equal(validateProblem?.(apiProblem), true, JSON.stringify(validateProblem?.errors));
  assert.equal(apiProblem.code, "invalid_api_key");
  assert.equal(ingestionRejectsApiKey.status, 401);
  assert.equal(ingestionProblem.code, "invalid_administration_key");
  assert.match(ingestionProblem.request_id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  assert.equal(JSON.stringify(apiProblem).includes(administrationKey), false);
  assert.equal(JSON.stringify(ingestionProblem).includes(apiKey), false);

  const rejectedCli = await runCli(["health", "--json"], {
    ...cliEnvironment,
    KEEPR_API_KEY: administrationKey,
  });
  assert.equal(rejectedCli.code, 4);
  assert.equal(rejectedCli.stderr, "");
  assert.deepEqual(JSON.parse(rejectedCli.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "authentication_failed",
    detail: "api runtime rejected its credential",
    runtime: "api",
  });
});

test("the CLI exit code follows readiness when a runtime is degraded", async (t) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "card-keepr-degraded-"));
  const apiKey = crypto.randomUUID();
  const administrationKey = crypto.randomUUID();
  const apiEnv = join(testDirectory, "api.env");
  const ingestionEnv = join(testDirectory, "ingestion.env");
  await Promise.all([
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\n`, {
      mode: 0o600,
    }),
  ]);
  const api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    migrate: true,
    statePath: join(testDirectory, "api-state"),
  });
  // A broken binding is injected through a var override: the ingestion
  // Worker's configured catalogue database id is not a database id at all.
  const ingestion = await startWorker({
    config: "apps/ingestion/wrangler.jsonc",
    envFile: ingestionEnv,
    migrate: true,
    statePath: join(testDirectory, "ingestion-state"),
    vars: { CATALOGUE_D1_DATABASE_ID: "not-a-database-id" },
  });
  t.after(async () => {
    await Promise.all([stopWorker(api), stopWorker(ingestion)]);
  });
  // Liveness is what a boot can be awaited on while readiness is degraded.
  await Promise.all([
    waitForHealth(`${api.url}/healthz`, "no-credential-required", api),
    waitForHealth(`${ingestion.url}/healthz`, "no-credential-required", ingestion),
  ]);

  const readiness = await fetch(`${ingestion.url}/health`, {
    headers: { authorization: `Bearer ${administrationKey}` },
  });
  assert.equal(readiness.status, 503);
  assert.equal(readiness.headers.get("cache-control"), "no-store");
  const document = await readiness.json();
  assert.equal(document.status, "degraded");
  assert.deepEqual(document.checks.database, {
    status: "fail",
    migration_level: null,
    current_revision_id: null,
    configured_database_id: "not-a-database-id",
    reason: "database_id_not_configured",
  });
  assert.equal(document.checks.workflows.status, "pass");

  const cliEnvironment = {
    KEEPR_API_URL: api.url,
    KEEPR_INGESTION_URL: ingestion.url,
    KEEPR_API_KEY: apiKey,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
  };
  const cli = await runCli(["health", "--json"], cliEnvironment);
  assert.equal(cli.code, 9, cli.stderr);
  assert.equal(cli.stderr, "");
  const cliDocument = JSON.parse(cli.stdout);
  assert.equal(cliDocument.contract, "card-keepr-cli-health@1");
  assert.equal(cliDocument.status, "degraded");
  assert.equal(cliDocument.runtimes[0].status, "ok");
  assert.equal(cliDocument.runtimes[1].status, "degraded");
  assert.deepEqual(cliDocument.runtimes[1].checks.database, document.checks.database);

  const humanCli = await runCli(["health"], cliEnvironment);
  assert.equal(humanCli.code, 9, humanCli.stderr);
  const lines = humanCli.stdout.split("\n");
  assert.equal(lines[0], "Card Keepr runtimes are degraded");
  assert.ok(
    lines.includes("  database: fail (configured database not-a-database-id, database_id_not_configured)"),
    humanCli.stdout,
  );
});

test("the API accepts an unauthenticated preflight for an exact allowed origin", async (t) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "card-keepr-preflight-"));
  const apiKey = crypto.randomUUID();
  const apiEnv = join(testDirectory, "api.env");
  await writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 });
  const api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    migrate: true,
    statePath: join(testDirectory, "api-state"),
  });
  t.after(async () => {
    await stopWorker(api);
  });
  await waitForHealth(`${api.url}/health`, apiKey, api);

  const response = await fetch(`${api.url}/v1/catalogue`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:3000",
      "access-control-request-method": "GET",
      "access-control-request-headers": "Authorization",
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
  assert.equal(response.headers.get("access-control-allow-headers"), "Authorization");
  assert.equal(response.headers.get("vary"), "Origin");
  assert.equal(await response.text(), "");
});

test("the API rejects a browser origin that only prefixes the allowed origin", async (t) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "card-keepr-origin-"));
  const apiKey = crypto.randomUUID();
  const apiEnv = join(testDirectory, "api.env");
  await writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 });
  const api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    migrate: true,
    statePath: join(testDirectory, "api-state"),
  });
  t.after(async () => {
    await stopWorker(api);
  });
  await waitForHealth(`${api.url}/health`, apiKey, api);

  const response = await fetch(`${api.url}/v1/catalogue`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      origin: "http://localhost:3000.evil.example",
    },
  });
  const problem = await response.json();

  assert.equal(response.status, 403);
  assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json/);
  assert.equal(validateProblem?.(problem), true, JSON.stringify(validateProblem?.errors));
  assert.equal(problem.code, "forbidden_origin");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("vary"), "Origin");
});

test("an allowed browser origin receives a CORS-shaped authentication problem", async (t) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "card-keepr-auth-"));
  const apiKey = crypto.randomUUID();
  const apiEnv = join(testDirectory, "api.env");
  await writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 });
  const api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    migrate: true,
    statePath: join(testDirectory, "api-state"),
  });
  t.after(async () => {
    await stopWorker(api);
  });
  await waitForHealth(`${api.url}/health`, apiKey, api);

  const response = await fetch(`${api.url}/v1/catalogue`, {
    headers: { origin: "http://localhost:3000" },
  });
  const problem = await response.json();

  assert.equal(response.status, 401);
  assert.equal(validateProblem?.(problem), true, JSON.stringify(validateProblem?.errors));
  assert.equal(problem.code, "authentication_required");
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.equal(response.headers.get("access-control-expose-headers"), "ETag, X-Catalogue-Revision");
  assert.equal(response.headers.get("vary"), "Origin");
});

test("catalogue requests return a stable problem after the per-IP limit", async (t) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "card-keepr-rate-"));
  const apiKey = crypto.randomUUID();
  const apiEnv = join(testDirectory, "api.env");
  await writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 });
  const api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    migrate: true,
    statePath: join(testDirectory, "api-state"),
  });
  t.after(async () => {
    await stopWorker(api);
  });
  await waitForHealth(`${api.url}/health`, apiKey, api);

  const request = () =>
    fetch(`${api.url}/v1/catalogue`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "cf-connecting-ip": "192.0.2.10",
      },
    });
  const { elapsedMs, total } = await exhaustRateLimit(request, 300);
  t.diagnostic(`exhausted the catalogue limit with ${total} requests in ${elapsedMs} ms`);
  const response = await request();
  const problem = await response.json();

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(validateProblem?.(problem), true, JSON.stringify(validateProblem?.errors));
  assert.equal(problem.code, "rate_limited");
});

test("Printing Image requests use their independent per-IP limit", async (t) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "card-keepr-image-rate-"));
  const apiKey = crypto.randomUUID();
  const apiEnv = join(testDirectory, "api.env");
  await writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 });
  const api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    migrate: true,
    statePath: join(testDirectory, "api-state"),
  });
  t.after(async () => {
    await stopWorker(api);
  });
  await waitForHealth(`${api.url}/health`, apiKey, api);

  const request = (clientIp) =>
    fetch(`${api.url}/v1/printing-images/image_test/content`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "cf-connecting-ip": clientIp,
      },
    });
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const clientIp = `192.0.2.${20 + attempt}`;
    const startingEpoch = Math.floor(Date.now() / 60_000);
    for (let requestNumber = 1; requestNumber <= 1_200; requestNumber += 1) {
      response = await request(clientIp);
      assert.equal(response.status, 404, `request ${requestNumber}`);
    }
    response = await request(clientIp);
    if (response.status === 429) break;
    assert.notEqual(
      Math.floor(Date.now() / 60_000),
      startingEpoch,
      "the Printing Image limit was not enforced within one rate-limit epoch",
    );
  }
  assert.ok(response);
  const problem = await response.json();

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(validateProblem?.(problem), true, JSON.stringify(validateProblem?.errors));
  assert.equal(problem.code, "rate_limited");
});

test("administration requests return a stable problem after the per-IP limit", async (t) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "card-keepr-admin-rate-"));
  const administrationKey = crypto.randomUUID();
  const ingestionEnv = join(testDirectory, "ingestion.env");
  await writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\n`, { mode: 0o600 });
  const ingestion = await startWorker({
    config: "apps/ingestion/wrangler.jsonc",
    envFile: ingestionEnv,
    migrate: true,
    statePath: join(testDirectory, "ingestion-state"),
  });
  t.after(async () => {
    await stopWorker(ingestion);
  });
  await waitForHealth(`${ingestion.url}/health`, administrationKey, ingestion);

  const request = () =>
    fetch(`${ingestion.url}/health`, {
      headers: {
        authorization: `Bearer ${administrationKey}`,
        "cf-connecting-ip": "192.0.2.30",
      },
    });
  const { elapsedMs, total } = await exhaustRateLimit(request, 30);
  t.diagnostic(`exhausted the administration limit with ${total} requests in ${elapsedMs} ms`);
  const response = await request();
  const problem = await response.json();

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(validateProblem?.(problem), true, JSON.stringify(validateProblem?.errors));
  assert.equal(problem.code, "rate_limited");
});

test("authenticated API responses expose the accepted browser headers", async (t) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "card-keepr-cors-response-"));
  const apiKey = crypto.randomUUID();
  const apiEnv = join(testDirectory, "api.env");
  await writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 });
  const api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    migrate: true,
    statePath: join(testDirectory, "api-state"),
  });
  t.after(async () => {
    await stopWorker(api);
  });
  await waitForHealth(`${api.url}/health`, apiKey, api);

  const response = await fetch(`${api.url}/v1/catalogue`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      origin: "http://localhost:3000",
    },
  });
  const document = await response.json();

  assert.equal(response.status, 200);
  assert.equal(validateCatalogue?.(document), true, JSON.stringify(validateCatalogue?.errors));
  assert.equal(response.headers.get("x-catalogue-revision"), document.meta.catalogue_revision_id);
  assert.match(response.headers.get("etag") ?? "", /^".+"$/);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.equal(response.headers.get("access-control-expose-headers"), "ETag, X-Catalogue-Revision");
  assert.equal(response.headers.get("vary"), "Origin");
});

test("a preflight cannot request a method outside the accepted CORS contract", async (t) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "card-keepr-preflight-method-"));
  const apiKey = crypto.randomUUID();
  const apiEnv = join(testDirectory, "api.env");
  await writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 });
  const api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    migrate: true,
    statePath: join(testDirectory, "api-state"),
  });
  t.after(async () => {
    await stopWorker(api);
  });
  await waitForHealth(`${api.url}/health`, apiKey, api);

  const response = await fetch(`${api.url}/v1/catalogue`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:3000",
      "access-control-request-method": "POST",
      "access-control-request-headers": "Authorization",
    },
  });
  const problem = await response.json();

  assert.equal(response.status, 403);
  assert.equal(validateProblem?.(problem), true, JSON.stringify(validateProblem?.errors));
  assert.equal(problem.code, "forbidden_origin");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});
