const repository = "KeeprDigital/card-keepr";
const issuer = "https://token.actions.githubusercontent.com";
export const devAudience = "https://card-dev.keepr.digital/ingest/v1/dev-deployments";
export const stagingAudience = "https://card.keepr.digital/ingest/v1/staging-release-authorizations";
export const requiredCiChecks = [
  "lint",
  "checks",
  "domain-tests",
  "ingestion-tests (1)",
  "ingestion-tests (2)",
  "ingestion-tests (3)",
  "acceptance (1)",
  "acceptance (2)",
  "acceptance (3)",
];
const denied = () => {
  throw new Error("invalid_dev_workflow_attestation");
};
const bytes = (value) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
async function document(url, token) {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: token
      ? { authorization: `Bearer ${token}`, "User-Agent": "card-keepr-dev", accept: "application/vnd.github+json" }
      : {},
  });
  if (!response.ok) denied();
  const text = await response.text();
  if (text.length > 2_000_000) denied();
  return JSON.parse(text);
}

/** Verify GitHub's signature before trusting any identity or using the workflow token. */
export async function verifyDevWorkflow(token, githubToken, intent, now = Date.now()) {
  return verifyWorkflow(token, githubToken, intent, "dev", now);
}

/** A manual staging workflow may run from later main, but cannot replace the owner's selected SHA. */
export async function verifyStagingWorkflow(token, githubToken, intent, now = Date.now(), requireCi = true) {
  return verifyWorkflow(token, githubToken, intent, "staging", now, requireCi);
}

async function verifyWorkflow(token, githubToken, intent, environment, now, requireCi = true) {
  const staging = environment === "staging";
  const event = staging ? "workflow_dispatch" : "workflow_run";
  const workflow = staging ? "staging-deploy.yml" : "dev-deploy.yml";
  if (typeof token !== "string" || token.length > 16384 || typeof githubToken !== "string" || githubToken.length > 4096)
    denied();
  const parts = token.split(".");
  if (parts.length !== 3) denied();
  const header = JSON.parse(new TextDecoder().decode(bytes(parts[0])));
  if (header.alg !== "RS256" || header.typ !== "JWT" || typeof header.kid !== "string" || header.crit !== undefined)
    denied();
  const jwks = await document(`${issuer}/.well-known/jwks`);
  const keys = jwks.keys?.filter(
    (key) => key.kid === header.kid && key.kty === "RSA" && key.use === "sig" && key.alg === "RS256",
  );
  if (keys?.length !== 1) denied();
  const key = await crypto.subtle.importKey("jwk", keys[0], { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ]);
  if (
    !(await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      bytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    ))
  )
    denied();
  const claims = JSON.parse(new TextDecoder().decode(bytes(parts[1])));
  const seconds = Math.floor(now / 1000);
  if (
    claims.iss !== issuer ||
    claims.aud !== (staging ? stagingAudience : devAudience) ||
    ![
      `repo:KeeprDigital/card-keepr:environment:${environment}`,
      `repo:KeeprDigital@114643329/card-keepr@1313489088:environment:${environment}`,
    ].includes(claims.sub) ||
    claims.repository !== repository ||
    claims.repository_id !== "1313489088" ||
    claims.repository_owner_id !== "114643329" ||
    claims.environment !== environment ||
    claims.ref !== "refs/heads/main" ||
    claims.event_name !== event ||
    claims.workflow_ref !== `${repository}/.github/workflows/${workflow}@refs/heads/main` ||
    !/^[0-9a-f]{40}$/u.test(claims.sha ?? "") ||
    !/^[0-9a-f]{40}$/u.test(claims.workflow_sha ?? "") ||
    !/^\d+$/u.test(claims.run_id ?? "") ||
    !/^\d+$/u.test(claims.run_attempt ?? "") ||
    typeof claims.jti !== "string" ||
    ![claims.exp, claims.iat, claims.nbf].every(Number.isSafeInteger) ||
    claims.exp <= seconds ||
    claims.nbf > seconds ||
    claims.iat > seconds ||
    claims.exp - claims.iat > 600 ||
    seconds - claims.iat > 600
  )
    denied();
  if (
    Object.keys(intent).sort().join("|") !== (staging ? "ci_run_id|expected_actor|head_sha" : "ci_run_id|head_sha") ||
    (!staging && intent.head_sha !== claims.sha) ||
    claims.sha !== claims.workflow_sha ||
    (staging && (typeof intent.expected_actor !== "string" || intent.expected_actor !== claims.actor)) ||
    !/^[0-9a-f]{40}$/u.test(intent.head_sha ?? "") ||
    !/^\d+$/u.test(intent.ci_run_id ?? "")
  )
    denied();
  const root = `https://api.github.com/repos/${repository}`;
  const run = await document(`${root}/actions/runs/${claims.run_id}`, githubToken);
  if (
    String(run.repository?.id) !== claims.repository_id ||
    run.event !== event ||
    run.path !== `.github/workflows/${workflow}` ||
    run.head_branch !== "main" ||
    run.head_sha !== claims.sha ||
    String(run.run_attempt) !== claims.run_attempt ||
    run.status !== "in_progress" ||
    (staging && run.actor?.login !== intent.expected_actor)
  )
    denied();
  if (requireCi) await verifyCommit(githubToken, { head_sha: intent.head_sha, ci_run_id: intent.ci_run_id }, staging);
  return {
    headSha: intent.head_sha,
    runId: claims.run_id,
    runAttempt: claims.run_attempt,
    tokenId: claims.jti,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}

/** Shared exact-merge gate for owner first install and subsequent OIDC releases. */
export async function verifyDevCommit(githubToken, intent) {
  return verifyCommit(githubToken, intent, false);
}

export async function verifyReleaseCommit(githubToken, intent) {
  return verifyCommit(githubToken, intent, true);
}

async function verifyCommit(githubToken, intent, allowManual) {
  if (
    Object.keys(intent).sort().join("|") !== "ci_run_id|head_sha" ||
    !/^[0-9a-f]{40}$/u.test(intent.head_sha ?? "") ||
    !/^\d+$/u.test(intent.ci_run_id ?? "")
  )
    denied();
  const root = `https://api.github.com/repos/${repository}`;
  const ci = await document(`${root}/actions/runs/${intent.ci_run_id}`, githubToken);
  if (
    String(ci.repository?.id) !== "1313489088" ||
    ci.path !== ".github/workflows/ci.yml" ||
    !(allowManual ? ["push", "workflow_dispatch"] : ["push"]).includes(ci.event) ||
    ci.head_branch !== "main" ||
    ci.head_sha !== intent.head_sha ||
    ci.status !== "completed" ||
    ci.conclusion !== "success"
  )
    denied();
  const compare = await document(`${root}/compare/main...${intent.head_sha}`, githubToken);
  if (!["identical", "behind"].includes(compare.status)) denied();
  const checks = [];
  for (let page = 1; page <= 10; page++) {
    const result = await document(
      `${root}/commits/${intent.head_sha}/check-runs?filter=latest&per_page=100&page=${page}`,
      githubToken,
    );
    if (!Array.isArray(result.check_runs)) denied();
    checks.push(...result.check_runs);
    if (checks.length >= result.total_count) break;
    if (page === 10) denied();
  }
  for (const name of requiredCiChecks) {
    const matches = checks.filter((check) => check.name === name && check.app?.slug === "github-actions");
    if (
      matches.length !== 1 ||
      matches[0].head_sha !== intent.head_sha ||
      matches[0].status !== "completed" ||
      matches[0].conclusion !== "success"
    )
      denied();
  }
  return intent.head_sha;
}
