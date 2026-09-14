import assert from "node:assert/strict";
import test from "node:test";

test("staging provisioning plan refreshes inventory and reserves three environment recovery slots without writing", async (t) => {
  const { provisionEnvironment } = await import("../scripts/provision-dev.mjs");
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const methods = [];
  globalThis.fetch = async (url, options) => {
    methods.push(options.method);
    const path = new URL(url).pathname;
    if (path.includes("/workflows/")) return new Response(null, { status: 404 });
    return Response.json({
      success: true,
      result: path.endsWith("/d1/database")
        ? Array.from({ length: 8 }, (_, id) => ({ name: `other-${id}`, uuid: String(id), file_size: 1000 }))
        : path.endsWith("/r2/buckets")
          ? { buckets: [] }
          : [],
    });
  };
  const account = "3ec389380c7b82e6a172e6f351d4aad9";
  const plan = await provisionEnvironment(
    { RELEASE_ENVIRONMENT: "staging", STAGING_CLOUDFLARE_ACCOUNT_ID: account },
    {
      account_id: account,
      workers_plan: "paid",
      plan_evidence: "synthetic confirmed Paid",
      observed_at: new Date().toISOString(),
    },
  );
  assert.equal(plan.reserved_replacement_databases, 3);
  assert.equal(plan.d1_after_provisioning, 10);
  assert.equal(plan.names.catalogue, "card-keepr-catalogue-staging");
  assert.ok(methods.every((method) => method === "GET"));
});
