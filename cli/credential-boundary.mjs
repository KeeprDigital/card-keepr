import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

export async function executeCredentialBoundary(
  plan,
  secrets,
  environment,
) {
  const consumerProofKey = secrets.consumer_proof_key;
  if (
    typeof consumerProofKey !== "string" ||
    consumerProofKey.length < 32
  ) {
    return boundaryFailure(false);
  }
  const providerSecrets = {
    ...(secrets.old_secret === undefined
      ? {}
      : { old_secret: secrets.old_secret }),
    ...(secrets.replacement_secret === undefined
      ? {}
      : { replacement_secret: secrets.replacement_secret }),
    ...(secrets.management_credential === undefined
      ? {}
      : { management_credential: secrets.management_credential }),
    ...(secrets.github_management_credential === undefined
      ? {}
      : {
          github_management_credential:
            secrets.github_management_credential,
        }),
  };
  const testBoundary = safeTestBoundary(environment);
  if (testBoundary !== null) {
    try {
      const response = await fetch(testBoundary, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan, secrets: providerSecrets }),
      });
      if (!response.ok) throw new Error("test boundary failed");
      const result = await response.json();
      if (result?.ok !== true) {
        const journal = validMutationJournal(result?.journal);
        return boundaryFailure(
          journal?.mutation_started ?? true,
          journal,
        );
      }
      return validateBoundaryResult(plan, result);
    } catch {
      return boundaryFailure(true);
    }
  }
  const executor = fileURLToPath(
    new URL("./credential-boundary-attestor.mjs", import.meta.url),
  );
  const input = JSON.stringify(providerSecrets);
  const result = await run(
    process.execPath,
    [executor],
    input,
    consumerProofKey,
    JSON.stringify({
      contract: "card-keepr-credential-boundary-plan@1",
      plan,
    }),
    subprocessEnvironment(environment),
  );
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
  if (result.code !== 0 || document?.ok !== true) {
    const journal = validMutationJournal(document?.journal);
    return boundaryFailure(
      journal?.mutation_started ?? true,
      journal,
    );
  }
  return validateBoundaryResult(plan, document);
}

export function mayReleaseExecutionClaim(boundaryResult) {
  return (
    boundaryResult?.ok === false &&
    boundaryResult.mutation_started === false &&
    boundaryResult.journal?.contract ===
      "card-keepr-provider-mutation-journal@1" &&
    boundaryResult.journal.mutation_started === false
  );
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

function boundaryFailure(mutationStarted = true, journal = null) {
  return {
    ok: false,
    code: "credential_boundary_operation_failed",
    detail: "The owning credential boundary rejected the operation.",
    mutation_started: mutationStarted,
    journal,
  };
}

function validMutationJournal(value) {
  return value?.contract ===
    "card-keepr-provider-mutation-journal@1" &&
    typeof value.mutation_started === "boolean" &&
    Array.isArray(value.steps) &&
    value.steps.every(
      (step) => typeof step === "string" && step.length <= 256,
    )
    ? value
    : null;
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

function subprocessEnvironment(environment) {
  return Object.fromEntries(
    Object.entries({
      PATH: environment.PATH,
      HOME: environment.HOME,
      CI: "1",
    }).filter(([, value]) => typeof value === "string"),
  );
}

function run(command, arguments_, input, key, planEnvelope, environment) {
  return new Promise((resolveRun) => {
    const child = spawn(command, arguments_, {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: environment,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
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
    child.stdio[3].end(key);
    child.stdio[4].end(planEnvelope);
  });
}
