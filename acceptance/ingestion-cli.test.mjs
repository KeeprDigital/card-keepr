import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { runCli } from "./helpers/acceptance-runtime.mjs";

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
  operational_diagnostics: {
    contract: "card-keepr-operational-diagnostics@1",
    references: {
      run_id: "run_cli_demo",
      request_id: "request_cli_demo",
      expected_catalogue_revision_id: "catrev_cli_demo",
      resulting_catalogue_revision_id: "catrev_cli_demo",
      candidate_digest: "a".repeat(64),
      adapter_versions: ["one-piece-en@3"],
      workflow: {
        status_path: "/v1/ingestion-runs/run_cli_demo",
        parent_id: "workflow_cli_demo",
        child_ids: ["workflow_child_cli_demo"],
      },
      backup: {
        status_path: "/v1/catalogue-revisions/catrev_cli_demo/backups",
      },
      recovery: { status_path: "/v1/status" },
    },
    terminal_evidence: {
      state: "failed",
      terminal_at: "2026-07-29T00:01:00.000Z",
      failure: {
        code: "source_unavailable",
        retryability_code: "retryable_failure",
        retryable: true,
      },
      warning_count: 1,
      approval_decision_count: 1,
      coverage: {
        evidence_plan_count: 1,
        source_snapshot_count: 7,
        source_observation_set_count: 7,
        fetch_attempt_count: 8,
      },
    },
    retry: {
      code: "evidence_collection_retry_available",
      source_run_id: "run_cli_demo",
      method: "POST",
      path: "/v1/ingestion-runs/run_cli_demo/collection/retry",
    },
    diagnosis_sequence: [
      { code: "check_status", method: "GET", path: "/v1/status" },
      {
        code: "inspect_run",
        method: "GET",
        path: "/v1/ingestion-runs/run_cli_demo",
      },
      {
        code: "retry_evidence_collection",
        method: "POST",
        path: "/v1/ingestion-runs/run_cli_demo/collection/retry",
      },
      {
        code: "inspect_backup",
        method: "GET",
        path: "/v1/catalogue-revisions/catrev_cli_demo/backups",
      },
    ],
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
  assert.deepEqual(
    schema.$defs.CatalogueBackupCommandRequest.required,
    ["expected_current_revision_id", "idempotency_key"],
  );
  assert.equal(
    schema.$defs.CatalogueBackupCommandRequest.additionalProperties,
    false,
  );
  assert.equal(
    schema.$defs.CatalogueRecoveryBeginCommandRequest.additionalProperties,
    false,
  );
  assert.deepEqual(
    schema.$defs.CatalogueRecoveryVerifyCommandRequest.required,
    ["target_digest", "idempotency_key"],
  );
  assert.deepEqual(
    schema.$defs.CatalogueRecoveryAcceptCommandRequest.required,
    [
      "expected_restored_revision_id",
      "target_digest",
      "confirmation_recovery_id",
      "idempotency_key",
    ],
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
  assert.match(contract, /backup create.*starts or observes.*Workflow/s);
  assert.match(contract, /first non-terminal response is HTTP `202`/);
  assert.match(contract, /exact replays observe the same.*HTTP `200`/s);
  assert.match(contract, /CLI\s+exits `10` until the Workflow is complete/s);
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

test("CLI Catalogue Export deletion preserves the prepared bindings and typed revision confirmation", async (t) => {
  const requests = [];
  const plan = {
    contract: "card-keepr-catalogue-export-deletion-plan@1",
    id: "plan-cli-export-delete",
    catalogue_revision_id: "catrev_cli_previous",
    manifest_digest: "a".repeat(64),
    expected_current_revision_id: "catrev_cli_demo",
    object_keys: [
      "catalogue-exports/catrev_cli_previous/components/a.ndjson.gz",
      "catalogue-exports/catrev_cli_previous/manifest.json",
    ],
    object_set_digest: "b".repeat(64),
    dependencies: [],
    plan_digest: "c".repeat(64),
    created_at: "2026-08-05T00:00:00.000Z",
    expires_at: "2026-08-05T00:15:00.000Z",
  };
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
        safe_state: { current_revision_id: "catrev_cli_demo" },
        repairable_catalogue_revision_ids: [
          "catrev_cli_demo",
          "catrev_cli_previous",
        ],
      }));
      return;
    }
    if (request.url === "/v1/catalogue-export-deletion-plans") {
      response.statusCode = 201;
      response.end(JSON.stringify(plan));
      return;
    }
    const deleting = {
      contract: "card-keepr-catalogue-export-deletion@1",
      id: "deletion-cli-export",
      plan_id: plan.id,
      state: "deleting",
      catalogue_revision_id: plan.catalogue_revision_id,
      object_set_digest: plan.object_set_digest,
      completed_at: null,
      failure_code: null,
    };
    if (request.method === "POST") {
      response.statusCode = 202;
      response.end(JSON.stringify(deleting));
      return;
    }
    response.end(JSON.stringify({
      ...deleting,
      state: "deleted",
      completed_at: "2026-08-05T00:02:00.000Z",
    }));
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const environment = {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${address.port}`,
    KEEPR_ADMINISTRATION_KEY: "cli-test-key",
  };

  const prepared = await runCli([
    "catalogue-export", "deletion", "prepare",
    "--catalogue-revision", plan.catalogue_revision_id,
    "--manifest-digest", plan.manifest_digest,
    "--expected-current-revision", plan.expected_current_revision_id,
    "--plan-id", plan.id,
    "--json",
  ], environment);
  assert.equal(prepared.code, 0, prepared.stderr);
  assert.deepEqual(JSON.parse(prepared.stdout), plan);
  assert.deepEqual(requests.at(-1), {
    method: "POST",
    path: "/v1/catalogue-export-deletion-plans",
    body: {
      catalogue_revision_id: plan.catalogue_revision_id,
      manifest_digest: plan.manifest_digest,
      expected_current_revision_id: plan.expected_current_revision_id,
      plan_id: plan.id,
    },
  });

  const confirmation = JSON.stringify({
    production_target: productionTarget,
    plan_id: plan.id,
    plan_digest: plan.plan_digest,
    catalogue_revision_id: plan.catalogue_revision_id,
    manifest_digest: plan.manifest_digest,
    expected_current_revision_id: plan.expected_current_revision_id,
    deletion_id: "deletion-cli-export",
    idempotency_key: "deletion-cli-export-key",
  });
  const confirmed = await runCli([
    "catalogue-export", "deletion", "confirm",
    "--plan-id", plan.id,
    "--plan-digest", plan.plan_digest,
    "--catalogue-revision", plan.catalogue_revision_id,
    "--manifest-digest", plan.manifest_digest,
    "--expected-current-revision", plan.expected_current_revision_id,
    "--confirm-revision", plan.catalogue_revision_id,
    "--deletion-id", "deletion-cli-export",
    "--idempotency-key", "deletion-cli-export-key",
    "--environment", "production",
    "--confirm", confirmation,
    "--yes",
    "--json",
  ], environment);
  assert.equal(confirmed.code, 10, confirmed.stderr);
  assert.deepEqual(JSON.parse(confirmed.stdout), {
    contract: "card-keepr-catalogue-export-deletion@1",
    id: "deletion-cli-export",
    plan_id: plan.id,
    state: "deleting",
    catalogue_revision_id: plan.catalogue_revision_id,
    object_set_digest: plan.object_set_digest,
    completed_at: null,
    failure_code: null,
  });
  assert.deepEqual(requests.at(-1), {
    method: "POST",
    path: "/v1/catalogue-export-deletions",
    body: {
      plan_id: plan.id,
      plan_digest: plan.plan_digest,
      catalogue_revision_id: plan.catalogue_revision_id,
      manifest_digest: plan.manifest_digest,
      expected_current_revision_id: plan.expected_current_revision_id,
      confirmation_revision_id: plan.catalogue_revision_id,
      deletion_id: "deletion-cli-export",
      idempotency_key: "deletion-cli-export-key",
    },
  });

  const retryIdempotencyKey = "deletion-cli-export-retry";
  const retryConfirmation = JSON.stringify({
    production_target: productionTarget,
    deletion_id: "deletion-cli-export",
    object_set_digest: plan.object_set_digest,
    expected_current_revision_id: plan.expected_current_revision_id,
    idempotency_key: retryIdempotencyKey,
  });
  const retried = await runCli([
    "catalogue-export", "deletion", "retry",
    "--deletion-id", "deletion-cli-export",
    "--object-set-digest", plan.object_set_digest,
    "--expected-current-revision", plan.expected_current_revision_id,
    "--idempotency-key", retryIdempotencyKey,
    "--environment", "production",
    "--confirm", retryConfirmation,
    "--yes",
    "--json",
  ], environment);
  assert.equal(retried.code, 10, retried.stderr);
  assert.deepEqual(JSON.parse(retried.stdout), JSON.parse(confirmed.stdout));
  assert.deepEqual(requests.at(-1), {
    method: "POST",
    path: "/v1/catalogue-export-deletions/deletion-cli-export/retry",
    body: {
      object_set_digest: plan.object_set_digest,
      idempotency_key: retryIdempotencyKey,
    },
  });

  const terminal = await runCli([
    "catalogue-export", "deletion", "status",
    "--deletion-id", "deletion-cli-export",
    "--json",
  ], environment);
  assert.equal(terminal.code, 0, terminal.stderr);
  assert.equal(JSON.parse(terminal.stdout).state, "deleted");
});

test("CLI backup create confirms the exact target before the operation", async (t) => {
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
        production_target: productionTarget,
        safe_state: { current_revision_id: "catrev_cli_demo" },
      }));
      return;
    }
    response.statusCode = 201;
    response.end(JSON.stringify({
      contract: "card-keepr-catalogue-backup-workflow@1",
      expected_current_revision_id: "catrev_cli_demo",
      idempotency_key: "backup-cli-confirmed-target",
      workflow_instance_id: "backup-cli-workflow",
      status: "complete",
      output: {
        contract: "card-keepr-catalogue-backup@1",
        catalogue_revision_id: "catrev_cli_demo",
        object_key: "d1-backups/catrev_cli_demo/backup.sql",
        d1_bookmark: "bookmark-cli-backup",
        verified: true,
      },
    }));
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const result = await runCli([
    "backup",
    "create",
    "--expected-current-revision",
    "catrev_cli_demo",
    "--idempotency-key",
    "backup-cli-confirmed-target",
    "--environment",
    "production",
    "--confirm",
    JSON.stringify({
      production_target: productionTarget,
      expected_current_revision_id: "catrev_cli_demo",
      idempotency_key: "backup-cli-confirmed-target",
    }),
    "--yes",
    "--json",
  ], {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${address.port}`,
    KEEPR_ADMINISTRATION_KEY: "cli-test-key",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests.at(-1), {
    method: "POST",
    path: "/v1/backups",
    body: {
      expected_current_revision_id: "catrev_cli_demo",
      idempotency_key: "backup-cli-confirmed-target",
    },
  });
});

test("CLI recovery commands resolve and confirm exact production evidence", async (t) => {
  const requests = [];
  const targetDigest = "c".repeat(64);
  const recovery = {
    contract: "card-keepr-catalogue-recovery@1",
    id: "recovery-cli-exact",
    state: "validating",
    target_revision_id: "catrev_cli_restored",
    target_digest: targetDigest,
    expected_current_revision_id: "catrev_cli_demo",
  };
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
        production_target: productionTarget,
        safe_state: { current_revision_id: "catrev_cli_demo" },
      }));
      return;
    }
    response.statusCode = request.method === "POST" ? 201 : 200;
    response.end(JSON.stringify(recovery));
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const environment = {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${address.port}`,
    KEEPR_ADMINISTRATION_KEY: "cli-test-key",
  };
  const beginBody = {
    environment: "production",
    recovery_id: recovery.id,
    method: "time_travel",
    target_revision_id: recovery.target_revision_id,
    target_bookmark: "bookmark-cli-restored",
    target_digest: targetDigest,
    backup_attempt_id: "backup-cli-restored",
    expected_current_revision_id: recovery.expected_current_revision_id,
    idempotency_key: "recovery-cli-begin",
  };
  const begun = await runCli([
    "recovery", "begin",
    "--recovery-id", recovery.id,
    "--method", "time_travel",
    "--target-revision", recovery.target_revision_id,
    "--target-bookmark", "bookmark-cli-restored",
    "--target-digest", targetDigest,
    "--backup-attempt-id", "backup-cli-restored",
    "--expected-current-revision", recovery.expected_current_revision_id,
    "--idempotency-key", "recovery-cli-begin",
    "--environment", "production",
    "--confirm", JSON.stringify({
      production_target: productionTarget,
      ...beginBody,
    }),
    "--yes", "--json",
  ], environment);
  assert.equal(begun.code, 0, begun.stderr);
  assert.deepEqual(requests.at(-1), {
    method: "POST",
    path: "/v1/recoveries",
    body: beginBody,
  });

  const inspected = await runCli([
    "recovery", "inspect", "--recovery-id", recovery.id, "--json",
  ], environment);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.equal(requests.at(-1).path, `/v1/recoveries/${recovery.id}`);

  const verifyBody = {
    target_digest: targetDigest,
    idempotency_key: "recovery-cli-verify",
  };
  const verified = await runCli([
    "recovery", "verify",
    "--recovery-id", recovery.id,
    "--target-digest", targetDigest,
    "--idempotency-key", "recovery-cli-verify",
    "--environment", "production",
    "--confirm", JSON.stringify({
      production_target: productionTarget,
      recovery_id: recovery.id,
      ...verifyBody,
    }),
    "--yes", "--json",
  ], environment);
  assert.equal(verified.code, 0, verified.stderr);
  assert.deepEqual(requests.at(-1), {
    method: "POST",
    path: `/v1/recoveries/${recovery.id}/verification`,
    body: verifyBody,
  });

  const acceptBody = {
    expected_restored_revision_id: recovery.target_revision_id,
    target_digest: targetDigest,
    confirmation_recovery_id: recovery.id,
    idempotency_key: "recovery-cli-accept",
  };
  const accepted = await runCli([
    "recovery", "accept",
    "--recovery-id", recovery.id,
    "--expected-restored-revision", recovery.target_revision_id,
    "--target-digest", targetDigest,
    "--confirmation-recovery-id", recovery.id,
    "--idempotency-key", "recovery-cli-accept",
    "--environment", "production",
    "--confirm", JSON.stringify({
      production_target: productionTarget,
      recovery_id: recovery.id,
      ...acceptBody,
    }),
    "--yes", "--json",
  ], environment);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.deepEqual(requests.at(-1), {
    method: "POST",
    path: `/v1/recoveries/${recovery.id}/acceptance`,
    body: acceptBody,
  });
});

test("CLI backup status and retry preserve the exact failed-attempt evidence", async (t) => {
  const requests = [];
  const digest = "a".repeat(64);
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
        production_target: productionTarget,
        safe_state: { current_revision_id: "catrev_cli_demo" },
      }));
      return;
    }
    response.end(JSON.stringify({
      contract: "card-keepr-catalogue-backup-status@1",
      idempotency_key: "backup-failed-exact",
      state: "failed",
      attempt_digest: digest,
    }));
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const environment = {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${address.port}`,
    KEEPR_ADMINISTRATION_KEY: "cli-test-key",
  };
  const status = await runCli([
    "backup", "status", "--attempt-id", "backup-failed-exact", "--json",
  ], environment);
  assert.equal(status.code, 0, status.stderr);
  const revisionStatus = await runCli([
    "backup", "status", "--catalogue-revision", "catrev_cli_demo", "--json",
  ], environment);
  assert.equal(revisionStatus.code, 0, revisionStatus.stderr);
  const retry = await runCli([
    "backup", "retry",
    "--expected-current-revision", "catrev_cli_demo",
    "--idempotency-key", "backup-retry-exact",
    "--failed-attempt-id", "backup-failed-exact",
    "--failed-attempt-digest", digest,
    "--environment", "production",
    "--confirm", JSON.stringify({
      production_target: productionTarget,
      expected_current_revision_id: "catrev_cli_demo",
      idempotency_key: "backup-retry-exact",
      failed_attempt_id: "backup-failed-exact",
      failed_attempt_digest: digest,
    }),
    "--yes",
    "--json",
  ], environment);
  assert.equal(retry.code, 0, retry.stderr);
  assert.deepEqual(JSON.parse(retry.stderr), {
    contract: "card-keepr-resolved-backup-retry@1",
    production_target: productionTarget,
    current_catalogue_revision_id: "catrev_cli_demo",
    expected_current_revision_id: "catrev_cli_demo",
    idempotency_key: "backup-retry-exact",
    failed_attempt_id: "backup-failed-exact",
    failed_attempt_digest: digest,
  });
  assert.deepEqual(requests, [{
    method: "GET",
    path: "/v1/backups/backup-failed-exact",
    body: null,
  }, {
    method: "GET",
    path: "/v1/catalogue-revisions/catrev_cli_demo/backups",
    body: null,
  }, {
    method: "GET",
    path: "/v1/status",
    body: null,
  }, {
    method: "POST",
    path: "/v1/backups",
    body: {
      expected_current_revision_id: "catrev_cli_demo",
      idempotency_key: "backup-retry-exact",
      failed_attempt_id: "backup-failed-exact",
      failed_attempt_digest: digest,
    },
  }]);
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
  const rejectedRun = {
    ...run,
    id: "run_rejected_cli",
    state: "rejected",
    failure_code: null,
    progress: {
      completed_stages: ["planning", "collecting", "parsing", "reconciling"],
      current_stage: "rejected",
    },
    operational_diagnostics: {
      ...run.operational_diagnostics,
      references: {
        ...run.operational_diagnostics.references,
        run_id: "run_rejected_cli",
        request_id: "request_rejected_cli",
      },
      terminal_evidence: {
        ...run.operational_diagnostics.terminal_evidence,
        state: "rejected",
        failure: {
          code: "ingestion_run_rejected",
          retryability_code: "retryable_rejection",
          retryable: true,
        },
      },
      retry: {
        code: "ingestion_run_retry_available",
        source_run_id: "run_rejected_cli",
        method: "POST",
        path: "/v1/ingestion-runs/run_rejected_cli/retry",
      },
      retry_available: true,
      diagnosis_sequence: [
        { code: "check_status", method: "GET", path: "/v1/status" },
        {
          code: "inspect_run",
          method: "GET",
          path: "/v1/ingestion-runs/run_rejected_cli",
        },
        {
          code: "retry_ingestion_run",
          method: "POST",
          path: "/v1/ingestion-runs/run_rejected_cli/retry",
        },
      ],
    },
  };
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
    if (request.url === "/v1/ingestion-runs/run_rejected_cli") {
      response.end(JSON.stringify(rejectedRun));
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
  assert.match(
    status.stdout,
    /Next: keepr run show --run-id run_cli_demo/,
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
  assert.match(shown.stdout, /Request reference: request_cli_demo/);
  assert.doesNotMatch(shown.stdout, /retry-cli-demo/);
  assert.match(shown.stdout, /Workflow: workflow_cli_demo/);
  assert.match(shown.stdout, /Adapter versions: one-piece-en@3/);
  assert.match(shown.stdout, new RegExp(`Candidate: ${"a".repeat(64)}`));
  assert.match(
    shown.stdout,
    /Backup: \/v1\/catalogue-revisions\/catrev_cli_demo\/backups/,
  );
  assert.match(shown.stdout, /Recovery: \/v1\/status/);
  assert.match(
    shown.stdout,
    /Retry: evidence_collection_retry_available \(run_cli_demo\)/,
  );
  assert.match(
    shown.stdout,
    /Next: POST \/v1\/ingestion-runs\/run_cli_demo\/collection\/retry/,
  );
  assert.match(shown.stdout, /Coverage: 7 snapshots, 7 observation sets, 8 attempts/);
  assert.doesNotMatch(shown.stdout, /cli-test-key|source payload|proposal/iu);

  const shownRejected = await runCli(
    ["run", "show", "--run-id", "run_rejected_cli"],
    environment,
  );
  assert.equal(shownRejected.code, 0, shownRejected.stderr);
  assert.match(shownRejected.stdout, /Retry classification: retryable_rejection/);
  assert.match(
    shownRejected.stdout,
    /Retry: ingestion_run_retry_available \(run_rejected_cli\)/,
  );
  assert.match(
    shownRejected.stdout,
    /Next: POST \/v1\/ingestion-runs\/run_rejected_cli\/retry/,
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
  const sourceRetried = await runCli(
    [
      "source",
      "retry",
      "--run-id",
      "run_cli_demo",
      "--idempotency-key",
      "source-retry-cli-demo",
    ],
    environment,
  );
  assert.equal(sourceRetried.code, 0, sourceRetried.stderr);
  assert.match(sourceRetried.stdout, /Request reference: request_cli_demo/);
  assert.doesNotMatch(sourceRetried.stdout, /source-retry-cli-demo/);
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
  assert.deepEqual(requests.slice(-10), [
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
      path: "/v1/ingestion-runs/run_cli_demo/collection/retry",
      body: { idempotency_key: "source-retry-cli-demo" },
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

test("a capacity-paused Ingestion Run reports its pause facts through source show", async (t) => {
  const pausedEvidence = {
    id: "run_paused_cli",
    state: "paused",
    plan_origin: "production",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    failure_code: null,
    collection_completed_at: null,
    pause: {
      reason: "source_request_capacity_exhausted",
      paused_at: "2026-08-30T00:00:00.000Z",
      source_lineage: "fusion-world-en",
      parent_request_id: "fusion-world-en:discovery",
      request_capacity: 15000,
      capacity_generation: 1,
      used_capacity: 15000,
      overflow_request_count: 3,
      required_capacity: 15003,
    },
    workflow: { parent_id: "workflow_paused_cli", child_ids: [] },
    snapshots: [],
    observation_sets: [],
    diagnostics: [],
    operational_diagnostics: {
      contract: "card-keepr-operational-diagnostics@1",
      references: { request_id: "request_paused_cli" },
    },
  };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/ingestion-runs/run_paused_cli/evidence") {
      response.end(JSON.stringify(pausedEvidence));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: "not_found" }));
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

  const shownJson = await runCli(
    ["source", "show", "--run-id", "run_paused_cli", "--json"],
    environment,
  );
  assert.equal(shownJson.code, 0, shownJson.stderr);
  assert.deepEqual(JSON.parse(shownJson.stdout), pausedEvidence);

  const shown = await runCli(
    ["source", "show", "--run-id", "run_paused_cli"],
    environment,
  );
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /Ingestion Run run_paused_cli evidence: paused/);
  assert.match(
    shown.stdout,
    /Paused: source_request_capacity_exhausted at 2026-08-30T00:00:00.000Z/,
  );
  assert.match(shown.stdout, /Source Lineage: fusion-world-en/);
  assert.match(
    shown.stdout,
    /Request Capacity: 15000 used of 15000 \(generation 1\)/,
  );
  assert.match(shown.stdout, /Overflow: 3 requests require capacity 15003/);
  assert.match(shown.stdout, /Parent request: fusion-world-en:discovery/);
  assert.match(shown.stdout, /Request reference: request_paused_cli/);
  assert.doesNotMatch(shown.stdout, /cli-test-key/);
});

test("a retry-paused Ingestion Run reports its pause facts through source show", async (t) => {
  const pausedEvidence = {
    id: "run_retry_paused_cli",
    state: "paused",
    plan_origin: "production",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    failure_code: null,
    collection_completed_at: null,
    pause: {
      reason: "source_transport_retries_exhausted",
      paused_at: "2026-08-31T00:00:00.000Z",
      source_lineage: "fusion-world-en",
      request_id: "fusion-world-en:detail:cards:0f0f0f",
      hostname: "en.dbs-cardgame.com",
      retry_generation: 1,
      attempt_count: 4,
      failure_classification: "http_failure",
      http_status: 503,
      actions: ["resume", "terminate"],
    },
    actions: ["resume", "terminate"],
    workflow: { parent_id: "workflow_retry_paused_cli", child_ids: [] },
    snapshots: [],
    observation_sets: [],
    diagnostics: [],
    operational_diagnostics: {
      contract: "card-keepr-operational-diagnostics@1",
      references: { request_id: "request_retry_paused_cli" },
    },
  };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/ingestion-runs/run_retry_paused_cli/evidence") {
      response.end(JSON.stringify(pausedEvidence));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: "not_found" }));
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

  const shownJson = await runCli(
    ["source", "show", "--run-id", "run_retry_paused_cli", "--json"],
    environment,
  );
  assert.equal(shownJson.code, 0, shownJson.stderr);
  assert.deepEqual(JSON.parse(shownJson.stdout), pausedEvidence);

  const shown = await runCli(
    ["source", "show", "--run-id", "run_retry_paused_cli"],
    environment,
  );
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(
    shown.stdout,
    /Ingestion Run run_retry_paused_cli evidence: paused/,
  );
  assert.match(
    shown.stdout,
    /Paused: source_transport_retries_exhausted at 2026-08-31T00:00:00.000Z/,
  );
  assert.match(shown.stdout, /Source Lineage: fusion-world-en/);
  assert.match(
    shown.stdout,
    /Request: fusion-world-en:detail:cards:0f0f0f/,
  );
  assert.match(shown.stdout, /Hostname: en.dbs-cardgame.com/);
  assert.match(shown.stdout, /Attempts: 4 in retry generation 1/);
  assert.match(shown.stdout, /Last failure: http_failure \(HTTP 503\)/);
  assert.match(shown.stdout, /Available actions: resume, terminate/);
  assert.match(shown.stdout, /Request reference: request_retry_paused_cli/);
  assert.doesNotMatch(shown.stdout, /cli-test-key/);
});

test("a workflow-paused Ingestion Run reports its recovery facts through source show", async (t) => {
  const pausedEvidence = {
    id: "run_workflow_paused_cli",
    state: "paused",
    plan_origin: "production",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    failure_code: null,
    collection_completed_at: null,
    pause: {
      reason: "source_workflow_stalled",
      paused_at: "2026-09-01T00:00:00.000Z",
      workflow_instance_id: "evidence-run_workflow_paused_cli",
      workflow_status: "running",
      last_progress_at: "2026-08-31T22:00:00.000Z",
      actions: ["resume", "terminate"],
    },
    actions: ["resume", "terminate"],
    workflow: {
      parent_id: "evidence-run_workflow_paused_cli",
      child_ids: [],
      last_progress_at: "2026-08-31T22:00:00.000Z",
      current_attempt: {
        id: "evidence-run_workflow_paused_cli",
        attempt_number: 1,
        created_at: "2026-08-31T20:00:00.000Z",
      },
      attempts: [
        {
          id: "evidence-run_workflow_paused_cli",
          kind: "parent",
          attempt_number: 1,
          created_at: "2026-08-31T20:00:00.000Z",
          current: true,
        },
      ],
      status: "running",
    },
    snapshots: [],
    observation_sets: [],
    diagnostics: [],
    operational_diagnostics: {
      contract: "card-keepr-operational-diagnostics@1",
      references: { request_id: "request_workflow_paused_cli" },
    },
  };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (
      request.url === "/v1/ingestion-runs/run_workflow_paused_cli/evidence"
    ) {
      response.end(JSON.stringify(pausedEvidence));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: "not_found" }));
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

  const shownJson = await runCli(
    ["source", "show", "--run-id", "run_workflow_paused_cli", "--json"],
    environment,
  );
  assert.equal(shownJson.code, 0, shownJson.stderr);
  assert.deepEqual(JSON.parse(shownJson.stdout), pausedEvidence);

  const shown = await runCli(
    ["source", "show", "--run-id", "run_workflow_paused_cli"],
    environment,
  );
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(
    shown.stdout,
    /Ingestion Run run_workflow_paused_cli evidence: paused/,
  );
  assert.match(
    shown.stdout,
    /Paused: source_workflow_stalled at 2026-09-01T00:00:00.000Z/,
  );
  assert.match(
    shown.stdout,
    /Workflow attempt: evidence-run_workflow_paused_cli \(status running\)/,
  );
  assert.match(shown.stdout, /Last progress: 2026-08-31T22:00:00.000Z/);
  assert.match(shown.stdout, /Available actions: resume, terminate/);
  assert.match(
    shown.stdout,
    /Workflow attempt 1: evidence-run_workflow_paused_cli \(status running\)/,
  );
  assert.doesNotMatch(shown.stdout, /cli-test-key/);
});

test("source capacity extend performs the compare-and-set administration mutation", async (t) => {
  const extensionDocument = {
    contract: "card-keepr-capacity-extension@1",
    ingestion_run_id: "run_paused_cli",
    source_lineage: "fusion-world-en",
    previous_request_capacity: 15000,
    previous_capacity_generation: 1,
    request_capacity: 20000,
    capacity_generation: 2,
    extended_at: "2026-08-30T01:00:00.000Z",
  };
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: body === "" ? null : JSON.parse(body),
      });
      response.setHeader("content-type", "application/json");
      if (
        request.url === "/v1/ingestion-runs/run_paused_cli/capacity/extension"
      ) {
        response.end(JSON.stringify(extensionDocument));
        return;
      }
      if (
        request.url === "/v1/ingestion-runs/run_stale_cli/capacity/extension"
      ) {
        response.statusCode = 409;
        response.setHeader("content-type", "application/problem+json");
        response.end(JSON.stringify({
          type: "https://card-keepr.invalid/problems/request_capacity_mismatch",
          title: "Conflict",
          status: 409,
          code: "request_capacity_mismatch",
          detail:
            "The expected request capacity is stale: the effective capacity is 20000.",
          request_id: "request_stale_cli",
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ code: "not_found" }));
    });
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
  const extendArguments = [
    "source",
    "capacity",
    "extend",
    "--run-id",
    "run_paused_cli",
    "--expected-capacity",
    "15000",
    "--expected-generation",
    "1",
    "--capacity",
    "20000",
    "--idempotency-key",
    "extend-cli-demo",
  ];

  const extendedJson = await runCli(
    [...extendArguments, "--json"],
    environment,
  );
  assert.equal(extendedJson.code, 0, extendedJson.stderr);
  assert.deepEqual(JSON.parse(extendedJson.stdout), extensionDocument);
  assert.deepEqual(requests.at(-1), {
    method: "POST",
    path: "/v1/ingestion-runs/run_paused_cli/capacity/extension",
    authorization: "Bearer cli-test-key",
    body: {
      expected_request_capacity: 15000,
      expected_capacity_generation: 1,
      request_capacity: 20000,
      idempotency_key: "extend-cli-demo",
    },
  });

  const extended = await runCli(extendArguments, environment);
  assert.equal(extended.code, 0, extended.stderr);
  assert.match(
    extended.stdout,
    /Ingestion Run run_paused_cli capacity extended/,
  );
  assert.match(
    extended.stdout,
    /Request Capacity: 15000 -> 20000 \(generation 1 -> 2\)/,
  );
  assert.match(extended.stdout, /Source Lineage: fusion-world-en/);
  assert.doesNotMatch(extended.stdout, /cli-test-key/);

  // A stale compare-and-set expectation renders the problem document and the
  // conflict exit code.
  const stale = await runCli(
    [
      "source",
      "capacity",
      "extend",
      "--run-id",
      "run_stale_cli",
      "--expected-capacity",
      "15000",
      "--expected-generation",
      "1",
      "--capacity",
      "20000",
      "--idempotency-key",
      "extend-stale-cli",
      "--json",
    ],
    environment,
  );
  assert.equal(stale.code, 7);
  assert.deepEqual(JSON.parse(stale.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "request_capacity_mismatch",
    detail:
      "The expected request capacity is stale: the effective capacity is 20000.",
  });

  // Malformed or missing capacity values fail as usage errors before any
  // request is made.
  const mutationCount = requests.length;
  for (const [option, value] of [
    ["--capacity", "not-a-number"],
    ["--capacity", "0"],
    ["--expected-generation", "1.5"],
  ]) {
    const invalid = await runCli(
      extendArguments.map((argument, index) =>
        extendArguments[index - 1] === option ? value : argument
      ),
      environment,
    );
    assert.equal(invalid.code, 2, `${option}=${value} must be a usage error`);
  }
  const missing = await runCli(
    ["source", "capacity", "extend", "--run-id", "run_paused_cli"],
    environment,
  );
  assert.equal(missing.code, 2);
  assert.equal(
    requests.length,
    mutationCount,
    "usage failures must stop before any administration request",
  );
});

test("source terminate performs the idempotent termination mutation", async (t) => {
  const terminationDocument = {
    contract: "card-keepr-collection-termination@1",
    ingestion_run_id: "run_paused_cli",
    state: "failed",
    failure_code: "ingestion_run_terminated",
    pause_reason: "source_request_capacity_exhausted",
    paused_at: "2026-08-30T00:00:00.000Z",
    terminated_at: "2026-08-30T02:00:00.000Z",
    active_run_released: true,
  };
  const terminatedEvidence = {
    id: "run_paused_cli",
    state: "failed",
    plan_origin: "production",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    failure_code: "ingestion_run_terminated",
    collection_completed_at: null,
    termination: {
      reason: "ingestion_run_terminated",
      pause_reason: "source_request_capacity_exhausted",
      paused_at: "2026-08-30T00:00:00.000Z",
      terminated_at: "2026-08-30T02:00:00.000Z",
    },
    actions: ["retry"],
    workflow: { parent_id: "workflow_paused_cli", child_ids: [] },
    snapshots: [],
    observation_sets: [],
    diagnostics: [],
    operational_diagnostics: {
      contract: "card-keepr-operational-diagnostics@1",
      references: { request_id: "request_terminated_cli" },
    },
  };
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: body === "" ? null : JSON.parse(body),
      });
      response.setHeader("content-type", "application/json");
      if (
        request.url ===
          "/v1/ingestion-runs/run_paused_cli/collection/termination"
      ) {
        response.end(JSON.stringify(terminationDocument));
        return;
      }
      if (request.url === "/v1/ingestion-runs/run_paused_cli/evidence") {
        response.end(JSON.stringify(terminatedEvidence));
        return;
      }
      if (
        request.url ===
          "/v1/ingestion-runs/run_collecting_cli/collection/termination"
      ) {
        response.statusCode = 409;
        response.setHeader("content-type", "application/problem+json");
        response.end(JSON.stringify({
          type: "https://card-keepr.invalid/problems/ingestion_run_not_paused",
          title: "Conflict",
          status: 409,
          code: "ingestion_run_not_paused",
          detail: "Only a paused Ingestion Run can be terminated.",
          request_id: "request_not_paused_cli",
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ code: "not_found" }));
    });
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
  const terminateArguments = [
    "source",
    "terminate",
    "--run-id",
    "run_paused_cli",
    "--idempotency-key",
    "terminate-cli-demo",
  ];

  const terminatedJson = await runCli(
    [...terminateArguments, "--json"],
    environment,
  );
  assert.equal(terminatedJson.code, 0, terminatedJson.stderr);
  assert.deepEqual(JSON.parse(terminatedJson.stdout), terminationDocument);
  assert.deepEqual(requests.at(-1), {
    method: "POST",
    path: "/v1/ingestion-runs/run_paused_cli/collection/termination",
    authorization: "Bearer cli-test-key",
    body: { idempotency_key: "terminate-cli-demo" },
  });

  const terminated = await runCli(terminateArguments, environment);
  assert.equal(terminated.code, 0, terminated.stderr);
  assert.match(terminated.stdout, /Ingestion Run run_paused_cli terminated/);
  assert.match(
    terminated.stdout,
    /Paused: source_request_capacity_exhausted at 2026-08-30T00:00:00.000Z/,
  );
  assert.match(terminated.stdout, /Terminated at: 2026-08-30T02:00:00.000Z/);
  assert.match(terminated.stdout, /Active run released: yes/);
  assert.doesNotMatch(terminated.stdout, /cli-test-key/);

  // Inspection of the terminated run reports the owner decision and no
  // longer advertises resume or capacity extension.
  const shownJson = await runCli(
    ["source", "show", "--run-id", "run_paused_cli", "--json"],
    environment,
  );
  assert.equal(shownJson.code, 0, shownJson.stderr);
  assert.deepEqual(JSON.parse(shownJson.stdout), terminatedEvidence);
  const shown = await runCli(
    ["source", "show", "--run-id", "run_paused_cli"],
    environment,
  );
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /Ingestion Run run_paused_cli evidence: failed/);
  assert.match(
    shown.stdout,
    /Terminated: ingestion_run_terminated at 2026-08-30T02:00:00.000Z \(paused source_request_capacity_exhausted at 2026-08-30T00:00:00.000Z\)/,
  );
  assert.match(shown.stdout, /Available actions: retry/);
  assert.doesNotMatch(shown.stdout, /resume|extend_capacity/);

  // A state conflict renders the problem document and the conflict exit
  // code.
  const conflict = await runCli(
    [
      "source",
      "terminate",
      "--run-id",
      "run_collecting_cli",
      "--idempotency-key",
      "terminate-conflict-cli",
      "--json",
    ],
    environment,
  );
  assert.equal(conflict.code, 7);
  assert.deepEqual(JSON.parse(conflict.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "ingestion_run_not_paused",
    detail: "Only a paused Ingestion Run can be terminated.",
  });

  // Missing arguments fail as usage errors before any request is made.
  const mutationCount = requests.length;
  for (const missing of [
    ["source", "terminate", "--run-id", "run_paused_cli"],
    ["source", "terminate", "--idempotency-key", "terminate-cli-demo"],
    ["source", "terminate"],
  ]) {
    const invalid = await runCli(missing, environment);
    assert.equal(invalid.code, 2, missing.join(" "));
  }
  assert.equal(
    requests.length,
    mutationCount,
    "usage failures must stop before any administration request",
  );
});

test("source show renders aggregated collection progress in human-readable form", async (t) => {
  const evidence = {
    id: "run_progress_cli",
    state: "collecting",
    plan_origin: "production",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    failure_code: null,
    collection_completed_at: null,
    actions: [],
    collection: {
      state: "collecting",
      pause_reason: null,
      paused_at: null,
      started_at: "2026-09-01T00:00:00.000Z",
      last_progress_at: "2026-09-01T03:00:00.000Z",
      collection_completed_at: null,
      terminal_at: null,
      expected_catalogue_revision_id: "catrev_current_cli",
      capacity: [{
        source_lineage: "fusion-world-en",
        adapter_version: "fusion-world-en@9",
        capacity_generation: 2,
        request_capacity: 20000,
        used_capacity: 15003,
        remaining_capacity: 4997,
        required_capacity: null,
        overflow_request_count: null,
      }],
      requests: {
        total: 15003,
        by_state: { pending: 9000, captured: 3, observed: 6000 },
        by_role: { surface: 5, detail: 12000, image: 2998 },
        by_lineage: [{
          source_lineage: "fusion-world-en",
          total: 15003,
          by_state: { pending: 9000, captured: 3, observed: 6000 },
          by_role: { surface: 5, detail: 12000, image: 2998 },
        }],
      },
      evidence: {
        snapshot_count: 6003,
        retained_byte_total: 1234567890,
        observation_set_count: 6000,
        fetch_attempt_count: 6010,
        retry_attempt_count: 7,
        failed_attempt_count: 7,
        latest_failure: {
          request_id: "fusion-world-en:detail:abc",
          hostname: "www.dbs-cardgame.com",
          classification: "http_failure",
          http_status: 503,
          attempt_number: 2,
          at: "2026-09-01T02:59:00.000Z",
        },
        detail_limit: 200,
        snapshots_truncated: true,
        observation_sets_truncated: true,
        diagnostics_truncated: true,
      },
      progress: {
        current_request: {
          request_id: "fusion-world-en:detail:def",
          hostname: "www.dbs-cardgame.com",
          role: "detail",
          state: "pending",
          attempt_count: 1,
          last_attempt_at: "2026-09-01T03:00:00.000Z",
        },
      },
      pacing: {
        mode: "production",
        interval_ms: 1000,
        hosts: [{
          hostname: "www.dbs-cardgame.com",
          pending_request_count: 9000,
          captured_request_count: 3,
          next_request_not_before: "2026-09-01T03:00:01.000Z",
          waiting_ms: 800,
        }],
      },
      estimate: {
        advisory: true,
        pending_request_count: 9000,
        captured_request_count: 3,
        active_host_count: 1,
        minimum_remaining_ms: 9000800,
      },
    },
    workflow: {
      parent_id: "evidence-run_progress_cli",
      child_ids: ["evidence-host-abc"],
      last_progress_at: "2026-09-01T03:00:00.000Z",
      current_attempt: {
        id: "evidence-run_progress_cli",
        attempt_number: 1,
        created_at: "2026-09-01T00:00:00.000Z",
        status: "running",
      },
      attempts: [
        {
          id: "evidence-run_progress_cli",
          kind: "parent",
          attempt_number: 1,
          created_at: "2026-09-01T00:00:00.000Z",
          current: true,
          status: "running",
        },
        {
          id: "evidence-host-abc",
          kind: "child",
          attempt_number: 1,
          created_at: "2026-09-01T00:00:01.000Z",
          current: false,
          status: "errored",
        },
        {
          id: "evidence-host-abc-attempt-0",
          kind: "child",
          attempt_number: 2,
          created_at: "2026-09-01T01:00:00.000Z",
          current: true,
          status: "running",
        },
      ],
      status: "running",
      classification: "active",
    },
    snapshots: [],
    observation_sets: [],
    diagnostics: [],
    operational_diagnostics: {
      contract: "card-keepr-operational-diagnostics@1",
      references: { request_id: "request_progress_cli" },
    },
  };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/ingestion-runs/run_progress_cli/evidence") {
      response.end(JSON.stringify(evidence));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: "not_found" }));
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  t.after(
    () => new Promise((resolveClose) => server.close(resolveClose)),
  );
  const address = server.address();
  const environment = {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${address.port}`,
    KEEPR_ADMINISTRATION_KEY: "cli-test-key",
  };

  const shownJson = await runCli(
    ["source", "show", "--run-id", "run_progress_cli", "--json"],
    environment,
  );
  assert.equal(shownJson.code, 0, shownJson.stderr);
  assert.deepEqual(JSON.parse(shownJson.stdout), evidence);

  const shown = await runCli(
    ["source", "show", "--run-id", "run_progress_cli"],
    environment,
  );
  assert.equal(shown.code, 0, shown.stderr);
  const out = shown.stdout;
  assert.match(out, /Ingestion Run run_progress_cli evidence: collecting/);
  // Aggregate counts replace the bounded detail lengths in the summary.
  assert.match(out, /6003 Source Snapshots \(1234567890 bytes\)/);
  assert.match(out, /6000 Source Observation sets/);
  assert.match(out, /6010 fetch attempts \(7 retries, 7 failures\)/);
  assert.match(
    out,
    /Requests: 15003 \(pending 9000, captured 3, observed 6000; surface 5, detail 12000, image 2998\)/,
  );
  assert.match(
    out,
    /Capacity fusion-world-en: 15003 used of 20000 \(generation 2, 4997 remaining\)/,
  );
  assert.match(
    out,
    /Latest failure: http_failure \(HTTP 503\) on fusion-world-en:detail:abc attempt 2 at 2026-09-01T02:59:00.000Z/,
  );
  assert.match(
    out,
    /Current request: fusion-world-en:detail:def \(www.dbs-cardgame.com, detail, pending, 1 attempt\)/,
  );
  assert.match(
    out,
    /Pacing: production 1000ms; www.dbs-cardgame.com 9000 pending \(waiting 800ms\)/,
  );
  assert.match(
    out,
    /Estimated minimum remaining: 2h 30m 0s \(advisory\)/,
  );
  assert.match(out, /Expected Catalogue Revision: catrev_current_cli/);
  assert.match(out, /Last progress: 2026-09-01T03:00:00.000Z/);
  assert.match(
    out,
    /Workflow attempt 1: evidence-run_progress_cli \(status running\)/,
  );
  assert.match(
    out,
    /Workflow attempts: 3 recorded, 2 current; child evidence-host-abc attempt 1 errored; child evidence-host-abc-attempt-0 attempt 2 running \(current\)/,
  );
  assert.doesNotMatch(out, /cli-test-key/);
});
