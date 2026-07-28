import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(import.meta.dirname, "..");
const apiPort = 18_787;
const ingestionPort = 18_788;
const apiSchema = JSON.parse(
  readFileSync(
    resolve(
      root,
      "prototype/formalize-implementation-contracts/schemas/api.schema.json",
    ),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(apiSchema);
const validateProblem = ajv.getSchema(`${apiSchema.$id}#/$defs/Problem`);
const validateCatalogue = ajv.getSchema(
  `${apiSchema.$id}#/$defs/CatalogueDocument`,
);

async function waitForHealth(url, key, runtime, worker) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (worker.process.exitCode !== null) {
      throw new Error(
        `${runtime} Worker exited with code ${worker.process.exitCode}`,
      );
    }
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${key}` },
      });
      if (response.ok) return;
    } catch {
      // The local Worker has not started accepting requests yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${runtime} Worker did not become healthy`);
}

function startWorker({ config, envFile, inspectorPort, port, statePath }) {
  let output = "";
  const child = spawn(
    resolve(root, "node_modules/.bin/wrangler"),
    [
      "dev",
      "--config",
      config,
      "--env-file",
      envFile,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      statePath,
      "--log-level",
      "error",
      "--show-interactive-dev-session",
      "false",
    ],
    {
      cwd: root,
      env: {
        ...processEnvWithoutSecrets(),
        WRANGLER_LOG_PATH: join(statePath, "logs"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  child.on("error", (error) => {
    output += `${error.message}\n`;
  });
  return { process: child, getOutput: () => output };
}

function processEnvWithoutSecrets() {
  const environment = { ...process.env };
  delete environment.KEEPR_API_KEY;
  delete environment.KEEPR_ADMINISTRATION_KEY;
  return environment;
}

async function stopWorker(worker) {
  if (worker.process.exitCode !== null) return;
  worker.process.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => worker.process.once("exit", resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
  ]);
  if (worker.process.exitCode === null) worker.process.kill("SIGKILL");
}

function runCli(arguments_, environment) {
  return new Promise((resolveExit) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "cli/keepr.mjs"), ...arguments_],
      {
        cwd: root,
        env: {
          ...processEnvWithoutSecrets(),
          ...environment,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => resolveExit({ code, stdout, stderr }));
  });
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

  const api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 19_229,
    port: apiPort,
    statePath: join(testDirectory, "api-state"),
  });
  const ingestion = startWorker({
    config: "apps/ingestion/wrangler.jsonc",
    envFile: ingestionEnv,
    inspectorPort: 19_230,
    port: ingestionPort,
    statePath: join(testDirectory, "ingestion-state"),
  });
  t.after(async () => {
    await Promise.all([stopWorker(api), stopWorker(ingestion)]);
  });

  try {
    await Promise.all([
      waitForHealth(
        `http://127.0.0.1:${apiPort}/health`,
        apiKey,
        "API",
        api,
      ),
      waitForHealth(
        `http://127.0.0.1:${ingestionPort}/health`,
        administrationKey,
        "ingestion",
        ingestion,
      ),
    ]);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nAPI:\n${api.getOutput()}\nIngestion:\n${ingestion.getOutput()}`,
    );
  }

  const cliEnvironment = {
    KEEPR_API_URL: `http://127.0.0.1:${apiPort}`,
    KEEPR_INGESTION_URL: `http://127.0.0.1:${ingestionPort}`,
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
        capabilities: ["catalogue:read", "printing-image:read"],
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
      "api: ok (catalogue:read, printing-image:read)",
      "ingestion: ok (catalogue:write, evidence:write, printing-image:write, export:write, backup:write)",
      "",
    ].join("\n"),
  );

  const [apiRejectsAdminKey, ingestionRejectsApiKey] = await Promise.all([
    fetch(`http://127.0.0.1:${apiPort}/health`, {
      headers: { authorization: `Bearer ${administrationKey}` },
    }),
    fetch(`http://127.0.0.1:${ingestionPort}/health`, {
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
  const api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 19_231,
    port: apiPort,
    statePath: join(testDirectory, "api-state"),
  });
  t.after(async () => {
    await stopWorker(api);
  });
  await waitForHealth(
    `http://127.0.0.1:${apiPort}/health`,
    apiKey,
    "API",
    api,
  );

  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/catalogue`, {
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
  const api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 19_232,
    port: apiPort,
    statePath: join(testDirectory, "api-state"),
  });
  t.after(async () => {
    await stopWorker(api);
  });
  await waitForHealth(
    `http://127.0.0.1:${apiPort}/health`,
    apiKey,
    "API",
    api,
  );

  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/catalogue`, {
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
  const api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 19_233,
    port: apiPort,
    statePath: join(testDirectory, "api-state"),
  });
  t.after(async () => {
    await stopWorker(api);
  });
  await waitForHealth(
    `http://127.0.0.1:${apiPort}/health`,
    apiKey,
    "API",
    api,
  );

  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/catalogue`, {
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
  const api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 19_234,
    port: apiPort,
    statePath: join(testDirectory, "api-state"),
  });
  t.after(async () => {
    await stopWorker(api);
  });
  await waitForHealth(
    `http://127.0.0.1:${apiPort}/health`,
    apiKey,
    "API",
    api,
  );

  let response;
  for (let requestNumber = 1; requestNumber <= 301; requestNumber += 1) {
    response = await fetch(`http://127.0.0.1:${apiPort}/v1/catalogue`, {
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
  const api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 19_235,
    port: apiPort,
    statePath: join(testDirectory, "api-state"),
  });
  t.after(async () => {
    await stopWorker(api);
  });
  await waitForHealth(
    `http://127.0.0.1:${apiPort}/health`,
    apiKey,
    "API",
    api,
  );

  const request = () =>
    fetch(
      `http://127.0.0.1:${apiPort}/v1/printing-images/image_test/content`,
      {
        headers: {
          authorization: `Bearer ${apiKey}`,
          "cf-connecting-ip": "192.0.2.20",
        },
      },
    );
  for (let requestNumber = 1; requestNumber <= 1_200; requestNumber += 1) {
    const response = await request();
    assert.equal(response.status, 404, `request ${requestNumber}`);
  }
  const response = await request();
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
  const ingestion = startWorker({
    config: "apps/ingestion/wrangler.jsonc",
    envFile: ingestionEnv,
    inspectorPort: 19_236,
    port: ingestionPort,
    statePath: join(testDirectory, "ingestion-state"),
  });
  t.after(async () => {
    await stopWorker(ingestion);
  });
  await waitForHealth(
    `http://127.0.0.1:${ingestionPort}/health`,
    administrationKey,
    "ingestion",
    ingestion,
  );

  let response;
  for (let requestNumber = 1; requestNumber <= 31; requestNumber += 1) {
    response = await fetch(`http://127.0.0.1:${ingestionPort}/health`, {
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
  const api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 19_237,
    port: apiPort,
    statePath: join(testDirectory, "api-state"),
  });
  t.after(async () => {
    await stopWorker(api);
  });
  await waitForHealth(
    `http://127.0.0.1:${apiPort}/health`,
    apiKey,
    "API",
    api,
  );

  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/catalogue`, {
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
  const api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 19_238,
    port: apiPort,
    statePath: join(testDirectory, "api-state"),
  });
  t.after(async () => {
    await stopWorker(api);
  });
  await waitForHealth(
    `http://127.0.0.1:${apiPort}/health`,
    apiKey,
    "API",
    api,
  );

  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/catalogue`, {
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
