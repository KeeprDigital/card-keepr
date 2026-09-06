import { readFile } from "node:fs/promises";
import { parseOptions, writeCliFailure } from "./command-support.mjs";
import { requestDocument } from "./lib/json-client.mjs";

export async function runIdentityCorrectionCommand(arguments_, environment, json) {
  const [operation, ...args] = arguments_;
  const options = parseOptions(args, ["--proposal", "--correction-id", "--game", "--after"], ["--yes"]);
  const value = (name) => options.values[`--${name}`];
  const usage = () =>
    writeCliFailure(
      json,
      {
        code: "usage",
        detail:
          "Usage: keepr identity-correction validate --proposal FILE | create --proposal FILE --yes | inspect --correction-id ID | list --game GAME [--after SEQUENCE]",
      },
      2,
    );
  if (options.error !== null) return usage();
  let pathname = "/v1/identity-corrections",
    body;
  if (operation === "validate" || operation === "create") {
    if (!value("proposal") || (operation === "create" && !options.flags.has("--yes"))) return usage();
    try {
      const bytes = await readFile(value("proposal"));
      if (bytes.byteLength > 64 * 1024) throw new Error("too large");
      body = JSON.parse(bytes.toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("object required");
    } catch {
      return writeCliFailure(
        json,
        { code: "invalid_correction_file", detail: "Provide one JSON object of at most 64 KiB." },
        2,
      );
    }
    if (operation === "validate") pathname += "/validate";
  } else if (operation === "inspect") {
    if (!value("correction-id")) return usage();
    pathname += `/${encodeURIComponent(value("correction-id"))}`;
  } else if (operation === "list") {
    if (!value("game")) return usage();
    pathname += `?game=${encodeURIComponent(value("game"))}&after=${encodeURIComponent(value("after") ?? "0")}`;
  } else return usage();
  const result = await requestDocument(environment, pathname, { method: body ? "POST" : "GET", body });
  if (result.error) return writeCliFailure(json, result.error, result.exitCode);
  process.stdout.write(`${JSON.stringify(result.document, null, json ? undefined : 2)}\n`);
  return 0;
}
