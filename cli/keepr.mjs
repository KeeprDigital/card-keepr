#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  apiCapabilities,
  ingestionCapabilities,
} from "../src/runtime-capabilities.mjs";
import { runCatalogueCommand } from "./catalogue.mjs";
import {
  exitCodeForStatus,
  parseOptions,
  runtimeUrl,
  writeCliFailure as writeFailure,
} from "./command-support.mjs";
import { runLegalityStatusCommand } from "./contextual-legality.mjs";
import { runCuratedRevisionCommand } from "./curated-revisions.mjs";
import { validatedProductionTarget } from "./production-target.mjs";
import { runProductionReleaseCommand } from "./production-release.mjs";

export async function main(arguments_, environment) {
  const json = arguments_.includes("--json");
  if (arguments_[0] === "health") {
    if (arguments_.slice(1).some((option) => option !== "--json")) {
      return usageFailure(json);
    }
    return health(environment, json);
  }
  if (arguments_[0] === "status") {
    if (arguments_.slice(1).some((option) => option !== "--json")) {
      return usageFailure(json);
    }
    return administrationRequest(
      environment,
      json,
      "/v1/status",
      "GET",
    );
  }
  if (isCommand(arguments_, "release", "production")) {
    return runProductionReleaseCommand(arguments_.slice(2), environment, json);
  }

  if (isCommand(arguments_, "run", "start")) {
    return startRun(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "run", "show")) {
    return showRun(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "candidate", "inspect")) {
    return inspectCandidate(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "run", "approve")) {
    return approveRun(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "run", "reject")) {
    return rejectRun(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "run", "retry")) {
    return retryRun(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "run", "cleanup")) {
    return cleanupRun(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "run", "reconcile")) {
    return reconcileRun(arguments_.slice(2), environment, json);
  }
  if (
    arguments_[0] === "catalogue" &&
    arguments_[1] === "search" &&
    arguments_[2] === "repair"
  ) {
    return repairCatalogueSearch(
      arguments_.slice(3),
      environment,
      json,
    );
  }
  if (isCommand(arguments_, "backup", "create")) {
    return createBackup(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "backup", "status")) {
    return backupStatus(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "backup", "retry")) {
    return retryBackup(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "recovery", "begin")) {
    return beginRecovery(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "recovery", "inspect")) {
    return inspectRecovery(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "recovery", "verify")) {
    return verifyRecovery(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "recovery", "accept")) {
    return acceptRecovery(arguments_.slice(2), environment, json);
  }
  if (
    arguments_[0] === "catalogue-export" &&
    arguments_[1] === "deletion"
  ) {
    return catalogueExportDeletion(
      arguments_[2],
      arguments_.slice(3),
      environment,
      json,
    );
  }
  if (isCommand(arguments_, "source", "collect")) {
    return collectSource(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "source", "show")) {
    return showSourceEvidence(arguments_.slice(2), environment, json);
  }
  if (
    arguments_[0] === "source" &&
    arguments_[1] === "capacity" &&
    arguments_[2] === "extend"
  ) {
    return extendSourceCapacity(arguments_.slice(3), environment, json);
  }
  if (isCommand(arguments_, "source", "pause")) {
    return pauseEvidenceCollection(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "source", "resume")) {
    return resumeEvidenceCollection(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "source", "terminate")) {
    return terminateEvidenceCollection(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "source", "retry")) {
    return retryEvidenceCollection(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "snapshot", "reparse")) {
    return reparseSourceSnapshot(arguments_.slice(2), environment, json);
  }
  if (arguments_[0] === "cards") {
    return runCatalogueCommand(
      arguments_.slice(1),
      environment,
      json,
    );
  }
  if (isCommand(arguments_, "legality", "status")) {
    return runLegalityStatusCommand(
      arguments_.slice(2),
      environment,
      json,
    );
  }
  if (arguments_[0] === "curated-revision") {
    return runCuratedRevisionCommand(
      arguments_.slice(1),
      environment,
      json,
    );
  }

  return usageFailure(json);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}

async function health(environment, json) {
  const configuration = readHealthConfiguration(environment);
  if (configuration.error !== null) {
    return writeFailure(
      json,
      {
        code: "configuration_error",
        detail: configuration.error,
      },
      2,
    );
  }

  const results = await Promise.all(
    configuration.runtimes.map(async (runtime) => checkRuntime(runtime)),
  );
  const failure = results.find((result) => !result.ok);
  if (failure !== undefined) {
    return writeFailure(json, failure, failure.exitCode);
  }

  const document = {
    contract: "card-keepr-cli-health@1",
    status: "ok",
    runtimes: results.map((result) => result.health),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else {
    process.stdout.write("Card Keepr runtimes are healthy\n");
    for (const runtime of document.runtimes) {
      process.stdout.write(
        `${runtime.name}: ${runtime.status} (${runtime.capabilities.join(", ")})\n`,
      );
    }
  }
  return 0;
}

async function startRun(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--fixture",
    "--games",
    "--idempotency-key",
  ]);
  if (
    options.error !== null ||
    options.values["--fixture"] === undefined ||
    options.values["--games"] === undefined ||
    options.values["--idempotency-key"] === undefined
  ) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    "/v1/ingestion-runs",
    "POST",
    {
      fixture: options.values["--fixture"],
      selected_games: options.values["--games"]
        .split(",")
        .map((game) => game.trim())
        .filter(Boolean),
      idempotency_key: options.values["--idempotency-key"],
    },
  );
}

async function showRun(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--run-id"]);
  const runId = options.values["--run-id"];
  if (options.error !== null || runId === undefined) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}`,
    "GET",
  );
}

async function inspectCandidate(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--run-id"]);
  const runId = options.values["--run-id"];
  if (options.error !== null || runId === undefined) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}/candidate`,
    "GET",
  );
}

async function approveRun(arguments_, environment, json) {
  const options = parseOptions(
    arguments_,
    [
      "--run-id",
      "--candidate-digest",
      "--expected-current-revision",
      "--idempotency-key",
    ],
    ["--yes"],
  );
  const runId = options.values["--run-id"];
  const candidateDigest = options.values["--candidate-digest"];
  const expectedCurrentRevision =
    options.values["--expected-current-revision"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (
    options.error !== null ||
    runId === undefined ||
    candidateDigest === undefined ||
    expectedCurrentRevision === undefined ||
    idempotencyKey === undefined ||
    !options.flags.has("--yes")
  ) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}/approval`,
    "POST",
    {
      candidate_digest: candidateDigest,
      expected_current_revision_id: expectedCurrentRevision,
      idempotency_key: idempotencyKey,
    },
  );
}

async function rejectRun(arguments_, environment, json) {
  const options = parseOptions(
    arguments_,
    [
      "--run-id",
      "--candidate-digest",
      "--idempotency-key",
    ],
    ["--yes"],
  );
  const runId = options.values["--run-id"];
  const candidateDigest = options.values["--candidate-digest"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (
    options.error !== null ||
    runId === undefined ||
    candidateDigest === undefined ||
    idempotencyKey === undefined ||
    !options.flags.has("--yes")
  ) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}/rejection`,
    "POST",
    {
      candidate_digest: candidateDigest,
      idempotency_key: idempotencyKey,
    },
  );
}

async function retryRun(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--run-id",
    "--idempotency-key",
  ]);
  const runId = options.values["--run-id"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (
    options.error !== null ||
    runId === undefined ||
    idempotencyKey === undefined
  ) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}/retry`,
    "POST",
    {
      idempotency_key: idempotencyKey,
    },
  );
}

async function cleanupRun(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--run-id",
    "--idempotency-key",
  ]);
  const runId = options.values["--run-id"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (
    options.error !== null ||
    runId === undefined ||
    idempotencyKey === undefined
  ) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(
      runId,
    )}/publication-cleanup`,
    "POST",
    {
      idempotency_key: idempotencyKey,
    },
  );
}

async function reconcileRun(arguments_, environment, json) {
  const options = parseOptions(
    arguments_,
    [
      "--run-id",
      "--expected-current-revision",
      "--idempotency-key",
      "--environment",
      "--confirm",
    ],
    ["--yes"],
  );
  const runId = options.values["--run-id"];
  const expectedCurrentRevision =
    options.values["--expected-current-revision"];
  const idempotencyKey = options.values["--idempotency-key"];
  const target = options.values["--environment"];
  const confirmation = options.values["--confirm"];
  if (
    options.error !== null ||
    runId === undefined ||
    expectedCurrentRevision === undefined ||
    idempotencyKey === undefined ||
    target === undefined ||
    !options.flags.has("--yes")
  ) {
    return usageFailure(json);
  }
  if (target !== "production") {
    return productionTargetFailure(
      json,
      "Reconciliation requires --environment production.",
    );
  }
  const resolved = await resolveReconciliationTarget(
    environment,
    json,
    runId,
    expectedCurrentRevision,
  );
  if (typeof resolved === "number") return resolved;
  const confirmed = confirmProductionTarget(
    json,
    resolved.productionTarget,
    confirmation,
  );
  if (confirmed !== 0) return confirmed;
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}/reconciliation`,
    "POST",
    {
      expected_current_revision_id: expectedCurrentRevision,
      idempotency_key: idempotencyKey,
    },
  );
}

async function repairCatalogueSearch(arguments_, environment, json) {
  const options = parseOptions(
    arguments_,
    [
      "--target-revision",
      "--expected-current-revision",
      "--idempotency-key",
      "--environment",
      "--confirm",
    ],
    ["--yes"],
  );
  const targetRevision = options.values["--target-revision"];
  const expectedCurrentRevision =
    options.values["--expected-current-revision"];
  const idempotencyKey = options.values["--idempotency-key"];
  const target = options.values["--environment"];
  const confirmation = options.values["--confirm"];
  if (
    options.error !== null ||
    targetRevision === undefined ||
    expectedCurrentRevision === undefined ||
    idempotencyKey === undefined ||
    target === undefined ||
    !options.flags.has("--yes")
  ) {
    return usageFailure(json);
  }
  if (target !== "production") {
    return productionTargetFailure(
      json,
      "Card search repair requires --environment production.",
    );
  }
  const resolved = await resolveSearchRepairTarget(
    environment,
    json,
    targetRevision,
    expectedCurrentRevision,
  );
  if (typeof resolved === "number") return resolved;
  const confirmed = confirmProductionTarget(
    json,
    resolved.productionTarget,
    confirmation,
  );
  if (confirmed !== 0) return confirmed;
  return administrationRequest(
    environment,
    json,
    "/v1/catalogue-search-materialization/repair",
    "POST",
    {
      target_revision_id: targetRevision,
      expected_current_revision_id: expectedCurrentRevision,
      idempotency_key: idempotencyKey,
    },
  );
}

async function createBackup(arguments_, environment, json) {
  const options = parseOptions(
    arguments_,
    [
      "--expected-current-revision",
      "--idempotency-key",
      "--environment",
      "--confirm",
    ],
    ["--yes"],
  );
  const expectedCurrentRevision =
    options.values["--expected-current-revision"];
  const idempotencyKey = options.values["--idempotency-key"];
  const target = options.values["--environment"];
  const confirmation = options.values["--confirm"];
  if (
    options.error !== null ||
    expectedCurrentRevision === undefined ||
    idempotencyKey === undefined ||
    target === undefined ||
    !options.flags.has("--yes")
  ) {
    return usageFailure(json);
  }
  if (target !== "production") {
    return productionTargetFailure(
      json,
      "Catalogue backup requires --environment production.",
    );
  }
  const resolved = await resolveProductionStatus(
    environment,
    json,
    expectedCurrentRevision,
  );
  if (typeof resolved === "number") return resolved;
  const confirmed = confirmProductionTarget(
    json,
    {
      production_target: resolved.productionTarget,
      expected_current_revision_id: expectedCurrentRevision,
      idempotency_key: idempotencyKey,
    },
    confirmation,
  );
  if (confirmed !== 0) return confirmed;
  return administrationRequest(
    environment,
    json,
    "/v1/backups",
    "POST",
    {
      expected_current_revision_id: expectedCurrentRevision,
      idempotency_key: idempotencyKey,
    },
  );
}

async function backupStatus(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--attempt-id",
    "--catalogue-revision",
  ]);
  const attemptId = options.values["--attempt-id"];
  const catalogueRevision = options.values["--catalogue-revision"];
  if (
    options.error !== null ||
    (attemptId === undefined) === (catalogueRevision === undefined)
  ) return usageFailure(json);
  return administrationRequest(
    environment,
    json,
    attemptId === undefined
      ? `/v1/catalogue-revisions/${encodeURIComponent(catalogueRevision)}/backups`
      : `/v1/backups/${encodeURIComponent(attemptId)}`,
    "GET",
  );
}

async function retryBackup(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--expected-current-revision",
    "--idempotency-key",
    "--failed-attempt-id",
    "--failed-attempt-digest",
    "--environment",
    "--confirm",
  ], ["--yes"]);
  const expected = options.values["--expected-current-revision"];
  const idempotencyKey = options.values["--idempotency-key"];
  const failedAttemptId = options.values["--failed-attempt-id"];
  const failedAttemptDigest = options.values["--failed-attempt-digest"];
  const target = options.values["--environment"];
  const confirmation = options.values["--confirm"];
  if (
    options.error !== null || expected === undefined ||
    idempotencyKey === undefined || failedAttemptId === undefined ||
    failedAttemptDigest === undefined || target === undefined ||
    !options.flags.has("--yes")
  ) return usageFailure(json);
  if (target !== "production") {
    return productionTargetFailure(
      json,
      "Catalogue backup retry requires --environment production.",
    );
  }
  const resolved = await resolveProductionStatus(environment, json, expected);
  if (typeof resolved === "number") return resolved;
  writeResolvedBackupRetry(json, {
    contract: "card-keepr-resolved-backup-retry@1",
    production_target: resolved.productionTarget,
    current_catalogue_revision_id: expected,
    expected_current_revision_id: expected,
    idempotency_key: idempotencyKey,
    failed_attempt_id: failedAttemptId,
    failed_attempt_digest: failedAttemptDigest,
  });
  const confirmed = confirmProductionTarget(
    json,
    {
      production_target: resolved.productionTarget,
      expected_current_revision_id: expected,
      idempotency_key: idempotencyKey,
      failed_attempt_id: failedAttemptId,
      failed_attempt_digest: failedAttemptDigest,
    },
    confirmation,
  );
  if (confirmed !== 0) return confirmed;
  return administrationRequest(environment, json, "/v1/backups", "POST", {
    expected_current_revision_id: expected,
    idempotency_key: idempotencyKey,
    failed_attempt_id: failedAttemptId,
    failed_attempt_digest: failedAttemptDigest,
  });
}

async function catalogueExportDeletion(action, arguments_, environment, json) {
  if (action === "prepare") {
    const options = parseOptions(arguments_, [
      "--catalogue-revision",
      "--manifest-digest",
      "--expected-current-revision",
      "--plan-id",
    ]);
    const revision = options.values["--catalogue-revision"];
    const manifest = options.values["--manifest-digest"];
    const expected = options.values["--expected-current-revision"];
    const planId = options.values["--plan-id"];
    if (
      options.error !== null || revision === undefined ||
      manifest === undefined || expected === undefined || planId === undefined
    ) return usageFailure(json);
    return administrationRequest(
      environment,
      json,
      "/v1/catalogue-export-deletion-plans",
      "POST",
      {
        catalogue_revision_id: revision,
        manifest_digest: manifest,
        expected_current_revision_id: expected,
        plan_id: planId,
      },
    );
  }
  if (action === "status") {
    const options = parseOptions(arguments_, ["--deletion-id"]);
    const deletionId = options.values["--deletion-id"];
    if (options.error !== null || deletionId === undefined) {
      return usageFailure(json);
    }
    return administrationRequest(
      environment,
      json,
      `/v1/catalogue-export-deletions/${encodeURIComponent(deletionId)}`,
      "GET",
    );
  }
  if (action === "confirm") {
    const options = parseOptions(arguments_, [
      "--plan-id",
      "--plan-digest",
      "--catalogue-revision",
      "--manifest-digest",
      "--expected-current-revision",
      "--confirm-revision",
      "--deletion-id",
      "--idempotency-key",
      "--environment",
      "--confirm",
    ], ["--yes"]);
    const values = options.values;
    const required = [
      "--plan-id", "--plan-digest", "--catalogue-revision",
      "--manifest-digest", "--expected-current-revision",
      "--confirm-revision", "--deletion-id", "--idempotency-key",
      "--environment",
    ];
    if (
      options.error !== null ||
      required.some((name) => values[name] === undefined) ||
      !options.flags.has("--yes")
    ) return usageFailure(json);
    if (values["--environment"] !== "production") {
      return productionTargetFailure(
        json,
        "Catalogue Export deletion requires --environment production.",
      );
    }
    const resolved = await resolveProductionStatus(
      environment,
      json,
      values["--expected-current-revision"],
    );
    if (typeof resolved === "number") return resolved;
    const confirmation = {
      production_target: resolved.productionTarget,
      plan_id: values["--plan-id"],
      plan_digest: values["--plan-digest"],
      catalogue_revision_id: values["--catalogue-revision"],
      manifest_digest: values["--manifest-digest"],
      expected_current_revision_id: values["--expected-current-revision"],
      deletion_id: values["--deletion-id"],
      idempotency_key: values["--idempotency-key"],
    };
    const confirmed = confirmProductionTarget(
      json,
      confirmation,
      values["--confirm"],
    );
    if (confirmed !== 0) return confirmed;
    return administrationRequest(
      environment,
      json,
      "/v1/catalogue-export-deletions",
      "POST",
      {
        plan_id: values["--plan-id"],
        plan_digest: values["--plan-digest"],
        catalogue_revision_id: values["--catalogue-revision"],
        manifest_digest: values["--manifest-digest"],
        expected_current_revision_id: values["--expected-current-revision"],
        confirmation_revision_id: values["--confirm-revision"],
        deletion_id: values["--deletion-id"],
        idempotency_key: values["--idempotency-key"],
      },
    );
  }
  if (action === "retry") {
    const options = parseOptions(arguments_, [
      "--deletion-id",
      "--object-set-digest",
      "--expected-current-revision",
      "--idempotency-key",
      "--environment",
      "--confirm",
    ], ["--yes"]);
    const values = options.values;
    const required = [
      "--deletion-id", "--object-set-digest", "--expected-current-revision",
      "--idempotency-key", "--environment",
    ];
    if (
      options.error !== null ||
      required.some((name) => values[name] === undefined) ||
      !options.flags.has("--yes")
    ) return usageFailure(json);
    if (values["--environment"] !== "production") {
      return productionTargetFailure(
        json,
        "Catalogue Export deletion retry requires --environment production.",
      );
    }
    const resolved = await resolveProductionStatus(
      environment,
      json,
      values["--expected-current-revision"],
    );
    if (typeof resolved === "number") return resolved;
    const confirmation = {
      production_target: resolved.productionTarget,
      deletion_id: values["--deletion-id"],
      object_set_digest: values["--object-set-digest"],
      expected_current_revision_id: values["--expected-current-revision"],
      idempotency_key: values["--idempotency-key"],
    };
    const confirmed = confirmProductionTarget(
      json,
      confirmation,
      values["--confirm"],
    );
    if (confirmed !== 0) return confirmed;
    return administrationRequest(
      environment,
      json,
      `/v1/catalogue-export-deletions/${encodeURIComponent(values["--deletion-id"])}/retry`,
      "POST",
      {
        object_set_digest: values["--object-set-digest"],
        idempotency_key: values["--idempotency-key"],
      },
    );
  }
  return usageFailure(json);
}

function writeResolvedBackupRetry(json, resolved) {
  if (json) {
    process.stderr.write(`${JSON.stringify(resolved)}\n`);
    return;
  }
  process.stderr.write(
    `Resolved backup retry ${JSON.stringify(resolved)}\n`,
  );
}

async function beginRecovery(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--recovery-id",
    "--method",
    "--target-revision",
    "--target-bookmark",
    "--target-digest",
    "--backup-attempt-id",
    "--expected-current-revision",
    "--idempotency-key",
    "--linked-operation-id",
    "--environment",
    "--confirm",
  ], ["--yes"]);
  const recoveryId = options.values["--recovery-id"];
  const method = options.values["--method"];
  const targetRevision = options.values["--target-revision"];
  const targetBookmark = options.values["--target-bookmark"];
  const targetDigest = options.values["--target-digest"];
  const backupAttemptId = options.values["--backup-attempt-id"];
  const expectedCurrentRevision =
    options.values["--expected-current-revision"];
  const idempotencyKey = options.values["--idempotency-key"];
  const linkedOperationId = options.values["--linked-operation-id"];
  const target = options.values["--environment"];
  const confirmation = options.values["--confirm"];
  if (
    options.error !== null || recoveryId === undefined ||
    !["time_travel", "replacement_database"].includes(method) ||
    targetRevision === undefined || targetBookmark === undefined ||
    targetDigest === undefined || backupAttemptId === undefined ||
    expectedCurrentRevision === undefined || idempotencyKey === undefined ||
    target === undefined || !options.flags.has("--yes")
  ) return usageFailure(json);
  if (target !== "production") {
    return productionTargetFailure(
      json,
      "Catalogue recovery requires --environment production.",
    );
  }
  const resolved = await resolveProductionStatus(
    environment,
    json,
    expectedCurrentRevision,
  );
  if (typeof resolved === "number") return resolved;
  const request = {
    environment: "production",
    recovery_id: recoveryId,
    method,
    target_revision_id: targetRevision,
    target_bookmark: targetBookmark,
    target_digest: targetDigest,
    backup_attempt_id: backupAttemptId,
    expected_current_revision_id: expectedCurrentRevision,
    idempotency_key: idempotencyKey,
    ...(linkedOperationId === undefined
      ? {}
      : { linked_operation_id: linkedOperationId }),
  };
  const confirmed = confirmProductionTarget(json, {
    production_target: resolved.productionTarget,
    ...request,
  }, confirmation);
  if (confirmed !== 0) return confirmed;
  return administrationRequest(
    environment,
    json,
    "/v1/recoveries",
    "POST",
    request,
  );
}

async function inspectRecovery(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--recovery-id"]);
  const recoveryId = options.values["--recovery-id"];
  if (options.error !== null || recoveryId === undefined) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/recoveries/${encodeURIComponent(recoveryId)}`,
    "GET",
  );
}

async function verifyRecovery(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--recovery-id",
    "--target-digest",
    "--idempotency-key",
    "--environment",
    "--confirm",
  ], ["--yes"]);
  const recoveryId = options.values["--recovery-id"];
  const targetDigest = options.values["--target-digest"];
  const idempotencyKey = options.values["--idempotency-key"];
  const target = options.values["--environment"];
  const confirmation = options.values["--confirm"];
  if (
    options.error !== null || recoveryId === undefined ||
    targetDigest === undefined || idempotencyKey === undefined ||
    target === undefined || !options.flags.has("--yes")
  ) return usageFailure(json);
  if (target !== "production") {
    return productionTargetFailure(
      json,
      "Catalogue recovery verification requires --environment production.",
    );
  }
  const resolved = await resolveRecoveryTarget(
    environment,
    json,
    recoveryId,
    targetDigest,
  );
  if (typeof resolved === "number") return resolved;
  const request = {
    target_digest: targetDigest,
    idempotency_key: idempotencyKey,
  };
  const confirmed = confirmProductionTarget(json, {
    production_target: resolved.productionTarget,
    recovery_id: recoveryId,
    ...request,
  }, confirmation);
  if (confirmed !== 0) return confirmed;
  return administrationRequest(
    environment,
    json,
    `/v1/recoveries/${encodeURIComponent(recoveryId)}/verification`,
    "POST",
    request,
  );
}

async function acceptRecovery(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--recovery-id",
    "--expected-restored-revision",
    "--target-digest",
    "--confirmation-recovery-id",
    "--idempotency-key",
    "--environment",
    "--confirm",
  ], ["--yes"]);
  const recoveryId = options.values["--recovery-id"];
  const expectedRestoredRevision =
    options.values["--expected-restored-revision"];
  const targetDigest = options.values["--target-digest"];
  const confirmationRecoveryId =
    options.values["--confirmation-recovery-id"];
  const idempotencyKey = options.values["--idempotency-key"];
  const target = options.values["--environment"];
  const confirmation = options.values["--confirm"];
  if (
    options.error !== null || recoveryId === undefined ||
    expectedRestoredRevision === undefined || targetDigest === undefined ||
    confirmationRecoveryId === undefined || idempotencyKey === undefined ||
    target === undefined || !options.flags.has("--yes")
  ) return usageFailure(json);
  if (target !== "production") {
    return productionTargetFailure(
      json,
      "Catalogue recovery acceptance requires --environment production.",
    );
  }
  const resolved = await resolveRecoveryTarget(
    environment,
    json,
    recoveryId,
    targetDigest,
    expectedRestoredRevision,
  );
  if (typeof resolved === "number") return resolved;
  const request = {
    expected_restored_revision_id: expectedRestoredRevision,
    target_digest: targetDigest,
    confirmation_recovery_id: confirmationRecoveryId,
    idempotency_key: idempotencyKey,
  };
  const confirmed = confirmProductionTarget(json, {
    production_target: resolved.productionTarget,
    recovery_id: recoveryId,
    ...request,
  }, confirmation);
  if (confirmed !== 0) return confirmed;
  return administrationRequest(
    environment,
    json,
    `/v1/recoveries/${encodeURIComponent(recoveryId)}/acceptance`,
    "POST",
    request,
  );
}

async function collectSource(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--game",
    "--lineage",
    "--adapter",
    "--request-id",
    "--url",
    "--plan-file",
    "--idempotency-key",
  ]);
  const planFile = options.values["--plan-file"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (
    options.error === null &&
    planFile !== undefined &&
    idempotencyKey !== undefined &&
    [
      "--game",
      "--lineage",
      "--adapter",
      "--request-id",
      "--url",
    ].every((option) => options.values[option] === undefined)
  ) {
    let planDocument;
    try {
      planDocument = JSON.parse(await readFile(planFile, "utf8"));
    } catch {
      return usageFailure(json);
    }
    if (
      planDocument === null ||
      typeof planDocument !== "object" ||
      Array.isArray(planDocument) ||
      !Array.isArray(planDocument.plans)
    ) {
      return usageFailure(json);
    }
    return administrationRequest(
      environment,
      json,
      "/v1/ingestion-runs/evidence",
      "POST",
      {
        plans: planDocument.plans,
        idempotency_key: idempotencyKey,
      },
    );
  }
  const game = options.values["--game"];
  const lineage = options.values["--lineage"];
  const adapter = options.values["--adapter"];
  const requestId = options.values["--request-id"];
  const url = options.values["--url"];
  if (
    options.error !== null ||
    planFile !== undefined ||
    game === undefined ||
    lineage === undefined ||
    adapter === undefined ||
    requestId === undefined ||
    url === undefined ||
    idempotencyKey === undefined
  ) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: game,
      source_lineage: lineage,
      adapter_version: adapter,
      idempotency_key: idempotencyKey,
      requests: [{ id: requestId, url }],
    },
  );
}

async function showSourceEvidence(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--run-id"]);
  const runId = options.values["--run-id"];
  if (options.error !== null || runId === undefined) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}/evidence`,
    "GET",
  );
}

// The compare-and-set numbers of a capacity extension travel as JSON
// integers, so the CLI accepts only canonical positive decimal digits.
function parsedCapacityInteger(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function extendSourceCapacity(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--run-id",
    "--expected-capacity",
    "--expected-generation",
    "--capacity",
    "--idempotency-key",
  ]);
  const runId = options.values["--run-id"];
  const expectedCapacity = parsedCapacityInteger(
    options.values["--expected-capacity"],
  );
  const expectedGeneration = parsedCapacityInteger(
    options.values["--expected-generation"],
  );
  const capacity = parsedCapacityInteger(options.values["--capacity"]);
  const idempotencyKey = options.values["--idempotency-key"];
  if (
    options.error !== null ||
    runId === undefined ||
    expectedCapacity === null ||
    expectedGeneration === null ||
    capacity === null ||
    idempotencyKey === undefined
  ) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}/capacity/extension`,
    "POST",
    {
      expected_request_capacity: expectedCapacity,
      expected_capacity_generation: expectedGeneration,
      request_capacity: capacity,
      idempotency_key: idempotencyKey,
    },
  );
}

async function resumeEvidenceCollection(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--run-id"]);
  const runId = options.values["--run-id"];
  if (options.error !== null || runId === undefined) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}/collection/resume`,
    "POST",
  );
}

// An owner pause stops a collecting Ingestion Run deliberately: the run
// enters its Workflow Pause with the reason owner_requested, retains every
// evidence object, and then resumes or is terminated. It is idempotent under
// its key.
async function pauseEvidenceCollection(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--run-id",
    "--idempotency-key",
  ]);
  const runId = options.values["--run-id"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (
    options.error !== null ||
    runId === undefined ||
    idempotencyKey === undefined
  ) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}/collection/pause`,
    "POST",
    { idempotency_key: idempotencyKey },
  );
}

// Termination is the owner's deliberate decision to abandon a paused
// Ingestion Run: it is idempotent under its key and releases the single
// active-run reservation while retaining every evidence object.
async function terminateEvidenceCollection(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--run-id",
    "--idempotency-key",
  ]);
  const runId = options.values["--run-id"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (
    options.error !== null ||
    runId === undefined ||
    idempotencyKey === undefined
  ) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}/collection/termination`,
    "POST",
    { idempotency_key: idempotencyKey },
  );
}

async function retryEvidenceCollection(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--run-id",
    "--idempotency-key",
  ]);
  const runId = options.values["--run-id"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (
    options.error !== null ||
    runId === undefined ||
    idempotencyKey === undefined
  ) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}/collection/retry`,
    "POST",
    { idempotency_key: idempotencyKey },
  );
}

async function reparseSourceSnapshot(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--snapshot-id",
    "--adapter",
    "--idempotency-key",
  ]);
  const snapshotId = options.values["--snapshot-id"];
  const adapter = options.values["--adapter"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (
    options.error !== null ||
    snapshotId === undefined ||
    adapter === undefined ||
    idempotencyKey === undefined
  ) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/source-snapshots/${encodeURIComponent(snapshotId)}/observations`,
    "POST",
    {
      adapter_version: adapter,
      idempotency_key: idempotencyKey,
    },
  );
}

async function administrationRequest(
  environment,
  json,
  pathname,
  method,
  body,
) {
  const observed = await fetchAdministrationDocument(
    environment,
    pathname,
    method,
    body,
  );
  if (observed.error !== null) {
    return writeFailure(
      json,
      observed.error,
      observed.exitCode,
    );
  }
  const document = observed.document;
  if (json) {
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else {
    process.stdout.write(`${formatAdministrationResult(document)}\n`);
  }
  const incomplete =
    (document.contract ===
      "card-keepr-reconciliation-workflow@1" &&
      document.status !== "complete"
    ) ||
    (document.contract ===
      "card-keepr-catalogue-backup-workflow@1" &&
      document.status !== "complete"
    ) ||
    (document.contract ===
      "card-keepr-card-search-repair@1" &&
      document.complete !== true) ||
    (document.contract === "card-keepr-catalogue-export-deletion@1" &&
      document.state === "deleting" && observed.responseStatus === 202);
  return incomplete ? 10 : 0;
}

async function fetchAdministrationDocument(
  environment,
  pathname,
  method = "GET",
  body,
) {
  const configuration = readAdministrationConfiguration(environment);
  if (configuration.error !== null) {
    return {
      error: {
        code: "configuration_error",
        detail: configuration.error,
      },
      exitCode: 2,
      document: null,
    };
  }
  let response;
  try {
    response = await fetch(runtimeUrl(configuration.url, pathname), {
      method,
      headers: {
        authorization: `Bearer ${configuration.key}`,
        ...(configuration.testNow === undefined
          ? {}
          : { "x-keepr-test-now": configuration.testNow }),
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return {
      error: {
        code: "runtime_unavailable",
        detail: "ingestion runtime is unavailable",
        runtime: "ingestion",
      },
      exitCode: 9,
      document: null,
    };
  }

  let document;
  try {
    document = await response.json();
  } catch {
    return {
      error: {
        code: "invalid_administration_contract",
        detail: "ingestion runtime returned invalid JSON",
        runtime: "ingestion",
      },
      exitCode: 8,
      document: null,
    };
  }
  if (!response.ok) {
    const code =
      typeof document?.code === "string"
        ? document.code
        : "administration_error";
    const detail =
      typeof document?.detail === "string"
        ? document.detail
        : `ingestion runtime returned HTTP ${response.status}`;
    return {
      error: { code, detail },
      exitCode: exitCodeForStatus(response.status),
      document: null,
    };
  }
  return {
    error: null,
    exitCode: 0,
    responseStatus: response.status,
    document,
  };
}

async function resolveReconciliationTarget(
  environment,
  json,
  runId,
  expectedCurrentRevision,
) {
  const run = await fetchAdministrationDocument(
    environment,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}`,
  );
  const failedRun = writeObservedFailure(run, json);
  if (failedRun !== null) return failedRun;
  if (
    run.document?.id !== runId ||
    run.document?.expected_current_revision_id !== expectedCurrentRevision
  ) {
    return resolvedTargetFailure(
      json,
      "The production Ingestion Run does not resolve to the supplied run and expected Catalogue Revision.",
    );
  }
  return resolveProductionStatus(
    environment,
    json,
    expectedCurrentRevision,
  );
}

async function resolveSearchRepairTarget(
  environment,
  json,
  targetRevision,
  expectedCurrentRevision,
) {
  const resolved = await resolveProductionStatus(
    environment,
    json,
    expectedCurrentRevision,
  );
  if (typeof resolved === "number") return resolved;
  const repairableRevisionIds = validatedRepairableRevisionIds(
    resolved.repairableRevisionIds,
    expectedCurrentRevision,
  );
  if (repairableRevisionIds === null) {
    return writeFailure(
      json,
      {
        code: "invalid_administration_contract",
        detail:
          "Production status did not expose the authoritative retained revision chain.",
      },
      8,
    );
  }
  if (!repairableRevisionIds.includes(targetRevision)) {
    return resolvedTargetFailure(
      json,
      "The target Catalogue Revision was not resolved from the authoritative retained revision chain.",
    );
  }
  return resolved;
}

async function resolveRecoveryTarget(
  environment,
  json,
  recoveryId,
  targetDigest,
  expectedRestoredRevision,
) {
  const observed = await fetchAdministrationDocument(
    environment,
    `/v1/recoveries/${encodeURIComponent(recoveryId)}`,
  );
  const failed = writeObservedFailure(observed, json);
  if (failed !== null) return failed;
  const recovery = observed.document;
  if (
    recovery?.id !== recoveryId || recovery?.target_digest !== targetDigest ||
    (expectedRestoredRevision !== undefined &&
      recovery?.target_revision_id !== expectedRestoredRevision) ||
    typeof recovery?.expected_current_revision_id !== "string"
  ) {
    return resolvedTargetFailure(
      json,
      "The production recovery operation does not match the supplied exact target evidence.",
    );
  }
  const status = await fetchAdministrationDocument(environment, "/v1/status");
  const failedStatus = writeObservedFailure(status, json);
  if (failedStatus !== null) return failedStatus;
  const currentRevision = status.document?.safe_state?.current_revision_id;
  if (
    currentRevision !== recovery.expected_current_revision_id &&
    currentRevision !== recovery.target_revision_id
  ) {
    return resolvedTargetFailure(
      json,
      "Production does not resolve to either the recovery source or restored Catalogue Revision.",
    );
  }
  const productionTarget = validatedProductionTarget(
    status.document?.production_target,
  );
  if (productionTarget === null) {
    return writeFailure(
      json,
      {
        code: "invalid_administration_contract",
        detail:
          "Production status did not expose exact Cloudflare target identities.",
      },
      8,
    );
  }
  return { productionTarget };
}

async function resolveProductionStatus(
  environment,
  json,
  expectedCurrentRevision,
) {
  const status = await fetchAdministrationDocument(
    environment,
    "/v1/status",
  );
  const failedStatus = writeObservedFailure(status, json);
  if (failedStatus !== null) return failedStatus;
  const currentRevision = status.document?.safe_state?.current_revision_id;
  if (currentRevision !== expectedCurrentRevision) {
    return resolvedTargetFailure(
      json,
      `Production currently resolves to Catalogue Revision ${
        typeof currentRevision === "string" ? currentRevision : "unknown"
      }, not ${expectedCurrentRevision}.`,
    );
  }
  const productionTarget = validatedProductionTarget(
    status.document?.production_target,
  );
  const repairableRevisionIds =
    status.document?.repairable_catalogue_revision_ids;
  if (productionTarget === null) {
    return writeFailure(
      json,
      {
        code: "invalid_administration_contract",
        detail:
          "Production status did not expose exact Cloudflare target identities.",
      },
      8,
    );
  }
  return { productionTarget, repairableRevisionIds };
}

function validatedRepairableRevisionIds(value, currentRevision) {
  if (
    !Array.isArray(value) ||
    value.length > 3 ||
    (value.length > 0 && value[0] !== currentRevision) ||
    !value.every(
      (revision) =>
        typeof revision === "string" &&
        /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(revision),
    )
  ) {
    return null;
  }
  return value;
}

function confirmProductionTarget(json, productionTarget, confirmation) {
  const required = JSON.stringify(productionTarget);
  if (confirmation === required) return 0;
  return writeFailure(
    json,
    {
      code: "confirmation_required",
      detail:
        `Resolved production target ${required}. ` +
        `Re-run with --confirm '${required}'.`,
    },
    3,
  );
}

function sameKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    expected.slice().sort().every((key, index) => key === keys[index]);
}

function sameStringArray(value, expected) {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function writeObservedFailure(observed, json) {
  return observed.error === null
    ? null
    : writeFailure(json, observed.error, observed.exitCode);
}

function readHealthConfiguration(environment) {
  const required = [
    "KEEPR_API_KEY",
    "KEEPR_ADMINISTRATION_KEY",
  ];
  const missing = required.filter((name) => !environment[name]);
  if (missing.length > 0) {
    return {
      error: `Missing required environment: ${missing.join(", ")}`,
      runtimes: [],
    };
  }
  return {
    error: null,
    runtimes: [
      {
        name: "api",
        url: environment.KEEPR_API_URL ?? "http://127.0.0.1:8787",
        key: environment.KEEPR_API_KEY,
        capabilities: apiCapabilities,
      },
      {
        name: "ingestion",
        url: environment.KEEPR_INGESTION_URL ?? "http://127.0.0.1:8788",
        key: environment.KEEPR_ADMINISTRATION_KEY,
        capabilities: ingestionCapabilities,
      },
    ],
  };
}

function readAdministrationConfiguration(environment) {
  if (!environment.KEEPR_ADMINISTRATION_KEY) {
    return {
      error: "Missing required environment: KEEPR_ADMINISTRATION_KEY",
      url: "",
      key: "",
      testNow: undefined,
    };
  }
  return {
    error: null,
    url: environment.KEEPR_INGESTION_URL ?? "http://127.0.0.1:8788",
    key: environment.KEEPR_ADMINISTRATION_KEY,
    testNow: environment.KEEPR_TEST_NOW,
  };
}

function isCommand(arguments_, first, second) {
  return arguments_[0] === first && arguments_[1] === second;
}

function usageFailure(json) {
  return writeFailure(
    json,
    {
      code: "usage_error",
      detail:
        "Usage: keepr health | status | cards search | catalogue search repair | catalogue-export deletion prepare | catalogue-export deletion confirm | catalogue-export deletion status | catalogue-export deletion retry | backup create | backup status | backup retry | recovery begin | recovery inspect | recovery verify | recovery accept | run start | run show | candidate inspect | run reconcile | run approve | run reject | run retry | run cleanup | source collect | source show | source pause | source resume | source terminate | source retry | source capacity extend | snapshot reparse | legality status | curated-revision validate | curated-revision list | curated-revision show | curated-revision create | curated-revision reaffirm | curated-revision supersede | curated-revision retire",
    },
    2,
  );
}

function productionTargetFailure(json, detail) {
  return writeFailure(
    json,
    { code: "production_target_required", detail },
    2,
  );
}

function resolvedTargetFailure(json, detail) {
  return writeFailure(
    json,
    { code: "production_target_mismatch", detail },
    7,
  );
}

function formatAdministrationResult(document) {
  if (document.contract === "card-keepr-administration-status@1") {
    return formatStatus(document);
  }
  if (document.contract === "card-keepr-capacity-extension@1") {
    return formatCapacityExtension(document);
  }
  if (document.contract === "card-keepr-collection-pause@1") {
    return formatCollectionPause(document);
  }
  if (document.contract === "card-keepr-collection-termination@1") {
    return formatCollectionTermination(document);
  }
  if (
    Array.isArray(document.snapshots) &&
    Array.isArray(document.observation_sets) &&
    Array.isArray(document.diagnostics) &&
    document.state &&
    document.id
  ) {
    const lines = [
      `Ingestion Run ${document.id} evidence: ${document.state}`,
      ...formatEvidenceVolume(document),
    ];
    lines.push(...formatEvidencePause(document.pause));
    lines.push(...formatEvidenceTermination(document.termination));
    lines.push(...formatCollectionProgress(document.collection));
    lines.push(...formatEvidenceWorkflow(document.workflow));
    lines.push(...formatEvidenceActions(document.actions ?? document.pause?.actions));
    const requestId = safeDiagnosticReference(
      document.operational_diagnostics?.references?.request_id,
    );
    if (requestId !== null) lines.push(`Request reference: ${requestId}`);
    return lines.join("; ");
  }
  if (
    document.source_snapshot_id &&
    document.adapter_version &&
    document.id
  ) {
    return `Source Observation set ${document.id} for Source Snapshot ${document.source_snapshot_id} (${document.adapter_version})`;
  }
  if (document.state && document.id) {
    return formatRun(document);
  }
  if (document.run_id && document.candidate_digest) {
    return `Candidate ${document.candidate_digest} for Ingestion Run ${document.run_id}`;
  }
  return JSON.stringify(document);
}

function formatCount(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Evidence volume prefers the aggregate counts of the collection block: the
// per-request detail lists are bounded, so their lengths understate a
// production-sized run.
function formatEvidenceVolume(document) {
  const evidence = document.collection?.evidence;
  if (
    typeof evidence === "object" && evidence !== null &&
    Number.isSafeInteger(evidence.snapshot_count) &&
    Number.isSafeInteger(evidence.observation_set_count) &&
    Number.isSafeInteger(evidence.fetch_attempt_count)
  ) {
    return [
      `${formatCount(evidence.snapshot_count, "Source Snapshot")}${
        Number.isSafeInteger(evidence.retained_byte_total)
          ? ` (${evidence.retained_byte_total} bytes)`
          : ""
      }`,
      formatCount(evidence.observation_set_count, "Source Observation set"),
      `${formatCount(evidence.fetch_attempt_count, "fetch attempt")}${
        Number.isSafeInteger(evidence.retry_attempt_count) &&
          Number.isSafeInteger(evidence.failed_attempt_count)
          ? ` (${evidence.retry_attempt_count} ${
            evidence.retry_attempt_count === 1 ? "retry" : "retries"
          }, ${formatCount(evidence.failed_attempt_count, "failure")})`
          : ""
      }`,
    ];
  }
  return [
    formatCount(document.snapshots.length, "Source Snapshot"),
    formatCount(document.observation_sets.length, "Source Observation set"),
    formatCount(document.diagnostics.length, "diagnostic"),
  ];
}

function formatCountMap(map) {
  if (typeof map !== "object" || map === null) return "";
  return Object.entries(map)
    .filter(([key, value]) =>
      safeMachineCode(key) !== null && Number.isSafeInteger(value)
    )
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;
}

// The aggregated collection progress: request counts by state and role,
// per-lineage capacity, the latest safe failure, the current safe request
// reference, host pacing, the advisory remaining-time floor, and the
// lifecycle timestamps. Human output carries the same material facts as the
// JSON document, in the same closed vocabulary.
function formatCollectionProgress(collection) {
  if (typeof collection !== "object" || collection === null) return [];
  const lines = [];
  const requests = collection.requests;
  if (
    typeof requests === "object" && requests !== null &&
    Number.isSafeInteger(requests.total)
  ) {
    const groups = [
      formatCountMap(requests.by_state),
      formatCountMap(requests.by_role),
    ].filter((group) => group !== "");
    lines.push(
      `Requests: ${requests.total}${
        groups.length === 0 ? "" : ` (${groups.join("; ")})`
      }`,
    );
    // Per-lineage counts only add information when a run spans lineages.
    const byLineage = Array.isArray(requests.by_lineage)
      ? requests.by_lineage
      : [];
    if (byLineage.length > 1) {
      for (const group of byLineage) {
        const lineage = safeDiagnosticReference(group?.source_lineage);
        if (lineage === null || !Number.isSafeInteger(group.total)) continue;
        const lineageGroups = [
          formatCountMap(group.by_state),
          formatCountMap(group.by_role),
        ].filter((part) => part !== "");
        lines.push(
          `Requests ${lineage}: ${group.total}${
            lineageGroups.length === 0 ? "" : ` (${lineageGroups.join("; ")})`
          }`,
        );
      }
    }
  }
  for (const capacity of Array.isArray(collection.capacity) ? collection.capacity : []) {
    const lineage = safeDiagnosticReference(capacity?.source_lineage);
    if (
      lineage === null ||
      !Number.isSafeInteger(capacity.used_capacity) ||
      !Number.isSafeInteger(capacity.request_capacity) ||
      !Number.isSafeInteger(capacity.capacity_generation)
    ) {
      continue;
    }
    const details = [`generation ${capacity.capacity_generation}`];
    if (Number.isSafeInteger(capacity.remaining_capacity)) {
      details.push(`${capacity.remaining_capacity} remaining`);
    }
    if (Number.isSafeInteger(capacity.required_capacity)) {
      details.push(`${capacity.required_capacity} required`);
    }
    if (Number.isSafeInteger(capacity.overflow_request_count)) {
      details.push(`${formatCount(capacity.overflow_request_count, "overflow request")}`);
    }
    lines.push(
      `Capacity ${lineage}: ${capacity.used_capacity} used of ${
        capacity.request_capacity
      } (${details.join(", ")})`,
    );
  }
  const evidence = collection.evidence;
  if (
    typeof evidence === "object" && evidence !== null &&
    Number.isSafeInteger(evidence.detail_limit)
  ) {
    const truncated = [
      ["snapshots", evidence.snapshots_truncated],
      ["observation sets", evidence.observation_sets_truncated],
      ["diagnostics", evidence.diagnostics_truncated],
    ].filter(([, flag]) => flag === true).map(([name]) => name);
    if (truncated.length > 0) {
      lines.push(
        `Detail lists bounded to the newest ${evidence.detail_limit}: ${
          truncated.join(", ")
        } truncated`,
      );
    }
  }
  const failure = collection.evidence?.latest_failure;
  if (typeof failure === "object" && failure !== null) {
    const classification = safeMachineCode(failure.classification);
    const requestId = safeDiagnosticReference(failure.request_id);
    if (classification !== null && requestId !== null) {
      const at = safeDiagnosticReference(failure.at);
      lines.push(
        `Latest failure: ${classification}${
          Number.isSafeInteger(failure.http_status)
            ? ` (HTTP ${failure.http_status})`
            : ""
        } on ${requestId}${
          Number.isSafeInteger(failure.attempt_number)
            ? ` attempt ${failure.attempt_number}`
            : ""
        }${at === null ? "" : ` at ${at}`}`,
      );
    }
  }
  const current = collection.progress?.current_request;
  if (typeof current === "object" && current !== null) {
    const requestId = safeDiagnosticReference(current.request_id);
    if (requestId !== null) {
      const facts = [
        safeDiagnosticReference(current.hostname),
        safeMachineCode(current.role),
        safeMachineCode(current.state),
        Number.isSafeInteger(current.attempt_count)
          ? formatCount(current.attempt_count, "attempt")
          : null,
      ].filter((fact) => fact !== null);
      lines.push(
        `Current request: ${requestId}${
          facts.length === 0 ? "" : ` (${facts.join(", ")})`
        }`,
      );
    }
  }
  const pacing = collection.pacing;
  if (typeof pacing === "object" && pacing !== null) {
    const mode = safeMachineCode(pacing.mode);
    if (mode !== null) {
      const hosts = (Array.isArray(pacing.hosts) ? pacing.hosts : [])
        .map((host) => {
          const hostname = safeDiagnosticReference(host?.hostname);
          if (hostname === null || !Number.isSafeInteger(host.pending_request_count)) {
            return null;
          }
          return `${hostname} ${host.pending_request_count} pending${
            Number.isSafeInteger(host.captured_request_count) &&
              host.captured_request_count > 0
              ? `, ${host.captured_request_count} captured`
              : ""
          }${
            Number.isSafeInteger(host.waiting_ms) && host.waiting_ms > 0
              ? ` (waiting ${host.waiting_ms}ms)`
              : ""
          }`;
        })
        .filter((host) => host !== null);
      lines.push(
        `Pacing: ${mode}${
          Number.isSafeInteger(pacing.interval_ms)
            ? ` ${pacing.interval_ms}ms`
            : ""
        }${
          hosts.length === 0
            ? ""
            : `; ${formatCount(hosts.length, "host")}: ${hosts.join(", ")}`
        }`,
      );
    }
  }
  const estimate = collection.estimate;
  if (
    typeof estimate === "object" && estimate !== null &&
    Number.isSafeInteger(estimate.minimum_remaining_ms)
  ) {
    lines.push(
      `Estimated minimum remaining: ${
        formatDuration(estimate.minimum_remaining_ms)
      } (advisory)`,
    );
  }
  const expectedRevision = safeDiagnosticReference(
    collection.expected_catalogue_revision_id,
  );
  if (expectedRevision !== null) {
    lines.push(`Expected Catalogue Revision: ${expectedRevision}`);
  }
  return lines;
}

// The confirmation facts of an applied capacity extension: which Ingestion
// Run and Source Lineage were extended, and how the compare-and-set advanced
// the capacity and its generation.
function formatCapacityExtension(document) {
  const lines = [];
  const runId = safeDiagnosticReference(document.ingestion_run_id);
  if (runId !== null) {
    lines.push(`Ingestion Run ${runId} capacity extended`);
  }
  if (
    Number.isSafeInteger(document.previous_request_capacity) &&
    Number.isSafeInteger(document.request_capacity) &&
    Number.isSafeInteger(document.previous_capacity_generation) &&
    Number.isSafeInteger(document.capacity_generation)
  ) {
    lines.push(
      `Request Capacity: ${document.previous_request_capacity} -> ` +
        `${document.request_capacity} (generation ` +
        `${document.previous_capacity_generation} -> ` +
        `${document.capacity_generation})`,
    );
  }
  const sourceLineage = safeDiagnosticReference(document.source_lineage);
  if (sourceLineage !== null) {
    lines.push(`Source Lineage: ${sourceLineage}`);
  }
  return lines.length === 0 ? JSON.stringify(document) : lines.join("; ");
}

// The minimum pause facts of a paused Ingestion Run: why collection stopped,
// and either the capacity consumption the rejected overflow batch requires
// (a Capacity Pause) or the exhausted request's safe reference, hostname,
// retry generation, and latest safe failure classification (a retry pause).
function formatEvidencePause(pause) {
  if (typeof pause !== "object" || pause === null) return [];
  const lines = [];
  const reason = safeMachineCode(pause.reason);
  const pausedAt = safeDiagnosticReference(pause.paused_at);
  if (reason !== null) {
    lines.push(
      `Paused: ${reason}${pausedAt === null ? "" : ` at ${pausedAt}`}`,
    );
  }
  const sourceLineage = safeDiagnosticReference(pause.source_lineage);
  if (sourceLineage !== null) {
    lines.push(`Source Lineage: ${sourceLineage}`);
  }
  if (
    Number.isSafeInteger(pause.request_capacity) &&
    Number.isSafeInteger(pause.used_capacity) &&
    Number.isSafeInteger(pause.capacity_generation)
  ) {
    lines.push(
      `Request Capacity: ${pause.used_capacity} used of ` +
        `${pause.request_capacity} (generation ${pause.capacity_generation})`,
    );
  }
  if (
    Number.isSafeInteger(pause.overflow_request_count) &&
    Number.isSafeInteger(pause.required_capacity)
  ) {
    lines.push(
      `Overflow: ${
        formatCount(pause.overflow_request_count, "request")
      } require${pause.overflow_request_count === 1 ? "s" : ""} capacity ${
        pause.required_capacity
      }`,
    );
  }
  const parentRequestId = safeDiagnosticReference(pause.parent_request_id);
  if (parentRequestId !== null) {
    lines.push(`Parent request: ${parentRequestId}`);
  }
  // A retry-exhaustion pause identifies the exhausted Source Request and its
  // bounded retry generation instead of lineage capacity facts.
  const requestId = safeDiagnosticReference(pause.request_id);
  if (requestId !== null) lines.push(`Request: ${requestId}`);
  const hostname = safeDiagnosticReference(pause.hostname);
  if (hostname !== null) lines.push(`Hostname: ${hostname}`);
  if (
    Number.isSafeInteger(pause.attempt_count) &&
    Number.isSafeInteger(pause.retry_generation)
  ) {
    lines.push(
      `Attempts: ${pause.attempt_count} in retry generation ` +
        `${pause.retry_generation}`,
    );
  }
  const classification = safeMachineCode(pause.failure_classification);
  if (classification !== null) {
    lines.push(
      `Last failure: ${classification}${
        Number.isSafeInteger(pause.http_status)
          ? ` (HTTP ${pause.http_status})`
          : ""
      }`,
    );
  }
  // A Workflow Pause identifies the abandoned Workflow Attempt, the safe
  // status that classified it, and the deterministic last-progress time the
  // classification was derived from.
  const workflowInstanceId = safeDiagnosticReference(
    pause.workflow_instance_id,
  );
  if (workflowInstanceId !== null) {
    const workflowStatus = safeMachineCode(pause.workflow_status);
    lines.push(
      `Workflow attempt: ${workflowInstanceId}${
        workflowStatus === null ? "" : ` (status ${workflowStatus})`
      }`,
    );
  }
  const lastProgressAt = safeDiagnosticReference(pause.last_progress_at);
  if (lastProgressAt !== null) {
    lines.push(`Last progress: ${lastProgressAt}`);
  }
  return lines;
}

// The exact owner actions the collection lifecycle currently admits, so an
// operator reading the human form sees the same choices automation reads
// from the JSON document.
function formatEvidenceActions(actions) {
  if (!Array.isArray(actions)) return [];
  const safe = actions
    .map((action) => safeMachineCode(action))
    .filter((action) => action !== null);
  return safe.length === 0 ? [] : [`Available actions: ${safe.join(", ")}`];
}

// The retained owner decision of a terminated run: the stable terminal
// reason, when it was taken, and which pause it abandoned.
function formatEvidenceTermination(termination) {
  if (typeof termination !== "object" || termination === null) return [];
  const reason = safeMachineCode(termination.reason);
  if (reason === null) return [];
  const terminatedAt = safeDiagnosticReference(termination.terminated_at);
  const pauseReason = safeMachineCode(termination.pause_reason);
  const pausedAt = safeDiagnosticReference(termination.paused_at);
  const abandoned = pauseReason === null
    ? ""
    : ` (paused ${pauseReason}${pausedAt === null ? "" : ` at ${pausedAt}`})`;
  return [
    `Terminated: ${reason}${
      terminatedAt === null ? "" : ` at ${terminatedAt}`
    }${abandoned}`,
  ];
}

// The confirmation facts of an applied owner pause: which run paused, when,
// which parent Workflow Attempt was abandoned with the safe status observed
// at the time, and the actions the paused run now admits.
function formatCollectionPause(document) {
  const lines = [];
  const runId = safeDiagnosticReference(document.ingestion_run_id);
  if (runId !== null) lines.push(`Ingestion Run ${runId} paused`);
  const pauseReason = safeMachineCode(document.pause_reason);
  const pausedAt = safeDiagnosticReference(document.paused_at);
  if (pauseReason !== null) {
    lines.push(
      `Paused: ${pauseReason}${pausedAt === null ? "" : ` at ${pausedAt}`}`,
    );
  }
  const workflow = typeof document.workflow === "object" &&
      document.workflow !== null
    ? document.workflow
    : {};
  const workflowId = safeDiagnosticReference(workflow.id);
  const status = safeMachineCode(workflow.status);
  if (workflowId !== null) {
    const attempt = Number.isSafeInteger(workflow.attempt_number)
      ? `Workflow attempt ${workflow.attempt_number} (${workflowId})`
      : `Workflow ${workflowId}`;
    lines.push(status === null ? attempt : `${attempt}: ${status}`);
  }
  const lastProgressAt = safeDiagnosticReference(document.last_progress_at);
  if (lastProgressAt !== null) lines.push(`Last progress: ${lastProgressAt}`);
  lines.push(...formatEvidenceActions(document.actions));
  return lines.length === 0 ? JSON.stringify(document) : lines.join("; ");
}

// The confirmation facts of an applied termination: which run became
// terminal, which pause it abandoned, and whether the single active-run
// reservation was released.
function formatCollectionTermination(document) {
  const lines = [];
  const runId = safeDiagnosticReference(document.ingestion_run_id);
  if (runId !== null) lines.push(`Ingestion Run ${runId} terminated`);
  const pauseReason = safeMachineCode(document.pause_reason);
  const pausedAt = safeDiagnosticReference(document.paused_at);
  if (pauseReason !== null) {
    lines.push(
      `Paused: ${pauseReason}${pausedAt === null ? "" : ` at ${pausedAt}`}`,
    );
  }
  const terminatedAt = safeDiagnosticReference(document.terminated_at);
  if (terminatedAt !== null) lines.push(`Terminated at: ${terminatedAt}`);
  if (typeof document.active_run_released === "boolean") {
    lines.push(
      `Active run released: ${document.active_run_released ? "yes" : "no"}`,
    );
  }
  return lines.length === 0 ? JSON.stringify(document) : lines.join("; ");
}

// The collection Workflow observability facts: the current Workflow Attempt
// with its safe status, its stall classification while collecting, and the
// deterministic last-progress time.
function formatEvidenceWorkflow(workflow) {
  if (typeof workflow !== "object" || workflow === null) return [];
  const lines = [];
  const current = workflow.current_attempt;
  if (typeof current === "object" && current !== null) {
    const id = safeDiagnosticReference(current.id);
    if (id !== null && Number.isSafeInteger(current.attempt_number)) {
      const status = safeMachineCode(workflow.status);
      lines.push(
        `Workflow attempt ${current.attempt_number}: ${id}${
          status === null ? "" : ` (status ${status})`
        }`,
      );
    }
  }
  const classification = safeMachineCode(workflow.classification);
  if (classification !== null) {
    lines.push(`Workflow classification: ${classification}`);
  }
  const lastProgressAt = safeDiagnosticReference(workflow.last_progress_at);
  if (lastProgressAt !== null) {
    lines.push(`Last progress: ${lastProgressAt}`);
  }
  if (Array.isArray(workflow.attempts) && workflow.attempts.length > 0) {
    const attempts = workflow.attempts
      .map((attempt) => {
        const id = safeDiagnosticReference(attempt?.id);
        const kind = safeMachineCode(attempt?.kind);
        if (id === null || kind === null) return null;
        return {
          kind,
          current: attempt.current === true,
          text: `${kind} ${id}${
            Number.isSafeInteger(attempt.attempt_number)
              ? ` attempt ${attempt.attempt_number}`
              : ""
          }${
            safeMachineCode(attempt.status) === null
              ? ""
              : ` ${attempt.status}`
          }${attempt.current === true ? " (current)" : ""}`,
        };
      })
      .filter((attempt) => attempt !== null);
    // The current parent attempt already has its own line above.
    const listed = attempts.filter((attempt) =>
      attempt.kind !== "parent" || !attempt.current
    );
    lines.push(
      `Workflow attempts: ${attempts.length} recorded, ${
        attempts.filter((attempt) => attempt.current).length
      } current${
        listed.length === 0
          ? ""
          : `; ${listed.map((attempt) => attempt.text).join("; ")}`
      }`,
    );
  }
  return lines;
}

function formatStatus(document) {
  const safeState = document.safe_state ?? {};
  const lines = [
    `Catalogue Revision: ${safeState.current_revision_id ?? "unknown"}`,
    `Recovery health: ${safeState.recovery_health ?? "unknown"}`,
    `Mutation safe: ${safeState.mutation_safe === true ? "yes" : "no"}`,
    `Active Ingestion Run: ${
      safeState.active_ingestion_run_id ?? "none"
    }`,
    `Active Recovery: ${safeState.active_recovery_id ?? "none"}`,
  ];
  const diagnostics = document.diagnostics ?? {};
  lines.push(
    `Catalogue diagnostics: ${
      diagnostics.catalogue_revision_count ?? "unknown"
    } revisions, ${
      diagnostics.catalogue_export_count ?? "unknown"
    } exports`,
  );
  lines.push(
    `export_objects: ${
      diagnostics.catalogue_export_object_count ?? "unknown"
    }`,
    `orphaned_export_objects: ${
      diagnostics.orphaned_catalogue_export_object_count ?? "unknown"
    }`,
    `pending_publication_cleanups: ${
      diagnostics.pending_publication_cleanup_count ?? "unknown"
    }`,
  );
  const freshness = Array.isArray(document.source_freshness)
    ? document.source_freshness
    : [];
  lines.push("Source freshness:");
  if (freshness.length === 0) {
    lines.push("  none");
  } else {
    for (const item of freshness) {
      const scope = item.area === "legality-rules"
        ? `/${item.source_lineage}/${item.region}`
        : "";
      lines.push(
        `  ${item.game}/${item.area}${scope}: ${item.checked_at} (${item.ingestion_run_id})`,
      );
    }
  }
  const recentRuns = Array.isArray(document.recent_runs)
    ? document.recent_runs
    : [];
  lines.push("Recent Ingestion Runs:");
  if (recentRuns.length === 0) {
    lines.push("  none");
  } else {
    for (const run of recentRuns) {
      lines.push(
        `  ${run.id}: ${run.state} (${
          run.progress?.current_stage ?? "unknown progress"
        })`,
      );
    }
    const nextRunId = safeDiagnosticReference(recentRuns[0]?.id);
    if (nextRunId !== null) {
      lines.push(`Next: keepr run show --run-id ${nextRunId}`);
    }
  }
  return lines.join("\n");
}

function formatRun(document) {
  const lines = [
    `Ingestion Run ${document.id}: ${document.state}`,
    `Progress: ${document.progress?.current_stage ?? "unknown"}`,
  ];
  const completed = Array.isArray(document.progress?.completed_stages)
    ? document.progress.completed_stages
    : [];
  lines.push(
    `Completed stages: ${
      completed.length === 0 ? "none" : completed.join(", ")
    }`,
  );
  const warnings = Array.isArray(document.warnings)
    ? document.warnings
    : [];
  if (warnings.length === 0) {
    lines.push("Warnings: none");
  } else {
    for (const warning of warnings) {
      lines.push(`Warning: ${safeMachineCode(warning.code) ?? "unspecified"}`);
    }
  }
  lines.push(`Failure: ${safeMachineCode(document.failure_code) ?? "none"}`);
  const cleanup = document.publication_cleanup;
  lines.push(
    `Publication cleanup: ${
      cleanup?.state ?? "not required"
    }${
      cleanup?.failure_code
        ? ` (${cleanup.failure_code})`
        : ""
    }`,
  );
  const history = Array.isArray(document.approval_history)
    ? document.approval_history
    : [];
  lines.push(
    `Approval history: ${history.length} ${
      history.length === 1 ? "decision" : "decisions"
    }`,
  );
  for (const decision of history) {
    lines.push(
      `  ${decision.action ?? "decision"} at ${
        decision.approved_at ?? decision.rejected_at ?? "unknown"
      }`,
    );
  }
  lines.push(
    `Publication outcome: ${document.publication_outcome ?? "none"}`,
  );
  lines.push(
    `Resulting Catalogue Revision: ${
      document.resulting_revision_id ?? "none"
    }`,
  );
  appendOperationalDiagnostics(lines, document.operational_diagnostics);
  return lines.join("\n");
}

function appendOperationalDiagnostics(lines, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const references = value.references;
  if (
    references === null || typeof references !== "object" ||
    Array.isArray(references)
  ) return;
  lines.push(
    `Request reference: ${
      safeDiagnosticReference(references.request_id) ?? "none"
    }`,
  );
  const workflow = references.workflow;
  lines.push(
    `Workflow: ${
      workflow !== null && typeof workflow === "object" &&
        !Array.isArray(workflow)
        ? safeDiagnosticReference(workflow.parent_id) ?? "none"
        : "none"
    }`,
  );
  const adapters = Array.isArray(references.adapter_versions)
    ? references.adapter_versions.flatMap((adapter) => {
      const safe = safeDiagnosticReference(adapter);
      return safe === null ? [] : [safe];
    })
    : [];
  lines.push(`Adapter versions: ${adapters.length === 0 ? "none" : adapters.join(", ")}`);
  lines.push(
    `Candidate: ${
      safeDiagnosticReference(references.candidate_digest) ?? "none"
    }`,
  );
  const backup = references.backup;
  lines.push(
    `Backup: ${
      backup !== null && typeof backup === "object" && !Array.isArray(backup)
        ? safeDiagnosticPath(backup.status_path) ?? "none"
        : "none"
    }`,
  );
  const recovery = references.recovery;
  lines.push(
    `Recovery: ${
      recovery !== null && typeof recovery === "object" &&
        !Array.isArray(recovery)
        ? safeDiagnosticPath(recovery.status_path) ?? "none"
        : "none"
    }`,
  );
  const retry = value.retry;
  lines.push(
    `Retry: ${
      retry !== null && typeof retry === "object" && !Array.isArray(retry)
        ? `${safeMachineCode(retry.code) ?? "unclassified"} (${
          safeDiagnosticReference(retry.source_run_id) ?? "unknown"
        })`
        : "not available"
    }`,
  );
  const terminalFailure = value.terminal_evidence?.failure;
  if (
    terminalFailure !== null && typeof terminalFailure === "object" &&
    !Array.isArray(terminalFailure)
  ) {
    lines.push(
      `Retry classification: ${
        safeMachineCode(terminalFailure.retryability_code) ?? "unclassified"
      }`,
    );
  }
  const diagnosis = Array.isArray(value.diagnosis_sequence)
    ? value.diagnosis_sequence.flatMap((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const method = safeDiagnosticMethod(entry.method);
      const path = safeDiagnosticPath(entry.path);
      const code = safeMachineCode(entry.code);
      return method === null || path === null || code === null
        ? []
        : [{ method, path, code }];
    })
    : [];
  for (const entry of diagnosis) {
    lines.push(`Diagnosis: ${entry.method} ${entry.path} (${entry.code})`);
  }
  const retryMethod = retry !== null && typeof retry === "object" &&
      !Array.isArray(retry)
    ? safeDiagnosticMethod(retry.method)
    : null;
  const retryPath = retry !== null && typeof retry === "object" &&
      !Array.isArray(retry)
    ? safeDiagnosticPath(retry.path)
    : null;
  const next = retryMethod !== null && retryPath !== null
    ? { method: retryMethod, path: retryPath }
    : diagnosis[0];
  if (next !== undefined && next !== null) {
    lines.push(`Next: ${next.method} ${next.path}`);
  }
  const evidence = value.terminal_evidence;
  const coverage = evidence !== null && typeof evidence === "object" &&
      !Array.isArray(evidence) && evidence.coverage !== null &&
      typeof evidence.coverage === "object" && !Array.isArray(evidence.coverage)
    ? evidence.coverage
    : {};
  lines.push(
    `Coverage: ${safeDiagnosticCount(coverage.source_snapshot_count)} snapshots, ${
      safeDiagnosticCount(coverage.source_observation_set_count)
    } observation sets, ${safeDiagnosticCount(coverage.fetch_attempt_count)} attempts`,
  );
}

function safeDiagnosticReference(value) {
  return typeof value === "string" && value.length <= 512 &&
      /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/u.test(value)
    ? value
    : null;
}

function safeMachineCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value)
    ? value
    : null;
}

function safeDiagnosticPath(value) {
  return typeof value === "string" && value.length <= 1024 &&
      /^\/v1\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(value)
    ? value
    : null;
}

function safeDiagnosticMethod(value) {
  return value === "GET" || value === "POST" ? value : null;
}

function safeDiagnosticCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : "unknown";
}

async function checkRuntime(runtime) {
  let response;
  try {
    response = await fetch(runtimeUrl(runtime.url, "/health"), {
      headers: {
        authorization: `Bearer ${runtime.key}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return {
      ok: false,
      exitCode: 9,
      code: "runtime_unavailable",
      detail: `${runtime.name} runtime is unavailable`,
      runtime: runtime.name,
    };
  }

  if (response.status === 401) {
    return {
      ok: false,
      exitCode: 4,
      code: "authentication_failed",
      detail: `${runtime.name} runtime rejected its credential`,
      runtime: runtime.name,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      exitCode: 9,
      code: "runtime_error",
      detail: `${runtime.name} runtime returned HTTP ${response.status}`,
      runtime: runtime.name,
    };
  }

  let health;
  try {
    health = await response.json();
  } catch {
    return {
      ok: false,
      exitCode: 8,
      code: "invalid_health_contract",
      detail: `${runtime.name} runtime returned invalid JSON`,
      runtime: runtime.name,
    };
  }
  if (
    health?.contract !== "card-keepr-runtime-health@1" ||
    health.runtime !== runtime.name ||
    health.status !== "ok" ||
    !sameStrings(health.capabilities, runtime.capabilities)
  ) {
    return {
      ok: false,
      exitCode: 8,
      code: "invalid_health_contract",
      detail: `${runtime.name} runtime returned an invalid health contract`,
      runtime: runtime.name,
    };
  }

  return {
    ok: true,
    health: {
      name: runtime.name,
      status: health.status,
      capabilities: health.capabilities,
    },
  };
}

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}
