import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "./helpers/cli-http.mjs";
import { runCli } from "./helpers/acceptance-runtime.mjs";

// `source show` reads the compact summary by default, pages per-request
// detail behind --requests and keeps the complete document behind --full
// (#397). Its deadline is per command and a timeout names the endpoint.
const summary = {
  contract: "card-keepr-evidence-summary@1",
  id: "run_summary_cli",
  state: "collecting",
  selected_games: ["one-piece"],
  plan_origin: "production",
  source_coverage: [],
  idempotency_key: "summary-cli",
  linked_run_id: null,
  expected_current_revision_id: "catrev_summary_cli",
  started_at: "2026-09-01T00:00:00.000Z",
  collection_completed_at: null,
  failure_code: null,
  actions: ["pause"],
  acquisition: null,
  collection: {
    state: "collecting",
    requests: { total: 4003, by_state: { pending: 1000, observed: 3000, failed: 3 }, by_role: { detail: 4003 } },
    evidence: {
      snapshot_count: 3000,
      retained_byte_total: 900000,
      observation_set_count: 3000,
      fetch_attempt_count: 3010,
      retry_attempt_count: 7,
      failed_attempt_count: 7,
      revalidated_attempt_count: 0,
      skipped_request_count: 0,
      latest_failure: null,
      detail_limit: 200,
      snapshots_truncated: true,
      observation_sets_truncated: true,
      diagnostics_truncated: true,
    },
  },
  failures: {
    attempts_by_outcome: { http_failure: 5, network_failure: 2 },
    requests_by_failure_code: { source_image_not_found: 3 },
  },
  workflow: {
    parent_id: "evidence-run_summary_cli",
    child_ids: [],
    last_progress_at: "2026-09-01T03:00:00.000Z",
    current_attempt: null,
    attempts: [],
    attempt_count: 9,
    current_attempt_count: 2,
    attempts_truncated: false,
  },
  operational_diagnostics: {
    contract: "card-keepr-operational-diagnostics@1",
    references: { request_id: "request_summary_cli" },
  },
};
const requestPage = (after) => ({
  contract: "card-keepr-evidence-requests@1",
  ingestion_run_id: "run_summary_cli",
  page_size: 250,
  requests: [
    {
      sequence_number: after === undefined ? 1 : 251,
      request_id: after === undefined ? "one-piece-en:detail:first" : "one-piece-en:detail:last",
      role: "detail",
      state: after === undefined ? "observed" : "failed",
      hostname: "en.onepiece-cardgame.com",
      url: "https://en.onepiece-cardgame.com/cardlist/",
      discovered_from_request_id: null,
      retry_generation: 1,
      failure_code: after === undefined ? null : "source_image_not_found",
      source_snapshot_id: null,
      attempt_count: after === undefined ? 1 : 3,
      latest_attempt:
        after === undefined
          ? null
          : { attempt_number: 3, outcome: "http_failure", http_status: 404, completed_at: "2026-09-01T02:00:00.000Z" },
    },
  ],
  next_after: after === undefined ? "250" : null,
});

async function fixtureServer(t, handle) {
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    handle(request, response);
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolveClose) => server.close(resolveClose));
  });
  return {
    paths,
    environment: {
      KEEPR_INGESTION_URL: `http://127.0.0.1:${server.address().port}`,
      KEEPR_ADMINISTRATION_KEY: "cli-test-key",
    },
  };
}

test("source show reads the compact summary by default and pages requests behind --requests", async (t) => {
  const { paths, environment } = await fixtureServer(t, (request, response) => {
    response.setHeader("content-type", "application/json");
    const url = new URL(request.url, "http://fixture.invalid");
    if (url.pathname === "/v1/ingestion-runs/run_summary_cli/evidence/summary")
      return response.end(JSON.stringify(summary));
    if (url.pathname === "/v1/ingestion-runs/run_summary_cli/evidence/requests")
      return response.end(JSON.stringify(requestPage(url.searchParams.get("after") ?? undefined)));
    response.statusCode = 404;
    response.end(JSON.stringify({ code: "not_found" }));
  });

  const json = await runCli(["source", "show", "--run-id", "run_summary_cli", "--json"], environment);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), summary);

  const human = await runCli(["source", "show", "--run-id", "run_summary_cli"], environment);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /Ingestion Run run_summary_cli evidence: collecting/);
  assert.match(human.stdout, /3000 Source Snapshots \(900000 bytes\)/);
  assert.match(human.stdout, /Requests: 4003 \(pending 1000, observed 3000, failed 3; detail 4003\)/);
  assert.match(human.stdout, /Failed attempts: http_failure 5, network_failure 2/);
  assert.match(human.stdout, /Failed requests: source_image_not_found 3/);
  assert.match(human.stdout, /Per-request detail: source show --requests/);
  // The summary does not describe the full document's truncated lists.
  assert.doesNotMatch(human.stdout, /Detail lists bounded/);
  assert.doesNotMatch(human.stdout, /cli-test-key/);

  const first = await runCli(["source", "show", "--run-id", "run_summary_cli", "--requests", "--json"], environment);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), requestPage(undefined));
  const next = await runCli(
    ["source", "show", "--requests", "--run-id", "run_summary_cli", "--after", "250"],
    environment,
  );
  assert.equal(next.code, 0, next.stderr);
  assert.match(
    next.stdout,
    /251 one-piece-en:detail:last \(en\.onepiece-cardgame\.com, detail, failed, 3 attempts, latest http_failure \(HTTP 404\), failure source_image_not_found\)/,
  );
  assert.match(next.stdout, /End of requests/);

  assert.deepEqual(paths, [
    "/v1/ingestion-runs/run_summary_cli/evidence/summary",
    "/v1/ingestion-runs/run_summary_cli/evidence/summary",
    "/v1/ingestion-runs/run_summary_cli/evidence/requests",
    "/v1/ingestion-runs/run_summary_cli/evidence/requests?after=250",
  ]);

  // --after pages only the request listing; the views are exclusive.
  for (const arguments_ of [
    ["--run-id", "run_summary_cli", "--after", "250"],
    ["--run-id", "run_summary_cli", "--requests", "--full"],
    ["--run-id", "run_summary_cli", "--timeout-ms", "0"],
  ]) {
    const refused = await runCli(["source", "show", ...arguments_, "--json"], environment);
    assert.equal(refused.code, 2, refused.stdout);
  }
  assert.equal(paths.length, 4);
});

test("a source show timeout names the endpoint and elapsed time", async (t) => {
  const { environment } = await fixtureServer(t, () => {
    // Never answers: the CLI deadline must end the request.
  });
  const started = performance.now();
  const flagged = await runCli(
    ["source", "show", "--run-id", "run_slow_cli", "--timeout-ms", "300", "--json"],
    environment,
  );
  assert.equal(flagged.code, 9, flagged.stdout);
  const problem = JSON.parse(flagged.stdout);
  assert.equal(problem.code, "runtime_timeout");
  assert.match(
    problem.detail,
    /^ingestion runtime did not answer GET \/v1\/ingestion-runs\/run_slow_cli\/evidence\/summary within 300 ms \(elapsed \d+ ms\)/,
  );
  assert.ok(performance.now() - started < 30_000);

  const configured = await runCli(["source", "show", "--run-id", "run_slow_cli", "--full"], {
    ...environment,
    KEEPR_TIMEOUT_MS: "200",
  });
  assert.equal(configured.code, 9);
  assert.match(configured.stderr, /GET \/v1\/ingestion-runs\/run_slow_cli\/evidence within 200 ms/);
});
