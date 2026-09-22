#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promotionAudience, promotionEnvironment } from "../src/http/dev-workflow-identity.mjs";
import {
  isReleaseDigest,
  isReleaseHead,
  isReleaseIdentity,
  promotionDispatchInputNames,
} from "../src/catalogue/shared/release-input-shapes.mjs";

/**
 * The promote job of staging-deploy.yml (#238). Runs from trusted workflow code
 * after the `production-promotion` environment's required reviewer approved this
 * run. It requests production's fresh promotion plan and hands its dispatch inputs
 * to the reusable guarded executor (production-release.yml) in the same run.
 */
// Evidence that completes later; any other stop needs a new staging release.
const retryable = new Set(["extended_scenarios_pending", "staging_outcome_unavailable"]);
const defaults = { pollMs: 60_000, pendingLimitMs: 60 * 60_000 };

function promotionRequest(environment) {
  if (
    !isReleaseIdentity(environment.RELEASE_ID) ||
    !isReleaseDigest(environment.INTENT_DIGEST) ||
    !isReleaseHead(environment.EXPECTED_HEAD_SHA) ||
    !/^\d+$/u.test(environment.GITHUB_RUN_ID ?? "") ||
    environment.GITHUB_REPOSITORY !== "KeeprDigital/card-keepr" ||
    typeof environment.GH_TOKEN !== "string" ||
    environment.GH_TOKEN.length === 0
  )
    throw new Error("invalid_promotion_environment");
  return {
    release_id: environment.RELEASE_ID,
    intent_digest: environment.INTENT_DIGEST,
    expected_head_sha: environment.EXPECTED_HEAD_SHA,
  };
}

/**
 * Fail closed unless a person approved this run's `production-promotion`
 * deployment. If the environment lost its required reviewer (or was auto-created
 * without one), GitHub records no approval and nothing reaches production.
 */
export async function verifyHumanApproval(environment) {
  promotionRequest(environment);
  const response = await fetch(
    `https://api.github.com/repos/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}/approvals`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${environment.GH_TOKEN}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) throw new Error(`promotion_approval_unreadable:${response.status}`);
  const approvals = await response.json();
  const approval = Array.isArray(approvals)
    ? approvals.find(
        (item) =>
          item?.state === "approved" &&
          item.user?.type === "User" &&
          typeof item.user.login === "string" &&
          (item.environments ?? []).some((env) => env?.name === promotionEnvironment),
      )
    : undefined;
  if (approval === undefined) throw new Error("promotion_not_approved");
  return approval.user.login;
}

/** Production's receipt must name this run's release and commit and carry an ordinary plan. */
export function dispatchInputsFrom(receipt, environment) {
  const inputs = receipt?.production_release?.dispatch_inputs;
  if (
    receipt?.contract !== "card-keepr-production-promotion@1" ||
    receipt.staging_release_id !== environment.RELEASE_ID ||
    receipt.intent_digest !== environment.INTENT_DIGEST ||
    receipt.expected_head_sha !== environment.EXPECTED_HEAD_SHA ||
    receipt.workflow_run_id !== environment.GITHUB_RUN_ID ||
    inputs === null ||
    typeof inputs !== "object" ||
    Object.keys(inputs).sort().join("|") !== [...promotionDispatchInputNames].sort().join("|") ||
    !Object.values(inputs).every((value) => typeof value === "string") ||
    inputs.operation !== "production_release" ||
    inputs.release_id !== `promotion-${environment.RELEASE_ID}` ||
    inputs.expected_head_sha !== environment.EXPECTED_HEAD_SHA ||
    inputs.expected_actor !== "github-actions[bot]"
  )
    throw new Error("promotion_receipt_mismatch");
  return inputs;
}

/**
 * Request the promotion with a fresh signed identity per attempt. Pending
 * extended-scenarios evidence or an unavailable staging read is retried by this
 * same run (a stop never blocks its retry); every other stop ends the job.
 */
export async function requestPromotion(environment, options = {}) {
  const { pollMs, pendingLimitMs } = { ...defaults, ...options };
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const say = options.say ?? ((line) => process.stdout.write(`${line}\n`));
  const body = promotionRequest(environment);
  const deadline = now() + pendingLimitMs;
  for (;;) {
    const oidc = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (oidc.protocol !== "https:") throw new Error("invalid_oidc_endpoint");
    oidc.searchParams.set("audience", promotionAudience);
    const identityResponse = await fetch(oidc, {
      redirect: "error",
      headers: { authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!identityResponse.ok) throw new Error("promotion_identity_unavailable");
    const identity = await identityResponse.json();
    const response = await fetch(promotionAudience, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
      headers: {
        authorization: `Bearer ${identity.value}`,
        "x-github-token": environment.GH_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const document = await response.json().catch(() => null);
    if (response.status === 200 || response.status === 201) return dispatchInputsFrom(document, environment);
    const code = typeof document?.code === "string" ? document.code : "promotion_request_failed";
    if (retryable.has(code) && now() < deadline) {
      say(`Production promotion waits: ${code}; retrying in ${Math.round(pollMs / 1000)} s.`);
      await sleep(pollMs);
      continue;
    }
    throw new Error(`promotion_stopped:${response.status}:${code}: ${document?.detail ?? "no detail"}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const approver = await verifyHumanApproval(process.env);
  process.stdout.write(`Promotion approved by ${approver}.\n`);
  const inputs = await requestPromotion(process.env);
  // JSON.stringify emits one line; the values are server-issued plan bytes, not secrets.
  await appendFile(process.env.GITHUB_OUTPUT, `dispatch_inputs=${JSON.stringify(inputs)}\n`);
  process.stdout.write(
    `Production promotion ${inputs.release_id} of ${inputs.expected_head_sha}: Bootstrap Mode ${inputs.bootstrap}, revision ${inputs.expected_current_revision}, schema level ${inputs.expected_migration_level}.\n`,
  );
}
