import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { build } from "esbuild";
import { validateGolden } from "./retained-source-integrity.mjs";
import { reviewedCosmeticComparison } from "./official-source-cosmetic-comparison.mjs";

// These exact captures preserve the old eligibility evidence and regression
// census, but ADR 0014 removed their acquisition from the current card scope.
export const excludedRecaptures = new Set([
  "digimon-en-policy.json",
  "fusion-world-en-legality-history-news.json",
  "fusion-world-en-policy-detail.json",
  "fusion-world-en-policy-live.json",
  "gundam-en-asia-policy-detail.json",
  "gundam-en-asia-policy.json",
  "gundam-en-us-policy-detail.json",
  "gundam-en-us-policy.json",
  "one-piece-en-block-policy-topic.json",
  "one-piece-en-policy.json",
]);

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const dynamicIdentity = (role) => `${role}:${"0".repeat(64)}`;

function requestIdentity(name, lineage) {
  if (name.includes("-product-")) return dynamicIdentity("product_detail");
  if (name.includes("-card-detail-")) return dynamicIdentity("detail");
  if (name.includes("-rules-hub")) return dynamicIdentity("listing:rules");
  if (name.includes("-news-hub")) return dynamicIdentity("listing:news");
  if (name.includes("-errata-listing")) return "errata";
  if (name.includes("-products-hub")) return "products";
  if (name.includes("-products-")) return dynamicIdentity("listing");
  if (name.endsWith("-discovery.json") && !name.includes("restructured")) return "discovery";
  if (name.includes("-restructured-") || name === "one-piece-en-card-list.json")
    return lineage.startsWith("gundam-") ? "packages" : lineage === "fusion-world-en" ? "card-search" : "card-list";
  if (name.includes("-card-list-")) return dynamicIdentity("listing");
  throw new Error(`No reviewed recapture request identity for ${name}.`);
}

function changedPaths(before, after, path = "$", result = []) {
  if (JSON.stringify(before) === JSON.stringify(after) || result.length >= 30) return result;
  if (before && after && typeof before === "object" && typeof after === "object") {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      changedPaths(before[key], after[key], `${path}.${key}`, result);
  } else result.push({ path, expected: before, actual: after });
  return result;
}

export async function createOfficialSourceAssessment({ fixturesDirectory, reviewedBaselinesDirectory }) {
  const reviewedBaselines = reviewedBaselinesDirectory
    ? JSON.parse(await readFile(join(reviewedBaselinesDirectory, "baselines.json"), "utf8"))
    : {};
  const root = resolve(import.meta.dirname, "..");
  const bundle = await build({
    stdin: {
      contents: 'export { sourceAdapterRegistrations } from "./src/catalogue/adapters/source-adapters";',
      resolveDir: root,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const { sourceAdapterRegistrations } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  // A full golden of the exact same original response can supply the bytes a
  // historical header range omitted. Never infer equivalence from a similar URL.
  const fullGoldens = new Map();
  for (const name of (await readdir(fixturesDirectory)).filter((file) => file.endsWith(".json"))) {
    try {
      const capture = JSON.parse(await readFile(join(fixturesDirectory, name), "utf8"));
      validateGolden(capture);
      if (capture.range_start === 0 && capture.range_end_exclusive === capture.full_body_size)
        fullGoldens.set(capture.full_body_sha256, { name, capture });
    } catch {
      /* The recapture report records each invalid golden independently. */
    }
  }
  return async ({ name, golden, actual, bytes, differences }) => {
    if (excludedRecaptures.has(name))
      return {
        category: "out_of_scope",
        actionable: false,
        reason: "ADR 0014 eligibility capture; raw evidence and regression caller retained.",
      };
    const adapter = sourceAdapterRegistrations.find(
      (entry) =>
        entry.origin === "production" &&
        entry.reconciliationCapability === "catalogue" &&
        name.startsWith(`${entry.sourceLineage}-`),
    );
    const base = { adapter_version: adapter?.adapterVersion };
    if (!adapter)
      return { ...base, category: "unresolved_drift", actionable: true, reason: "No current adapter for capture." };
    let fullGolden = fullGoldens.get(golden.full_body_sha256);
    if (Object.hasOwn(reviewedBaselines, name)) {
      try {
        if (!/^[a-z0-9-]+\.json$/u.test(name)) throw new Error("Invalid reviewed capture filename.");
        const compressed = await readFile(join(reviewedBaselinesDirectory, `${name}.gz`));
        const capture = JSON.parse(gunzipSync(compressed, { maxOutputLength: 24 * 1024 * 1024 }).toString("utf8"));
        validateGolden(capture);
        if (
          capture.source_url !== golden.source_url ||
          capture.range_start !== 0 ||
          capture.range_end_exclusive !== capture.full_body_size ||
          capture.full_body_sha256 !== reviewedBaselines[name].full_body_sha256
        )
          throw new Error("Reviewed baseline must retain the complete declared Source response and digest.");
        fullGolden = { name: `monitoring/${name}.gz`, capture };
      } catch (error) {
        return { ...base, category: "integrity_failure", actionable: true, reason: error.message };
      }
    }
    const baseline = fullGolden?.capture ?? golden;
    if (!fullGolden && differences.length)
      return {
        ...base,
        category: "unresolved_drift",
        actionable: true,
        reason: "Only a retained range of the original response exists; whole-response equivalence is unproven.",
      };
    const context = {
      url: golden.source_url,
      mediaType: golden.content_type,
      requestId: `${adapter.sourceLineage}:${requestIdentity(name, adapter.sourceLineage)}`,
    };
    const observe = (body, mediaType) => ({
      observations: adapter.parseBytes(body, { ...context, mediaType }),
      requests: adapter.discoverRequests(body, { ...context, mediaType }),
    });
    let expected;
    try {
      expected = observe(Buffer.from(baseline.body_base64, "base64"), baseline.content_type);
    } catch (error) {
      return {
        ...base,
        category: "unresolved_drift",
        actionable: true,
        reason: `Current adapter rejects baseline: ${error.message}`,
      };
    }
    let observed;
    try {
      observed = observe(bytes, actual.content_type);
    } catch (error) {
      return { ...base, category: "structural_drift", actionable: true, reason: error.message };
    }
    const expectedDigest = digest(expected);
    const actualDigest = digest(observed);
    const semanticChanged = expectedDigest !== actualDigest;
    let cosmetic = null;
    if (semanticChanged) {
      try {
        const comparison = reviewedCosmeticComparison({
          name,
          baseline: { bytes: Buffer.from(baseline.body_base64, "base64"), content_type: baseline.content_type },
          actual: { bytes, content_type: actual.content_type },
          expected,
          observed,
          observe,
        });
        if (comparison && digest(comparison.expected) === digest(comparison.observed)) cosmetic = comparison.rule;
      } catch {
        // A comparison-only rule cannot turn a rejection into success.
      }
    }
    return {
      ...base,
      category:
        semanticChanged && !cosmetic
          ? "semantic_drift"
          : baseline.full_body_sha256 !== actual.full_body_sha256
            ? "cosmetic_drift"
            : "unchanged",
      actionable: semanticChanged && !cosmetic,
      comparison:
        "Exact current adapter observations (including source sidecars) and discovered requests; reviewed cosmetic equivalence is reported separately without replacing these raw output hashes.",
      ...(cosmetic ? { cosmetic_equivalence_rule: cosmetic } : {}),
      baseline_file: fullGolden?.name ?? name,
      baseline_full_body_sha256: baseline.full_body_sha256,
      expected_observations_sha256: expectedDigest,
      actual_observations_sha256: actualDigest,
      observation_count: observed.observations.length,
      request_count: observed.requests.length,
      ...(semanticChanged
        ? {
            changed_paths: changedPaths(expected, observed).map(({ path }) => path),
            changes: changedPaths(expected, observed),
          }
        : {}),
    };
  };
}
