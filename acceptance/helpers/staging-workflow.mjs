import assert from "node:assert/strict";
import { requiredCiChecks } from "../../src/http/dev-workflow-identity.mjs";

// Test-only keys sign actual JWTs; only external GitHub HTTP is simulated.
export async function stagingWorkflowFixture(t, selected = "a".repeat(40)) {
  const main = "b".repeat(40);
  const key = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", key.publicKey)),
    kid: "staging-test",
    alg: "RS256",
    use: "sig",
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: "https://card.keepr.digital/ingest/v1/staging-release-authorizations",
    sub: "repo:KeeprDigital/card-keepr:environment:staging",
    repository: "KeeprDigital/card-keepr",
    repository_id: "1313489088",
    repository_owner_id: "114643329",
    environment: "staging",
    ref: "refs/heads/main",
    event_name: "workflow_dispatch",
    workflow_ref: "KeeprDigital/card-keepr/.github/workflows/staging-deploy.yml@refs/heads/main",
    sha: main,
    workflow_sha: main,
    actor: "owner",
    run_id: "456",
    run_attempt: "1",
    jti: "test-staging",
    iat: now,
    nbf: now,
    exp: now + 300,
  };
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const state = { checkConclusion: "success", runAttempt: 1, ciEvent: "push" };
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/.well-known/jwks")) return Response.json({ keys: [jwk] });
    if (path.endsWith("/actions/runs/456"))
      return Response.json({
        repository: { id: 1313489088 },
        path: ".github/workflows/staging-deploy.yml",
        event: "workflow_dispatch",
        head_sha: main,
        head_branch: "main",
        run_attempt: state.runAttempt,
        status: "in_progress",
        actor: { login: "owner" },
      });
    if (path.endsWith("/actions/runs/123"))
      return Response.json({
        repository: { id: 1313489088 },
        path: ".github/workflows/ci.yml",
        event: state.ciEvent,
        head_branch: "main",
        head_sha: selected,
        status: "completed",
        conclusion: "success",
      });
    if (path.includes("/compare/")) return Response.json({ status: "behind" });
    if (path.endsWith("/check-runs"))
      return Response.json({
        total_count: 9,
        check_runs: requiredCiChecks.map((name) => ({
          name,
          app: { slug: "github-actions" },
          head_sha: selected,
          status: "completed",
          conclusion: state.checkConclusion,
        })),
      });
    assert.fail(`Unexpected provider path ${path}`);
  };
  const token = async (changes = {}) => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const body = `${encode({ alg: "RS256", typ: "JWT", kid: "staging-test" })}.${encode({ ...claims, ...changes })}`;
    const signature = Buffer.from(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(body)),
    ).toString("base64url");
    return `${body}.${signature}`;
  };
  return { selected, main, now, token, state };
}
