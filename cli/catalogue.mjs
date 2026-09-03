import {
  exitCodeForStatus,
  parseOptions,
  runtimeUrl,
  writeCliFailure,
} from "./command-support.mjs";

export async function runCatalogueCommand(
  arguments_,
  environment,
  json,
) {
  if (arguments_[0] !== "search") return usageFailure(json);
  const options = parseOptions(arguments_.slice(1), [
    "--query",
    "--game",
    "--card-number",
    "--limit",
    "--after",
  ]);
  if (options.error !== null) return usageFailure(json);
  const parameters = new URLSearchParams();
  for (const [option, parameter] of [
    ["--query", "q"],
    ["--game", "game"],
    ["--card-number", "card_number"],
    ["--limit", "limit"],
    ["--after", "after"],
  ]) {
    const value = options.values[option];
    if (value !== undefined) parameters.set(parameter, value);
  }
  return catalogueRequest(
    environment,
    json,
    `/v1/cards${parameters.size === 0 ? "" : `?${parameters}`}`,
  );
}

async function catalogueRequest(environment, json, pathname) {
  if (!environment.KEEPR_API_KEY) {
    return writeCliFailure(
      json,
      {
        code: "configuration_error",
        detail: "Missing required environment: KEEPR_API_KEY",
      },
      2,
    );
  }
  let response;
  try {
    response = await fetch(
      runtimeUrl(
        environment.KEEPR_API_URL ?? "http://127.0.0.1:8787",
        pathname,
      ),
      {
        headers: {
          authorization: `Bearer ${environment.KEEPR_API_KEY}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return writeCliFailure(
      json,
      {
        code: "runtime_unavailable",
        detail: "API runtime is unavailable",
        runtime: "api",
      },
      9,
    );
  }
  let document;
  try {
    document = await response.json();
  } catch {
    return writeCliFailure(
      json,
      {
        code: "invalid_catalogue_contract",
        detail: "API runtime returned invalid JSON",
        runtime: "api",
      },
      8,
    );
  }
  if (!response.ok) {
    return writeCliFailure(
      json,
      {
        code:
          typeof document?.code === "string"
            ? document.code
            : "catalogue_error",
        detail:
          typeof document?.detail === "string"
            ? document.detail
            : `API runtime returned HTTP ${response.status}`,
      },
      exitCodeForStatus(response.status),
    );
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else {
    for (const card of document.data ?? []) {
      process.stdout.write(
        `${card.game} ${card.official_identity?.value ?? "unknown"} ${card.name}\n`,
      );
    }
  }
  return 0;
}

function usageFailure(json) {
  return writeCliFailure(
    json,
    {
      code: "usage_error",
      detail:
        "Usage: keepr cards search [--query TEXT] [--game GAME] [--card-number NUMBER] [--limit N] [--after CURSOR]",
    },
    2,
  );
}
