import { parseOptions, writeCliFailure } from "./command-support.mjs";
import { requestDocument } from "./lib/json-client.mjs";

export async function runLegalityStatusCommand(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--card-id", "--on", "--format", "--event-tier", "--region"]);
  const cardId = options.values["--card-id"];
  const on = options.values["--on"];
  const format = options.values["--format"];
  if (options.error !== null || cardId === undefined || on === undefined || format === undefined) {
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
  return apiRequest(environment, json, `/v1/legality-status?${parameters}`);
}

async function apiRequest(environment, json, pathname) {
  const result = await requestDocument(environment, pathname, {
    runtime: "api",
    key: environment.KEEPR_API_KEY,
    contract: "api",
  });
  if (result.error !== null) return writeCliFailure(json, result.error, result.exitCode);
  const document = result.document;
  process.stdout.write(json ? `${JSON.stringify(document)}\n` : `${formatLegalityStatus(document)}\n`);
  return 0;
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
