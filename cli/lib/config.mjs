import { readFile } from "node:fs/promises";
import { parse } from "jsonc-parser";

export async function readWorkerConfig(path) {
  const errors = [];
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new Error(`invalid_wrangler_config:${path}`);
  }
  const config = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`invalid_wrangler_config:${path}`);
  }
  return config;
}
