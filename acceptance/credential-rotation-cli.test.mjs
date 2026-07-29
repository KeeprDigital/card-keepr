import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

test("credential installation is fully bound while secrets travel only through a stdin descriptor", async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    requests.push({
      authorization: request.headers.authorization,
      body: JSON.parse(body),
      method: request.method,
      url: request.url,
    });
    response.writeHead(201, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        contract: "card-keepr-credential-rotation@1",
        id: "credrot_cli_001",
        credential_class: "api_bearer_key",
        state: "replacement_installed",
        environment: "production",
        resource_identity: "worker:card-keepr-api",
        owning_boundary: "api_worker",
        old_fingerprint: "sha256:111111111111111111111111",
        replacement_fingerprint: "sha256:222222222222222222222222",
        installed_at: "2026-07-29T00:00:00.000Z",
        verified_at: null,
        old_revoked_at: null,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("missing test server address");
  }

  const oldSecret = "old-cli-secret";
  const replacementSecret = "replacement-cli-secret";
  const administrationKey = "administration-cli-secret";
  const arguments_ = [
    "credential",
    "install",
    "--rotation-id",
    "credrot_cli_001",
    "--credential-class",
    "api_bearer_key",
    "--environment",
    "production",
    "--resource",
    "worker:card-keepr-api",
    "--boundary",
    "api_worker",
    "--expected-old-fingerprint",
    "sha256:111111111111111111111111",
    "--secrets-stdin-fd",
    "0",
    "--confirm",
    "install:production:api_bearer_key:worker:card-keepr-api:credrot_cli_001",
    "--yes",
    "--json",
  ];
  const result = await runCli(
    arguments_,
    {
      KEEPR_INGESTION_URL: `http://127.0.0.1:${address.port}`,
    },
    JSON.stringify({
      administration_key: administrationKey,
      old_secret: oldSecret,
      replacement_secret: replacementSecret,
    }),
  );

  assert.equal(result.code, 0);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    authorization: `Bearer ${administrationKey}`,
    body: {
      rotation_id: "credrot_cli_001",
      credential_class: "api_bearer_key",
      environment: "production",
      resource_identity: "worker:card-keepr-api",
      owning_boundary: "api_worker",
      expected_old_fingerprint:
        "sha256:111111111111111111111111",
      old_secret: oldSecret,
      replacement_secret: replacementSecret,
    },
    method: "POST",
    url: "/v1/credential-rotations",
  });
  for (const secret of [
    oldSecret,
    replacementSecret,
    administrationKey,
  ]) {
    assert.equal(arguments_.join(" ").includes(secret), false);
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
  }
  assert.match(result.stdout, /"state":"replacement_installed"/);
});

test("credential mutations reject secret arguments and inexact confirmation", async () => {
  const exposedSecret = "must-not-enter-arguments";
  const result = await runCli(
    [
      "credential",
      "install",
      "--replacement-secret",
      exposedSecret,
      "--json",
    ],
    {},
    "",
  );

  assert.equal(result.code, 2);
  assert.equal(result.stdout.includes(exposedSecret), false);
  assert.equal(result.stderr.includes(exposedSecret), false);
  assert.match(result.stdout, /"code":"usage_error"/);
});

async function runCli(arguments_, environment, input) {
  const child = spawn(
    process.execPath,
    ["cli/keepr.mjs", ...arguments_],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end(input);
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
