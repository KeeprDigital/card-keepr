#!/usr/bin/env node

const exit = await main(process.argv.slice(2), process.env);
process.exitCode = exit;

async function main(arguments_, environment) {
  const [command, ...options] = arguments_;
  if (command !== "health" || options.some((option) => option !== "--json")) {
    process.stderr.write("Usage: keepr health [--json]\n");
    return 2;
  }

  const configuration = readConfiguration(environment);
  if (configuration.error !== null) {
    process.stderr.write(`${configuration.error}\n`);
    return 2;
  }

  const results = await Promise.all(
    configuration.runtimes.map(async (runtime) => checkRuntime(runtime)),
  );
  const failure = results.find((result) => !result.ok);
  if (failure !== undefined) {
    process.stderr.write(`${failure.message}\n`);
    return failure.exitCode;
  }

  const document = {
    contract: "card-keepr-cli-health@1",
    status: "ok",
    runtimes: results.map((result) => result.health),
  };
  if (options.includes("--json")) {
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
        capabilities: [
          "catalogue:read",
          "evidence:read",
          "printing-image:read",
          "export:read",
        ],
      },
      {
        name: "ingestion",
        url: environment.KEEPR_INGESTION_URL ?? "http://127.0.0.1:8788",
        key: environment.KEEPR_ADMINISTRATION_KEY,
        capabilities: [
          "catalogue:write",
          "evidence:write",
          "printing-image:write",
          "export:write",
          "backup:write",
        ],
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
      message: `${runtime.name} runtime is unavailable`,
    };
  }

  if (response.status === 401) {
    return {
      ok: false,
      exitCode: 4,
      message: `${runtime.name} runtime rejected its credential`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      exitCode: 9,
      message: `${runtime.name} runtime returned HTTP ${response.status}`,
    };
  }

  const health = await response.json();
  if (
    health?.contract !== "card-keepr-runtime-health@1" ||
    health.runtime !== runtime.name ||
    health.status !== "ok" ||
    !sameStrings(health.capabilities, runtime.capabilities)
  ) {
    return {
      ok: false,
      exitCode: 8,
      message: `${runtime.name} runtime returned an invalid health contract`,
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
