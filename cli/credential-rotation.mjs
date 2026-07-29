import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  exitCodeForStatus,
  parseOptions,
  writeCliFailure,
} from "./command-support.mjs";
import { executeCredentialBoundary } from "./credential-boundary.mjs";

const targets = {
  api_bearer_key: {
    resource: "worker:card-keepr-api",
    boundary: "api_worker",
    verification: "worker-health:card-keepr-api",
    runtime: "api",
  },
  ingestion_admin_key: {
    resource: "worker:card-keepr-ingestion",
    boundary: "ingestion_worker",
    verification: "worker-health:card-keepr-ingestion",
    runtime: "ingestion",
  },
  d1_export_token: {
    resource: "d1:card-keepr-catalogue",
    boundary: "d1_export_operation",
    verification: "cloudflare:d1:card-keepr-catalogue:export",
  },
  d1_verification_token: {
    resource: "d1:disposable-verification",
    boundary: "disposable_verification",
    verification: "cloudflare:d1:disposable-verification:edit",
  },
  github_deployment_token: {
    resource: "worker-release:card-keepr",
    boundary: "production_release_workflow",
    verification:
      "github:KeeprDigital/card-keepr:environment:production",
  },
};

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

async function mutate(action, arguments_, environment, json) {
  const options = parse(arguments_);
  if (options.error !== null) return usage(json);
  const credentialClass = options.values["--credential-class"];
  const expected = targets[credentialClass];
  const identity = {
    credential_class: credentialClass,
    environment: options.values["--environment"],
    resource_identity: options.values["--resource"],
    owning_boundary: options.values["--boundary"],
    verification_target: options.values["--verification-target"],
  };
  if (
    expected === undefined ||
    identity.environment !== "production" ||
    identity.resource_identity !== expected.resource ||
    identity.owning_boundary !== expected.boundary ||
    identity.verification_target !== expected.verification
  ) {
    return failure(
      json,
      "stale_credential_identity",
      "The resolved credential boundary identity is stale.",
      7,
    );
  }
  const secretFields = [
    "administration_key",
    ...(action === "install" || action === "revoke"
      ? ["old_secret"]
      : []),
    ...(action === "install" || action === "verify"
      ? ["replacement_secret"]
      : []),
  ];
  const secrets = readSecrets(
    options.values["--secrets-stdin-fd"],
    secretFields,
  );
  if (secrets.error !== null) {
    return failure(json, "secret_input_error", secrets.error, 2);
  }
  const oldFingerprint =
    secrets.values.old_secret === undefined
      ? options.values["--expected-old-fingerprint"]
      : fingerprint(secrets.values.old_secret);
  const replacementFingerprint =
    secrets.values.replacement_secret === undefined
      ? options.values["--expected-replacement-fingerprint"]
      : fingerprint(secrets.values.replacement_secret);
  if (
    oldFingerprint !== options.values["--expected-old-fingerprint"] ||
    replacementFingerprint !==
      options.values["--expected-replacement-fingerprint"]
  ) {
    return failure(
      json,
      "stale_credential_identity",
      "A supplied credential does not match its expected active fingerprint.",
      7,
    );
  }
  const confirmation = [
    action,
    options.values["--rotation-id"],
    identity.credential_class,
    identity.environment,
    identity.resource_identity,
    identity.owning_boundary,
    identity.verification_target,
    oldFingerprint,
    replacementFingerprint,
    options.values["--idempotency-key"],
  ].join(":");
  if (
    !options.flags.has("--yes") ||
    options.values["--confirm"] !== confirmation
  ) {
    return usage(json);
  }

  let receipt;
  if (action === "install") {
    const oldProbe = await proveBoundary(
      "probe-old",
      identity,
      secrets.values.old_secret,
      expected,
      environment,
    );
    if (!oldProbe.ok) return boundaryFailure(json, oldProbe);
    const installed = await executeCredentialBoundary(
      "install",
      identity,
      secrets.values.replacement_secret,
      environment,
    );
    if (!installed.ok) return boundaryFailure(json, installed);
    receipt = installed.receipt;
  } else if (action === "verify") {
    const verified = await proveBoundary(
      "verify",
      identity,
      secrets.values.replacement_secret,
      expected,
      environment,
    );
    if (!verified.ok) return boundaryFailure(json, verified);
    receipt = verified.receipt;
  } else {
    const revoked = await executeCredentialBoundary(
      "revoke",
      identity,
      secrets.values.old_secret,
      environment,
    );
    if (!revoked.ok) return boundaryFailure(json, revoked);
    receipt = revoked.receipt;
  }

  const rotationId = options.values["--rotation-id"];
  const body = {
    ...identity,
    boundary_receipt: receipt,
    idempotency_key: options.values["--idempotency-key"],
    ...(action === "install"
      ? {
          rotation_id: rotationId,
          old_fingerprint: oldFingerprint,
          replacement_fingerprint: replacementFingerprint,
        }
      : action === "verify"
        ? { replacement_fingerprint: replacementFingerprint }
        : {
            old_fingerprint: oldFingerprint,
            replacement_fingerprint: replacementFingerprint,
          }),
  };
  return request(
    environment,
    json,
    action === "install"
      ? "/v1/credential-rotations"
      : `/v1/credential-rotations/${encodeURIComponent(rotationId)}/${
          action === "verify" ? "verification" : "revocation"
        }`,
    "POST",
    body,
    secrets.values.administration_key,
  );
}

async function proveBoundary(
  action,
  identity,
  secret,
  target,
  environment,
) {
  if (target.runtime === undefined) {
    return executeCredentialBoundary(
      action,
      identity,
      secret,
      environment,
    );
  }
  const base =
    target.runtime === "api"
      ? environment.KEEPR_API_URL ?? "http://127.0.0.1:8787"
      : environment.KEEPR_INGESTION_URL ?? "http://127.0.0.1:8788";
  let response;
  try {
    response = await fetch(new URL("/health", base), {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return {
      ok: false,
      code: "credential_boundary_operation_failed",
      detail: "The owning Worker boundary was unavailable.",
    };
  }
  let document;
  try {
    document = await response.json();
  } catch {
    document = null;
  }
  if (
    !response.ok ||
    document?.contract !== "card-keepr-runtime-health@1" ||
    document.runtime !== target.runtime ||
    document.status !== "ok"
  ) {
    return {
      ok: false,
      code: "stale_credential_identity",
      detail:
        "The credential did not authenticate at its exact owning Worker boundary.",
    };
  }
  return {
    ok: true,
    receipt: `receipt:worker-health:${createHash("sha256")
      .update(
        [
          action,
          identity.credential_class,
          identity.resource_identity,
          identity.verification_target,
          fingerprint(secret),
        ].join("\0"),
      )
      .digest("hex")}`,
  };
}

async function show(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--rotation-id"]);
  const rotationId = options.values["--rotation-id"];
  if (options.error !== null || rotationId === undefined) {
    return usage(json);
  }
  return request(
    environment,
    json,
    `/v1/credential-rotations/${encodeURIComponent(rotationId)}`,
    "GET",
    undefined,
    environment.KEEPR_ADMINISTRATION_KEY,
  );
}

function parse(arguments_) {
  const valueOptions = [
    "--rotation-id",
    "--credential-class",
    "--environment",
    "--resource",
    "--boundary",
    "--verification-target",
    "--expected-old-fingerprint",
    "--expected-replacement-fingerprint",
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
  if (Buffer.byteLength(text) > 16_384) {
    return { error: "The secrets input exceeds 16 KiB.", values: {} };
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

async function request(
  environment,
  json,
  pathname,
  method,
  body,
  administrationKey,
) {
  if (!administrationKey) {
    return failure(
      json,
      "configuration_error",
      "Missing administration credential input.",
      2,
    );
  }
  let response;
  try {
    response = await fetch(
      new URL(
        pathname,
        environment.KEEPR_INGESTION_URL ??
          "http://127.0.0.1:8788",
      ),
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
    return failure(
      json,
      "runtime_unavailable",
      "ingestion runtime is unavailable",
      9,
    );
  }
  let document;
  try {
    document = await response.json();
  } catch {
    return failure(
      json,
      "invalid_administration_contract",
      "ingestion runtime returned invalid JSON",
      8,
    );
  }
  if (!response.ok) {
    return failure(
      json,
      typeof document?.code === "string"
        ? document.code
        : "administration_error",
      typeof document?.detail === "string"
        ? document.detail
        : `ingestion runtime returned HTTP ${response.status}`,
      exitCodeForStatus(response.status),
    );
  }
  if (json) process.stdout.write(`${JSON.stringify(document)}\n`);
  else {
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
  return 0;
}

function boundaryFailure(json, result) {
  return failure(json, result.code, result.detail, 9);
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
