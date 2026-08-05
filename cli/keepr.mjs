#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  apiCapabilities,
  ingestionCapabilities,
} from "../src/runtime-capabilities.mjs";
import { runCredentialCommand } from "./credential-rotation.mjs";
import { runCatalogueCommand } from "./catalogue.mjs";
import {
  exitCodeForStatus,
  parseOptions,
  writeCliFailure as writeFailure,
} from "./command-support.mjs";
import { runLegalityStatusCommand } from "./contextual-legality.mjs";
import { runCuratedRevisionCommand } from "./curated-revisions.mjs";
import { validatedProductionTarget } from "./production-target.mjs";

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
  if (isCommand(arguments_, "source", "collect")) {
    return collectSource(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "source", "show")) {
    return showSourceEvidence(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "source", "resume")) {
    return resumeEvidenceCollection(arguments_.slice(2), environment, json);
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
  if (arguments_[0] === "credential") {
    return runCredentialCommand(
      arguments_.slice(1),
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

function writeResolvedBackupRetry(json, resolved) {
  if (json) {
    process.stderr.write(`${JSON.stringify(resolved)}\n`);
    return;
  }
  process.stderr.write(
    `Resolved backup retry ${JSON.stringify(resolved)}\n`,
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
      document.complete !== true);
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
    response = await fetch(new URL(pathname, configuration.url), {
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
        "Usage: keepr health | status | cards search | catalogue search repair | backup create | backup status | backup retry | run start | run show | candidate inspect | run reconcile | run approve | run reject | run retry | run cleanup | source collect | source show | source resume | source retry | snapshot reparse | legality status | curated-revision validate | curated-revision list | curated-revision show | curated-revision create | curated-revision reaffirm | curated-revision supersede | curated-revision retire | credential install | credential verify | credential revoke | credential show",
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
  if (
    Array.isArray(document.snapshots) &&
    Array.isArray(document.observation_sets) &&
    Array.isArray(document.diagnostics) &&
    document.state &&
    document.id
  ) {
    const lines = [
      `Ingestion Run ${document.id} evidence: ${document.state}`,
      formatCount(document.snapshots.length, "Source Snapshot"),
      formatCount(
        document.observation_sets.length,
        "Source Observation set",
      ),
      formatCount(document.diagnostics.length, "diagnostic"),
    ];
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

function formatStatus(document) {
  const safeState = document.safe_state ?? {};
  const lines = [
    `Catalogue Revision: ${safeState.current_revision_id ?? "unknown"}`,
    `Recovery health: ${safeState.recovery_health ?? "unknown"}`,
    `Mutation safe: ${safeState.mutation_safe === true ? "yes" : "no"}`,
    `Active Ingestion Run: ${
      safeState.active_ingestion_run_id ?? "none"
    }`,
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
    response = await fetch(new URL("/health", runtime.url), {
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
