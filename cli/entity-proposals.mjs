import { readFile } from "node:fs/promises";
import { parseOptions, writeCliFailure } from "./command-support.mjs";
import { requestDocument } from "./lib/json-client.mjs";

export async function runEntityProposalCommand(arguments_, environment, json) {
  const [operation, ...args] = arguments_;
  const options = parseOptions(
    args,
    ["--proposal", "--decision", "--proposal-id", "--game", "--after", "--after-generation"],
    ["--yes"],
  );
  const value = (name) => options.values[`--${name}`];
  let pathname = "/v1/entity-proposals";
  let body;
  if (options.error !== null) return usage(json);
  if (operation === "list") {
    if (!value("game")) return usage(json);
    pathname += `?game=${encodeURIComponent(value("game"))}&after=${encodeURIComponent(value("after") ?? "")}`;
  } else if (operation === "inspect") {
    if (!value("proposal-id")) return usage(json);
    pathname += `/${encodeURIComponent(value("proposal-id"))}?after_generation=${encodeURIComponent(value("after-generation") ?? "0")}`;
  } else if (operation === "create" || ["admit", "link", "reject", "reconsider"].includes(operation)) {
    const file = value(operation === "create" ? "proposal" : "decision");
    if (!file || !options.flags.has("--yes") || (operation !== "create" && !value("proposal-id"))) return usage(json);
    try {
      const bytes = await readFile(file);
      if (bytes.byteLength > 64 * 1024) throw new Error("too large");
      body = JSON.parse(bytes.toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("object required");
    } catch {
      return writeCliFailure(
        json,
        { code: "invalid_proposal_file", detail: "Provide one JSON object of at most 64 KiB." },
        2,
      );
    }
    if (operation !== "create") {
      if (body.action !== undefined && body.action !== operation) return usage(json);
      body.action = operation;
      pathname += `/${encodeURIComponent(value("proposal-id"))}/decisions`;
    }
  } else return usage(json);
  const result = await requestDocument(environment, pathname, { method: body ? "POST" : "GET", body });
  if (result.error) return writeCliFailure(json, result.error, result.exitCode);
  process.stdout.write(`${JSON.stringify(result.document, null, json ? undefined : 2)}\n`);
  return 0;
}
function usage(json) {
  return writeCliFailure(
    json,
    {
      code: "usage",
      detail:
        "Usage: keepr entity-proposal list --game GAME | inspect --proposal-id ID | create --proposal FILE --yes | admit|link|reject|reconsider --proposal-id ID --decision FILE --yes",
    },
    2,
  );
}
