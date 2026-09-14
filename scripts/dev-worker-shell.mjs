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

/** Use Wrangler provenance so the later strict versions upload accepts this shell. */
export async function writeDevWorkerShell(environment, name, secretFile) {
  const account = environment.DEV_CLOUDFLARE_ACCOUNT_ID;
  if (!/^[0-9a-f]{32}$/u.test(account ?? "") || !environmentNames("dev").workers.includes(name) || !secretFile)
    throw new Error("invalid_dev_shell_target");
  const secrets = JSON.parse(await readFile(secretFile, "utf8"));
  const expected = secretNames[environmentNames("dev").workers.indexOf(name)];
  if (
    Object.keys(secrets).sort().join("|") !== [...expected].sort().join("|") ||
    Object.values(secrets).some((value) => typeof value !== "string" || value.length < 16)
  )
    throw new Error("invalid_dev_secret_inventory");
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
export async function restoreDevWorkerShells(environment) {
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
  // Observe both shells before changing either; never overwrite application code.
  for (const [index, name] of names.workers.entries())
    await writeDevWorkerShell(
      environment,
      name,
      [environment.DEV_API_SECRETS_FILE, environment.DEV_INGESTION_SECRETS_FILE][index],
    );
}
