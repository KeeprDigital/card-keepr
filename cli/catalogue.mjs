import { parseOptions, writeCliFailure } from "./command-support.mjs";
import { requestDocument } from "./lib/json-client.mjs";

export async function runCatalogueCommand(arguments_, environment, json) {
  if (arguments_[0] !== "search") return usageFailure(json);
  const options = parseOptions(arguments_.slice(1), ["--query", "--game", "--card-number", "--limit", "--after"]);
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
  return catalogueRequest(environment, json, `/v1/cards${parameters.size === 0 ? "" : `?${parameters}`}`);
}

async function catalogueRequest(environment, json, pathname) {
  const result = await requestDocument(environment, pathname, {
    runtime: "api",
    key: environment.KEEPR_API_KEY,
    contract: "catalogue",
  });
  if (result.error !== null) return writeCliFailure(json, result.error, result.exitCode);
  const document = result.document;
  if (json) {
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else {
    for (const card of document.data ?? []) {
      process.stdout.write(`${card.game} ${card.official_identity?.value ?? "unknown"} ${card.name}\n`);
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
