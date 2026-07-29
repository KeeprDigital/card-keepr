import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";

const executor = resolve(
  "acceptance/fixtures/credential-boundary-executor.mjs",
);

test("API credential installation proves the active old key and sends only safe owning-boundary evidence", async (t) => {
  const oldSecret = "old-api-cli-secret";
  const replacementSecret = "replacement-api-cli-secret";
  const administrationKey = "administration-cli-secret";
  const oldFingerprint = fingerprint(oldSecret);
  const replacementFingerprint = fingerprint(replacementSecret);
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      assert.equal(
        request.headers.authorization,
        `Bearer ${oldSecret}`,
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          contract: "card-keepr-runtime-health@1",
          runtime: "api",
          status: "ok",
        }),
      );
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    requests.push({
      authorization: request.headers.authorization,
      body: JSON.parse(body),
    });
    response.writeHead(201, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        rotationDocument(
          "credrot_cli_api",
          "api_bearer_key",
          oldFingerprint,
          replacementFingerprint,
        ),
      ),
    );
  });
  const port = await listen(server);
  t.after(() => server.close());

  const arguments_ = mutationArguments({
    action: "install",
    rotationId: "credrot_cli_api",
    credentialClass: "api_bearer_key",
    resource: "worker:card-keepr-api",
    boundary: "api_worker",
    verificationTarget: "worker-health:card-keepr-api",
    oldFingerprint,
    replacementFingerprint,
    idempotencyKey: "install-cli-api-001",
  });
  const result = await runCli(
    arguments_,
    {
      KEEPR_API_URL: `http://127.0.0.1:${port}`,
      KEEPR_INGESTION_URL: `http://127.0.0.1:${port}`,
      KEEPR_CREDENTIAL_BOUNDARY_EXECUTOR: executor,
    },
    {
      administration_key: administrationKey,
      old_secret: oldSecret,
      replacement_secret: replacementSecret,
    },
  );

  assert.equal(result.code, 0);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].authorization,
    `Bearer ${administrationKey}`,
  );
  const boundaryReceipt = requests[0].body.boundary_receipt;
  assert.match(boundaryReceipt, /^receipt:test:/);
  assert.deepEqual(requests[0].body, {
    credential_class: "api_bearer_key",
    environment: "production",
    resource_identity: "worker:card-keepr-api",
    owning_boundary: "api_worker",
    verification_target: "worker-health:card-keepr-api",
    boundary_receipt: boundaryReceipt,
    idempotency_key: "install-cli-api-001",
    rotation_id: "credrot_cli_api",
    old_fingerprint: oldFingerprint,
    replacement_fingerprint: replacementFingerprint,
  });
  assertSecretsAbsent(
    arguments_,
    result,
    oldSecret,
    replacementSecret,
    administrationKey,
  );
});

test("deployment token plaintext stays in its injected GitHub owning-boundary executor", async (t) => {
  const oldSecret = "old-deployment-token";
  const replacementSecret = "replacement-deployment-token";
  const administrationKey = "admin-for-deployment-rotation";
  const oldFingerprint = fingerprint(oldSecret);
  const replacementFingerprint = fingerprint(replacementSecret);
  let receivedBody;
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    receivedBody = JSON.parse(body);
    response.writeHead(201, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        rotationDocument(
          "credrot_cli_deploy",
          "github_deployment_token",
          oldFingerprint,
          replacementFingerprint,
        ),
      ),
    );
  });
  const port = await listen(server);
  t.after(() => server.close());
  const arguments_ = mutationArguments({
    action: "install",
    rotationId: "credrot_cli_deploy",
    credentialClass: "github_deployment_token",
    resource: "worker-release:card-keepr",
    boundary: "production_release_workflow",
    verificationTarget:
      "github:KeeprDigital/card-keepr:environment:production",
    oldFingerprint,
    replacementFingerprint,
    idempotencyKey: "install-cli-deploy-001",
  });
  const result = await runCli(
    arguments_,
    {
      KEEPR_INGESTION_URL: `http://127.0.0.1:${port}`,
      KEEPR_CREDENTIAL_BOUNDARY_EXECUTOR: executor,
    },
    {
      administration_key: administrationKey,
      old_secret: oldSecret,
      replacement_secret: replacementSecret,
    },
  );

  assert.equal(result.code, 0);
  assert.equal(JSON.stringify(receivedBody).includes(oldSecret), false);
  assert.equal(
    JSON.stringify(receivedBody).includes(replacementSecret),
    false,
  );
  assert.equal(receivedBody.credential_class, "github_deployment_token");
  assert.equal(
    receivedBody.verification_target,
    "github:KeeprDigital/card-keepr:environment:production",
  );
  assertSecretsAbsent(
    arguments_,
    result,
    oldSecret,
    replacementSecret,
    administrationKey,
  );
});

test("single-holder replacement is verified before the old owning-boundary credential is revoked", async (t) => {
  const oldSecret = "old-d1-export-token";
  const replacementSecret = "replacement-d1-export-token";
  const administrationKey = "admin-for-d1-export-rotation";
  const oldFingerprint = fingerprint(oldSecret);
  const replacementFingerprint = fingerprint(replacementSecret);
  const received = [];
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    received.push({
      url: request.url,
      body: JSON.parse(body),
    });
    const state = request.url?.endsWith("/verification")
      ? "replacement_verified"
      : request.url?.endsWith("/revocation")
        ? "old_revoked"
        : "replacement_installed";
    response.writeHead(
      request.url === "/v1/credential-rotations" ? 201 : 200,
      { "content-type": "application/json" },
    );
    response.end(
      JSON.stringify({
        ...rotationDocument(
          "credrot_cli_d1_export",
          "d1_export_token",
          oldFingerprint,
          replacementFingerprint,
        ),
        state,
      }),
    );
  });
  const port = await listen(server);
  t.after(() => server.close());
  const environment = {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${port}`,
    KEEPR_CREDENTIAL_BOUNDARY_EXECUTOR: executor,
  };
  const identity = {
    rotationId: "credrot_cli_d1_export",
    credentialClass: "d1_export_token",
    resource: "d1:card-keepr-catalogue",
    boundary: "d1_export_operation",
    verificationTarget:
      "cloudflare:d1:card-keepr-catalogue:export",
    oldFingerprint,
    replacementFingerprint,
  };

  const installed = await runCli(
    mutationArguments({
      action: "install",
      ...identity,
      idempotencyKey: "install-d1-export-001",
    }),
    environment,
    {
      administration_key: administrationKey,
      old_secret: oldSecret,
      replacement_secret: replacementSecret,
    },
  );
  const verified = await runCli(
    mutationArguments({
      action: "verify",
      ...identity,
      idempotencyKey: "verify-d1-export-001",
    }),
    environment,
    {
      administration_key: administrationKey,
      replacement_secret: replacementSecret,
    },
  );
  const revoked = await runCli(
    mutationArguments({
      action: "revoke",
      ...identity,
      idempotencyKey: "revoke-d1-export-001",
    }),
    environment,
    {
      administration_key: administrationKey,
      old_secret: oldSecret,
    },
  );

  assert.deepEqual(
    [installed.code, verified.code, revoked.code],
    [0, 0, 0],
  );
  assert.deepEqual(
    received.map((entry) => entry.url),
    [
      "/v1/credential-rotations",
      "/v1/credential-rotations/credrot_cli_d1_export/verification",
      "/v1/credential-rotations/credrot_cli_d1_export/revocation",
    ],
  );
  assert.match(received[0].body.boundary_receipt, /^receipt:test:/);
  assert.match(received[1].body.boundary_receipt, /^receipt:test:/);
  assert.match(received[2].body.boundary_receipt, /^receipt:test:/);
  for (const entry of received) {
    assert.equal(JSON.stringify(entry.body).includes(oldSecret), false);
    assert.equal(
      JSON.stringify(entry.body).includes(replacementSecret),
      false,
    );
  }
});

test("secret arguments and incomplete typed confirmation fail without echoing the value", async () => {
  const secret = "must-not-enter-arguments";
  const result = await runCli(
    ["credential", "install", "--replacement-secret", secret, "--json"],
    {},
    {},
  );
  assert.equal(result.code, 2);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
});

function mutationArguments(input) {
  const confirmation = [
    input.action,
    input.rotationId,
    input.credentialClass,
    "production",
    input.resource,
    input.boundary,
    input.verificationTarget,
    input.oldFingerprint,
    input.replacementFingerprint,
    input.idempotencyKey,
  ].join(":");
  return [
    "credential",
    input.action,
    "--rotation-id",
    input.rotationId,
    "--credential-class",
    input.credentialClass,
    "--environment",
    "production",
    "--resource",
    input.resource,
    "--boundary",
    input.boundary,
    "--verification-target",
    input.verificationTarget,
    "--expected-old-fingerprint",
    input.oldFingerprint,
    "--expected-replacement-fingerprint",
    input.replacementFingerprint,
    "--idempotency-key",
    input.idempotencyKey,
    "--secrets-stdin-fd",
    "0",
    "--confirm",
    confirmation,
    "--yes",
    "--json",
  ];
}

function rotationDocument(
  id,
  credentialClass,
  oldFingerprint,
  replacementFingerprint,
) {
  return {
    contract: "card-keepr-credential-rotation@1",
    id,
    credential_class: credentialClass,
    state: "replacement_installed",
    environment: "production",
    resource_identity:
      credentialClass === "api_bearer_key"
        ? "worker:card-keepr-api"
        : credentialClass === "d1_export_token"
          ? "d1:card-keepr-catalogue"
        : "worker-release:card-keepr",
    owning_boundary:
      credentialClass === "api_bearer_key"
        ? "api_worker"
        : credentialClass === "d1_export_token"
          ? "d1_export_operation"
        : "production_release_workflow",
    verification_target:
      credentialClass === "api_bearer_key"
        ? "worker-health:card-keepr-api"
        : credentialClass === "d1_export_token"
          ? "cloudflare:d1:card-keepr-catalogue:export"
        : "github:KeeprDigital/card-keepr:environment:production",
    old_fingerprint: oldFingerprint,
    replacement_fingerprint: replacementFingerprint,
    operation_code: "ok",
  };
}

function fingerprint(secret) {
  return `sha256:${createHash("sha256").update(secret).digest("hex")}`;
}

function assertSecretsAbsent(arguments_, result, ...secrets) {
  for (const secret of secrets) {
    assert.equal(arguments_.join(" ").includes(secret), false);
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
  }
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

async function runCli(arguments_, environment, secrets) {
  const child = spawn(process.execPath, ["cli/keepr.mjs", ...arguments_], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
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
