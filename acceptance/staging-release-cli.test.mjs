import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../cli/keepr.mjs";

test("staging outcome inspection uses the staging owner profile and reports a failed result", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  t.after(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  });
  let output = "";
  process.stdout.write = (text) => {
    output += text;
    return true;
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://card-staging.keepr.digital/ingest/v1/staging-deployments/staging-237");
    assert.equal(options.method, "GET");
    assert.equal(new Headers(options.headers).get("authorization"), "Bearer synthetic-stage-owner");
    return Response.json({
      release_id: "staging-237",
      outcome: { state: "failed", failure_code: "migration_rehearsal_failed" },
    });
  };
  assert.equal(
    await main(["release", "staging-status", "--target", "staging", "--release-id", "staging-237", "--json"], {
      KEEPR_STAGING_ADMINISTRATION_KEY: "synthetic-stage-owner",
    }),
    0,
  );
  assert.equal(JSON.parse(output).outcome.state, "failed");
});

test("owner staging initiation dispatches only server-issued intent and keeps credentials separate", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  t.after(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  });
  const requests = [];
  const output = [];
  process.stdout.write = (text) => {
    output.push(text);
    return true;
  };
  const inputs = { release_id: "staging-237", intent_digest: "c".repeat(64), expected_head_sha: "a".repeat(40) };
  globalThis.fetch = async (url, options) => {
    requests.push({
      url: String(url),
      token: new Headers(options.headers).get("authorization"),
      body: JSON.parse(options.body),
    });
    return String(url).includes("api.github.com")
      ? new Response(null, { status: 204 })
      : Response.json(
          {
            contract: "card-keepr-staging-release-request@1",
            release_id: "staging-237",
            dispatch_inputs: inputs,
          },
          { status: 201 },
        );
  };
  const code = await main(
    [
      "release",
      "staging",
      "--target",
      "production",
      "--release-id",
      "staging-237",
      "--expected-head-sha",
      "a".repeat(40),
      "--ci-run-id",
      "123",
      "--idempotency-key",
      "owner-237",
      "--confirm",
      "server-confirmation",
      "--yes",
      "--json",
    ],
    {
      KEEPR_PRODUCTION_ADMINISTRATION_KEY: "synthetic-production-owner",
      KEEPR_STAGING_ADMINISTRATION_KEY: "synthetic-staging-owner",
      KEEPR_ADMINISTRATION_KEY: "synthetic-unscoped-owner",
      KEEPR_GITHUB_RELEASE_TOKEN: "synthetic-github-release-credential",
      KEEPR_GITHUB_RELEASE_ACTOR: "owner",
    },
  );
  assert.equal(code, 10, output.join(""));
  assert.deepEqual(requests, [
    {
      url: "https://card.keepr.digital/ingest/v1/staging-releases",
      token: "Bearer synthetic-production-owner",
      body: {
        release_id: "staging-237",
        expected_head_sha: "a".repeat(40),
        expected_actor: "owner",
        ci_run_id: "123",
        idempotency_key: "owner-237",
        confirmation: "server-confirmation",
      },
    },
    {
      url: "https://api.github.com/repos/KeeprDigital/card-keepr/actions/workflows/staging-deploy.yml/dispatches",
      token: "Bearer synthetic-github-release-credential",
      body: { ref: "main", inputs },
    },
  ]);
});
