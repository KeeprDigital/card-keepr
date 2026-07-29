import { readFileSync } from "node:fs";

export async function runCredentialCommand(
  arguments_,
  environment,
  json,
) {
  const action = arguments_[0];
  if (action === "show") {
    return showCredential(arguments_.slice(1), environment, json);
  }
  if (!["install", "verify", "revoke"].includes(action)) {
    return usageFailure(json);
  }
  return mutateCredential(
    action,
    arguments_.slice(1),
    environment,
    json,
  );
}

async function mutateCredential(
  action,
  arguments_,
  environment,
  json,
) {
  const requiredForAction =
    action === "install" || action === "revoke"
      ? ["--expected-old-fingerprint"]
      : [];
  const options = parseOptions(
    arguments_,
    [
      "--rotation-id",
      "--credential-class",
      "--environment",
      "--resource",
      "--boundary",
      "--secrets-stdin-fd",
      "--confirm",
      ...requiredForAction,
      ...(action === "verify" ? ["--verification-url"] : []),
    ],
    ["--yes", "--json"],
  );
  const required = [
    "--rotation-id",
    "--credential-class",
    "--environment",
    "--resource",
    "--boundary",
    "--secrets-stdin-fd",
    "--confirm",
    ...requiredForAction,
  ];
  if (
    options.error !== null ||
    !options.flags.has("--yes") ||
    required.some((option) => options.values[option] === undefined) ||
    options.values["--environment"] !== "production"
  ) {
    return usageFailure(json);
  }
  const confirmation = [
    action,
    options.values["--environment"],
    options.values["--credential-class"],
    options.values["--resource"],
    options.values["--rotation-id"],
  ].join(":");
  if (options.values["--confirm"] !== confirmation) {
    return usageFailure(json);
  }

  const secretFields = [
    "administration_key",
    ...(action === "install" ? ["old_secret"] : []),
    ...(action === "install" || action === "verify"
      ? ["replacement_secret"]
      : []),
  ];
  const secrets = readSecretBundle(
    options.values["--secrets-stdin-fd"],
    secretFields,
  );
  if (secrets.error !== null) {
    return writeFailure(
      json,
      { code: "secret_input_error", detail: secrets.error },
      2,
    );
  }

  if (action === "verify") {
    const verificationFailure = await probeCredentialBoundary(
      environment,
      options.values,
      secrets.values.replacement_secret,
    );
    if (verificationFailure !== null) {
      return writeFailure(json, verificationFailure, 7);
    }
  }

  const identity = {
    credential_class: options.values["--credential-class"],
    environment: options.values["--environment"],
    resource_identity: options.values["--resource"],
    owning_boundary: options.values["--boundary"],
  };
  const rotationId = options.values["--rotation-id"];
  const request =
    action === "install"
      ? {
          pathname: "/v1/credential-rotations",
          body: {
            rotation_id: rotationId,
            ...identity,
            expected_old_fingerprint:
              options.values["--expected-old-fingerprint"],
            old_secret: secrets.values.old_secret,
            replacement_secret: secrets.values.replacement_secret,
          },
        }
      : {
          pathname: `/v1/credential-rotations/${encodeURIComponent(
            rotationId,
          )}/${action === "verify" ? "verification" : "revocation"}`,
          body: {
            ...identity,
            ...(action === "verify"
              ? {
                  replacement_secret:
                    secrets.values.replacement_secret,
                }
              : {
                  expected_old_fingerprint:
                    options.values["--expected-old-fingerprint"],
                }),
          },
        };
  return credentialRequest(
    environment,
    json,
    request.pathname,
    "POST",
    request.body,
    secrets.values.administration_key,
  );
}

async function showCredential(arguments_, environment, json) {
  const options = parseOptions(
    arguments_,
    ["--rotation-id"],
    ["--json"],
  );
  const rotationId = options.values["--rotation-id"];
  if (options.error !== null || rotationId === undefined) {
    return usageFailure(json);
  }
  return credentialRequest(
    environment,
    json,
    `/v1/credential-rotations/${encodeURIComponent(rotationId)}`,
    "GET",
    undefined,
    environment.KEEPR_ADMINISTRATION_KEY,
  );
}

async function probeCredentialBoundary(
  environment,
  values,
  replacementSecret,
) {
  const credentialClass = values["--credential-class"];
  let probeUrl;
  let expectedRuntime = null;
  if (credentialClass === "api_bearer_key") {
    probeUrl = new URL(
      "/health",
      environment.KEEPR_API_URL ?? "http://127.0.0.1:8787",
    );
    expectedRuntime = "api";
  } else if (credentialClass === "ingestion_admin_key") {
    probeUrl = new URL(
      "/health",
      environment.KEEPR_INGESTION_URL ?? "http://127.0.0.1:8788",
    );
    expectedRuntime = "ingestion";
  } else {
    try {
      probeUrl = new URL(values["--verification-url"]);
    } catch {
      return {
        code: "credential_boundary_mismatch",
        detail:
          "Single-holder Cloudflare tokens require an exact Cloudflare API verification URL.",
      };
    }
    if (
      probeUrl.protocol !== "https:" ||
      probeUrl.hostname !== "api.cloudflare.com" ||
      !probeUrl.pathname.startsWith("/client/v4/")
    ) {
      return {
        code: "credential_boundary_mismatch",
        detail:
          "Single-holder Cloudflare tokens may be verified only at the Cloudflare API owning boundary.",
      };
    }
  }

  let response;
  try {
    response = await fetch(probeUrl, {
      headers: { authorization: `Bearer ${replacementSecret}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return {
      code: "replacement_verification_failed",
      detail: "The replacement credential boundary probe was unavailable.",
    };
  }
  let document;
  try {
    document = await response.json();
  } catch {
    return {
      code: "replacement_verification_failed",
      detail:
        "The replacement credential boundary probe returned an invalid contract.",
    };
  }
  if (
    !response.ok ||
    (expectedRuntime === null
      ? document?.success !== true
      : document?.contract !== "card-keepr-runtime-health@1" ||
        document.runtime !== expectedRuntime ||
        document.status !== "ok")
  ) {
    return {
      code: "replacement_verification_failed",
      detail:
        "The replacement credential did not pass its owning-boundary probe.",
    };
  }
  return null;
}

async function credentialRequest(
  environment,
  json,
  pathname,
  method,
  body,
  administrationKey,
) {
  if (!administrationKey) {
    return writeFailure(
      json,
      {
        code: "configuration_error",
        detail: "Missing administration credential input.",
      },
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
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return writeFailure(
      json,
      {
        code: "runtime_unavailable",
        detail: "ingestion runtime is unavailable",
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
      },
      8,
    );
  }
  if (!response.ok) {
    return writeFailure(
      json,
      {
        code:
          typeof document?.code === "string"
            ? document.code
            : "administration_error",
        detail:
          typeof document?.detail === "string"
            ? document.detail
            : `ingestion runtime returned HTTP ${response.status}`,
      },
      exitCodeForStatus(response.status),
    );
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else {
    process.stdout.write(
      [
        `Credential rotation ${document.id}: ${document.state}`,
        `Class: ${document.credential_class}`,
        `Environment: ${document.environment}`,
        `Resource: ${document.resource_identity}`,
        `Boundary: ${document.owning_boundary}`,
        `Old fingerprint: ${document.old_fingerprint}`,
        `Replacement fingerprint: ${document.replacement_fingerprint}`,
      ].join("\n") + "\n",
    );
  }
  return 0;
}

function readSecretBundle(descriptor, requiredFields) {
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
  if (Buffer.byteLength(text, "utf8") > 16_384) {
    return {
      error: "The secrets stdin document exceeds 16 KiB.",
      values: {},
    };
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return {
      error: "The secrets stdin document must be a JSON object.",
      values: {},
    };
  }
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    Object.keys(document).some(
      (field) => !requiredFields.includes(field),
    ) ||
    requiredFields.some(
      (field) =>
        typeof document[field] !== "string" ||
        document[field].length === 0,
    )
  ) {
    return {
      error:
        "The secrets stdin document does not match the required secret fields.",
      values: {},
    };
  }
  return { error: null, values: document };
}

function parseOptions(arguments_, valueOptions, flagOptions) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (flagOptions.includes(option)) {
      if (flags.has(option)) return { error: "duplicate", values, flags };
      flags.add(option);
      continue;
    }
    if (!valueOptions.includes(option) || values[option] !== undefined) {
      return { error: "unknown", values, flags };
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: "missing", values, flags };
    }
    values[option] = value;
    index += 1;
  }
  return { error: null, values, flags };
}

function usageFailure(json) {
  return writeFailure(
    json,
    {
      code: "usage_error",
      detail:
        "Usage: keepr credential install | credential verify | credential revoke | credential show",
    },
    2,
  );
}

function writeFailure(json, failure, exitCode) {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        contract: "card-keepr-cli-problem@1",
        status: "error",
        code: failure.code,
        detail: failure.detail,
      })}\n`,
    );
  } else {
    process.stderr.write(`${failure.detail}\n`);
  }
  return exitCode;
}

function exitCodeForStatus(status) {
  if (status === 401) return 4;
  if (status === 403) return 5;
  if (status === 404) return 6;
  if (status === 409) return 7;
  if (status === 400 || status === 413 || status === 422) return 8;
  return 9;
}
