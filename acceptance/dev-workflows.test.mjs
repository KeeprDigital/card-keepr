import assert from "node:assert/strict";
import test from "node:test";
import { provisionDev } from "../scripts/provision-dev.mjs";
import { verifyDevWorkflows } from "../scripts/dev-workflows.mjs";
import { readWorkerConfig } from "../cli/lib/config.mjs";

test("first provisioning refuses an occupied dev Workflow name before creating resources", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const methods = [];
  globalThis.fetch = async (url, options) => {
    methods.push(options.method);
    const path = new URL(url).pathname;
    const result = path.includes("/workflows/")
      ? { name: path.split("/").at(-1), script_name: "card-keepr-ingestion", class_name: "EvidenceIngestionWorkflow" }
      : path.endsWith("/r2/buckets")
        ? { buckets: [] }
        : [];
    return Response.json({ success: true, result });
  };
  const account = "0123456789abcdef0123456789abcdef";
  await assert.rejects(
    provisionDev(
      { DEV_CLOUDFLARE_ACCOUNT_ID: account },
      {
        account_id: account,
        workers_plan: "free",
        plan_evidence: "synthetic confirmed limit",
        observed_at: new Date().toISOString(),
      },
      true,
    ),
    /dev_workflow_name_occupied/u,
  );
  assert.ok(methods.every((method) => method === "GET"));
});

test("deployment permits only absent or exactly dev-owned Workflow names and fails closed on provider errors", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const source = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  const environment = { DEV_CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" };
  let mode = "absent";
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests++;
    if (mode === "absent") return new Response(null, { status: 404 });
    if (mode === "unavailable") return new Response(null, { status: 403 });
    const name = new URL(url).pathname.split("/").at(-1);
    const workflow = source.workflows.find((entry) => `${entry.name}-dev` === name);
    return Response.json({
      success: true,
      result: {
        name,
        script_name: mode === "wrong-script" ? "card-keepr-ingestion" : "card-keepr-ingestion-dev",
        class_name: mode === "wrong-class" ? "OtherWorkflow" : workflow.class_name,
      },
    });
  };
  await verifyDevWorkflows(environment);
  assert.equal(requests, 4);
  mode = "owned";
  await verifyDevWorkflows(environment);
  assert.equal(requests, 8);
  for (mode of ["wrong-script", "wrong-class"])
    await assert.rejects(verifyDevWorkflows(environment), /dev_workflow_owner_mismatch/u);
  mode = "unavailable";
  await assert.rejects(verifyDevWorkflows(environment), /dev_workflow_inventory_unavailable/u);
});
