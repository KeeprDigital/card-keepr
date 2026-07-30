import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import {
  isCredentialClass,
  resolveCredentialIdentity,
} from "../src/credentials/credential-catalogue.mjs";
import {
  exitCodeForStatus,
  parseOptions,
  writeCliFailure,
} from "./command-support.mjs";
import {
  executeCredentialBoundary,
  mayReleaseExecutionClaim,
} from "./credential-boundary.mjs";

export async function runCredentialCommand(
  arguments_,
  environment,
  json,
) {
  const action = arguments_[0];
  if (action === "show") {
    return show(arguments_.slice(1), environment, json);
  }
  if (!["install", "verify", "revoke"].includes(action)) {
    return usage(json);
  }
  return mutate(action, arguments_.slice(1), environment, json);
}

async function mutate(
  action,
  arguments_,
  environment,
  json,
) {
  const options = parseMutation(arguments_);
  if (options.error !== null) return usage(json);
  const credentialClass = options.values["--credential-class"];
  if (!isCredentialClass(credentialClass)) {
    return failure(
      json,
      "invalid_credential_class",
      "The credential class is not supported.",
      2,
    );
  }
  const targetEnvironment = options.values["--environment"];
  if (targetEnvironment !== "production") {
    return failure(
      json,
      "production_target_required",
      "Credential mutation requires --environment production.",
      2,
    );
  }
  const context = {
    cloudflare_account_id:
      options.values["--cloudflare-account-id"],
    catalogue_d1_database_id:
      options.values["--catalogue-d1-database-id"],
    disposable_d1_database_id:
      options.values["--disposable-d1-database-id"],
    github_repository_id:
      options.values["--github-repository-id"],
    github_installation_id:
      options.values["--github-installation-id"],
    github_environment_id:
      options.values["--github-environment-id"],
    github_workflow_id:
      options.values["--github-workflow-id"],
  };
  const identity = resolveCredentialIdentity(credentialClass, context);
  if (identity === undefined) return usage(json);
  const expectedGeneration = Number.parseInt(
    options.values["--expected-state-generation"],
    10,
  );
  if (
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 0
  ) {
    return usage(json);
  }
  const secretFields = [
    "administration_key",
    "management_credential",
    "consumer_proof_key",
    ...(credentialClass === "github_deployment_token"
      ? ["github_management_credential"]
      : []),
    ...(action === "install"
      ? ["old_secret", "replacement_secret"]
      : []),
  ];
  const secrets = readSecrets(
    options.values["--secrets-stdin-fd"],
    secretFields,
  );
  if (secrets.error !== null) {
    return failure(json, "secret_input_error", secrets.error, 2);
  }
  if (
    action === "install" &&
    ["api_bearer_key", "ingestion_admin_key"].includes(
      credentialClass,
    ) &&
    (!safeBearerSecret(secrets.values.old_secret) ||
      !safeBearerSecret(secrets.values.replacement_secret))
  ) {
    return failure(
      json,
      "invalid_bearer_secret",
      "Bearer credentials must be non-empty and contain no whitespace or control characters.",
      2,
    );
  }
  const oldFingerprint =
    options.values["--expected-old-fingerprint"];
  const replacementFingerprint =
    options.values["--expected-replacement-fingerprint"];
  if (
    action === "install" &&
    (!equalFingerprint(
      fingerprint(secrets.values.old_secret),
      oldFingerprint,
    ) ||
      !equalFingerprint(
        fingerprint(secrets.values.replacement_secret),
        replacementFingerprint,
      ))
  ) {
    return failure(
      json,
      "stale_credential_identity",
      "A supplied credential does not match its expected fingerprint.",
      7,
    );
  }
  if (
    credentialClass === "github_deployment_token" &&
    !equalFingerprint(
      fingerprint(secrets.values.github_management_credential),
      options.values[
        "--expected-github-management-fingerprint"
      ],
    )
  ) {
    return failure(
      json,
      "stale_github_management_identity",
      "The GitHub management credential does not match its expected fingerprint.",
      7,
    );
  }

  const planRequest = {
    action,
    rotation_id: options.values["--rotation-id"],
    credential_class: credentialClass,
    environment: targetEnvironment,
    cloudflare_account_id: context.cloudflare_account_id,
    resource_identity: identity.resource_identity,
    owning_boundary: identity.owning_boundary,
    verification_target: identity.verification_target,
    production_target_identity:
      identity.production_target_identity,
    expected_catalogue_revision_id:
      options.values["--expected-catalogue-revision"],
    expected_state_generation: expectedGeneration,
    old_fingerprint: oldFingerprint,
    replacement_fingerprint: replacementFingerprint,
    old_issuer_credential_id:
      options.values["--old-issuer-credential-id"],
    replacement_issuer_credential_id:
      options.values["--replacement-issuer-credential-id"],
    management_credential_id:
      options.values["--management-credential-id"],
    github_management_credential_id:
      options.values["--github-management-credential-id"],
    github_management_credential_fingerprint:
      options.values[
        "--expected-github-management-fingerprint"
      ],
    idempotency_key: options.values["--idempotency-key"],
  };
  const planned = await requestDocument(
    environment,
    "/v1/credential-rotation-plans",
    "POST",
    planRequest,
    secrets.values.administration_key,
  );
  if (!planned.ok) return requestFailure(json, planned);
  const plan = planned.document;
  if (
    plan?.contract !== "card-keepr-credential-rotation-plan@1" ||
    typeof plan.plan_digest !== "string" ||
    typeof plan.plan_nonce !== "string" ||
    typeof plan.required_permission !== "string" ||
    typeof plan.consumer_installation_identity !== "string"
  ) {
    return failure(
      json,
      "invalid_administration_contract",
      "ingestion runtime returned an invalid transition plan",
      8,
    );
  }
  if (plan.status === "finalized") {
    const completed = await requestDocument(
      environment,
      `/v1/credential-rotations/${encodeURIComponent(
        plan.rotation_id,
      )}`,
      "GET",
      undefined,
      secrets.values.administration_key,
    );
    if (!completed.ok) return requestFailure(json, completed);
    writeSuccess(json, completed.document);
    return 0;
  }
  if (!["reserved", "executing"].includes(plan.status)) {
    return failure(
      json,
      "credential_plan_expired",
      "The credential transition plan is no longer executable.",
      7,
    );
  }
  const confirmation = confirmationText(plan);
  if (
    !options.flags.has("--yes") ||
    options.values["--confirm"] !== confirmation
  ) {
    return failure(
      json,
      "confirmation_required",
      `Re-run with --confirm ${confirmation}`,
      2,
    );
  }
  const executionOwnerToken = randomBytes(32).toString("hex");
  const claimed = await requestDocument(
    environment,
    `/v1/credential-rotation-plans/${encodeURIComponent(
      plan.id,
    )}/execution`,
    "POST",
    {
      plan_digest: plan.plan_digest,
      execution_owner_token: executionOwnerToken,
      expected_execution_attempt: plan.execution_attempt,
    },
    secrets.values.administration_key,
  );
  if (!claimed.ok) return requestFailure(json, claimed);
  if (
    claimed.document?.contract !==
      "card-keepr-credential-rotation-plan@1" ||
    claimed.document.status !== "executing" ||
    !["mutation", "reconciliation"].includes(
      claimed.document.execution_mode,
    ) ||
    !Number.isSafeInteger(claimed.document.execution_attempt) ||
    claimed.document.execution_attempt < 1 ||
    !/^[0-9a-f]{64}$/.test(
      claimed.document.execution_capability ?? "",
    ) ||
    !sameExecutionPlan(plan, claimed.document)
  ) {
    return failure(
      json,
      "invalid_administration_contract",
      "ingestion runtime returned an invalid execution claim",
      8,
    );
  }
  const executionBaseUrl = administrationBaseUrl(environment);
  if (executionBaseUrl === null) {
    return failure(
      json,
      "invalid_administration_url",
      "Credential execution requires the validated ingestion URL.",
      8,
    );
  }
  claimed.document.execution_validation_url = new URL(
    `/v1/credential-rotation-plans/${encodeURIComponent(
      plan.id,
    )}/execution-capability`,
    executionBaseUrl,
  ).toString();

  const boundary = await executeCredentialBoundary(
    claimed.document,
    secrets.values,
    environment,
  );
  if (!boundary.ok) {
    if (
      claimed.document.execution_mode === "mutation" &&
      mayReleaseExecutionClaim(boundary)
    ) {
      await requestDocument(
        environment,
        `/v1/credential-rotation-plans/${encodeURIComponent(
          plan.id,
        )}/execution-failure`,
        "POST",
        {
          plan_digest: plan.plan_digest,
          execution_owner_token: executionOwnerToken,
          execution_attempt: claimed.document.execution_attempt,
          mutation_started: false,
        },
        secrets.values.administration_key,
      );
    }
    return failure(json, boundary.code, boundary.detail, 9);
  }
  const finalized = await requestDocument(
    environment,
    `/v1/credential-rotation-plans/${encodeURIComponent(
      plan.id,
    )}/finalization`,
    "POST",
    {
      plan_digest: plan.plan_digest,
      boundary_attestation: boundary.attestation,
    },
    secrets.values.administration_key,
  );
  if (!finalized.ok) return requestFailure(json, finalized);
  writeSuccess(json, finalized.document);
  return 0;
}

async function show(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--rotation-id"]);
  const rotationId = options.values["--rotation-id"];
  if (options.error !== null || rotationId === undefined) {
    return usage(json);
  }
  const response = await requestDocument(
    environment,
    `/v1/credential-rotations/${encodeURIComponent(rotationId)}`,
    "GET",
    undefined,
    environment.KEEPR_ADMINISTRATION_KEY,
  );
  if (!response.ok) return requestFailure(json, response);
  writeSuccess(json, response.document);
  return 0;
}

function parseMutation(arguments_) {
  const valueOptions = [
    "--rotation-id",
    "--credential-class",
    "--environment",
    "--cloudflare-account-id",
    "--catalogue-d1-database-id",
    "--disposable-d1-database-id",
    "--github-repository-id",
    "--github-installation-id",
    "--github-environment-id",
    "--github-workflow-id",
    "--expected-catalogue-revision",
    "--expected-state-generation",
    "--expected-old-fingerprint",
    "--expected-replacement-fingerprint",
    "--old-issuer-credential-id",
    "--replacement-issuer-credential-id",
    "--management-credential-id",
    "--github-management-credential-id",
    "--expected-github-management-fingerprint",
    "--idempotency-key",
    "--secrets-stdin-fd",
    "--confirm",
  ];
  const parsed = parseOptions(arguments_, valueOptions, [
    "--yes",
    "--json",
  ]);
  return {
    ...parsed,
    error:
      parsed.error ??
      (valueOptions.some(
        (option) => parsed.values[option] === undefined,
      )
        ? "missing"
        : null),
  };
}

function confirmationText(plan) {
  return [
    plan.action,
    plan.rotation_id,
    plan.credential_class,
    plan.environment,
    plan.cloudflare_account_id,
    plan.resource_identity,
    plan.owning_boundary,
    plan.expected_catalogue_revision_id,
    plan.expected_state_generation,
    plan.old_fingerprint,
    plan.replacement_fingerprint,
    plan.verification_target,
    plan.production_target_identity,
    plan.required_permission,
    plan.cloudflare_management_required_permissions,
    plan.consumer_installation_identity,
    plan.plan_digest,
    plan.idempotency_key,
    plan.old_issuer_credential_id,
    plan.replacement_issuer_credential_id,
    plan.management_credential_id,
    plan.github_management_credential_id,
    plan.github_management_credential_fingerprint,
    plan.github_management_required_permission,
  ].join(":");
}

function readSecrets(descriptor, required) {
  if (!/^(0|[3-9]|[1-9][0-9]+)$/.test(descriptor ?? "")) {
    return {
      error: "Secrets must be supplied through a readable stdin descriptor.",
      values: {},
    };
  }
  let text;
  try {
    text = readFileSync(Number.parseInt(descriptor, 10), "utf8");
  } catch {
    return {
      error: "The secrets stdin descriptor could not be read.",
      values: {},
    };
  }
  if (Buffer.byteLength(text) > 32_768) {
    return { error: "The secrets input exceeds 32 KiB.", values: {} };
  }
  let values;
  try {
    values = JSON.parse(text);
  } catch {
    values = null;
  }
  if (
    values === null ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.keys(values).some((key) => !required.includes(key)) ||
    required.some(
      (key) => typeof values[key] !== "string" || values[key].length === 0,
    )
  ) {
    return {
      error: "The secrets input does not match its required fields.",
      values: {},
    };
  }
  return { error: null, values };
}

function fingerprint(secret) {
  return `sha256:${createHash("sha256").update(secret).digest("hex")}`;
}

function safeBearerSecret(value) {
  return (
    typeof value === "string" &&
    value.length >= 22 &&
    value.length <= 4096 &&
    /^[A-Za-z0-9\-._~+/]+={0,8}$/u.test(value)
  );
}

function equalFingerprint(left, right) {
  const leftBytes = fingerprintBytes(left);
  const rightBytes = fingerprintBytes(right);
  return timingSafeEqual(leftBytes, rightBytes);
}

function fingerprintBytes(value) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(value ?? "");
  return match === null
    ? Buffer.alloc(32)
    : Buffer.from(match[1], "hex");
}

function equalDigest(left, right) {
  const leftMatch = /^[0-9a-f]{64}$/.exec(left ?? "");
  const rightMatch = /^[0-9a-f]{64}$/.exec(right ?? "");
  return (
    leftMatch !== null &&
    rightMatch !== null &&
    timingSafeEqual(
      Buffer.from(left, "hex"),
      Buffer.from(right, "hex"),
    )
  );
}

function sameExecutionPlan(planned, claimed) {
  const exactFields = [
    "id",
    "action",
    "rotation_id",
    "credential_class",
    "environment",
    "cloudflare_account_id",
    "resource_identity",
    "owning_boundary",
    "verification_target",
    "production_target_identity",
    "required_permission",
    "cloudflare_management_required_permissions",
    "consumer_installation_identity",
    "expected_catalogue_revision_id",
    "expected_state_generation",
    "expected_rotation_state",
    "old_issuer_credential_id",
    "replacement_issuer_credential_id",
    "management_credential_id",
    "github_management_credential_id",
    "github_management_credential_fingerprint",
    "github_management_required_permission",
    "idempotency_key",
  ];
  return (
    exactFields.every(
      (field) => planned[field] === claimed[field],
    ) &&
    equalDigest(planned.plan_digest, claimed.plan_digest) &&
    equalDigest(planned.plan_nonce, claimed.plan_nonce) &&
    equalFingerprint(
      planned.old_fingerprint,
      claimed.old_fingerprint,
    ) &&
    equalFingerprint(
      planned.replacement_fingerprint,
      claimed.replacement_fingerprint,
    )
  );
}

async function requestDocument(
  environment,
  pathname,
  method,
  body,
  administrationKey,
) {
  if (!administrationKey) {
    return {
      ok: false,
      status: 0,
      document: {
        code: "configuration_error",
        detail: "Missing administration credential input.",
      },
    };
  }
  const baseUrl = administrationBaseUrl(environment);
  if (baseUrl === null) {
    return {
      ok: false,
      status: 0,
      document: {
        code: "configuration_error",
        detail:
          "Credential commands require an explicit HTTPS KEEPR_INGESTION_URL.",
      },
    };
  }
  let response;
  try {
    response = await fetch(
      new URL(pathname, baseUrl),
      {
        method,
        headers: {
          authorization: `Bearer ${administrationKey}`,
          ...(body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return {
      ok: false,
      status: 0,
      document: {
        code: "runtime_unavailable",
        detail: "ingestion runtime is unavailable",
      },
    };
  }
  let document;
  try {
    document = await response.json();
  } catch {
    return {
      ok: false,
      status: response.status,
      document: {
        code: "invalid_administration_contract",
        detail: "ingestion runtime returned invalid JSON",
      },
    };
  }
  return { ok: response.ok, status: response.status, document };
}

function administrationBaseUrl(environment) {
  if (environment.KEEPR_INGESTION_URL === undefined) return null;
  try {
    const url = new URL(environment.KEEPR_INGESTION_URL);
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    if (url.protocol === "https:") return url;
    return environment.NODE_ENV === "test" &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== ""
      ? url
      : null;
  } catch {
    return null;
  }
}

function requestFailure(json, response) {
  return failure(
    json,
    typeof response.document?.code === "string"
      ? response.document.code
      : "administration_error",
    typeof response.document?.detail === "string"
      ? response.document.detail
      : `ingestion runtime returned HTTP ${response.status}`,
    response.status === 0
      ? 9
      : exitCodeForStatus(response.status),
  );
}

function writeSuccess(json, document) {
  if (json) {
    process.stdout.write(`${JSON.stringify(document)}\n`);
    return;
  }
  process.stdout.write(
    [
      `Credential rotation ${document.id}: ${document.state}`,
      `Class: ${document.credential_class}`,
      `Environment: ${document.environment}`,
      `Resource: ${document.resource_identity}`,
      `Boundary: ${document.owning_boundary}`,
      `Verification target: ${document.verification_target}`,
      `Old fingerprint: ${document.old_fingerprint}`,
      `Replacement fingerprint: ${document.replacement_fingerprint}`,
      `Operation: ${document.operation_code}`,
    ].join("\n") + "\n",
  );
}

function usage(json) {
  return failure(
    json,
    "usage_error",
    "Usage: keepr credential install | verify | revoke | show",
    2,
  );
}

function failure(json, code, detail, exitCode) {
  return writeCliFailure(json, { code, detail }, exitCode);
}
