import { createHash } from "node:crypto";
import { parseOptions, writeCliFailure } from "./command-support.mjs";
import { validatedProductionTarget } from "./production-target.mjs";
import { dispatchProductionRelease } from "./provider-github-release.mjs";

export async function runProductionReleaseCommand(args, environment, json) {
  const options = parseOptions(args, [
    "--release-id", "--expected-current-revision", "--expected-head-sha",
    "--expected-migration-level", "--idempotency-key", "--environment",
    "--confirm", "--replacement-recovery-id", "--replacement-database-id",
    "--retained-database-id",
  ], ["--json", "--yes"]);
  if (options.error !== null) return failure(json, "invalid_arguments", options.error, 2);
  const value = options.values;
  const releaseId = value["--release-id"];
  const expectedRevision = value["--expected-current-revision"];
  const expectedHeadSha = value["--expected-head-sha"];
  const expectedLevel = Number(value["--expected-migration-level"]);
  const idempotencyKey = value["--idempotency-key"];
  if (value["--environment"] !== "production") {
    return failure(json, "production_target_required", "Production release requires --environment production.", 2);
  }
  if (![releaseId, expectedRevision, idempotencyKey].every(opaque) ||
      !/^[0-9a-f]{40}$/.test(expectedHeadSha ?? "") ||
      !Number.isSafeInteger(expectedLevel) || expectedLevel < 1 ||
      !options.flags.has("--yes")) {
    return failure(json, "invalid_arguments", "Production Release identity, revision, SHA, migration level, idempotency key, and --yes are required.", 2);
  }
  const replacement = replacementInput(value);
  if (replacement === false) {
    return failure(json, "invalid_arguments", "Replacement recovery id, replacement D1 id, and retained D1 id must be supplied together and differ.", 2);
  }
  const status = await readStatus(environment);
  if (!status.ok) return failure(json, status.code, status.detail, status.exitCode);
  const target = validatedProductionTarget(status.document?.production_target);
  const safe = status.document?.safe_state;
  const preflight = status.document?.release_preflight;
  const targetDigest = target === null ? null : sha256(stableJson(target));
  const ordinaryMutationSafe = safe?.mutation_safe === true && safe?.recovery_health === "healthy";
  const replacementMutationSafe = replacement !== null && safe?.recovery_health === "blocked" &&
    safe?.active_recovery_id === replacement.recovery_id &&
    safe?.active_ingestion_run_id === null && safe?.active_release_id === null;
  if (target === null || safe?.current_revision_id !== expectedRevision ||
      (!ordinaryMutationSafe && !replacementMutationSafe) ||
      preflight?.schema_migration_level !== expectedLevel ||
      preflight?.production_target_digest !== targetDigest ||
      typeof preflight?.recovery_bookmark !== "string" ||
      typeof preflight?.recovery_backup_attempt_id !== "string" ||
      preflight?.retention_ready !== true ||
      preflight?.smoke_targets === null || typeof preflight?.smoke_targets !== "object") {
    return failure(json, "release_preflight_failed", "Production status did not satisfy the exact revision, migration, recovery, retention, and smoke gates.", 7);
  }
  if (replacement !== null && (preflight.replacement_handoff?.recovery_id !== replacement.recovery_id ||
      preflight.replacement_handoff?.replacement_database_id !== replacement.replacement_database_id ||
      preflight.replacement_handoff?.retained_database_id !== replacement.retained_database_id ||
      preflight.replacement_handoff?.verified !== true)) {
    return failure(json, "replacement_handoff_not_verified", "The replacement D1 target is not the exact verified recovery target.", 7);
  }
  const confirmation = {
    production_target: target,
    release_id: releaseId,
    expected_current_revision_id: expectedRevision,
    expected_head_sha: expectedHeadSha,
    expected_migration_level: expectedLevel,
    recovery_bookmark: preflight.recovery_bookmark,
    recovery_backup_attempt_id: preflight.recovery_backup_attempt_id,
    idempotency_key: idempotencyKey,
    ...(replacement === null ? {} : { replacement_handoff: replacement }),
  };
  if (value["--confirm"] !== JSON.stringify(confirmation)) {
    return failure(json, "confirmation_required", `Confirmation must exactly equal ${JSON.stringify(confirmation)}`, 3);
  }
  const expectedActor = environment.KEEPR_GITHUB_RELEASE_ACTOR ?? "";
  const replacementHandoff = replacement === null ? null : {
    ...replacement,
    target_revision_id: preflight.replacement_handoff.target_revision_id,
    target_digest: preflight.replacement_handoff.target_digest,
  };
  const preparedPlan = {
    release_id: releaseId,
    idempotency_key: idempotencyKey,
    expected_current_revision_id: expectedRevision,
    expected_head_sha: expectedHeadSha,
    expected_actor: expectedActor,
    expected_migration_level: expectedLevel,
    production_target: target,
    production_target_digest: targetDigest,
    recovery_bookmark: preflight.recovery_bookmark,
    recovery_backup_attempt_id: preflight.recovery_backup_attempt_id,
    smoke_targets: preflight.smoke_targets,
    retained_revision_evidence: preflight.retained_revision_evidence,
    replacement_handoff: replacementHandoff,
  };
  const prepared = await prepareRequest(environment, preparedPlan);
  if (!prepared.ok) return failure(json, prepared.code, prepared.detail, prepared.exitCode);
  if (prepared.document?.release_id !== releaseId || !/^[0-9a-f]{64}$/.test(prepared.document?.dispatch_digest ?? "")) {
    return failure(json, "invalid_production_release_request", "The ingestion runtime returned invalid Production Release request evidence.", 8);
  }
  const token = environment.KEEPR_GITHUB_RELEASE_TOKEN;
  if (typeof token !== "string" || token.length < 20) {
    return failure(json, "configuration_error", "KEEPR_GITHUB_RELEASE_TOKEN is required.", 2);
  }
  const dispatched = await dispatchProductionRelease({
    credential: token,
    apiUrl: environment.KEEPR_GITHUB_API_URL,
    workflowId: environment.KEEPR_GITHUB_RELEASE_WORKFLOW_ID,
    inputs: {
      operation: "production_release", release_id: releaseId,
      expected_account_id: target.cloudflare_account_id,
      expected_head_sha: expectedHeadSha, expected_actor: expectedActor,
      idempotency_key: idempotencyKey,
      dispatch_digest: prepared.document.dispatch_digest,
      prepared_plan_json: stableJson(preparedPlan),
      expected_current_revision: expectedRevision,
      expected_migration_level: String(expectedLevel),
      production_target_json: JSON.stringify(target), production_target_digest: targetDigest,
      recovery_bookmark: preflight.recovery_bookmark,
      recovery_backup_attempt_id: preflight.recovery_backup_attempt_id,
      smoke_targets_json: JSON.stringify(preflight.smoke_targets),
      retained_revision_evidence_json: JSON.stringify(preflight.retained_revision_evidence),
      replacement_recovery_id: replacement?.recovery_id ?? "none",
      replacement_database_id: replacement?.replacement_database_id ?? "none",
      retained_database_id: replacement?.retained_database_id ?? "none",
      replacement_target_digest: replacement === null ? "none" : preflight.replacement_handoff.target_digest,
    },
  });
  if (!dispatched) return failure(json, "release_dispatch_failed", "GitHub rejected the guarded production release dispatch.", 9);
  const document = { contract: "card-keepr-production-release-dispatch@1", release_id: releaseId, state: "requested", expected_head_sha: expectedHeadSha };
  process.stdout.write(json ? `${JSON.stringify(document)}\n` : `Production Release ${releaseId}: requested\n`);
  return 10;
}

async function prepareRequest(environment, body) {
  const base = environment.KEEPR_INGESTION_URL;
  const key = environment.KEEPR_ADMINISTRATION_KEY;
  try {
    const response = await fetch(new URL("/v1/production-releases", base), {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const document = await response.json();
    return response.ok ? { ok: true, document } : { ok: false, code: document.code ?? "administration_error", detail: document.detail ?? "Production Release preparation failed.", exitCode: response.status === 409 ? 7 : 8 };
  } catch {
    return { ok: false, code: "runtime_unavailable", detail: "Ingestion runtime is unavailable.", exitCode: 9 };
  }
}

function replacementInput(values) {
  const parts = [values["--replacement-recovery-id"], values["--replacement-database-id"], values["--retained-database-id"]];
  if (parts.every((item) => item === undefined)) return null;
  if (!parts.every(opaque) || parts[1] === parts[2]) return false;
  return { recovery_id: parts[0], replacement_database_id: parts[1], retained_database_id: parts[2] };
}

async function readStatus(environment) {
  const base = environment.KEEPR_INGESTION_URL;
  const key = environment.KEEPR_ADMINISTRATION_KEY;
  if (!base || !key) return { ok: false, code: "configuration_error", detail: "Ingestion URL and administration key are required.", exitCode: 2 };
  try {
    const response = await fetch(new URL("/v1/status", base), { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    const document = await response.json();
    return response.ok ? { ok: true, document } : { ok: false, code: document.code ?? "administration_error", detail: document.detail ?? "Status failed.", exitCode: response.status === 401 ? 4 : 9 };
  } catch {
    return { ok: false, code: "runtime_unavailable", detail: "Ingestion runtime is unavailable.", exitCode: 9 };
  }
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function opaque(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value); }
function failure(json, code, detail, exitCode) { return writeCliFailure(json, { code, detail }, exitCode); }
