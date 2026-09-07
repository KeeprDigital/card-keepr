import { parseOptions, writeCliFailure } from "./command-support.mjs";
import { requestDocument } from "./lib/json-client.mjs";
import { dispatchProductionRelease } from "./provider-github-release.mjs";

export async function runProductionReleaseCommand(args, environment, json) {
  const options = parseOptions(
    args,
    [
      "--fresh-database-id",
      "--baseline-sha256",
      "--release-id",
      "--expected-current-revision",
      "--expected-head-sha",
      "--expected-migration-level",
      "--idempotency-key",
      "--environment",
      "--confirm",
      "--replacement-recovery-id",
      "--replacement-database-id",
      "--retained-database-id",
    ],
    ["--json", "--yes", "--bootstrap", "--cancel-fresh-handoff"],
  );
  const value = options.values;
  const fail = (code, detail, exitCode) => writeCliFailure(json, { code, detail }, exitCode);
  if (options.error !== null) return fail("invalid_arguments", options.error, 2);
  if (value["--environment"] !== "production")
    return fail("production_target_required", "Production release requires --environment production.", 2);
  const required = [
    "--release-id",
    "--expected-current-revision",
    "--expected-head-sha",
    "--expected-migration-level",
    "--idempotency-key",
  ];
  if (required.some((key) => value[key] === undefined) || !options.flags.has("--yes")) {
    return fail(
      "invalid_arguments",
      "Production Release identity, revision, SHA, migration level, idempotency key, and --yes are required.",
      2,
    );
  }
  if (!environment.KEEPR_INGESTION_URL || !environment.KEEPR_ADMINISTRATION_KEY) {
    return fail("configuration_error", "Ingestion URL and administration key are required.", 2);
  }
  const replacementKeys = ["--replacement-recovery-id", "--replacement-database-id", "--retained-database-id"];
  const replacement = replacementKeys.some((key) => value[key] !== undefined)
    ? {
        recovery_id: value[replacementKeys[0]],
        replacement_database_id: value[replacementKeys[1]],
        retained_database_id: value[replacementKeys[2]],
      }
    : null;
  const body = {
    release_id: value["--release-id"],
    idempotency_key: value["--idempotency-key"],
    expected_current_revision_id: value["--expected-current-revision"],
    expected_head_sha: value["--expected-head-sha"],
    expected_actor: environment.KEEPR_GITHUB_RELEASE_ACTOR ?? "",
    expected_migration_level: Number(value["--expected-migration-level"]),
    bootstrap: options.flags.has("--bootstrap"),
    replacement_handoff: replacement,
    ...(options.flags.has("--cancel-fresh-handoff") ? { cancel_handoff: true } : {}),
    ...(value["--fresh-database-id"] !== undefined || value["--baseline-sha256"] !== undefined
      ? {
          fresh_baseline_handoff: {
            destination_database_id: value["--fresh-database-id"],
            baseline_sha256: value["--baseline-sha256"],
            destination_migration_level: 1,
            scope: "fresh_database_regeneration",
          },
        }
      : {}),
    ...(value["--confirm"] === undefined ? { prepare: true } : { confirmation: value["--confirm"] }),
  };
  const observed = await requestDocument(environment, "/v1/production-releases", { method: "POST", body });
  if (observed.error !== null)
    return fail(
      observed.error.code,
      observed.error.detail,
      observed.error.code === "confirmation_required" ? 3 : observed.exitCode,
    );
  const document = observed.document;
  if (body.prepare === true) {
    if (typeof document?.confirmation !== "string")
      return fail("invalid_administration_contract", "Production Release confirmation is unavailable.", 8);
    return fail("confirmation_required", `Confirmation must exactly equal ${document.confirmation}`, 3);
  }
  if (
    document?.release_id !== body.release_id ||
    document.contract !== "card-keepr-production-release-request@1" ||
    document.dispatch_inputs === null ||
    typeof document.dispatch_inputs !== "object" ||
    !Object.values(document.dispatch_inputs).every((value) => typeof value === "string")
  ) {
    return fail(
      "invalid_production_release_request",
      "The ingestion runtime returned invalid Production Release request evidence.",
      8,
    );
  }
  const token = environment.KEEPR_GITHUB_RELEASE_TOKEN;
  if (typeof token !== "string" || token.length < 20)
    return fail("configuration_error", "KEEPR_GITHUB_RELEASE_TOKEN is required.", 2);
  const dispatched = await dispatchProductionRelease({
    credential: token,
    apiUrl: environment.KEEPR_GITHUB_API_URL,
    workflowId: environment.KEEPR_GITHUB_RELEASE_WORKFLOW_ID,
    inputs: document.dispatch_inputs,
  });
  if (!dispatched)
    return fail("release_dispatch_failed", "GitHub rejected the guarded production release dispatch.", 9);
  const result = {
    contract: "card-keepr-production-release-dispatch@1",
    release_id: body.release_id,
    state: "requested",
    expected_head_sha: body.expected_head_sha,
  };
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `Production Release ${body.release_id}: requested\n`);
  return 10;
}
