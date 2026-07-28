#!/usr/bin/env node

import {
  apiCapabilities,
  ingestionCapabilities,
} from "../src/runtime-capabilities.mjs";

const exit = await main(process.argv.slice(2), process.env);
process.exitCode = exit;

async function main(arguments_, environment) {
  const [command, ...options] = arguments_;
  const json = options.includes("--json");
  if (command !== "health" || options.some((option) => option !== "--json")) {
    return writeFailure(
      json,
      {
        code: "usage_error",
        detail: "Usage: keepr health [--json]",
      },
      2,
    );
  }

  const configuration = readConfiguration(environment);
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

function readConfiguration(environment) {
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
