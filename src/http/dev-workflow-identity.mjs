const repository = "KeeprDigital/card-keepr";
const issuer = "https://token.actions.githubusercontent.com";
export const devAudience = "https://dev.card.keepr.digital/ingest/v1/dev-deployments";
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
    claims.aud !== devAudience ||
    ![
      "repo:KeeprDigital/card-keepr:environment:dev",
      "repo:KeeprDigital@114643329/card-keepr@1313489088:environment:dev",
    ].includes(claims.sub) ||
    claims.repository !== repository ||
    claims.repository_id !== "1313489088" ||
    claims.repository_owner_id !== "114643329" ||
    claims.environment !== "dev" ||
    claims.ref !== "refs/heads/main" ||
    claims.event_name !== "workflow_run" ||
    claims.workflow_ref !== `${repository}/.github/workflows/dev-deploy.yml@refs/heads/main` ||
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
    Object.keys(intent).sort().join("|") !== "ci_run_id|head_sha" ||
    intent.head_sha !== claims.sha ||
    intent.head_sha !== claims.workflow_sha ||
    !/^[0-9a-f]{40}$/u.test(intent.head_sha ?? "") ||
    !/^\d+$/u.test(intent.ci_run_id ?? "")
  )
    denied();
  const root = `https://api.github.com/repos/${repository}`;
  const run = await document(`${root}/actions/runs/${claims.run_id}`, githubToken);
  if (
    String(run.repository?.id) !== claims.repository_id ||
    run.event !== "workflow_run" ||
    run.path !== ".github/workflows/dev-deploy.yml" ||
    run.head_branch !== "main" ||
    run.head_sha !== claims.sha ||
    String(run.run_attempt) !== claims.run_attempt ||
    run.status !== "in_progress"
  )
    denied();
  await verifyDevCommit(githubToken, intent);
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
    ci.event !== "push" ||
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
