import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const productionTarget = {
  cloudflare_account_id: "0123456789abcdef0123456789abcdef",
  worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
  d1_databases: [
    {
      name: "card-keepr-catalogue",
      id: "00000000-0000-0000-0000-000000000001",
    },
    {
      name: "card-keepr-disposable-verification",
      id: "00000000-0000-0000-0000-000000000002",
    },
  ],
  r2_buckets: [
    "card-keepr-evidence",
    "card-keepr-printing-images",
    "card-keepr-catalogue-exports",
    "card-keepr-backups",
  ],
};
const productionConfirmation = JSON.stringify(productionTarget);
const run = {
  id: "run_cli_demo",
  state: "failed",
  expected_current_revision_id: "catrev_cli_demo",
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

test("guarded reconciliation and bounded search repair are normative administration commands", async () => {
  const schema = JSON.parse(
    await readFile(
      resolve(
        root,
        "prototype/formalize-implementation-contracts/schemas/administration.schema.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    schema.$defs.ReconciliationCommandRequest.required,
    ["expected_current_revision_id", "idempotency_key"],
  );
  assert.equal(
    schema.$defs.ReconciliationCommandRequest.additionalProperties,
    false,
  );
  assert.deepEqual(
    schema.$defs.CatalogueSearchRepairCommandRequest.required,
    [
      "target_revision_id",
      "expected_current_revision_id",
      "idempotency_key",
    ],
  );
  assert.equal(
    schema.$defs.CatalogueSearchRepairCommandRequest.additionalProperties,
    false,
  );
  const contract = await readFile(
    resolve(
      root,
      "prototype/formalize-implementation-contracts/ADMINISTRATION.md",
    ),
    "utf8",
  );
  assert.match(contract, /never executes reconciliation inline/);
  assert.match(contract, /one resumable, byte-bounded repair step/);
});

test("CLI reconciliation requires explicit production selection and confirmation", async () => {
  const result = await runCli(
    [
      "run",
      "reconcile",
      "--run-id",
      "run_cli_demo",
      "--expected-current-revision",
      "catrev_cli_demo",
      "--idempotency-key",
      "reconcile-cli-target-check",
      "--environment",
      "staging",
      "--yes",
      "--json",
    ],
    {
      KEEPR_INGESTION_URL: "http://127.0.0.1:1",
      KEEPR_ADMINISTRATION_KEY: "cli-test-key",
    },
  );
  assert.equal(result.code, 2, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "production_target_required",
    detail: "Reconciliation requires --environment production.",
  });
});

test("CLI search repair requires explicit production selection and confirmation", async () => {
  const result = await runCli(
    [
      "catalogue",
      "search",
      "repair",
      "--target-revision",
      "catrev_cli_demo",
      "--expected-current-revision",
      "catrev_cli_demo",
      "--idempotency-key",
      "repair-cli-target-check",
      "--environment",
      "staging",
      "--yes",
      "--json",
    ],
    {
      KEEPR_INGESTION_URL: "http://127.0.0.1:1",
      KEEPR_ADMINISTRATION_KEY: "cli-test-key",
    },
  );
  assert.equal(result.code, 2, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "production_target_required",
    detail: "Card search repair requires --environment production.",
  });
});

test("CLI search repair exits 10 while the retained repair remains incomplete", async (t) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/status") {
      response.end(JSON.stringify({
        contract: "card-keepr-administration-status@1",
        production_target: productionTarget,
        safe_state: {
          current_revision_id: "catrev_cli_demo",
        },
        repairable_catalogue_revision_ids: ["catrev_cli_demo"],
      }));
      return;
    }
    response.end(JSON.stringify({
      contract: "card-keepr-card-search-repair@1",
      complete: false,
      processed_cards: 25,
      revisions_available: 0,
      maximum_bound_parameter_bytes: 65_536,
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
    [
      "catalogue",
      "search",
      "repair",
      "--target-revision",
      "catrev_cli_demo",
      "--expected-current-revision",
      "catrev_cli_demo",
      "--idempotency-key",
      "repair-cli-incomplete",
      "--environment",
      "production",
      "--confirm",
      productionConfirmation,
      "--yes",
      "--json",
    ],
    {
      KEEPR_INGESTION_URL: `http://127.0.0.1:${address.port}`,
      KEEPR_ADMINISTRATION_KEY: "cli-test-key",
    },
  );

  assert.equal(result.code, 10, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    contract: "card-keepr-card-search-repair@1",
    complete: false,
    processed_cards: 25,
    revisions_available: 0,
    maximum_bound_parameter_bytes: 65_536,
  });
});

test("CLI production mutation requires exact resolved Cloudflare target confirmation before POST", async (t) => {
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
      response.end(JSON.stringify({
        contract: "card-keepr-administration-status@1",
        production_target: productionTarget,
        safe_state: {
          current_revision_id: "catrev_cli_demo",
        },
        repairable_catalogue_revision_ids: [
          "catrev_cli_demo",
          "catrev_cli_previous",
          "catrev_cli_second_previous",
        ],
        recent_runs: [],
      }));
      return;
    }
    if (request.method === "GET") {
      response.end(JSON.stringify(run));
      return;
    }
    response.end(JSON.stringify({
      contract: "card-keepr-card-search-repair@1",
      complete: true,
      processed_cards: 1,
      revisions_available: 3,
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
  const environment = {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${address.port}`,
    KEEPR_ADMINISTRATION_KEY: "cli-test-key",
  };

  const unconfirmed = await runCli(
    [
      "run",
      "reconcile",
      "--run-id",
      "run_cli_demo",
      "--expected-current-revision",
      "catrev_cli_demo",
      "--idempotency-key",
      "reconcile-cli-unconfirmed",
      "--environment",
      "production",
      "--yes",
      "--json",
    ],
    environment,
  );
  assert.equal(
    unconfirmed.code,
    3,
    "declining exact production confirmation is a confirmation exit",
  );
  assert.deepEqual(JSON.parse(unconfirmed.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "confirmation_required",
    detail:
      `Resolved production target ${productionConfirmation}. ` +
      `Re-run with --confirm '${productionConfirmation}'.`,
  });
  assert.equal(
    requests.filter(({ method }) => method === "POST").length,
    0,
  );

  const wronglyConfirmed = await runCli(
    [
      "catalogue",
      "search",
      "repair",
      "--target-revision",
      "catrev_cli_second_previous",
      "--expected-current-revision",
      "catrev_cli_demo",
      "--idempotency-key",
      "repair-cli-wrong-confirmation",
      "--environment",
      "production",
      "--confirm",
      `${productionConfirmation}altered`,
      "--yes",
      "--json",
    ],
    environment,
  );
  assert.equal(
    wronglyConfirmed.code,
    3,
    "altering exact production confirmation is a confirmation exit",
  );
  assert.equal(
    JSON.parse(wronglyConfirmed.stdout).code,
    "confirmation_required",
  );
  assert.equal(
    requests.filter(({ method }) => method === "POST").length,
    0,
  );

  const confirmed = await runCli(
    [
      "catalogue",
      "search",
      "repair",
      "--target-revision",
      "catrev_cli_second_previous",
      "--expected-current-revision",
      "catrev_cli_demo",
      "--idempotency-key",
      "repair-cli-confirmed-target",
      "--environment",
      "production",
      "--confirm",
      productionConfirmation,
      "--yes",
      "--json",
    ],
    environment,
  );
  assert.equal(confirmed.code, 0, confirmed.stderr);
  assert.equal(
    requests.filter(({ method }) => method === "POST").length,
    1,
  );
  assert.deepEqual(requests.at(-1), {
    method: "POST",
    path: "/v1/catalogue-search-materialization/repair",
    body: {
      target_revision_id: "catrev_cli_second_previous",
      expected_current_revision_id: "catrev_cli_demo",
      idempotency_key: "repair-cli-confirmed-target",
    },
  });
});

test("CLI reconciliation reports an accepted non-terminal Workflow with exit 10", async (t) => {
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
      response.end(JSON.stringify({
        contract: "card-keepr-administration-status@1",
        production_target: productionTarget,
        safe_state: {
          current_revision_id: "catrev_cli_demo",
        },
        repairable_catalogue_revision_ids: [],
      }));
      return;
    }
    if (request.method === "GET") {
      response.end(JSON.stringify(run));
      return;
    }
    response.statusCode = 202;
    response.end(JSON.stringify({
      contract: "card-keepr-reconciliation-workflow@1",
      ingestion_run_id: "run_cli_demo",
      expected_current_revision_id: "catrev_cli_demo",
      idempotency_key: "reconcile-cli-running",
      workflow_instance_id: "reconcile-cli-running-instance",
      status: "running",
      output: null,
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
    [
      "run",
      "reconcile",
      "--run-id",
      "run_cli_demo",
      "--expected-current-revision",
      "catrev_cli_demo",
      "--idempotency-key",
      "reconcile-cli-running",
      "--environment",
      "production",
      "--confirm",
      productionConfirmation,
      "--yes",
      "--json",
    ],
    {
      KEEPR_INGESTION_URL: `http://127.0.0.1:${address.port}`,
      KEEPR_ADMINISTRATION_KEY: "cli-test-key",
    },
  );

  assert.equal(result.code, 10, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    contract: "card-keepr-reconciliation-workflow@1",
    ingestion_run_id: "run_cli_demo",
    expected_current_revision_id: "catrev_cli_demo",
    idempotency_key: "reconcile-cli-running",
    workflow_instance_id: "reconcile-cli-running-instance",
    status: "running",
    output: null,
  });
  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/v1/ingestion-runs/run_cli_demo",
      body: null,
    },
    {
      method: "GET",
      path: "/v1/status",
      body: null,
    },
    {
      method: "POST",
      path: "/v1/ingestion-runs/run_cli_demo/reconciliation",
      body: {
        expected_current_revision_id: "catrev_cli_demo",
        idempotency_key: "reconcile-cli-running",
      },
    },
  ]);
});

test("CLI reconciliation exits zero for a terminal Workflow returned by the initial POST", async (t) => {
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/status") {
      response.end(JSON.stringify({
        contract: "card-keepr-administration-status@1",
        production_target: productionTarget,
        safe_state: {
          current_revision_id: "catrev_cli_demo",
        },
        repairable_catalogue_revision_ids: [],
      }));
      return;
    }
    if (request.method === "GET") {
      response.end(JSON.stringify(run));
      return;
    }
    response.statusCode = 202;
    response.end(JSON.stringify({
      contract: "card-keepr-reconciliation-workflow@1",
      ingestion_run_id: "run_cli_demo",
      expected_current_revision_id: "catrev_cli_demo",
      idempotency_key: "reconcile-cli-terminal-on-create",
      workflow_instance_id: "reconcile-cli-terminal-on-create-instance",
      status: "complete",
      output: {
        contract: "card-keepr-card-printing-reconciliation@2",
        run_id: "run_cli_demo",
        state: "failed",
        publishable: false,
        cards: [],
        printings: [],
        errata: [],
        diagnostics: [],
        warnings: [],
      },
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
    [
      "run",
      "reconcile",
      "--run-id",
      "run_cli_demo",
      "--expected-current-revision",
      "catrev_cli_demo",
      "--idempotency-key",
      "reconcile-cli-terminal-on-create",
      "--environment",
      "production",
      "--confirm",
      productionConfirmation,
      "--yes",
      "--json",
    ],
    {
      KEEPR_INGESTION_URL: `http://127.0.0.1:${address.port}`,
      KEEPR_ADMINISTRATION_KEY: "cli-test-key",
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "complete");
});

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
          production_target: productionTarget,
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
          repairable_catalogue_revision_ids: ["catrev_cli_demo"],
          recent_runs: [run],
        }),
      );
      return;
    }
    if (request.url === "/v1/catalogue-search-materialization/repair") {
      response.end(
        JSON.stringify({
          contract: "card-keepr-card-search-repair@1",
          complete: true,
          processed_cards: 2,
          revisions_available: 2,
        }),
      );
      return;
    }
    if (
      request.url ===
      "/v1/ingestion-runs/run_cli_demo/collection/resume"
    ) {
      response.statusCode = 202;
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

  const reconciled = await runCli(
    [
      "run",
      "reconcile",
      "--run-id",
      "run_cli_demo",
      "--expected-current-revision",
      "catrev_cli_demo",
      "--idempotency-key",
      "reconcile-cli-demo",
      "--environment",
      "production",
      "--confirm",
      productionConfirmation,
      "--yes",
      "--json",
    ],
    environment,
  );
  assert.equal(reconciled.code, 0, reconciled.stderr);

  const repaired = await runCli(
    [
      "catalogue",
      "search",
      "repair",
      "--target-revision",
      "catrev_cli_demo",
      "--expected-current-revision",
      "catrev_cli_demo",
      "--idempotency-key",
      "repair-cli-demo",
      "--environment",
      "production",
      "--confirm",
      productionConfirmation,
      "--yes",
      "--json",
    ],
    environment,
  );
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.deepEqual(JSON.parse(repaired.stdout), {
    contract: "card-keepr-card-search-repair@1",
    complete: true,
    processed_cards: 2,
    revisions_available: 2,
  });

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
  const resumed = await runCli(
    [
      "source",
      "resume",
      "--run-id",
      "run_cli_demo",
      "--json",
    ],
    environment,
  );
  assert.equal(
    resumed.code,
    0,
    "non-Workflow administration requests retain their established exit code",
  );
  assert.deepEqual(requests.slice(-9), [
    {
      method: "GET",
      path: "/v1/ingestion-runs/run_cli_demo",
      body: null,
    },
    {
      method: "GET",
      path: "/v1/status",
      body: null,
    },
    {
      method: "POST",
      path: "/v1/ingestion-runs/run_cli_demo/reconciliation",
      body: {
        expected_current_revision_id: "catrev_cli_demo",
        idempotency_key: "reconcile-cli-demo",
      },
    },
    {
      method: "GET",
      path: "/v1/status",
      body: null,
    },
    {
      method: "POST",
      path: "/v1/catalogue-search-materialization/repair",
      body: {
        target_revision_id: "catrev_cli_demo",
        expected_current_revision_id: "catrev_cli_demo",
        idempotency_key: "repair-cli-demo",
      },
    },
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
    {
      method: "POST",
      path: "/v1/ingestion-runs/run_cli_demo/collection/resume",
      body: null,
    },
  ]);

  const mutationCount = requests.filter(({ method }) => method === "POST")
    .length;
  const staleTarget = await runCli(
    [
      "run",
      "reconcile",
      "--run-id",
      "run_cli_demo",
      "--expected-current-revision",
      "catrev_stale_cli",
      "--idempotency-key",
      "reject-stale-cli-preflight",
      "--environment",
      "production",
      "--yes",
      "--json",
    ],
    environment,
  );
  assert.equal(
    staleTarget.code,
    7,
    "a resolved production revision mismatch is a stale-conflict exit",
  );
  assert.deepEqual(JSON.parse(staleTarget.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "production_target_mismatch",
    detail:
      "The production Ingestion Run does not resolve to the supplied run and expected Catalogue Revision.",
  });
  assert.equal(
    requests.filter(({ method }) => method === "POST").length,
    mutationCount,
    "target mismatch must stop before mutation",
  );
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
