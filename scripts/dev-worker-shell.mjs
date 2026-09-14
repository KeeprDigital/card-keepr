import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { environmentNames } from "../src/http/environment-target.mjs";
import { verifyDevWorkflows } from "./dev-workflows.mjs";

export const devShellSource =
  "export default { fetch() { return new Response('Dev installation pending', {status:503}); } };";
const secretNames = [
  ["API_BEARER_KEY", "API_BEARER_KEY_REPLACEMENT"],
  ["ADMINISTRATION_KEY", "ADMINISTRATION_KEY_REPLACEMENT", "D1_EXPORT_TOKEN", "D1_VERIFICATION_TOKEN"],
];

/** Initial provisioning and retry share the complete, independently issued inventory. */
export async function validateDevSecretFiles(environment) {
  const files = [environment.DEV_API_SECRETS_FILE, environment.DEV_INGESTION_SECRETS_FILE];
  const secrets = await Promise.all(
    files.map(async (path, index) => {
      if (!path) throw new Error("dev_secret_files_required");
      const value = JSON.parse(await readFile(path, "utf8"));
      if (
        Object.keys(value).sort().join("|") !== [...secretNames[index]].sort().join("|") ||
        Object.values(value).some((secret) => typeof secret !== "string" || secret.length < 16)
      )
        throw new Error("invalid_dev_secret_inventory");
      return value;
    }),
  );
  if (new Set(secrets.flatMap(Object.values)).size !== 6) throw new Error("dev_secrets_must_be_distinct");
  return files;
}

/** Use Wrangler provenance so the later strict versions upload accepts this shell. */
export async function writeDevWorkerShell(environment, name) {
  const account = environment.DEV_CLOUDFLARE_ACCOUNT_ID;
  const index = environmentNames("dev").workers.indexOf(name);
  if (!/^[0-9a-f]{32}$/u.test(account ?? "") || index === -1) throw new Error("invalid_dev_shell_target");
  const secretFile = (await validateDevSecretFiles(environment))[index];
  const directory = await mkdtemp(join(tmpdir(), "keepr-dev-shell-"));
  try {
    const config = join(directory, "wrangler.json");
    await writeFile(join(directory, "deny.mjs"), devShellSource, { mode: 0o600 });
    await writeFile(
      config,
      JSON.stringify({
        name,
        account_id: account,
        main: "deny.mjs",
        compatibility_date: "2026-07-29",
        workers_dev: false,
        preview_urls: false,
        routes: [],
      }),
      { mode: 0o600 },
    );
    execFileSync(
      resolve("node_modules/.bin/wrangler"),
      ["deploy", "--config", config, "--no-bundle", "--secrets-file", resolve(secretFile)],
      {
        env: { ...environment, CLOUDFLARE_ACCOUNT_ID: account },
        stdio: "inherit",
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A failed initial installation may refresh only the exact, still unbound deny shells. */
export async function verifyDevWorkerShells(environment) {
  await validateDevSecretFiles(environment);
  const names = environmentNames("dev");
  const account = environment.DEV_CLOUDFLARE_ACCOUNT_ID;
  const refuse = () => {
    throw new Error("first_install_retry_not_safe");
  };
  if (!/^[0-9a-f]{32}$/u.test(account ?? "")) refuse();
  const get = async (path) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) refuse();
    return response;
  };
  const document = async (path) => {
    const value = await (await get(path)).json();
    if (value.success !== true) refuse();
    return value.result;
  };
  const zones = await document("/zones?name=keepr.digital");
  if (!Array.isArray(zones) || zones.length !== 1 || zones[0].account?.id !== account || !zones[0].id) refuse();
  const routes = await document(`/zones/${zones[0].id}/workers/routes`);
  if (!Array.isArray(routes) || routes.some((route) => names.workers.includes(route.script))) refuse();
  await verifyDevWorkflows(environment, { mustBeAbsent: true });
  for (const [index, name] of names.workers.entries()) {
    const root = `/accounts/${account}/workers/scripts/${name}`;
    const source = await (await get(root)).formData();
    if ([...source.keys()].join("|") !== "deny.mjs") refuse();
    const part = source.get("deny.mjs");
    if ((typeof part === "string" ? part : await part.text()).trim() !== devShellSource) refuse();
    const settings = await document(`${root}/settings`);
    const bindings = settings?.bindings;
    if (
      !Array.isArray(bindings) ||
      bindings.some((binding) => binding.type !== "secret_text") ||
      bindings
        .map((binding) => binding.name)
        .sort()
        .join("|") !== [...secretNames[index]].sort().join("|")
    )
      refuse();
    const subdomain = await document(`${root}/subdomain`);
    if (subdomain?.enabled !== false || subdomain.previews_enabled !== false) refuse();
  }
}

/** Called only by the executor while it holds the canonical deployment lease. */
export async function restoreDevWorkerShells(environment) {
  await verifyDevWorkerShells(environment);
  const names = environmentNames("dev");
  // Observe both shells before changing either; never overwrite application code.
  for (const name of names.workers) await writeDevWorkerShell(environment, name);
}
