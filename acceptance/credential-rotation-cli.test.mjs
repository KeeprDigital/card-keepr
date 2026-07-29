import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cliHarness = resolve(
  "acceptance/fixtures/credential-cli-harness.mjs",
);
const context = {
  cloudflareAccountId: "0123456789abcdef0123456789abcdef",
  catalogueD1DatabaseId: "00000000-0000-0000-0000-000000000001",
  disposableD1DatabaseId: "00000000-0000-0000-0000-000000000002",
  githubRepositoryId: "repository-KeeprDigital-card-keepr",
};

test("credential mutation requires an explicit production environment before preflight or provider work", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500).end();
  });
  const port = await listen(server);
  t.after(() => server.close());
  const directory = mkdtempSync(join(tmpdir(), "keepr-environment-"));
  const log = join(directory, "calls.jsonl");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const oldSecret = "old-explicit-environment";
  const replacementSecret = "replacement-explicit-environment";
  const base = {
    action: "install",
    rotationId: "credrot_explicit_environment",
    credentialClass: "api_bearer_key",
    expectedGeneration: 0,
    oldFingerprint: fingerprint(oldSecret),
    replacementFingerprint: fingerprint(replacementSecret),
    idempotencyKey: "explicit-environment-001",
    confirm: "never-valid",
  };
  const secrets = {
    administration_key: "explicit-environment-admin",
    management_credential: "explicit-environment-management",
    old_secret: oldSecret,
    replacement_secret: replacementSecret,
  };
  const omitted = await runCli(
    mutationArguments({ ...base, environment: null }),
    environment(port, log),
    secrets,
  );
  const nonProduction = await runCli(
    mutationArguments({ ...base, environment: "staging" }),
    environment(port, log),
    secrets,
  );
  assert.equal(omitted.code, 2);
  assert.equal(nonProduction.code, 2);
  assert.match(nonProduction.stdout, /production_target_required/);
  assert.equal(requests, 0);
  assert.equal(existsSync(log), false);
});

test("rejected durable preflight causes zero owning-provider calls", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "keepr-boundary-ordering-"),
  );
  const log = join(directory, "calls.jsonl");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/credential-rotation-plans");
    response.writeHead(409, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        code: "recovery_in_progress",
        detail: "Credential mutation is blocked during recovery.",
      }),
    );
  });
  const port = await listen(server);
  t.after(() => server.close());
  const oldSecret = "old-api-ordering-secret";
  const replacementSecret = "replacement-api-ordering-secret";
  const result = await runCli(
    mutationArguments({
      action: "install",
      rotationId: "credrot_ordering",
      credentialClass: "api_bearer_key",
      expectedGeneration: 0,
      oldFingerprint: fingerprint(oldSecret),
      replacementFingerprint: fingerprint(replacementSecret),
      idempotencyKey: "plan-ordering-001",
      confirm: "cannot-be-valid",
    }),
    environment(port, log),
    {
      administration_key: "administration-ordering-secret",
      old_secret: oldSecret,
      replacement_secret: replacementSecret,
      management_credential: "separate-ordering-management-token",
    },
  );

  assert.equal(result.code, 7);
  assert.equal(existsSync(log), false);
  assert.match(result.stdout, /recovery_in_progress/);
});

test("a stale atomic execution claim causes zero owning-provider calls", async (t) => {
  const oldSecret = "old-stale-claim-secret";
  const replacementSecret = "replacement-stale-claim-secret";
  const planId = "credplan_stale_claim";
  const planDigest = "9".repeat(64);
  let reservedBody;
  const server = createServer(async (request, response) => {
    let text = "";
    request.setEncoding("utf8");
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    if (request.url === "/v1/credential-rotation-plans") {
      reservedBody = body;
      response.writeHead(201, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          planDocument(body, {
            id: planId,
            digest: planDigest,
            permission: "workers-secret:api-traffic",
          }),
        ),
      );
      return;
    }
    response.writeHead(409, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        code: "current_revision_mismatch",
        detail: "The claim snapshot is stale.",
      }),
    );
  });
  const port = await listen(server);
  t.after(() => server.close());
  const directory = mkdtempSync(join(tmpdir(), "keepr-stale-claim-"));
  const log = join(directory, "calls.jsonl");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const body = {
    action: "install",
    rotation_id: "credrot_stale_claim",
    credential_class: "api_bearer_key",
    idempotency_key: "stale-claim-001",
    expected_state_generation: 0,
    old_fingerprint: fingerprint(oldSecret),
    replacement_fingerprint: fingerprint(replacementSecret),
  };
  const plan = planDocument(body, {
    id: planId,
    digest: planDigest,
    permission: "workers-secret:api-traffic",
  });
  const result = await runCli(
    mutationArguments({
      action: "install",
      rotationId: body.rotation_id,
      credentialClass: body.credential_class,
      expectedGeneration: 0,
      oldFingerprint: body.old_fingerprint,
      replacementFingerprint: body.replacement_fingerprint,
      idempotencyKey: body.idempotency_key,
      confirm: confirmationText(plan),
    }),
    environment(port, log),
    {
      administration_key: "stale-claim-admin",
      management_credential: "stale-claim-management",
      old_secret: oldSecret,
      replacement_secret: replacementSecret,
    },
  );
  assert.equal(reservedBody.expected_catalogue_revision_id, "catrev_spine_000");
  assert.equal(result.code, 7);
  assert.match(result.stdout, /current_revision_mismatch/);
  assert.equal(existsSync(log), false);
});

test("an initial provider failure releases the bounded mutation claim without finalizing", async (t) => {
  const oldSecret = "old-release-claim-secret";
  const replacementSecret = "replacement-release-claim-secret";
  const planId = "credplan_release_claim";
  const planDigest = "8".repeat(64);
  const requests = [];
  let reservedBody;
  const server = createServer(async (request, response) => {
    let text = "";
    request.setEncoding("utf8");
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push(request.url);
    if (request.url === "/v1/credential-rotation-plans") {
      reservedBody = body;
      response.writeHead(201, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          planDocument(body, {
            id: planId,
            digest: planDigest,
            permission: "workers-secret:api-traffic",
          }),
        ),
      );
      return;
    }
    const document = planDocument(reservedBody, {
      id: planId,
      digest: planDigest,
      permission: "workers-secret:api-traffic",
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        request.url.endsWith("/execution")
          ? {
              ...document,
              status: "executing",
              execution_attempt: 1,
              execution_mode: "mutation",
            }
          : document,
      ),
    );
  });
  const port = await listen(server);
  t.after(() => server.close());
  const directory = mkdtempSync(join(tmpdir(), "keepr-release-claim-"));
  const log = join(directory, "calls.jsonl");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const body = {
    action: "install",
    rotation_id: "credrot_release_claim",
    credential_class: "api_bearer_key",
    idempotency_key: "release-claim-001",
    expected_state_generation: 0,
    old_fingerprint: fingerprint(oldSecret),
    replacement_fingerprint: fingerprint(replacementSecret),
  };
  const plan = planDocument(body, {
    id: planId,
    digest: planDigest,
    permission: "workers-secret:api-traffic",
  });
  const result = await runCli(
    mutationArguments({
      action: body.action,
      rotationId: body.rotation_id,
      credentialClass: body.credential_class,
      expectedGeneration: 0,
      oldFingerprint: body.old_fingerprint,
      replacementFingerprint: body.replacement_fingerprint,
      idempotencyKey: body.idempotency_key,
      confirm: confirmationText(plan),
    }),
    {
      ...environment(port, log),
      KEEPR_TEST_BOUNDARY_FAIL: "1",
    },
    {
      administration_key: "release-claim-admin",
      management_credential: "release-claim-management",
      old_secret: oldSecret,
      replacement_secret: replacementSecret,
    },
  );
  assert.equal(result.code, 9);
  assert.deepEqual(requests, [
    "/v1/credential-rotation-plans",
    `/v1/credential-rotation-plans/${planId}/execution`,
    `/v1/credential-rotation-plans/${planId}/execution-failure`,
  ]);
  assert.equal(
    readFileSync(log, "utf8").trim().split("\n").length,
    1,
  );
});

test("plan digest is printed and fully bound before provider installation and finalization", async (t) => {
  const oldSecret = "old-api-plan-secret";
  const replacementSecret = "replacement-api-plan-secret";
  const administrationKey = "administration-plan-secret";
  const oldFingerprint = fingerprint(oldSecret);
  const replacementFingerprint = fingerprint(replacementSecret);
  const planDigest = "1".repeat(64);
  const planId = "credplan_cli_api_001";
  const requests = [];
  let reservedBody;
  const server = createServer(async (request, response) => {
    let text = "";
    request.setEncoding("utf8");
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push({ url: request.url, body });
    if (request.url === "/v1/credential-rotation-plans") {
      reservedBody = body;
    }
    response.writeHead(
      request.url === "/v1/credential-rotation-plans" ? 201 : 200,
      { "content-type": "application/json" },
    );
    response.end(
      JSON.stringify(
        request.url === "/v1/credential-rotation-plans"
          ? planDocument(body, {
              id: planId,
              digest: planDigest,
              permission: "workers-secret:api-traffic",
            })
          : request.url?.endsWith("/execution")
            ? {
                ...planDocument(reservedBody, {
                  id: planId,
                  digest: planDigest,
                  permission: "workers-secret:api-traffic",
                }),
                status: "executing",
                execution_attempt: 1,
                execution_mode: "mutation",
              }
          : rotationDocument(
              body,
              "credrot_cli_api",
              "api_bearer_key",
              oldFingerprint,
              replacementFingerprint,
              "replacement_installed",
            ),
      ),
    );
  });
  const port = await listen(server);
  t.after(() => server.close());
  const directory = mkdtempSync(join(tmpdir(), "keepr-boundary-plan-"));
  const log = join(directory, "calls.jsonl");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const base = {
    action: "install",
    rotationId: "credrot_cli_api",
    credentialClass: "api_bearer_key",
    expectedGeneration: 0,
    oldFingerprint,
    replacementFingerprint,
    idempotencyKey: "plan-cli-api-001",
  };
  const first = await runCli(
    mutationArguments({ ...base, confirm: "first-pass" }),
    environment(port, log),
    {
      administration_key: administrationKey,
      old_secret: oldSecret,
      replacement_secret: replacementSecret,
      management_credential: "separate-plan-management-token",
    },
  );
  assert.equal(first.code, 2);
  assert.equal(existsSync(log), false);
  const confirmation = confirmationText({
    ...planDocument(
      {
        action: base.action,
        rotation_id: base.rotationId,
        credential_class: base.credentialClass,
        idempotency_key: base.idempotencyKey,
        old_fingerprint: oldFingerprint,
        replacement_fingerprint: replacementFingerprint,
      },
      {
        id: planId,
        digest: planDigest,
        permission: "workers-secret:api-traffic",
      },
    ),
  });
  assert.ok(first.stdout.includes(planDigest));
  assert.ok(first.stdout.includes("workers-secret:api-traffic"));
  assert.ok(
    first.stdout.includes(
      "wrangler:apps/api/wrangler.jsonc:API_BEARER_KEY_REPLACEMENT",
    ),
  );

  const second = await runCli(
    mutationArguments({ ...base, confirm: confirmation }),
    environment(port, log),
    {
      administration_key: administrationKey,
      old_secret: oldSecret,
      replacement_secret: replacementSecret,
      management_credential: "separate-plan-management-token",
    },
  );
  assert.equal(second.code, 0);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
  assert.deepEqual(
    requests.map((entry) => entry.url),
    [
      "/v1/credential-rotation-plans",
      "/v1/credential-rotation-plans",
      `/v1/credential-rotation-plans/${planId}/execution`,
      `/v1/credential-rotation-plans/${planId}/finalization`,
    ],
  );
  for (const entry of requests) {
    const serialized = JSON.stringify(entry.body);
    assert.equal(serialized.includes(oldSecret), false);
    assert.equal(serialized.includes(replacementSecret), false);
    assert.equal(serialized.includes(administrationKey), false);
  }
});

test("single-holder verify and revoke send no rotated plaintext and carry management identity separately", async (t) => {
  const oldSecret = "old-export-provider-token";
  const replacementSecret = "replacement-export-provider-token";
  const managementCredential = "separate-provider-management-token";
  const administrationKey = "admin-export-secret";
  const oldFingerprint = fingerprint(oldSecret);
  const replacementFingerprint = fingerprint(replacementSecret);
  const requests = [];
  let generation = 0;
  const reserved = new Map();
  const server = createServer(async (request, response) => {
    let text = "";
    request.setEncoding("utf8");
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push({ url: request.url, body });
    if (request.url === "/v1/credential-rotation-plans") {
      const action = body.action;
      reserved.set(`credplan_export_${action}`, body);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          planDocument(body, {
            id: `credplan_export_${action}`,
            digest: String(generation + 2).repeat(64),
            permission: "D1 Read",
          }),
        ),
      );
      return;
    }
    if (request.url?.endsWith("/execution")) {
      const planId = request.url.split("/").at(-2);
      const planBody = reserved.get(planId);
      const action = planId.slice("credplan_export_".length);
      response.writeHead(200, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          ...planDocument(planBody, {
            id: planId,
            digest: String(generation + 2).repeat(64),
            permission: "D1 Read",
          }),
          action,
          status: "executing",
          execution_attempt: 1,
          execution_mode: "mutation",
        }),
      );
      return;
    }
    const state =
      generation === 0
        ? "replacement_installed"
        : generation === 1
          ? "replacement_verified"
          : "old_revoked";
    generation += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        rotationDocument(
          body,
          "credrot_export",
          "d1_export_token",
          oldFingerprint,
          replacementFingerprint,
          state,
        ),
      ),
    );
  });
  const port = await listen(server);
  t.after(() => server.close());
  const directory = mkdtempSync(
    join(tmpdir(), "keepr-boundary-lifecycle-"),
  );
  const log = join(directory, "calls.jsonl");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const action of ["install", "verify", "revoke"]) {
    const plan = planDocument(
      {
        action,
        rotation_id: "credrot_export",
        credential_class: "d1_export_token",
        idempotency_key: `${action}-export-001`,
        old_fingerprint: oldFingerprint,
        replacement_fingerprint: replacementFingerprint,
        expected_state_generation: generation,
      },
      {
        id: `credplan_export_${action}`,
        digest: String(generation + 2).repeat(64),
        permission: "D1 Read",
      },
    );
    const result = await runCli(
      mutationArguments({
        action,
        rotationId: "credrot_export",
        credentialClass: "d1_export_token",
        expectedGeneration: generation,
        oldFingerprint,
        replacementFingerprint,
        idempotencyKey: `${action}-export-001`,
        confirm: confirmationText(plan),
        oldIssuerCredentialId: "cf-token:old-export-id",
        replacementIssuerCredentialId:
          "cf-token:replacement-export-id",
        managementCredentialId: "cf-token:management-id",
      }),
      environment(port, log),
      {
        administration_key: administrationKey,
        management_credential: managementCredential,
        ...(action === "install"
          ? {
              old_secret: oldSecret,
              replacement_secret: replacementSecret,
            }
          : {}),
      },
    );
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }

  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
  for (const entry of requests) {
    const serialized = JSON.stringify(entry.body);
    assert.equal(serialized.includes(oldSecret), false);
    assert.equal(serialized.includes(replacementSecret), false);
    assert.equal(serialized.includes(managementCredential), false);
  }
});

function mutationArguments(input) {
  return [
    "credential",
    input.action,
    "--rotation-id",
    input.rotationId,
    "--credential-class",
    input.credentialClass,
    ...(input.environment === null
      ? []
      : ["--environment", input.environment ?? "production"]),
    "--cloudflare-account-id",
    context.cloudflareAccountId,
    "--catalogue-d1-database-id",
    context.catalogueD1DatabaseId,
    "--disposable-d1-database-id",
    context.disposableD1DatabaseId,
    "--github-repository-id",
    context.githubRepositoryId,
    "--expected-catalogue-revision",
    "catrev_spine_000",
    "--expected-state-generation",
    String(input.expectedGeneration),
    "--expected-old-fingerprint",
    input.oldFingerprint,
    "--expected-replacement-fingerprint",
    input.replacementFingerprint,
    "--old-issuer-credential-id",
    input.oldIssuerCredentialId ?? "worker-secret:API_BEARER_KEY",
    "--replacement-issuer-credential-id",
    input.replacementIssuerCredentialId ??
      "worker-secret:API_BEARER_KEY_REPLACEMENT",
    "--management-credential-id",
    input.managementCredentialId ?? "cloudflare-operator:acceptance",
    "--idempotency-key",
    input.idempotencyKey,
    "--secrets-stdin-fd",
    "0",
    "--confirm",
    input.confirm,
    "--yes",
    "--json",
  ];
}

function planDocument(body, options) {
  const identity = identityFor(body.credential_class);
  return {
    contract: "card-keepr-credential-rotation-plan@1",
    id: options.id,
    action: body.action,
    rotation_id: body.rotation_id,
    credential_class: body.credential_class,
    environment: "production",
    cloudflare_account_id: context.cloudflareAccountId,
    resource_identity: identity.resource,
    owning_boundary: identity.boundary,
    verification_target: identity.target,
    required_permission: options.permission,
    consumer_installation_identity:
      body.credential_class === "api_bearer_key"
        ? "wrangler:apps/api/wrangler.jsonc:API_BEARER_KEY_REPLACEMENT"
        : "wrangler:apps/ingestion/wrangler.jsonc:D1_EXPORT_TOKEN_REPLACEMENT",
    expected_catalogue_revision_id: "catrev_spine_000",
    expected_state_generation: body.expected_state_generation ?? 0,
    expected_rotation_state: null,
    old_fingerprint: body.old_fingerprint,
    replacement_fingerprint: body.replacement_fingerprint,
    old_issuer_credential_id: body.old_issuer_credential_id,
    replacement_issuer_credential_id:
      body.replacement_issuer_credential_id,
    management_credential_id: body.management_credential_id,
    idempotency_key: body.idempotency_key,
    plan_nonce: "a".repeat(64),
    plan_digest: options.digest,
    status: "reserved",
    execution_attempt: 0,
    execution_mode: null,
    execution_started_at: null,
    execution_expires_at: null,
    created_at: "2026-07-29T00:00:00.000Z",
    expires_at: "2026-07-29T00:05:00.000Z",
  };
}

function identityFor(credentialClass) {
  if (credentialClass === "api_bearer_key") {
    const prefix =
      `cloudflare-account:${context.cloudflareAccountId}:worker:card-keepr-api`;
    return {
      resource: prefix,
      boundary: "api_worker",
      target: `${prefix}:health`,
    };
  }
  const prefix =
    `cloudflare-account:${context.cloudflareAccountId}:d1:${context.catalogueD1DatabaseId}`;
  return {
    resource: prefix,
    boundary: "d1_export_operation",
    target: `${prefix}:export-schema`,
  };
}

function confirmationText(plan) {
  return [
    plan.action,
    plan.rotation_id,
    plan.credential_class,
    plan.environment,
    plan.cloudflare_account_id,
    plan.resource_identity,
    plan.owning_boundary,
    plan.expected_catalogue_revision_id,
    plan.expected_state_generation,
    plan.old_fingerprint,
    plan.replacement_fingerprint,
    plan.verification_target,
    plan.required_permission,
    plan.consumer_installation_identity,
    plan.plan_digest,
    plan.idempotency_key,
    plan.credential_class === "d1_export_token"
      ? "cf-token:old-export-id"
      : "worker-secret:API_BEARER_KEY",
    plan.credential_class === "d1_export_token"
      ? "cf-token:replacement-export-id"
      : "worker-secret:API_BEARER_KEY_REPLACEMENT",
    plan.credential_class === "d1_export_token"
      ? "cf-token:management-id"
      : "cloudflare-operator:acceptance",
  ].join(":");
}

function rotationDocument(
  request,
  id,
  credentialClass,
  oldFingerprint,
  replacementFingerprint,
  state,
) {
  const identity = identityFor(credentialClass);
  return {
    contract: "card-keepr-credential-rotation@1",
    id,
    credential_class: credentialClass,
    state,
    environment: "production",
    resource_identity: identity.resource,
    owning_boundary: identity.boundary,
    verification_target: identity.target,
    old_fingerprint: oldFingerprint,
    replacement_fingerprint: replacementFingerprint,
    operation_code: "ok",
  };
}

function fingerprint(secret) {
  return `sha256:${createHash("sha256").update(secret).digest("hex")}`;
}

function environment(port, log) {
  return {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${port}`,
    KEEPR_TEST_BOUNDARY_LOG: log,
  };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("missing test server address");
  }
  return address.port;
}

async function runCli(arguments_, environment_, secrets) {
  const child = spawn(process.execPath, [cliHarness, ...arguments_], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment_ },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify(secrets));
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
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}
