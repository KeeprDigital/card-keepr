import {
  exitCodeForStatus,
  parseOptions,
  writeCliFailure,
} from "./command-support.mjs";

export async function runLegalityStatusCommand(
  arguments_,
  environment,
  json,
) {
  const options = parseOptions(arguments_, [
    "--card-id",
    "--on",
    "--format",
    "--event-tier",
    "--region",
  ]);
  const cardId = options.values["--card-id"];
  const on = options.values["--on"];
  const format = options.values["--format"];
  if (
    options.error !== null ||
    cardId === undefined ||
    on === undefined ||
    format === undefined
  ) {
    return usageFailure(json);
  }
  const parameters = new URLSearchParams({
    card_id: cardId,
    on,
    format,
  });
  const eventTier = options.values["--event-tier"];
  if (eventTier !== undefined) {
    parameters.set("event_tier", eventTier);
  }
  const region = options.values["--region"];
  if (region !== undefined) {
    parameters.set("region", region);
  }
  return apiRequest(
    environment,
    json,
    `/v1/legality-status?${parameters}`,
  );
}

async function apiRequest(environment, json, pathname) {
  const configuration = readApiConfiguration(environment);
  if (configuration.error !== null) {
    return writeCliFailure(
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
      headers: {
        authorization: `Bearer ${configuration.key}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
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
        code: "invalid_api_contract",
        detail: "API runtime returned invalid JSON",
        runtime: "api",
      },
      8,
    );
  }
  if (!response.ok) {
    const code =
      typeof document?.code === "string" ? document.code : "api_error";
    const detail =
      typeof document?.detail === "string"
        ? document.detail
        : `API runtime returned HTTP ${response.status}`;
    return writeCliFailure(
      json,
      { code, detail },
      exitCodeForStatus(response.status),
    );
  }
  process.stdout.write(
    json
      ? `${JSON.stringify(document)}\n`
      : `${formatLegalityStatus(document)}\n`,
  );
  return 0;
}

function readApiConfiguration(environment) {
  if (!environment.KEEPR_API_KEY) {
    return {
      error: "Missing required environment: KEEPR_API_KEY",
      url: "",
      key: "",
    };
  }
  return {
    error: null,
    url: environment.KEEPR_API_URL ?? "http://127.0.0.1:8787",
    key: environment.KEEPR_API_KEY,
  };
}

function formatLegalityStatus(document) {
  const results = Array.isArray(document.data) ? document.data : [];
  if (results.length === 0) return "No contextual Legality Status results";
  return results
    .map(
      (result) =>
        `${result.card_id} ${result.region} ${result.format} on ${result.on}: ${result.status}\n${result.derivation}`,
    )
    .join("\n");
}

function usageFailure(json) {
  return writeCliFailure(
    json,
    {
      code: "usage_error",
      detail:
        "Usage: keepr legality status --card-id ID --on DATE --format FORMAT [--event-tier TIER] [--region REGION] [--json]",
    },
    2,
  );
}
