import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manual staging authorizes from trusted workflow code before selected checkout or deployment credentials", async () => {
  const workflow = await readFile(".github/workflows/staging-deploy.yml", "utf8");
  const beforeSteps = workflow.split("    steps:\n")[0];
  assert.doesNotMatch(beforeSteps, /secrets\./u);
  const trusted = workflow.indexOf("ref: ${{ github.workflow_sha }}");
  const authorization = workflow.indexOf("run: node scripts/staging-authorize.mjs");
  const selected = workflow.indexOf("ref: ${{ inputs.expected_head_sha }}");
  const credentials = workflow.indexOf("secrets.STAGING_DEPLOYMENT_TOKEN");
  assert.ok(trusted >= 0 && authorization > trusted && selected > authorization && credentials > selected);
});

test("pre-checkout authorization refuses production denial and selected-SHA substitution without provider authority", async (t) => {
  const { authorizeStagingRelease } = await import("../scripts/staging-workflow-client.mjs");
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let mode = "denied";
  const env = {
    RELEASE_ENVIRONMENT: "staging",
    RELEASE_ID: "release-gate",
    INTENT_DIGEST: "a".repeat(64),
    EXPECTED_HEAD_SHA: "b".repeat(40),
    GH_TOKEN: "synthetic-github",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://synthetic.actions.example/oidc",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc",
  };
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === "synthetic.actions.example") return Response.json({ value: "signed-workflow-identity" });
    assert.equal(url.href, "https://card.keepr.digital/ingest/v1/staging-release-authorizations");
    assert.equal(options.headers.authorization, "Bearer signed-workflow-identity");
    assert.deepEqual(JSON.parse(options.body), { release_id: env.RELEASE_ID, intent_digest: env.INTENT_DIGEST });
    if (mode === "denied") return Response.json({ code: "refused" }, { status: 403 });
    return Response.json({
      contract: "card-keepr-staging-authorization@1",
      intent_digest: env.INTENT_DIGEST,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      intent: {
        release_id: env.RELEASE_ID,
        expected_head_sha: mode === "substitution" ? "c".repeat(40) : env.EXPECTED_HEAD_SHA,
      },
    });
  };
  await assert.rejects(authorizeStagingRelease(env), /staging_request_failed:403/u);
  mode = "substitution";
  await assert.rejects(authorizeStagingRelease(env), /staging_authorization_mismatch/u);
  mode = "approved";
  assert.equal((await authorizeStagingRelease(env)).intent.expected_head_sha, env.EXPECTED_HEAD_SHA);
});
