#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { safeDiagnosticCount, safeDiagnosticReference, safeMachineCode } from "../src/http/diagnostic-display.mjs";
import { apiCapabilities, ingestionCapabilities } from "../src/runtime-capabilities.mjs";
import { runCatalogueCommand } from "./catalogue.mjs";
import { parseOptions, runtimeUrl, writeCliFailure as writeFailure } from "./command-support.mjs";
import { runCuratedRevisionCommand } from "./curated-revisions.mjs";
import { request as httpRequest } from "./lib/http-client.mjs";
import { requestDocument } from "./lib/json-client.mjs";
import { runProductionReleaseCommand } from "./production-release.mjs";

const commandRoutes = {
  identityInspect: { path: "/v1/reconciliation/identities/{identity-id}?after={after}", optional: ["after"] },
  identityReviews: { path: "/v1/reconciliation/identity-reviews?run_id={run-id}&after={after}", optional: ["after"] },
  identityResolve: {
    path: "/v1/reconciliation/identity-reviews/{review-id}/resolve",
    yes: true,
    fields: { printing_id: "printing-id", rationale: "rationale", idempotency_key: "idempotency-key" },
  },
  sourceLifecycle: { path: "/v1/source-lineages/{lineage}/lifecycle" },
  decideSourceLifecycle: {
    path: "/v1/source-lineages/{lineage}/lifecycle",
    fields: {
      state: "state",
      expected_generation: "expected-generation",
      rationale: "rationale",
      idempotency_key: "idempotency-key",
    },
  },
  sourceRegistry: { path: "/v1/source-registry" },
  sourceAuthorities: { path: "/v1/source-authorities" },
  selectSourceAuthority: {
    path: "/v1/source-authorities",
    fields: {
      game: "game",
      locale: "locale",
      release_region: "release-region",
      area: "area",
      source_lineage: "source-lineage",
      expected_generation: "expected-generation",
      rationale: "rationale",
      idempotency_key: "idempotency-key",
    },
  },
  reconciliationStatus: { path: "/v1/ingestion-runs/{run-id}/reconciliation" },
  reconciliationPartitions: {
    path: "/v1/ingestion-runs/{run-id}/reconciliation/partitions?after={after}",
    optional: ["after"],
  },
  reconciliationPartition: { path: "/v1/ingestion-runs/{run-id}/reconciliation/partitions/{ordinal}" },
  ...Object.fromEntries(
    ["pause", "resume", "abandon"].map((action) => [
      `reconciliation-${action}`,
      {
        path: `/v1/ingestion-runs/{run-id}/reconciliation/${action}`,
        fields: { generation: "generation", idempotency_key: "idempotency-key" },
        production: `Reconciliation ${action}`,
      },
    ]),
  ),
  reconcileRun: {
    path: "/v1/ingestion-runs/{run-id}/reconciliation",
    fields: {
      expected_current_revision_id: "expected-current-revision",
      idempotency_key: "idempotency-key",
    },
    production: "Reconciliation",
    query: {
      ingestion_run_id: "run-id",
      expected_current_revision_id: "expected-current-revision",
    },
  },
  repairCatalogueSearch: {
    path: "/v1/catalogue-search-materialization/repair",
    fields: {
      target_revision_id: "target-revision",
      expected_current_revision_id: "expected-current-revision",
      idempotency_key: "idempotency-key",
    },
    production: "Card search repair",
    query: {
      repair_revision_id: "target-revision",
      expected_current_revision_id: "expected-current-revision",
    },
  },
  createBackup: {
    path: "/v1/backups",
    fields: {
      expected_current_revision_id: "expected-current-revision",
      idempotency_key: "idempotency-key",
    },
    production: "Catalogue backup",
    query: {
      expected_current_revision_id: "expected-current-revision",
    },
    confirmBody: true,
  },
  verifyRecovery: {
    path: "/v1/recoveries/{recovery-id}/verification",
    fields: {
      target_digest: "target-digest",
      idempotency_key: "idempotency-key",
    },
    production: "Catalogue recovery verification",
    query: {
      recovery_id: "recovery-id",
      target_digest: "target-digest",
    },
    confirmBody: true,
    confirmRoute: {
      recovery_id: "recovery-id",
    },
  },
  acceptRecovery: {
    path: "/v1/recoveries/{recovery-id}/acceptance",
    fields: {
      expected_restored_revision_id: "expected-restored-revision",
      target_digest: "target-digest",
      confirmation_recovery_id: "confirmation-recovery-id",
      idempotency_key: "idempotency-key",
    },
    production: "Catalogue recovery acceptance",
    query: {
      recovery_id: "recovery-id",
      target_digest: "target-digest",
      expected_restored_revision_id: "expected-restored-revision",
    },
    confirmBody: true,
    confirmRoute: {
      recovery_id: "recovery-id",
    },
  },
  beginRecovery: {
    path: "/v1/recoveries",
    fields: {
      recovery_id: "recovery-id",
      method: "method",
      target_revision_id: "target-revision",
      target_bookmark: "target-bookmark",
      target_digest: "target-digest",
      backup_attempt_id: "backup-attempt-id",
      expected_current_revision_id: "expected-current-revision",
      idempotency_key: "idempotency-key",
      linked_operation_id: "linked-operation-id",
    },
    production: "Catalogue recovery",
    query: {
      expected_current_revision_id: "expected-current-revision",
    },
    confirmBody: true,
    bodyEnvironment: true,
    optional: ["linked-operation-id"],
    choices: {
      method: ["time_travel", "replacement_database"],
    },
  },
  showRun: {
    path: "/v1/ingestion-runs/{run-id}",
  },
  inspectCandidate: {
    path: "/v1/ingestion-runs/{run-id}/candidate",
  },
  approveRun: {
    path: "/v1/ingestion-runs/{run-id}/approval",
    yes: true,
    fields: {
      candidate_digest: "candidate-digest",
      expected_current_revision_id: "expected-current-revision",
      idempotency_key: "idempotency-key",
    },
  },
  rejectRun: {
    path: "/v1/ingestion-runs/{run-id}/rejection",
    yes: true,
    fields: {
      candidate_digest: "candidate-digest",
      idempotency_key: "idempotency-key",
    },
  },
  retryRun: {
    path: "/v1/ingestion-runs/{run-id}/retry",
    fields: {
      idempotency_key: "idempotency-key",
    },
  },
  cleanupRun: {
    path: "/v1/ingestion-runs/{run-id}/publication-cleanup",
    fields: {
      idempotency_key: "idempotency-key",
    },
  },
  inspectRecovery: {
    path: "/v1/recoveries/{recovery-id}",
  },
  showSourceEvidence: {
    path: "/v1/ingestion-runs/{run-id}/evidence",
  },
  resumeEvidenceCollection: {
    path: "/v1/ingestion-runs/{run-id}/collection/resume",
    fields: {},
  },
  pauseEvidenceCollection: {
    path: "/v1/ingestion-runs/{run-id}/collection/pause",
    fields: {
      idempotency_key: "idempotency-key",
    },
  },
  terminateEvidenceCollection: {
    path: "/v1/ingestion-runs/{run-id}/collection/termination",
    fields: {
      idempotency_key: "idempotency-key",
    },
  },
  retryEvidenceCollection: {
    path: "/v1/ingestion-runs/{run-id}/collection/retry",
    fields: {
      idempotency_key: "idempotency-key",
    },
  },
  reparseSourceSnapshot: {
    path: "/v1/source-snapshots/{snapshot-id}/observations",
    fields: {
      adapter_version: "adapter",
      idempotency_key: "idempotency-key",
    },
  },
};
async function routeCommand(name, arguments_, environment, json) {
  const definition = commandRoutes[name];
  const routeFields = [...definition.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  const fields = [
    ...new Set([...routeFields, ...Object.values(definition.fields ?? {}), ...Object.values(definition.query ?? {})]),
  ];
  const yes = definition.yes || definition.production;
  const options = parseOptions(
    arguments_,
    fields.map((field) => `--${field}`).concat(definition.production ? ["--environment", "--confirm"] : []),
    yes ? ["--yes"] : [],
  );
  const value = (field) => options.values[`--${field}`];
  if (
    options.error !== null ||
    fields.some((field) => value(field) === undefined && !definition.optional?.includes(field)) ||
    (yes && !options.flags.has("--yes")) ||
    (definition.production && value("environment") === undefined) ||
    Object.entries(definition.choices ?? {}).some(([field, choices]) => !choices.includes(value(field)))
  )
    return usageFailure(json);
  if (definition.production && value("environment") !== "production")
    return productionTargetFailure(json, `${definition.production} requires --environment production.`);
  const mapped = (fields) =>
    Object.fromEntries(
      Object.entries(fields ?? {})
        .filter(([, option]) => value(option) !== undefined)
        .map(([field, option]) => [field, value(option)]),
    );
  const body =
    definition.fields === undefined
      ? undefined
      : { ...(definition.bodyEnvironment ? { environment: "production" } : {}), ...mapped(definition.fields) };
  if (definition.production) {
    const resolved = await resolveTarget(environment, json, mapped(definition.query));
    if (typeof resolved === "number") return resolved;
    const confirmation = definition.confirmBody
      ? { production_target: resolved.productionTarget, ...mapped(definition.confirmRoute), ...body }
      : resolved.productionTarget;
    const confirmed = confirmProductionTarget(json, confirmation, value("confirm"));
    if (confirmed !== 0) return confirmed;
  }
  const pathname = definition.path.replace(/\{([^}]+)\}/g, (_, field) => encodeURIComponent(value(field) ?? ""));
  return administrationRequest(
    environment,
    json,
    pathname,
    definition.fields === undefined ? "GET" : "POST",
    Object.keys(body ?? {}).length === 0 ? undefined : body,
  );
}

const commands = {
  "identity inspect": (args, env, json) => routeCommand("identityInspect", args, env, json),
  "identity reviews": (args, env, json) => routeCommand("identityReviews", args, env, json),
  "identity resolve": (args, env, json) => routeCommand("identityResolve", args, env, json),
  "release production": runProductionReleaseCommand,
  "run show": (args, env, json) => routeCommand("showRun", args, env, json),
  "candidate inspect": (args, env, json) => routeCommand("inspectCandidate", args, env, json),
  "run approve": (args, env, json) => routeCommand("approveRun", args, env, json),
  "run reject": (args, env, json) => routeCommand("rejectRun", args, env, json),
  "run retry": (args, env, json) => routeCommand("retryRun", args, env, json),
  "run cleanup": (args, env, json) => routeCommand("cleanupRun", args, env, json),
  "reconciliation status": (args, env, json) => routeCommand("reconciliationStatus", args, env, json),
  "reconciliation partitions": (args, env, json) => routeCommand("reconciliationPartitions", args, env, json),
  "reconciliation partition": (args, env, json) => routeCommand("reconciliationPartition", args, env, json),
  ...Object.fromEntries(
    ["pause", "resume", "abandon"].map((action) => [
      `reconciliation ${action}`,
      (args, env, json) => routeCommand(`reconciliation-${action}`, args, env, json),
    ]),
  ),
  "run reconcile": (args, env, json) => routeCommand("reconcileRun", args, env, json),
  "backup create": (args, env, json) => routeCommand("createBackup", args, env, json),
  "backup status": backupStatus,
  "backup retry": retryBackup,
  "recovery begin": (args, env, json) => routeCommand("beginRecovery", args, env, json),
  "recovery inspect": (args, env, json) => routeCommand("inspectRecovery", args, env, json),
  "recovery verify": (args, env, json) => routeCommand("verifyRecovery", args, env, json),
  "recovery accept": (args, env, json) => routeCommand("acceptRecovery", args, env, json),
  "source collect": collectSource,
  "source registry": (args, env, json) => routeCommand("sourceRegistry", args, env, json),
  "source lifecycle": (args, env, json) => routeCommand("sourceLifecycle", args, env, json),
  "source set-lifecycle": (args, env, json) => routeCommand("decideSourceLifecycle", args, env, json),
  "source authorities": (args, env, json) => routeCommand("sourceAuthorities", args, env, json),
  "source designate": (args, env, json) => routeCommand("selectSourceAuthority", args, env, json),
  "source show": (args, env, json) => routeCommand("showSourceEvidence", args, env, json),
  "source pause": (args, env, json) => routeCommand("pauseEvidenceCollection", args, env, json),
  "source resume": (args, env, json) => routeCommand("resumeEvidenceCollection", args, env, json),
  "source terminate": (args, env, json) => routeCommand("terminateEvidenceCollection", args, env, json),
  "source retry": (args, env, json) => routeCommand("retryEvidenceCollection", args, env, json),
  "snapshot reparse": (args, env, json) => routeCommand("reparseSourceSnapshot", args, env, json),
};

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
    return administrationRequest(environment, json, "/v1/status", "GET");
  }

  if (arguments_[0] === "catalogue" && arguments_[1] === "search" && arguments_[2] === "repair") {
    return routeCommand("repairCatalogueSearch", arguments_.slice(3), environment, json);
  }

  if (arguments_[0] === "catalogue-export" && arguments_[1] === "deletion") {
    return catalogueExportDeletion(arguments_[2], arguments_.slice(3), environment, json);
  }

  if (arguments_[0] === "source" && arguments_[1] === "capacity" && arguments_[2] === "extend") {
    return extendSourceCapacity(arguments_.slice(3), environment, json);
  }

  if (arguments_[0] === "cards") {
    return runCatalogueCommand(arguments_.slice(1), environment, json);
  }

  if (arguments_[0] === "curated-revision") {
    return runCuratedRevisionCommand(arguments_.slice(1), environment, json);
  }

  const handler = commands[arguments_.slice(0, 2).join(" ")];
  return handler === undefined ? usageFailure(json) : handler(arguments_.slice(2), environment, json);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
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

  const results = await Promise.all(configuration.runtimes.map(async (runtime) => checkRuntime(runtime)));
  const failure = results.find((result) => !result.ok);
  if (failure !== undefined) {
    return writeFailure(json, failure, failure.exitCode);
  }

  // Readiness (issue #144): a runtime whose checks fail answers 503 with a
  // "degraded" document. The CLI prints the whole document either way and
  // its exit code follows readiness.
  const degraded = results.some((result) => result.health.status !== "ok");
  const document = {
    contract: "card-keepr-cli-health@1",
    status: degraded ? "degraded" : "ok",
    runtimes: results.map((result) => result.health),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else {
    process.stdout.write(degraded ? "Card Keepr runtimes are degraded\n" : "Card Keepr runtimes are healthy\n");
    for (const runtime of document.runtimes) {
      process.stdout.write(`${runtime.name}: ${runtime.status} (${runtime.capabilities.join(", ")})\n`);
      for (const [name, check] of Object.entries(runtime.checks)) {
        process.stdout.write(`  ${name}: ${check.status}${describeHealthCheck(name, check)}\n`);
      }
    }
  }
  return degraded ? 9 : 0;
}

// The readiness document is rendered from a closed set of fields; anything
// outside the safe reference shapes is shown as "unknown" rather than echoed.
function describeHealthCheck(name, check) {
  const parts = [];
  if (name === "database") {
    if (check.status === "pass") {
      parts.push(`schema level ${safeDiagnosticCount(check.migration_level)}`);
      parts.push(`revision ${safeDiagnosticReference(check.current_revision_id) ?? "unknown"}`);
    }
    if (typeof check.configured_database_id === "string") {
      parts.push(`configured database ${safeDiagnosticReference(check.configured_database_id) ?? "unknown"}`);
    }
  } else if (name === "objects" || name === "workflows") {
    const members = name === "objects" ? check.buckets : check.bindings;
    for (const [member, verdict] of Object.entries(members ?? {})) {
      const label = safeDiagnosticReference(member) ?? "unknown";
      parts.push(
        verdict?.status === "pass"
          ? `${label} pass`
          : `${label} fail (${safeMachineCode(verdict?.reason) ?? "unknown"})`,
      );
    }
  } else if (name === "public_base") {
    parts.push(safeUrl(check.configured) ?? "unknown");
    parts.push(`arrived through it: ${check.arrived_through_public_base === true ? "yes" : "no"}`);
  } else if (name === "version") {
    parts.push(`id ${safeDiagnosticReference(check.id) ?? "unknown"}`);
  }
  if (check.status !== "pass" && typeof check.reason === "string") {
    parts.push(safeMachineCode(check.reason) ?? "unknown");
  }
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function safeUrl(value) {
  if (typeof value !== "string" || value.length > 1024) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

function validHealthChecks(checks) {
  if (checks === null || typeof checks !== "object" || Array.isArray(checks)) {
    return false;
  }
  const names = Object.keys(checks);
  return (
    names.length > 0 &&
    names.every(
      (name) =>
        ["database", "objects", "workflows", "public_base", "version"].includes(name) &&
        checks[name] !== null &&
        typeof checks[name] === "object" &&
        (checks[name].status === "pass" || checks[name].status === "fail"),
    )
  );
}

async function backupStatus(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--attempt-id", "--catalogue-revision"]);
  const attemptId = options.values["--attempt-id"];
  const catalogueRevision = options.values["--catalogue-revision"];
  if (options.error !== null || (attemptId === undefined) === (catalogueRevision === undefined))
    return usageFailure(json);
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
  const options = parseOptions(
    arguments_,
    [
      "--expected-current-revision",
      "--idempotency-key",
      "--failed-attempt-id",
      "--failed-attempt-digest",
      "--environment",
      "--confirm",
    ],
    ["--yes"],
  );
  const expected = options.values["--expected-current-revision"];
  const idempotencyKey = options.values["--idempotency-key"];
  const failedAttemptId = options.values["--failed-attempt-id"];
  const failedAttemptDigest = options.values["--failed-attempt-digest"];
  const target = options.values["--environment"];
  const confirmation = options.values["--confirm"];
  if (
    options.error !== null ||
    expected === undefined ||
    idempotencyKey === undefined ||
    failedAttemptId === undefined ||
    failedAttemptDigest === undefined ||
    target === undefined ||
    !options.flags.has("--yes")
  )
    return usageFailure(json);
  if (target !== "production") {
    return productionTargetFailure(json, "Catalogue backup retry requires --environment production.");
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
      options.error !== null ||
      revision === undefined ||
      manifest === undefined ||
      expected === undefined ||
      planId === undefined
    )
      return usageFailure(json);
    return administrationRequest(environment, json, "/v1/catalogue-export-deletion-plans", "POST", {
      catalogue_revision_id: revision,
      manifest_digest: manifest,
      expected_current_revision_id: expected,
      plan_id: planId,
    });
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
    const options = parseOptions(
      arguments_,
      [
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
      ],
      ["--yes"],
    );
    const values = options.values;
    const required = [
      "--plan-id",
      "--plan-digest",
      "--catalogue-revision",
      "--manifest-digest",
      "--expected-current-revision",
      "--confirm-revision",
      "--deletion-id",
      "--idempotency-key",
      "--environment",
    ];
    if (options.error !== null || required.some((name) => values[name] === undefined) || !options.flags.has("--yes"))
      return usageFailure(json);
    if (values["--environment"] !== "production") {
      return productionTargetFailure(json, "Catalogue Export deletion requires --environment production.");
    }
    const resolved = await resolveProductionStatus(environment, json, values["--expected-current-revision"]);
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
    const confirmed = confirmProductionTarget(json, confirmation, values["--confirm"]);
    if (confirmed !== 0) return confirmed;
    return administrationRequest(environment, json, "/v1/catalogue-export-deletions", "POST", {
      plan_id: values["--plan-id"],
      plan_digest: values["--plan-digest"],
      catalogue_revision_id: values["--catalogue-revision"],
      manifest_digest: values["--manifest-digest"],
      expected_current_revision_id: values["--expected-current-revision"],
      confirmation_revision_id: values["--confirm-revision"],
      deletion_id: values["--deletion-id"],
      idempotency_key: values["--idempotency-key"],
    });
  }
  if (action === "retry") {
    const options = parseOptions(
      arguments_,
      [
        "--deletion-id",
        "--object-set-digest",
        "--expected-current-revision",
        "--idempotency-key",
        "--environment",
        "--confirm",
      ],
      ["--yes"],
    );
    const values = options.values;
    const required = [
      "--deletion-id",
      "--object-set-digest",
      "--expected-current-revision",
      "--idempotency-key",
      "--environment",
    ];
    if (options.error !== null || required.some((name) => values[name] === undefined) || !options.flags.has("--yes"))
      return usageFailure(json);
    if (values["--environment"] !== "production") {
      return productionTargetFailure(json, "Catalogue Export deletion retry requires --environment production.");
    }
    const resolved = await resolveProductionStatus(environment, json, values["--expected-current-revision"]);
    if (typeof resolved === "number") return resolved;
    const confirmation = {
      production_target: resolved.productionTarget,
      deletion_id: values["--deletion-id"],
      object_set_digest: values["--object-set-digest"],
      expected_current_revision_id: values["--expected-current-revision"],
      idempotency_key: values["--idempotency-key"],
    };
    const confirmed = confirmProductionTarget(json, confirmation, values["--confirm"]);
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
  process.stderr.write(`Resolved backup retry ${JSON.stringify(resolved)}\n`);
}

async function collectSource(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--game",
    "--lineage",
    "--adapter",
    "--request-id",
    "--url",
    "--plan-file",
    "--participation",
    "--subset",
    "--idempotency-key",
  ]);
  const planFile = options.values["--plan-file"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (
    options.error === null &&
    planFile !== undefined &&
    idempotencyKey !== undefined &&
    ["--game", "--lineage", "--adapter", "--request-id", "--url", "--participation", "--subset"].every(
      (option) => options.values[option] === undefined,
    )
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
    return administrationRequest(environment, json, "/v1/ingestion-runs/evidence", "POST", {
      plans: planDocument.plans,
      idempotency_key: idempotencyKey,
    });
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
  return administrationRequest(environment, json, "/v1/ingestion-runs/evidence", "POST", {
    ...(options.values["--participation"] === undefined ? {} : { participation: options.values["--participation"] }),
    ...(options.values["--subset"] === undefined ? {} : { subset: options.values["--subset"] }),
    supported_game: game,
    source_lineage: lineage,
    adapter_version: adapter,
    idempotency_key: idempotencyKey,
    requests: [{ id: requestId, url }],
  });
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
  const expectedCapacity = parsedCapacityInteger(options.values["--expected-capacity"]);
  const expectedGeneration = parsedCapacityInteger(options.values["--expected-generation"]);
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

// An owner pause stops a collecting Ingestion Run deliberately: the run
// enters its Workflow Pause with the reason owner_requested, retains every
// evidence object, and then resumes or is terminated. It is idempotent under
// its key.

// Termination is the owner's deliberate decision to abandon a paused
// Ingestion Run: it is idempotent under its key and releases the single
// active-run reservation while retaining every evidence object.

async function administrationRequest(environment, json, pathname, method, body) {
  const observed = await fetchAdministrationDocument(environment, pathname, method, body, true);
  if (observed.error !== null) {
    return writeFailure(json, observed.error, observed.exitCode);
  }
  const document = observed.document;
  if (json) {
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else {
    process.stdout.write(`${observed.presentation.text}\n`);
  }
  return observed.presentation?.exit_code ?? (observed.responseStatus === 202 ? 10 : 0);
}

function fetchAdministrationDocument(environment, pathname, method = "GET", body, present = false) {
  return requestDocument(environment, pathname, { method, body, present });
}

function resolveProductionStatus(environment, json, expectedCurrentRevision) {
  return resolveTarget(environment, json, { expected_current_revision_id: expectedCurrentRevision });
}
async function resolveTarget(environment, json, parameters) {
  const observed = await fetchAdministrationDocument(environment, `/v1/status?${new URLSearchParams(parameters)}`);
  if (observed.error !== null) return writeObservedFailure(observed, json);
  const resolved = observed.document?.resolved_target;
  if (typeof resolved?.confirmation !== "string")
    return writeFailure(
      json,
      {
        code: "invalid_administration_contract",
        detail: "Production status did not expose exact Cloudflare target identities.",
      },
      8,
    );
  return { productionTarget: resolved.production_target };
}

function confirmProductionTarget(json, productionTarget, confirmation) {
  const required = JSON.stringify(productionTarget);
  if (confirmation === required) return 0;
  return writeFailure(
    json,
    {
      code: "confirmation_required",
      detail: `Resolved production target ${required}. ` + `Re-run with --confirm '${required}'.`,
    },
    3,
  );
}

function writeObservedFailure(observed, json) {
  return observed.error === null ? null : writeFailure(json, observed.error, observed.exitCode);
}

function readHealthConfiguration(environment) {
  const required = ["KEEPR_API_KEY", "KEEPR_ADMINISTRATION_KEY"];
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

function usageFailure(json) {
  return writeFailure(
    json,
    {
      code: "usage_error",
      detail:
        "Usage: keepr identity inspect | identity reviews | identity resolve | health | status | cards search | catalogue search repair | catalogue-export deletion prepare | catalogue-export deletion confirm | catalogue-export deletion status | catalogue-export deletion retry | backup create | backup status | backup retry | recovery begin | recovery inspect | recovery verify | recovery accept | run show | candidate inspect | run reconcile | reconciliation status | reconciliation partitions | reconciliation partition | reconciliation pause | reconciliation resume | reconciliation abandon | run approve | run reject | run retry | run cleanup | source registry | source authorities | source designate | source collect | source show | source pause | source resume | source terminate | source retry | source capacity extend | snapshot reparse | curated-revision validate | curated-revision list | curated-revision show | curated-revision create | curated-revision reaffirm | curated-revision supersede | curated-revision retire",
    },
    2,
  );
}

function productionTargetFailure(json, detail) {
  return writeFailure(json, { code: "production_target_required", detail }, 2);
}

async function checkRuntime(runtime) {
  let response;
  try {
    response = await httpRequest(runtimeUrl(runtime.url, "/health"), {
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
  // 503 is the readiness document with a failed check, not a transport
  // failure; it is validated like a 200 and reported as degraded.
  if (!response.ok && response.status !== 503) {
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
  const expectedStatus = response.status === 503 ? "degraded" : "ok";
  if (
    health?.contract !== "card-keepr-runtime-health@1" ||
    health.runtime !== runtime.name ||
    health.status !== expectedStatus ||
    !sameStrings(health.capabilities, runtime.capabilities) ||
    !validHealthChecks(health.checks)
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
      checks: health.checks,
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
