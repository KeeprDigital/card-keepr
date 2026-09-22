import { parseOptions, writeCliFailure } from "./command-support.mjs";
import { requestDocument } from "./lib/json-client.mjs";
import { dispatchStagingRelease } from "./provider-github-release.mjs";
import { isReleaseIdentity } from "../src/catalogue/shared/release-input-shapes.mjs";

export async function runStagingReleaseStatusCommand(args, environment, json) {
  const options = parseOptions(args, ["--release-id"]);
  const id = options.values["--release-id"];
  if (options.error || !isReleaseIdentity(id) || !["production", "staging"].includes(environment.KEEPR_TARGET))
    return writeCliFailure(
      json,
      { code: "invalid_arguments", detail: "Staging status requires a release ID and --target production or staging." },
      2,
    );
  const collection = environment.KEEPR_TARGET === "production" ? "staging-releases" : "staging-deployments";
  const result = await requestDocument(environment, `/v1/${collection}/${encodeURIComponent(id)}`);
  if (result.error) return writeCliFailure(json, result.error, result.exitCode);
  process.stdout.write(
    json
      ? `${JSON.stringify(result.document)}\n`
      : `Staging release ${id}: ${result.document.outcome?.state ?? (result.document.deployment ? "prepared" : result.document.authorization ? "claimed" : "requested")}\n`,
  );
  return 0;
}

/** Production owns release intent; this command dispatches staging only. */
export async function runStagingReleaseCommand(args, environment, json) {
  const options = parseOptions(
    args,
    ["--release-id", "--expected-head-sha", "--ci-run-id", "--idempotency-key", "--confirm"],
    ["--json", "--yes"],
  );
  const fail = (code, detail, exitCode) => writeCliFailure(json, { code, detail }, exitCode);
  if (environment.KEEPR_TARGET !== "production")
    return fail(
      "production_intent_profile_required",
      "Staging initiation requires --target production for its owner intent.",
      2,
    );
  const value = options.values;
  if (
    options.error ||
    !options.flags.has("--yes") ||
    ["--release-id", "--expected-head-sha", "--ci-run-id", "--idempotency-key"].some((key) => !value[key])
  )
    return fail("invalid_arguments", "Release identity, exact SHA, CI run, idempotency key and --yes are required.", 2);
  const body = {
    release_id: value["--release-id"],
    expected_head_sha: value["--expected-head-sha"],
    expected_actor: environment.KEEPR_GITHUB_RELEASE_ACTOR ?? "",
    ci_run_id: value["--ci-run-id"],
    idempotency_key: value["--idempotency-key"],
    ...(value["--confirm"] === undefined ? { prepare: true } : { confirmation: value["--confirm"] }),
  };
  const result = await requestDocument(environment, "/v1/staging-releases", { method: "POST", body });
  if (result.error) return fail(result.error.code, result.error.detail, result.exitCode);
  if (body.prepare) {
    if (typeof result.document?.confirmation !== "string")
      return fail("invalid_administration_contract", "Staging release confirmation is unavailable.", 8);
    return fail("confirmation_required", `Confirmation must exactly equal ${result.document.confirmation}`, 3);
  }
  const document = result.document;
  if (
    document?.contract !== "card-keepr-staging-release-request@1" ||
    document.release_id !== body.release_id ||
    document.dispatch_inputs?.release_id !== body.release_id ||
    document.dispatch_inputs?.expected_head_sha !== body.expected_head_sha
  )
    return fail("invalid_staging_release_request", "The runtime returned inconsistent staging intent.", 8);
  const token = environment.KEEPR_GITHUB_RELEASE_TOKEN;
  if (typeof token !== "string" || token.length < 20)
    return fail("configuration_error", "KEEPR_GITHUB_RELEASE_TOKEN is required.", 2);
  if (
    !(await dispatchStagingRelease({
      credential: token,
      inputs: document.dispatch_inputs,
      apiUrl: environment.KEEPR_GITHUB_API_URL,
    }))
  )
    return fail(
      "release_dispatch_failed",
      "GitHub rejected the manual staging dispatch; the original intent remains retained.",
      9,
    );
  const output = { contract: "card-keepr-staging-release-dispatch@1", ...document.dispatch_inputs, state: "requested" };
  process.stdout.write(json ? `${JSON.stringify(output)}\n` : `Staging release ${body.release_id}: requested\n`);
  return 10;
}
