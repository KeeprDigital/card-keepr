/**
 * The owner env file: the main checkout's git-ignored `.env`, or the absolute
 * path in `KEEPR_OWNER_ENV_FILE`. Its values fill only names the environment
 * does not already set, so an explicit variable always wins. `.env.example`
 * owns the canonical names.
 */

import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const cliCheckout = fileURLToPath(new URL("..", import.meta.url));

/**
 * Names that select the un-targeted local runtime profile or this loader. An
 * owner file setting them would silently point plain `keepr` commands at a
 * remote environment, so it is refused; remote profiles use `--target <env>`
 * with `KEEPR_<ENV>_*` names.
 */
export const refusedOwnerNames = Object.freeze([
  "KEEPR_OWNER_ENV_FILE",
  "KEEPR_TARGET",
  "KEEPR_API_URL",
  "KEEPR_INGESTION_URL",
  "KEEPR_API_KEY",
  "KEEPR_ADMINISTRATION_KEY",
  "KEEPR_TEST_NOW",
]);

export class OwnerEnvError extends Error {}

/**
 * Parse `NAME=value` / `export NAME=value` lines literally: no expansion,
 * command substitution or multi-line values. Matching outer quotes are removed.
 * @param {string} text
 */
export function parseOwnerEnv(text) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)=(.*)$/u.exec(line);
    if (match === null) continue;
    let value = match[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0])
      value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

/**
 * `environment` with the owner env file's values added under names it does not
 * set. A missing default `.env` adds nothing; a named file must be readable.
 * @param {Record<string, string | undefined>} environment
 */
export async function withOwnerEnvironment(environment, deps = defaultOwnerEnvDeps()) {
  const named = environment.KEEPR_OWNER_ENV_FILE;
  if (named !== undefined && named !== "" && !isAbsolute(named))
    throw new OwnerEnvError("KEEPR_OWNER_ENV_FILE must be an absolute path.");
  const checkouts = await deps.checkouts();
  if (!named && checkouts === null) return environment;
  const path = named ? resolve(named) : join(/** @type {{ main: string }} */ (checkouts).main, ".env");

  let text;
  try {
    text = await deps.read(path);
  } catch (error) {
    if (!named && error?.code === "ENOENT") return environment;
    throw new OwnerEnvError(`The owner env file ${path} is not readable.`);
  }
  const real = await realpath(path).catch(() => path);
  const root = [checkouts?.main, checkouts?.current, deps.cliCheckout].find(
    (candidate) => candidate !== undefined && within(candidate, real),
  );
  if (root !== undefined && !(await deps.ignored(root, real)))
    throw new OwnerEnvError(`The owner env file ${path} is inside the repository and not git-ignored; refusing it.`);

  const values = parseOwnerEnv(text);
  const refused = refusedOwnerNames.filter((name) => name in values);
  if (refused.length > 0)
    throw new OwnerEnvError(
      `The owner env file ${path} sets ${refused.join(", ")}; use --target <env> with KEEPR_<ENV>_* names (see .env.example).`,
    );
  const merged = { ...environment };
  for (const [name, value] of Object.entries(values)) if (merged[name] === undefined) merged[name] = value;
  return merged;
}

function within(root, path) {
  const inside = relative(resolve(root), path);
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

export function defaultOwnerEnvDeps({ checkout = cliCheckout } = {}) {
  const git = (cwd, args) => run("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return {
    cliCheckout: checkout,
    /** The main checkout (from the shared git dir, so worktrees resolve to it) and this checkout. */
    checkouts: async () => {
      try {
        const { stdout } = await git(checkout, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
          "--show-toplevel",
        ]);
        const [common, current] = stdout.trim().split("\n");
        return { main: dirname(common), current };
      } catch {
        return null;
      }
    },
    ignored: (root, path) =>
      git(root, ["check-ignore", "--quiet", "--", path]).then(
        () => true,
        () => false,
      ),
    read: async (path) => {
      const info = await stat(path);
      if (info.isFile() && (info.mode & 0o077) !== 0)
        process.stderr.write(`Warning: ${path} is readable by other users; chmod 600 it.\n`);
      return readFile(path, "utf8");
    },
  };
}
