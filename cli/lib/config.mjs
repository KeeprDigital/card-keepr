import { readFile } from "node:fs/promises";
import { parse } from "jsonc-parser";

/**
 * Parse JSONC only; each caller validates the bindings and fields it needs.
 * @param {string} path
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readWorkerConfig(path) {
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new Error(`invalid_wrangler_config:${path}`);
  }
  /** @type {unknown} */
  const config = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`invalid_wrangler_config:${path}`);
  }
  return /** @type {Record<string, unknown>} */ (config);
}
