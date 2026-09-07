import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
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
  const runtime = new Miniflare({
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
