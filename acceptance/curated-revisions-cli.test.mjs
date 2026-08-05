import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("CLI validates a proposal file against an explicit Catalogue Revision", async (t) => {
  const proposal = fixtureProposal();
  const expected = {
    contract: "card-keepr-curated-revision-validation@1",
    valid: true,
    proposal_digest: "b".repeat(64),
  };
  const observed = [];
  const server = await jsonServer(t, observed, expected);
  const directory = await mkdtemp(join(tmpdir(), "keepr-curated-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "proposal.json");
  await writeFile(file, JSON.stringify(proposal));

  const result = await runCli([
    "curated-revision", "validate", "--proposal", file,
    "--expected-current-revision", "catrev_123",
    "--secrets-stdin-fd", "3", "--json",
  ], server.environment, { administration_key: "cli-admin-key" });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.deepEqual(observed, [{
    method: "POST",
    path: "/admin/v1/curated-revisions/validate",
    authorization: "Bearer cli-admin-key",
    body: { proposal, catalogue_revision_id: "catrev_123" },
  }]);
});

test("CLI creates a production Curated Revision with all mutation bindings", async (t) => {
  const proposal = fixtureProposal();
  const expected = {
    operation_id: "curop_123",
    curated_revision_id: "currev_123",
    status: "active",
    event_version: 1,
    content_digest: "b".repeat(64),
    current_catalogue_revision_id: "catrev_123",
    code: "curated_revision_created",
  };
  const observed = [];
  const server = await jsonServer(t, observed, expected, 201);
  const directory = await mkdtemp(join(tmpdir(), "keepr-curated-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "proposal.json");
  await writeFile(file, JSON.stringify(proposal));

  const confirmation = JSON.stringify({
    production_target: productionTarget,
    operation: "create",
    current_catalogue_revision_id: "catrev_123",
    affected_supported_game: "one-piece",
    target: proposal.target,
    content_digest: "b".repeat(64),
    idempotency_key: "create-123",
  });
  const result = await runCli([
    "curated-revision", "create", "--proposal", file,
    "--proposal-digest", "b".repeat(64),
    "--expected-current-revision", "catrev_123",
    "--idempotency-key", "create-123", "--environment", "production",
    "--confirm", confirmation, "--secrets-stdin-fd", "3", "--yes", "--json",
  ], server.environment, { administration_key: "cli-admin-key" });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.deepEqual(observed[0], {
    method: "GET",
    path: "/v1/status",
    authorization: "Bearer cli-admin-key",
  });
  assert.deepEqual(observed[1], {
    method: "POST",
    path: "/admin/v1/curated-revisions",
    authorization: "Bearer cli-admin-key",
    body: {
      environment: "production",
      expected_current_revision_id: "catrev_123",
      proposal,
      proposal_digest: "b".repeat(64),
      idempotency_key: "create-123",
    },
  });
});

test("CLI list/show have stable query paths and validation failures exit 8", async (t) => {
  const observed = [];
  const server = await jsonServer(t, observed, {
    code: "curated_revision_schema_invalid",
    detail: "invalid proposal",
  }, 422);
  const result = await runCli([
    "curated-revision", "show", "--revision-id", "currev_123",
    "--secrets-stdin-fd", "3", "--json",
  ], server.environment, { administration_key: "cli-admin-key" });
  assert.equal(result.code, 8);
  assert.deepEqual(JSON.parse(result.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "curated_revision_schema_invalid",
    detail: "invalid proposal",
  });
});

test("CLI human list renders the Supported Game from immutable content", async (t) => {
  const observed = [];
  const server = await jsonServer(t, observed, {
    items: [{
      id: "currev_listed",
      content: { game: "digimon" },
      status: "active",
      content_digest: "a".repeat(64),
    }],
    next_cursor: null,
  });
  const result = await runCli([
    "curated-revision", "list", "--secrets-stdin-fd", "3",
  ], server.environment, { administration_key: "cli-admin-key" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.stdout,
    `currev_listed digimon active ${"a".repeat(64)}\n`,
  );
});

test("CLI retirement resolves the exact revision and production identities before mutation", async (t) => {
  const observed = [];
  const revision = {
    id: "currev_123",
    content: { game: "one-piece", target: fixtureProposal().target },
    content_digest: "d".repeat(64),
    event_version: 1,
    pending_conflict: null,
  };
  const resultDocument = {
    operation_id: "curop_retire",
    curated_revision_id: revision.id,
    status: "retired",
    event_version: 2,
    content_digest: revision.content_digest,
    current_catalogue_revision_id: "catrev_123",
    code: "curated_revision_retired",
  };
  const server = await jsonServer(t, observed, (request) =>
    request.method === "GET"
      ? { revision, events: [] }
      : resultDocument
  );
  const confirmation = JSON.stringify({
    production_target: productionTarget,
    operation: "retire",
    current_catalogue_revision_id: "catrev_123",
    curated_revision_id: revision.id,
    expected_event_version: 1,
    conflict_digest: null,
    idempotency_key: "retire-123",
    affected_supported_game: "one-piece",
    current_content_digest: revision.content_digest,
    target: revision.content.target,
    conflict_id: null,
  });
  const result = await runCli([
    "curated-revision", "retire",
    "--revision-id", revision.id,
    "--event-version", "1",
    "--rationale", "No longer required",
    "--expected-current-revision", "catrev_123",
    "--idempotency-key", "retire-123",
    "--environment", "production",
    "--confirm", confirmation,
    "--secrets-stdin-fd", "3",
    "--yes", "--json",
  ], server.environment, { administration_key: "cli-admin-key" });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), resultDocument);
  assert.deepEqual(observed.map(({ method, path }) => ({ method, path })), [
    { method: "GET", path: "/v1/status" },
    { method: "GET", path: "/admin/v1/curated-revisions/currev_123" },
    { method: "POST", path: "/admin/v1/curated-revisions/currev_123/retire" },
  ]);
  assert.equal(observed[2].authorization, "Bearer cli-admin-key");
  assert.deepEqual(observed[2].body, {
    environment: "production",
    expected_current_revision_id: "catrev_123",
    expected_event_version: 1,
    conflict_digest: null,
    rationale: "No longer required",
    idempotency_key: "retire-123",
  });
});

async function jsonServer(t, observed, document, status = 200) {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      observed.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        ...(body === "" ? {} : { body: JSON.parse(body) }),
      });
      const statusRequest = request.url === "/v1/status";
      response.statusCode = statusRequest ? 200 : status;
      response.setHeader("content-type", "application/json");
      const responseDocument = typeof document === "function"
        ? document(request)
        : document;
      response.end(JSON.stringify(statusRequest ? {
        safe_state: { current_revision_id: "catrev_123" },
        production_target: productionTarget,
      } : responseDocument));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  assert.equal(typeof address, "object");
  return {
    environment: {
      KEEPR_INGESTION_URL: `http://127.0.0.1:${address.port}`,
      KEEPR_ADMINISTRATION_KEY: "cli-admin-key",
    },
  };
}

function runCli(arguments_, environment, secrets) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [resolve(root, "cli/keepr.mjs"), ...arguments_], {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe", secrets === undefined ? "ignore" : "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    if (secrets !== undefined) child.stdio[3].end(JSON.stringify(secrets));
    child.once("exit", (code) => resolveExit({ code, stdout, stderr }));
  });
}

const productionTarget = {
  cloudflare_account_id: "a".repeat(32),
  worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
  d1_databases: [
    { name: "card-keepr-catalogue", id: "11111111-1111-4111-8111-111111111111" },
    { name: "card-keepr-disposable-verification", id: "22222222-2222-4222-8222-222222222222" },
  ],
  r2_buckets: [
    "card-keepr-evidence",
    "card-keepr-printing-images",
    "card-keepr-catalogue-exports",
    "card-keepr-backups",
  ],
};

function fixtureProposal() {
  return {
    game: "one-piece",
    target: { kind: "field", entity_type: "card", entity_id: "card_1", path: "/name" },
    assertion: { kind: "field", value: "Curated Name" },
    rationale: "Owner review",
    evidence: [{ kind: "owner_reference", uri: "https://owner.invalid/1", content_digest: "a".repeat(64) }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: "c".repeat(64),
    supersedes_revision_id: null,
  };
}
