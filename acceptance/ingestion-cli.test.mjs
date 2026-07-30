import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const run = {
  id: "run_cli_demo",
  state: "failed",
  progress: {
    completed_stages: ["planning", "collecting", "parsing"],
    current_stage: "failed",
  },
  warnings: [
    {
      code: "source_record_missing",
      detail: "An earlier observation was not present.",
    },
  ],
  failure_code: "source_unavailable",
  approval_history: [
    {
      action: "approved",
      approved_at: "2026-07-29T00:00:00.000Z",
    },
  ],
  publication_outcome: null,
  resulting_revision_id: "catrev_cli_demo",
  publication_cleanup: {
    state: "failed",
    failure_code: "publication_cleanup_failed",
  },
};

test("CLI lifecycle commands expose safe diagnostics and exact mutation requests", async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      path: request.url,
      body: body === "" ? null : JSON.parse(body),
    });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/status") {
      response.end(
        JSON.stringify({
          contract: "card-keepr-administration-status@1",
          safe_state: {
            current_revision_id: "catrev_cli_demo",
            recovery_health: "healthy",
            active_ingestion_run_id: null,
            mutation_safe: true,
          },
          active_ingestion_run: null,
          source_freshness: [
            {
              game: "one-piece",
              area: "cards-and-printings",
              checked_at: "2026-07-29T00:00:00.000Z",
              ingestion_run_id: "run_cli_demo",
            },
          ],
          diagnostics: {
            catalogue_revision_count: 1,
            catalogue_export_count: 1,
            catalogue_export_object_count: 12,
            orphaned_catalogue_export_object_count: 2,
            pending_publication_cleanup_count: 1,
          },
          recent_runs: [run],
        }),
      );
      return;
    }
    response.end(JSON.stringify(run));
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  t.after(
    () =>
      new Promise((resolveClose) => server.close(resolveClose)),
  );
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const environment = {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${address.port}`,
    KEEPR_ADMINISTRATION_KEY: "cli-test-key",
  };

  const status = await runCli(["status"], environment);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Catalogue Revision: catrev_cli_demo/);
  assert.match(status.stdout, /Mutation safe: yes/);
  assert.match(status.stdout, /export_objects: 12/);
  assert.match(status.stdout, /orphaned_export_objects: 2/);
  assert.match(status.stdout, /pending_publication_cleanups: 1/);
  assert.match(
    status.stdout,
    /one-piece\/cards-and-printings: 2026-07-29T00:00:00.000Z/,
  );

  const shown = await runCli(
    ["run", "show", "--run-id", "run_cli_demo"],
    environment,
  );
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /Progress: failed/);
  assert.match(shown.stdout, /Warning: source_record_missing/);
  assert.match(shown.stdout, /Failure: source_unavailable/);
  assert.match(
    shown.stdout,
    /Publication cleanup: failed \(publication_cleanup_failed\)/,
  );
  assert.match(shown.stdout, /Approval history: 1 decision/);
  assert.match(
    shown.stdout,
    /Resulting Catalogue Revision: catrev_cli_demo/,
  );

  const requestCountBeforeRemovedMutation = requests.length;
  const removedReconcile = await runCli(
    ["run", "reconcile", "--run-id", "run_cli_demo", "--json"],
    environment,
  );
  assert.equal(removedReconcile.code, 2);
  assert.match(removedReconcile.stdout, /usage_error/u);
  assert.equal(requests.length, requestCountBeforeRemovedMutation);

  const rejected = await runCli(
    [
      "run",
      "reject",
      "--run-id",
      "run_cli_demo",
      "--candidate-digest",
      "a".repeat(64),
      "--idempotency-key",
      "reject-cli-demo",
      "--yes",
      "--json",
    ],
    environment,
  );
  assert.equal(rejected.code, 0, rejected.stderr);

  const retried = await runCli(
    [
      "run",
      "retry",
      "--run-id",
      "run_cli_demo",
      "--idempotency-key",
      "retry-cli-demo",
      "--json",
    ],
    environment,
  );
  assert.equal(retried.code, 0, retried.stderr);
  const cleaned = await runCli(
    [
      "run",
      "cleanup",
      "--run-id",
      "run_cli_demo",
      "--idempotency-key",
      "cleanup-cli-demo",
      "--json",
    ],
    environment,
  );
  assert.equal(cleaned.code, 0, cleaned.stderr);
  assert.deepEqual(requests.slice(-3), [
    {
      method: "POST",
      path: "/v1/ingestion-runs/run_cli_demo/rejection",
      body: {
        candidate_digest: "a".repeat(64),
        idempotency_key: "reject-cli-demo",
      },
    },
    {
      method: "POST",
      path: "/v1/ingestion-runs/run_cli_demo/retry",
      body: {
        idempotency_key: "retry-cli-demo",
      },
    },
    {
      method: "POST",
      path:
        "/v1/ingestion-runs/run_cli_demo/publication-cleanup",
      body: {
        idempotency_key: "cleanup-cli-demo",
      },
    },
  ]);
});

test("CLI Card search uses the authenticated catalogue HTTP seam", async (t) => {
  let observed = null;
  const server = createServer((request, response) => {
    observed = {
      path: request.url,
      authorization: request.headers.authorization,
    };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      data: [{ id: "card_cli_erratum", name: "Éclair LÜFFY" }],
      meta: { catalogue_revision_id: "catrev_cli_erratum" },
      page: { limit: 25, next_cursor: null },
      links: { self: "/v1/cards?q=%C3%A9clair&limit=25" },
    }));
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  t.after(
    () => new Promise((resolveClose) => server.close(resolveClose)),
  );
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const result = await runCli(
    ["cards", "search", "--query", "éclair", "--limit", "25", "--json"],
    {
      KEEPR_API_URL: `http://127.0.0.1:${address.port}`,
      KEEPR_API_KEY: "cli-api-test-key",
    },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data[0].id, "card_cli_erratum");
  assert.deepEqual(observed, {
    path: "/v1/cards?q=%C3%A9clair&limit=25",
    authorization: "Bearer cli-api-test-key",
  });
});

function runCli(arguments_, environment) {
  return new Promise((resolveExit) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "cli/keepr.mjs"), ...arguments_],
      {
        cwd: root,
        env: {
          ...process.env,
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
    child.once("exit", (code) => {
      resolveExit({ code, stdout, stderr });
    });
  });
}
