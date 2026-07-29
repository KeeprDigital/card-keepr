import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";

export async function executeCredentialBoundary(
  plan,
  secrets,
  environment,
) {
  const testBoundary = safeTestBoundary(environment);
  if (testBoundary !== null) {
    try {
      const response = await fetch(testBoundary, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan, secrets }),
      });
      if (!response.ok) throw new Error("test boundary failed");
      const result = await response.json();
      return validateBoundaryResult(plan, result);
    } catch {
      return boundaryFailure();
    }
  }
  const executor = resolve("cli/credential-boundary-attestor.mjs");
  const arguments_ = [
    executor,
    plan.action,
    plan.id,
    plan.plan_digest,
    plan.plan_nonce,
    plan.credential_class,
    plan.cloudflare_account_id,
    plan.resource_identity,
    plan.owning_boundary,
    plan.verification_target,
    plan.production_target_identity,
    plan.required_permission,
    plan.consumer_installation_identity,
    plan.execution_mode,
    String(plan.execution_attempt),
    plan.old_fingerprint,
    plan.replacement_fingerprint,
    plan.old_issuer_credential_id,
    plan.replacement_issuer_credential_id,
    plan.management_credential_id,
    plan.github_management_credential_id,
    plan.github_management_credential_fingerprint,
    plan.github_management_required_permission,
  ];
  const input = JSON.stringify({
    ...(secrets.old_secret === undefined
      ? {}
      : { old_secret: secrets.old_secret }),
    ...(secrets.replacement_secret === undefined
      ? {}
      : { replacement_secret: secrets.replacement_secret }),
    ...(secrets.management_credential === undefined
      ? {}
      : {
          management_credential:
            secrets.management_credential,
        }),
    ...(secrets.github_management_credential === undefined
      ? {}
      : {
          github_management_credential:
            secrets.github_management_credential,
        }),
  });
  const result = await run(
    process.execPath,
    arguments_,
    input,
    environment,
  );
  if (result.code !== 0) return boundaryFailure();
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      code: "invalid_credential_boundary_attestation",
      detail:
        "The owning credential boundary returned an invalid attestation.",
    };
  }
  return validateBoundaryResult(plan, document);
}

function validateBoundaryResult(plan, document) {
  if (
    document?.ok !== true ||
    document.plan_id !== plan.id ||
    !safeDigestEqual(document.plan_digest, plan.plan_digest) ||
    typeof document.boundary_attestation !== "string" ||
    document.boundary_attestation.length > 16_384
  ) {
    return {
      ok: false,
      code: "credential_boundary_mismatch",
      detail:
        "The owning credential boundary did not attest the exact reserved plan.",
    };
  }
  return {
    ok: true,
    attestation: document.boundary_attestation,
  };
}

function safeTestBoundary(environment) {
  if (
    environment.NODE_ENV !== "test" ||
    environment.KEEPR_TEST_BOUNDARY_URL === undefined
  ) {
    return null;
  }
  try {
    const url = new URL(environment.KEEPR_TEST_BOUNDARY_URL);
    return url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/credential-boundary" &&
      url.search === "" &&
      url.hash === "" &&
      url.port !== ""
      ? url
      : null;
  } catch {
    return null;
  }
}

function boundaryFailure() {
  return {
    ok: false,
    code: "credential_boundary_operation_failed",
    detail: "The owning credential boundary rejected the operation.",
  };
}

function safeDigestEqual(left, right) {
  const leftMatch = /^[0-9a-f]{64}$/.exec(left ?? "");
  const rightMatch = /^[0-9a-f]{64}$/.exec(right ?? "");
  const leftBytes =
    leftMatch === null ? Buffer.alloc(32) : Buffer.from(left, "hex");
  const rightBytes =
    rightMatch === null ? Buffer.alloc(32) : Buffer.from(right, "hex");
  return (
    leftMatch !== null &&
    rightMatch !== null &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function run(command, arguments_, input, environment) {
  return new Promise((resolveRun) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 32_768) child.kill();
    });
    // Provider diagnostics are discarded because they may contain request
    // material. The CLI emits only stable safe errors.
    child.stderr.resume();
    child.once("error", () => {
      resolveRun({ code: 1, stdout: "" });
    });
    child.once("exit", (code) => {
      resolveRun({ code: code ?? 1, stdout });
    });
    child.stdin.end(input);
  });
}
