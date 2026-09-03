import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
} from "./helpers/acceptance-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const apiSchema = JSON.parse(
  readFileSync(
    resolve(
      root,
      "prototype/formalize-implementation-contracts/schemas/api.schema.json",
    ),
    "utf8",
  ),
);
const exportManifestSchemaV5 = JSON.parse(
  readFileSync(
    resolve(
      root,
      "prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest-v5.schema.json",
    ),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(exportManifestSchemaV5);
ajv.addSchema(apiSchema);
const validateProblem = ajv.getSchema(`${apiSchema.$id}#/$defs/Problem`);
const validateCatalogue = ajv.getSchema(
  `${apiSchema.$id}#/$defs/CatalogueDocument`,
);

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
  assert.deepEqual(JSON.parse(cli.stdout), {
    contract: "card-keepr-cli-health@1",
    status: "ok",
    runtimes: [
      {
        name: "api",
        status: "ok",
        capabilities: [
          "catalogue:read",
          "printing-image:read",
          "catalogue-export:read",
          "legality-status:read",
        ],
      },
      {
        name: "ingestion",
        status: "ok",
        capabilities: [
          "catalogue:write",
          "evidence:write",
          "printing-image:write",
          "export:write",
          "backup:write",
          "legality-rule:write",
        ],
      },
    ],
  });

  const humanCli = await runCli(["health"], cliEnvironment);
  assert.equal(humanCli.code, 0, humanCli.stderr);
  assert.equal(
    humanCli.stdout,
    [
      "Card Keepr runtimes are healthy",
      "api: ok (catalogue:read, printing-image:read, catalogue-export:read, legality-status:read)",
      "ingestion: ok (catalogue:write, evidence:write, printing-image:write, export:write, backup:write, legality-rule:write)",
      "",
    ].join("\n"),
  );

  const [apiRejectsAdminKey, ingestionRejectsApiKey] = await Promise.all([
    fetch(`${api.url}/health`, {
      headers: { authorization: `Bearer ${administrationKey}` },
    }),
    fetch(`${ingestion.url}/health`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }),
  ]);
  const [apiProblem, ingestionProblem] = await Promise.all([
    apiRejectsAdminKey.json(),
    ingestionRejectsApiKey.json(),
  ]);
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
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "http://localhost:3000",
  );
  assert.equal(
    response.headers.get("access-control-allow-methods"),
    "GET, HEAD, OPTIONS",
  );
  assert.equal(
    response.headers.get("access-control-allow-headers"),
    "Authorization",
  );
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
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/problem\+json/,
  );
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
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "http://localhost:3000",
  );
  assert.equal(
    response.headers.get("access-control-expose-headers"),
    "ETag, X-Catalogue-Revision",
  );
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

  let response;
  for (let requestNumber = 1; requestNumber <= 301; requestNumber += 1) {
    response = await fetch(`${api.url}/v1/catalogue`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "cf-connecting-ip": "192.0.2.10",
      },
    });
  }
  assert.ok(response);
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
    fetch(
      `${api.url}/v1/printing-images/image_test/content`,
      {
        headers: {
          authorization: `Bearer ${apiKey}`,
          "cf-connecting-ip": clientIp,
        },
      },
    );
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
  await writeFile(
    ingestionEnv,
    `ADMINISTRATION_KEY=${administrationKey}\n`,
    { mode: 0o600 },
  );
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

  let response;
  for (let requestNumber = 1; requestNumber <= 31; requestNumber += 1) {
    response = await fetch(`${ingestion.url}/health`, {
      headers: {
        authorization: `Bearer ${administrationKey}`,
        "cf-connecting-ip": "192.0.2.30",
      },
    });
  }
  assert.ok(response);
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
  assert.equal(
    validateCatalogue?.(document),
    true,
    JSON.stringify(validateCatalogue?.errors),
  );
  assert.equal(
    response.headers.get("x-catalogue-revision"),
    document.meta.catalogue_revision_id,
  );
  assert.match(response.headers.get("etag") ?? "", /^".+"$/);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "http://localhost:3000",
  );
  assert.equal(
    response.headers.get("access-control-expose-headers"),
    "ETag, X-Catalogue-Revision",
  );
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
