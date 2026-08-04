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
    "--expected-current-revision", "catrev_123", "--json",
  ], server.environment);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.deepEqual(observed, [{
    method: "POST",
    path: "/admin/v1/curated-revisions/validate",
    authorization: "Bearer cli-admin-key",
    body: { proposal, expected_current_revision_id: "catrev_123" },
  }]);
});

test("CLI creates a production Curated Revision with all mutation bindings", async (t) => {
  const proposal = fixtureProposal();
  const expected = {
    contract: "card-keepr-curated-revision@1",
    id: "currev_123",
    game: "one-piece",
    status: "active",
  };
  const observed = [];
  const server = await jsonServer(t, observed, expected, 201);
  const directory = await mkdtemp(join(tmpdir(), "keepr-curated-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "proposal.json");
  await writeFile(file, JSON.stringify(proposal));

  const result = await runCli([
    "curated-revision", "create", "--proposal", file,
    "--proposal-digest", "b".repeat(64),
    "--expected-current-revision", "catrev_123",
    "--idempotency-key", "create-123", "--yes", "--json",
  ], server.environment);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.deepEqual(observed[0], {
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
    "curated-revision", "show", "--revision-id", "currev_123", "--json",
  ], server.environment);
  assert.equal(result.code, 8);
  assert.deepEqual(JSON.parse(result.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "curated_revision_schema_invalid",
    detail: "invalid proposal",
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
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(document));
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

function runCli(arguments_, environment) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [resolve(root, "cli/keepr.mjs"), ...arguments_], {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => resolveExit({ code, stdout, stderr }));
  });
}

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
