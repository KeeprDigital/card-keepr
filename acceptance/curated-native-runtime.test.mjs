import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { profileNativeIsolates } from "./helpers/native-isolate-metrics.mjs";
import { curatedNativeD1Statements } from "./helpers/query-helpers/curated-native-fixture.mjs";

test("owner validation resolves a native published target in Workerd without request-time code generation", async (t) => {
  const bundled = await build({
    entryPoints: ["acceptance/fixtures/curated-native-validation.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["browser", "module", "main"],
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*", "cloudflare:*"],
  });
  const capacityOutput = process.env.KEEPR_CURATED_CAPACITY_OUTPUT;
  const runtime = new Miniflare({
    ...(capacityOutput ? { inspectorPort: 0 } : {}),
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-29",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["CATALOGUE_DB"],
  });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("CATALOGUE_DB");
  for (const statement of curatedNativeD1Statements())
    await db
      .prepare(statement.sql)
      .bind(...statement.params)
      .run();
  const proposal = {
    game: "riftbound",
    target: { kind: "field", entity_type: "printing", entity_id: "printing_monk", path: "/printed_rules_text" },
    assertion: { kind: "field", value: "Reviewed printed wording" },
    rationale: "Retained publisher image reviewed.",
    evidence: [{ kind: "owner_reference", uri: "https://example.com/monk.png", content_digest: "a".repeat(64) }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: createHash("sha256").update("null").digest("hex"),
    supersedes_revision_id: null,
  };
  const send = () =>
    runtime.dispatchFetch("https://owner.invalid/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposal, catalogue_revision_id: "composition_current" }),
    });
  const valid = await send();
  assert.equal(valid.status, 200, await valid.clone().text());
  assert.equal((await valid.json()).valid, true);
  if (capacityOutput) {
    // Optional bounded minimization probe: repeat the shipped native validation
    // boundary. This cannot stand in for the full Riftbound candidate workload.
    const stop = await profileNativeIsolates(runtime, capacityOutput, undefined, { sampleIntervalMs: 100 });
    const phases = [];
    try {
      for (let batch = 0; batch < 10; batch++) {
        const started = performance.now();
        for (let call = 0; call < 100; call++) {
          const response = await send();
          assert.equal(response.status, 200);
          assert.equal((await response.json()).valid, true);
        }
        phases.push({ batch, calls: 100, observer_started_ms: started, observer_finished_ms: performance.now() });
      }
    } finally {
      await stop();
      await writeFile(
        `${capacityOutput}.phases.json`,
        JSON.stringify(
          {
            limitation:
              "Driver-observed boundaries for 1,000 sequential validations of one synthetically seeded Riftbound Printing using the shipped native validation function. Not full-candidate capacity or an established reproduction of the earlier memory failure.",
            phases,
          },
          null,
          2,
        ) + "\n",
      );
    }
    const report = JSON.parse(await readFile(capacityOutput, "utf8"));
    assert.deepEqual(report.errors, []);
    const maximum = Math.max(
      ...report.isolates.flatMap((isolate) => isolate.heap_samples.map((sample) => sample.usedSize)),
    );
    t.diagnostic(JSON.stringify({ validations: 1000, sampled_used_heap_maximum: maximum, report: capacityOutput }));
    assert.ok(maximum <= 64 * 1024 ** 2, `Sampled used heap ${maximum} exceeds the initial 64 MiB target`);
  }
  const printingTarget = proposal.target;
  proposal.target = { kind: "field", entity_type: "product", entity_id: "product_native", path: "/name" };
  proposal.assertion.value = "Reviewed product";
  proposal.reviewed_source_digest = createHash("sha256").update(JSON.stringify("Official product")).digest("hex");
  const product = await send();
  assert.equal(product.status, 200, await product.clone().text());
  proposal.target = {
    kind: "relationship",
    relationship_kind: "printing-product",
    from: { type: "printing", id: "printing_monk" },
    to: { type: "product", id: "product_native" },
  };
  proposal.assertion = { kind: "relationship", presence: "absent" };
  proposal.reviewed_source_digest = createHash("sha256").update(JSON.stringify("present")).digest("hex");
  const relationship = await send();
  assert.equal(relationship.status, 200, await relationship.clone().text());
  proposal.target = printingTarget;
  proposal.assertion = { kind: "field", value: 42 };
  proposal.reviewed_source_digest = createHash("sha256").update("null").digest("hex");
  proposal.assertion.value = 42;
  const invalid = await send();
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).code, "curated_revision_assertion_type_invalid");
  proposal.assertion.value = "Reviewed printed wording";
  proposal.target.path = "/invented";
  const missing = await send();
  assert.equal(missing.status, 422);
  assert.equal((await missing.json()).code, "curated_revision_field_not_in_schema");
});
