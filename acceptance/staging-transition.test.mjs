import assert from "node:assert/strict";
import test from "node:test";

test("validation classification requires the actual complete active Worker pair and complete exact code comparison", async (t) => {
  const { observeStagingTransition } = await import("../src/http/staging-transition.mjs");
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let mode = "valid";
  const target = {
    cloudflare_account_id: "0123456789abcdef0123456789abcdef",
    worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
    d1_databases: [{ id: "catalogue-id" }],
    r2_buckets: ["evidence", "images", "exports", "backups"],
  };
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/deployments"))
      return Response.json({
        success: true,
        result: {
          deployments: [{ versions: [{ version_id: "active-version", percentage: mode === "split" ? 50 : 100 }] }],
        },
      });
    if (path.includes("/versions/"))
      return Response.json({
        success: true,
        result: {
          id: "active-version",
          annotations: { "workers/tag": `release-old-${path.includes("-api/") ? "api" : "ingestion"}` },
          resources: {
            bindings: [
              { name: "CATALOGUE_DB", type: "d1", database_id: "catalogue-id" },
              ...(path.includes("-api/") ? target.r2_buckets.slice(1, 3) : target.r2_buckets).map((bucket_name) => ({
                type: "r2_bucket",
                bucket_name: mode === "foreign bucket" ? "foreign" : bucket_name,
              })),
              ...(path.includes("-api/")
                ? []
                : [{ type: "service", service: target.worker_scripts[1], entrypoint: "OfficialSourceTransport" }]),
            ],
          },
        },
      });
    if (path.includes("/compare/"))
      return Response.json({
        status: "ahead",
        base_commit: { sha: "a".repeat(40) },
        merge_base_commit: { sha: "a".repeat(40) },
        commits: [{ sha: "b".repeat(40) }],
        total_commits: 1,
        files: Array.from({ length: mode === "truncated" ? 300 : 1 }, () => ({
          filename: "docs/runbooks/maintenance.md",
          status: "modified",
        })),
      });
    assert.fail(path);
  };
  const input = {
    target,
    previousRelease: { release_id: "old", head_sha: "a".repeat(40) },
    selectedSha: "b".repeat(40),
    token: "synthetic-read-token",
  };
  const observed = await observeStagingTransition(input);
  assert.equal(observed.head_sha, "a".repeat(40));
  assert.deepEqual(observed.paths, ["docs/runbooks/maintenance.md"]);
  for (mode of ["split", "truncated", "foreign bucket"]) assert.equal(await observeStagingTransition(input), null);
  assert.equal(await observeStagingTransition({ ...input, previousRelease: null }), null);
});
