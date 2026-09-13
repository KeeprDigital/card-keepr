import { readWorkerConfig } from "../cli/lib/config.mjs";
import { environmentNames } from "../src/http/environment-target.mjs";

/** Exact-name lookups avoid incomplete account-wide inventories. Read only. */
export async function verifyDevWorkflows(environment, { mustBeAbsent = false } = {}) {
  const account = environment.DEV_CLOUDFLARE_ACCOUNT_ID;
  if (!/^[0-9a-f]{32}$/u.test(account ?? "")) throw new Error("dev_account_mismatch");
  const names = environmentNames("dev");
  const source = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  for (const workflow of source.workflows) {
    const name = `${workflow.name}-dev`;
    if (!names.workflows.includes(name)) throw new Error("unexpected_dev_workflow");
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workflows/${name}`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}` },
    });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error("dev_workflow_inventory_unavailable");
    const document = await response.json();
    if (document.success !== true || !document.result) throw new Error("dev_workflow_inventory_unavailable");
    if (mustBeAbsent) throw new Error(`dev_workflow_name_occupied:${name}`);
    if (
      document.result.name !== name ||
      document.result.script_name !== names.workers[1] ||
      document.result.class_name !== workflow.class_name
    )
      throw new Error(`dev_workflow_owner_mismatch:${name}`);
  }
}
