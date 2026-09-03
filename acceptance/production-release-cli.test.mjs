import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const target = {
  cloudflare_account_id: "0123456789abcdef0123456789abcdef",
  worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
  d1_databases: [
    { name: "card-keepr-catalogue", id: "00000000-0000-0000-0000-000000000001" },
    { name: "card-keepr-disposable-verification", id: "00000000-0000-0000-0000-000000000002" },
  ],
  r2_buckets: ["card-keepr-evidence", "card-keepr-printing-images", "card-keepr-catalogue-exports", "card-keepr-backups"],
};

test("guarded CLI dispatches exact release bindings and never receives deployment credentials", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: body === "" ? null : JSON.parse(body) });
      if (request.url === "/v1/status") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(statusDocument()));
      } else if (request.url === "/v1/production-releases") {
        response.statusCode = 201;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          contract: "card-keepr-production-release-request@1",
          release_id: request.url && requests.at(-1).body.release_id,
          state: "requested",
          dispatch_digest: createHash("sha256").update(stableJson(requests.at(-1).body)).digest("hex"),
        }));
      } else {
        response.statusCode = 204;
        response.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const confirmation = {
    production_target: target,
    release_id: "release-47",
    expected_current_revision_id: "catrev-current",
    expected_head_sha: "a".repeat(40),
    expected_migration_level: 19,
    recovery_bookmark: "bookmark-current",
    recovery_backup_attempt_id: "backup-current",
    idempotency_key: "release-47-key",
  };
  const result = await runCli([
    "release", "production", "--release-id", "release-47",
    "--expected-current-revision", "catrev-current",
    "--expected-head-sha", "a".repeat(40), "--expected-migration-level", "19",
    "--idempotency-key", "release-47-key", "--environment", "production",
    "--confirm", JSON.stringify(confirmation), "--yes", "--json",
  ], base);
  assert.equal(result.code, 10, result.stderr);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, "/v1/status");
  assert.equal(requests[1].url, "/v1/production-releases");
  assert.match(requests[2].url, /production-release\.yml\/dispatches$/u);
  assert.equal(requests[2].body.inputs.operation, "production_release");
  assert.equal(requests[2].body.inputs.expected_current_revision, "catrev-current");
  assert.equal(requests[2].body.inputs.recovery_bookmark, "bookmark-current");
  assert.equal(requests[2].body.inputs.replacement_database_id, "none");
  assert.equal(requests[2].body.inputs.bootstrap, "false");
  assert.equal(requests[1].body.bootstrap, false);
  assert.equal(requests[2].body.inputs.dispatch_digest, createHash("sha256").update(stableJson(requests[1].body)).digest("hex"));
  assert.equal(JSON.stringify(requests[2]).includes("CLOUDFLARE"), false);
});

test("replacement handoff fails closed unless status proves the exact verified target", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(statusDocument()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = await runCli([
    "release", "production", "--release-id", "release-47",
    "--expected-current-revision", "catrev-current", "--expected-head-sha", "a".repeat(40),
    "--expected-migration-level", "19", "--idempotency-key", "release-47-key",
    "--environment", "production", "--replacement-recovery-id", "recovery-other",
    "--replacement-database-id", "replacement-other", "--retained-database-id", "retained-old",
    "--confirm", "not-reached", "--yes", "--json",
  ], base);
  assert.equal(result.code, 7);
  assert.equal(JSON.parse(result.stdout).code, "replacement_handoff_not_verified");
});

test("a Bootstrap Mode Production Release dispatches a relaxed envelope while the catalogue is provably empty", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body: body === "" ? null : JSON.parse(body) });
      // The ingestion base carries its public mount path (issue #123).
      if (request.url === "/ingest/v1/status") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(bootstrapStatusDocument()));
      } else if (request.url === "/ingest/v1/production-releases") {
        response.statusCode = 201;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          contract: "card-keepr-production-release-request@1",
          release_id: requests.at(-1).body.release_id,
          state: "requested",
          dispatch_digest: createHash("sha256").update(stableJson(requests.at(-1).body)).digest("hex"),
        }));
      } else {
        response.statusCode = 204;
        response.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const confirmation = {
    production_target: target,
    release_id: "release-0",
    expected_current_revision_id: "catrev_spine_000",
    expected_head_sha: "a".repeat(40),
    expected_migration_level: 1,
    bootstrap: true,
    idempotency_key: "release-0-key",
  };
  const unconfirmed = await runCli(bootstrapArguments("wrong"), base, `${base}/ingest/`);
  assert.equal(unconfirmed.code, 3);
  assert.equal(JSON.parse(unconfirmed.stdout).code, "confirmation_required");
  assert.ok(JSON.parse(unconfirmed.stdout).detail.includes(JSON.stringify(confirmation)));

  requests.length = 0;
  const result = await runCli(bootstrapArguments(JSON.stringify(confirmation)), base, `${base}/ingest/`);
  assert.equal(result.code, 10, result.stderr);
  assert.deepEqual(requests.map((item) => item.url), ["/ingest/v1/status", "/ingest/v1/production-releases", requests[2]?.url]);
  assert.match(requests[2].url, /production-release\.yml\/dispatches$/u);
  const plan = requests[1].body;
  assert.equal(plan.bootstrap, true);
  assert.equal(plan.expected_current_revision_id, "catrev_spine_000");
  assert.deepEqual(
    [plan.recovery_bookmark, plan.recovery_backup_attempt_id, plan.smoke_targets, plan.retained_revision_evidence, plan.replacement_handoff],
    [null, null, null, null, null],
  );
  const inputs = requests[2].body.inputs;
  assert.equal(inputs.operation, "production_release");
  assert.equal(inputs.bootstrap, "true");
  assert.equal(inputs.expected_current_revision, "catrev_spine_000");
  assert.equal(inputs.recovery_bookmark, "none");
  assert.equal(inputs.recovery_backup_attempt_id, "none");
  assert.equal(inputs.smoke_targets_json, "null");
  assert.equal(inputs.retained_revision_evidence_json, "null");
  assert.equal(inputs.replacement_database_id, "none");
  assert.deepEqual(JSON.parse(inputs.prepared_plan_json), JSON.parse(stableJson(plan)));
  assert.equal(inputs.dispatch_digest, createHash("sha256").update(stableJson(plan)).digest("hex"));
});

test("Bootstrap Mode is refused against a populated catalogue, and an ordinary Production Release is refused against an empty one", async (t) => {
  const requests = [];
  let document = statusDocument();
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(document));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const populated = await runCli(bootstrapArguments("not-reached"), base);
  assert.equal(populated.code, 7);
  assert.equal(JSON.parse(populated.stdout).code, "bootstrap_not_applicable");
  assert.deepEqual(requests, ["/v1/status"]);

  requests.length = 0;
  document = bootstrapStatusDocument();
  const ordinary = await runCli([
    "release", "production", "--release-id", "release-0",
    "--expected-current-revision", "catrev_spine_000", "--expected-head-sha", "a".repeat(40),
    "--expected-migration-level", "1", "--idempotency-key", "release-0-key",
    "--environment", "production", "--confirm", "not-reached", "--yes", "--json",
  ], base);
  assert.equal(ordinary.code, 7);
  assert.equal(JSON.parse(ordinary.stdout).code, "release_preflight_failed");
  assert.match(JSON.parse(ordinary.stdout).detail, /--bootstrap/u);
  assert.deepEqual(requests, ["/v1/status"]);
});

function bootstrapArguments(confirmation) {
  return [
    "release", "production", "--release-id", "release-0",
    "--expected-current-revision", "catrev_spine_000",
    "--expected-head-sha", "a".repeat(40), "--expected-migration-level", "1",
    "--idempotency-key", "release-0-key", "--environment", "production",
    "--bootstrap", "--confirm", confirmation, "--yes", "--json",
  ];
}

function bootstrapStatusDocument() {
  return {
    production_target: target,
    safe_state: { current_revision_id: "catrev_spine_000", mutation_safe: true, recovery_health: "healthy" },
    release_preflight: {
      bootstrap: true,
      schema_migration_level: 1,
      production_target_digest: createHash("sha256").update(stableJson(target)).digest("hex"),
      recovery_bookmark: null, recovery_backup_attempt_id: null,
      retention_ready: false, retained_revision_evidence: [], smoke_targets: null, replacement_handoff: null,
    },
  };
}

function statusDocument() {
  return {
    production_target: target,
    safe_state: { current_revision_id: "catrev-current", mutation_safe: true, recovery_health: "healthy" },
    release_preflight: {
      bootstrap: false,
      schema_migration_level: 19,
      production_target_digest: createHash("sha256").update(stableJson(target)).digest("hex"),
      recovery_bookmark: "bookmark-current", recovery_backup_attempt_id: "backup-current",
      retention_ready: true,
      retained_revision_evidence: ["catrev-current", "catrev-previous", "catrev-old"].map((revision_id, depth) => ({ revision_id, depth, export_verified: true, recovery_verified: true })),
      smoke_targets: smokeTargets(),
      replacement_handoff: null,
    },
  };
}

function smokeTargets() {
  const revisions = ["catrev-current", "catrev-previous", "catrev-old"].map((revision_id, index) => ({
    revision_id, card_id: `card-${index}`, printing_id: `printing-${index}`,
    search_query: `card-${index}`, card_cursor: `card-cursor-${index}`,
    search_cursor: `search-cursor-${index}`, printing_cursor: `printing-cursor-${index}`,
  }));
  return {
    revisions, printing_image_id: "image-1", legality_card_id: "card-0",
    legality_format: "standard", legality_region: "EN-OCEANIA",
    stale_cursor: Buffer.from(JSON.stringify({ revision_id: "catrev-archived" })).toString("base64"),
    stale_revision_id: "catrev-archived",
  };
}

function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }

function runCli(args, base, ingestionBase = base) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["cli/keepr.mjs", ...args], {
      env: { ...process.env, KEEPR_INGESTION_URL: ingestionBase, KEEPR_ADMINISTRATION_KEY: "admin-key", KEEPR_GITHUB_RELEASE_TOKEN: "github-token-at-least-twenty", KEEPR_GITHUB_API_URL: base, KEEPR_GITHUB_RELEASE_ACTOR: "keepr-release[bot]" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
