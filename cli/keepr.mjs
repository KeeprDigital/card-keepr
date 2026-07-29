#!/usr/bin/env node

import {
  apiCapabilities,
  ingestionCapabilities,
} from "../src/runtime-capabilities.mjs";

const exit = await main(process.argv.slice(2), process.env);
process.exitCode = exit;

async function main(arguments_, environment) {
  const json = arguments_.includes("--json");
  if (arguments_[0] === "health") {
    if (arguments_.slice(1).some((option) => option !== "--json")) {
      return usageFailure(json);
    }
    return health(environment, json);
  }

  if (isCommand(arguments_, "run", "start")) {
    return startRun(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "run", "show")) {
    return showRun(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "candidate", "inspect")) {
    return inspectCandidate(arguments_.slice(2), environment, json);
  }
  if (isCommand(arguments_, "run", "approve")) {
    return approveRun(arguments_.slice(2), environment, json);
  }

  return usageFailure(json);
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

  const results = await Promise.all(
    configuration.runtimes.map(async (runtime) => checkRuntime(runtime)),
  );
  const failure = results.find((result) => !result.ok);
  if (failure !== undefined) {
    return writeFailure(json, failure, failure.exitCode);
  }

  const document = {
    contract: "card-keepr-cli-health@1",
    status: "ok",
    runtimes: results.map((result) => result.health),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else {
    process.stdout.write("Card Keepr runtimes are healthy\n");
    for (const runtime of document.runtimes) {
      process.stdout.write(
        `${runtime.name}: ${runtime.status} (${runtime.capabilities.join(", ")})\n`,
      );
    }
  }
  return 0;
}

async function startRun(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--fixture",
    "--games",
    "--idempotency-key",
  ]);
  if (
    options.error !== null ||
    options.values["--fixture"] === undefined ||
    options.values["--games"] === undefined ||
    options.values["--idempotency-key"] === undefined
  ) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    "/v1/ingestion-runs",
    "POST",
    {
      fixture: options.values["--fixture"],
      selected_games: options.values["--games"]
        .split(",")
        .map((game) => game.trim())
        .filter(Boolean),
      idempotency_key: options.values["--idempotency-key"],
    },
  );
}

async function showRun(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--run-id"]);
  const runId = options.values["--run-id"];
  if (options.error !== null || runId === undefined) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}`,
    "GET",
  );
}

async function inspectCandidate(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--run-id"]);
  const runId = options.values["--run-id"];
  if (options.error !== null || runId === undefined) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}/candidate`,
    "GET",
  );
}

async function approveRun(arguments_, environment, json) {
  const options = parseOptions(
    arguments_,
    [
      "--run-id",
      "--candidate-digest",
      "--expected-current-revision",
      "--idempotency-key",
    ],
    ["--yes"],
  );
  const runId = options.values["--run-id"];
  const candidateDigest = options.values["--candidate-digest"];
  const expectedCurrentRevision =
    options.values["--expected-current-revision"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (
    options.error !== null ||
    runId === undefined ||
    candidateDigest === undefined ||
    expectedCurrentRevision === undefined ||
    idempotencyKey === undefined ||
    !options.flags.has("--yes")
  ) {
    return usageFailure(json);
  }
  return administrationRequest(
    environment,
    json,
    `/v1/ingestion-runs/${encodeURIComponent(runId)}/approval`,
    "POST",
    {
      candidate_digest: candidateDigest,
      expected_current_revision_id: expectedCurrentRevision,
      idempotency_key: idempotencyKey,
    },
  );
}

async function administrationRequest(
  environment,
  json,
  pathname,
  method,
  body,
) {
  const configuration = readAdministrationConfiguration(environment);
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
  let response;
  try {
    response = await fetch(new URL(pathname, configuration.url), {
      method,
      headers: {
        authorization: `Bearer ${configuration.key}`,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return writeFailure(
      json,
      {
        code: "runtime_unavailable",
        detail: "ingestion runtime is unavailable",
        runtime: "ingestion",
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
        runtime: "ingestion",
      },
      8,
    );
  }
  if (!response.ok) {
    const code =
      typeof document?.code === "string"
        ? document.code
        : "administration_error";
    const detail =
      typeof document?.detail === "string"
        ? document.detail
        : `ingestion runtime returned HTTP ${response.status}`;
    return writeFailure(
      json,
      { code, detail },
      exitCodeForStatus(response.status),
    );
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else {
    process.stdout.write(`${formatAdministrationResult(document)}\n`);
  }
  return 0;
}

function readHealthConfiguration(environment) {
  const required = [
    "KEEPR_API_KEY",
    "KEEPR_ADMINISTRATION_KEY",
  ];
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

function readAdministrationConfiguration(environment) {
  if (!environment.KEEPR_ADMINISTRATION_KEY) {
    return {
      error: "Missing required environment: KEEPR_ADMINISTRATION_KEY",
      url: "",
      key: "",
    };
  }
  return {
    error: null,
    url: environment.KEEPR_INGESTION_URL ?? "http://127.0.0.1:8788",
    key: environment.KEEPR_ADMINISTRATION_KEY,
  };
}

function isCommand(arguments_, first, second) {
  return arguments_[0] === first && arguments_[1] === second;
}

function parseOptions(
  arguments_,
  valueOptions,
  flagOptions = ["--json"],
) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (flagOptions.includes(option) || option === "--json") {
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
        "Usage: keepr health | run start | run show | candidate inspect | run approve",
    },
    2,
  );
}

function exitCodeForStatus(status) {
  if (status === 401) return 4;
  if (status === 403) return 5;
  if (status === 404) return 6;
  if (status === 409) return 7;
  if (status === 400 || status === 413 || status === 422) return 8;
  return 9;
}

function formatAdministrationResult(document) {
  if (document.state && document.id) {
    return `Ingestion Run ${document.id}: ${document.state}`;
  }
  if (document.run_id && document.candidate_digest) {
    return `Candidate ${document.candidate_digest} for Ingestion Run ${document.run_id}`;
  }
  return JSON.stringify(document);
}

async function checkRuntime(runtime) {
  let response;
  try {
    response = await fetch(new URL("/health", runtime.url), {
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
  if (!response.ok) {
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
  if (
    health?.contract !== "card-keepr-runtime-health@1" ||
    health.runtime !== runtime.name ||
    health.status !== "ok" ||
    !sameStrings(health.capabilities, runtime.capabilities)
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

function writeFailure(json, failure, exitCode) {
  if (json) {
    const document = {
      contract: "card-keepr-cli-problem@1",
      status: "error",
      code: failure.code,
      detail: failure.detail,
      ...(failure.runtime ? { runtime: failure.runtime } : {}),
    };
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else {
    process.stderr.write(`${failure.detail}\n`);
  }
  return exitCode;
}
