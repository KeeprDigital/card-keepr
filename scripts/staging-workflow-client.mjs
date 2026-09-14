import { stagingAudience } from "../src/http/dev-workflow-identity.mjs";
import { isReleaseDigest, isReleaseHead, isReleaseIdentity } from "../src/catalogue/shared/release-input-shapes.mjs";

export function stagingDispatchIdentity(environment) {
  if (
    environment.RELEASE_ENVIRONMENT !== "staging" ||
    !isReleaseIdentity(environment.RELEASE_ID) ||
    !isReleaseDigest(environment.INTENT_DIGEST) ||
    !isReleaseHead(environment.EXPECTED_HEAD_SHA)
  )
    throw new Error("invalid_staging_dispatch");
  return { release_id: environment.RELEASE_ID, intent_digest: environment.INTENT_DIGEST };
}

/** Runs from the trusted workflow checkout before dispatch-selected code can execute. */
export async function authorizeStagingRelease(environment) {
  const identity = stagingDispatchIdentity(environment);
  const authorization = await stagingWorkflowRequest(environment, stagingAudience, identity);
  if (
    authorization.contract !== "card-keepr-staging-authorization@1" ||
    authorization.intent_digest !== identity.intent_digest ||
    authorization.intent?.expected_head_sha !== environment.EXPECTED_HEAD_SHA ||
    authorization.intent.release_id !== identity.release_id ||
    !Number.isFinite(Date.parse(authorization.expires_at)) ||
    Date.parse(authorization.expires_at) <= Date.now()
  )
    throw new Error("staging_authorization_mismatch");
  return authorization;
}

export async function stagingWorkflowRequest(environment, url, body) {
  const oidc = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (oidc.protocol !== "https:") throw new Error("invalid_oidc_endpoint");
  oidc.searchParams.set("audience", stagingAudience);
  const identityResponse = await fetch(oidc, {
    redirect: "error",
    headers: { authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!identityResponse.ok) throw new Error("staging_identity_unavailable");
  const identity = await identityResponse.json();
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: {
      authorization: `Bearer ${identity.value}`,
      "x-github-token": environment.GH_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`staging_request_failed:${response.status}`);
  return response.json();
}
