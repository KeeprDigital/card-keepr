#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  apiCapabilities,
  ingestionCapabilities,
} from "../src/runtime-capabilities.mjs";
import { runCredentialCommand } from "./credential-rotation.mjs";
import {
  exitCodeForStatus,
  parseOptions,
  writeCliFailure as writeFailure,
} from "./command-support.mjs";

export async function main(
  arguments_,
  environment,
  dependencies,
) {
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
  if (arguments_[0] === "credential") {
    return runCredentialCommand(
      arguments_.slice(1),
      environment,
      json,
      dependencies,
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

async function collectSource(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--game",
    "--lineage",
    "--adapter",
    "--request-id",
    "--url",
    "--idempotency-key",
  ]);
  const game = options.values["--game"];
  const lineage = options.values["--lineage"];
  const adapter = options.values["--adapter"];
  const requestId = options.values["--request-id"];
  const url = options.values["--url"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (
    options.error !== null ||
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
  const configuration = readAdministrationConfiguration(environment);
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
    return writeFailure(
      json,
      {
        code: "runtime_unavailable",
        detail: "ingestion runtime is unavailable",
        runtime: "ingestion",
      },
      9,
    );
  }

  let document;
  try {
    document = await response.json();
  } catch {
    return writeFailure(
      json,
      {
        code: "invalid_administration_contract",
        detail: "ingestion runtime returned invalid JSON",
        runtime: "ingestion",
      },
      8,
    );
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
    return writeFailure(
      json,
      { code, detail },
      exitCodeForStatus(response.status),
    );
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else {
    process.stdout.write(`${formatAdministrationResult(document)}\n`);
  }
  return 0;
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
        "Usage: keepr health | status | run start | run show | candidate inspect | run approve | run reject | run retry | run cleanup | source collect | source show | source resume | source retry | snapshot reparse | credential install | credential verify | credential revoke | credential show",
    },
    2,
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
    return [
      `Ingestion Run ${document.id} evidence: ${document.state}`,
      formatCount(document.snapshots.length, "Source Snapshot"),
      formatCount(
        document.observation_sets.length,
        "Source Observation set",
      ),
      formatCount(document.diagnostics.length, "diagnostic"),
    ].join("; ");
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
      lines.push(
        `  ${item.game}/${item.area}: ${item.checked_at} (${item.ingestion_run_id})`,
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
      lines.push(
        `Warning: ${warning.code ?? "unspecified"}${
          warning.detail ? ` — ${warning.detail}` : ""
        }`,
      );
    }
  }
  lines.push(`Failure: ${document.failure_code ?? "none"}`);
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
  return lines.join("\n");
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
