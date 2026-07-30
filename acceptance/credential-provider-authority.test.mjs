import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  executeCredentialBoundary,
  mayReleaseExecutionClaim,
} from "../cli/credential-boundary.mjs";
import {
  githubAuthorityMatches,
  probeGithubInstalledSecret,
} from "../cli/provider-github-boundary.mjs";
import {
  classifySecretList,
  classifyTokenLookup,
  cloudflareOperationSucceeded,
  d1DatabaseInfoSucceeded,
  exactManagementTokenPolicy,
  exactTokenPolicy,
} from "../cli/provider-authority.mjs";
import {
  credentialClasses,
  credentialClassDefinitions,
  resolveCredentialIdentity,
} from "../src/credentials/credential-catalogue.mjs";
import {
  disposableProbeStatements,
  verifyCloudflareEnvelope,
  verifyD1DatabaseMetadata,
} from "../src/credentials/cloudflare-authority.mjs";

test("only an authoritative token 404 is absence; auth, outage, and malformed responses fail closed", async () => {
  const tokenId = "provider-token-123";
  const absent = await classifyTokenLookup(
    jsonResponse(404, { success: false, errors: [{ code: 1000 }] }),
    tokenId,
  );
  assert.equal(absent.kind, "absent");
  for (const status of [401, 403, 429, 500, 503]) {
    const result = await classifyTokenLookup(
      jsonResponse(status, { success: false }),
      tokenId,
    );
    assert.equal(result.kind, "failure");
  }
  assert.equal(
    (
      await classifyTokenLookup(
        jsonResponse(404, { success: true }),
        tokenId,
      )
    ).kind,
    "failure",
  );
});

test("Cloudflare capability probes require outer and every per-result success", async () => {
  assert.equal(
    await cloudflareOperationSucceeded(
      jsonResponse(200, {
        success: true,
        result: [{ success: true }, { success: true }],
      }),
    ),
    true,
  );
  assert.equal(
    await cloudflareOperationSucceeded(
      jsonResponse(200, {
        success: false,
        result: [{ success: true }],
      }),
    ),
    false,
  );
  assert.equal(
    await cloudflareOperationSucceeded(
      jsonResponse(200, {
        success: true,
        result: [{ success: true }, { success: false }],
      }),
    ),
    false,
  );
  assert.equal(
    await cloudflareOperationSucceeded(
      jsonResponse(200, {
        success: true,
        result: { success: true, status: "pending" },
      }),
    ),
    false,
  );
  assert.equal(
    await cloudflareOperationSucceeded(
      jsonResponse(200, {
        success: true,
        result: { status: "pending" },
      }),
    ),
    false,
  );
  assert.equal(
    await cloudflareOperationSucceeded(
      jsonResponse(200, {
        success: true,
        result: [{ success: true, status: "failed" }],
      }),
    ),
    false,
  );
});

test("one Cloudflare verifier rejects partial envelopes and binds exact D1 metadata", () => {
  assert.equal(
    verifyCloudflareEnvelope({
      success: true,
      result: [{ success: true }, { status: "pending" }],
    }),
    false,
  );
  assert.equal(
    verifyD1DatabaseMetadata(
      {
        success: true,
        result: {
          uuid: "00000000-0000-0000-0000-000000000001",
        },
      },
      "00000000-0000-0000-0000-000000000001",
    ),
    true,
  );
});

test("disposable probes are challenge-owned, collision-failing, and cleanup-addressable", () => {
  const first = disposableProbeStatements(
    "a".repeat(64),
    "b".repeat(64),
  );
  const second = disposableProbeStatements(
    "a".repeat(64),
    "c".repeat(64),
  );
  assert.notEqual(first.table, second.table);
  assert.match(first.create, /^CREATE TABLE "__keepr_probe_[0-9a-f]{32}"/u);
  assert.doesNotMatch(first.create, /IF NOT EXISTS/u);
  assert.match(first.write, new RegExp(first.table, "u"));
  assert.match(first.read, new RegExp(first.table, "u"));
  assert.match(first.drop, new RegExp(first.table, "u"));
});

test("D1 export verification accepts exact read-only database metadata and never starts an export", async () => {
  const databaseId = "00000000-0000-0000-0000-000000000001";
  assert.equal(
    await d1DatabaseInfoSucceeded(
      jsonResponse(200, {
        success: true,
        result: { uuid: databaseId, name: "card-keepr-catalogue" },
      }),
      databaseId,
    ),
    true,
  );
  assert.equal(
    await d1DatabaseInfoSucceeded(
      jsonResponse(200, {
        success: true,
        result: { uuid: "00000000-0000-0000-0000-000000000099" },
      }),
      databaseId,
    ),
    false,
  );
  const provider = [
    "cli/provider-credential-boundary.mjs",
    "cli/provider-cloudflare-boundary.mjs",
  ].map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(
    provider,
    /d1\/database\/\$\{databaseId\}\/export/u,
  );
  assert.doesNotMatch(provider, /output_format:\s*"polling"/u);
});

test("consumer secret list outage differs from authoritative missing name", () => {
  assert.equal(
    classifySecretList({ code: 1, stdout: "" }).kind,
    "failure",
  );
  const listed = classifySecretList({
    code: 0,
    stdout: JSON.stringify([{ name: "OTHER_SECRET" }]),
  });
  assert.deepEqual(listed, {
    kind: "present",
    names: ["OTHER_SECRET"],
  });
});

test("token policy rejects read-only, broad, wrong-account, and wrong-class scope", () => {
  const accountId = "0123456789abcdef0123456789abcdef";
  const policy = (permission, resourceAccount = accountId) => ({
    policies: [
      {
        effect: "allow",
        permission_groups: [{ name: permission }],
        resources: {
          [`com.cloudflare.api.account.${resourceAccount}`]: "*",
        },
      },
    ],
  });
  assert.equal(
    exactTokenPolicy(policy("D1 Edit"), "D1 Edit", accountId),
    true,
  );
  assert.equal(
    exactTokenPolicy(policy("D1 Read"), "D1 Edit", accountId),
    false,
  );
  assert.equal(
    exactTokenPolicy(
      {
        policies: [
          ...policy("D1 Edit").policies,
          ...policy("Workers Scripts Write").policies,
        ],
      },
      "D1 Edit",
      accountId,
    ),
    false,
  );
  assert.equal(
    exactTokenPolicy(
      policy("D1 Edit", "ffffffffffffffffffffffffffffffff"),
      "D1 Edit",
      accountId,
    ),
    false,
  );
  assert.equal(
    exactTokenPolicy(
      policy("Workers Scripts Write"),
      "D1 Edit",
      accountId,
    ),
    false,
  );
});

test("management policy requires the exact complete least-privilege permission set", () => {
  const accountId = "0123456789abcdef0123456789abcdef";
  const token = {
    policies: [
      {
        effect: "allow",
        permission_groups: [
          { name: "Account API Tokens Write" },
          { name: "Workers Scripts Write" },
        ],
        resources: {
          [`com.cloudflare.api.account.${accountId}`]: "*",
        },
      },
    ],
  };
  assert.equal(
    exactManagementTokenPolicy(token, [
      "Account API Tokens Write",
      "Workers Scripts Write",
    ], accountId),
    true,
  );
  assert.equal(
    exactManagementTokenPolicy(token, [
      "Account API Tokens Write",
    ], accountId),
    false,
  );
  assert.equal(
    exactManagementTokenPolicy({
      ...token,
      policies: [
        {
          ...token.policies[0],
          permission_groups: [
            ...token.policies[0].permission_groups,
            { name: "Account Settings Write" },
          ],
        },
      ],
    }, [
      "Account API Tokens Write",
      "Workers Scripts Write",
    ], accountId),
    false,
  );
});

test("GitHub management authority binds exact installation, repository, environment, workflow, and permissions", () => {
  const permissions = {
    actions: "write",
    contents: "read",
    environments: "write",
    metadata: "read",
  };
  const expected = {
    installationId: "22222222",
    repositoryId: "1313489088",
    environmentId: "33333333",
    workflowId: "44444444",
    permissions,
    requiredPolicy: "exact-policy",
    suppliedPolicy: "exact-policy",
  };
  const authority = {
    installation: { id: 22222222, permissions },
    repository: { id: 1313489088 },
    environment: { id: 33333333, name: "production" },
    workflow: {
      id: 44444444,
      path: ".github/workflows/credential-boundary-probe.yml",
      state: "active",
    },
    expected,
  };
  assert.equal(githubAuthorityMatches(authority), true);
  const installationTokenAuthority = {
    ...authority,
    installation: undefined,
    repositories: {
      repository_selection: "selected",
      total_count: 1,
      repositories: [{ id: 1313489088 }],
    },
    viewer: {
      data: { viewer: { login: "keepr-rotation[bot]" } },
    },
  };
  assert.equal(
    githubAuthorityMatches(installationTokenAuthority),
    true,
  );
  assert.equal(
    githubAuthorityMatches({
      ...installationTokenAuthority,
      repositories: {
        repository_selection: "selected",
        total_count: 2,
        repositories: [{ id: 1313489088 }, { id: 999 }],
      },
    }),
    false,
  );
  assert.equal(
    githubAuthorityMatches({
      ...installationTokenAuthority,
      viewer: {
        data: { viewer: { login: "attacker" } },
      },
    }),
    false,
  );
  assert.equal(
    githubAuthorityMatches({
      ...authority,
      installation: {
        ...authority.installation,
        permissions: { ...permissions, administration: "write" },
      },
    }),
    false,
  );
  assert.equal(
    githubAuthorityMatches({
      ...authority,
      repository: { id: 999 },
    }),
    false,
  );
  assert.equal(
    githubAuthorityMatches({
      ...authority,
      expected: { ...expected, suppliedPolicy: "broad-policy" },
    }),
    false,
  );
});

test("the GitHub installed-secret workflow retains semantic slots and exact actor validation", () => {
  const workflow = readFileSync(
    ".github/workflows/credential-boundary-probe.yml",
    "utf8",
  );
  assert.match(
    workflow,
    /options:\s*\n\s*- active\s*\n\s*- replacement/u,
  );
  assert.match(
    workflow,
    /inputs\.secret_slot == 'active' && secrets\.CLOUDFLARE_DEPLOYMENT_TOKEN \|\| secrets\.CLOUDFLARE_DEPLOYMENT_TOKEN_REPLACEMENT/u,
  );
  assert.match(workflow, /expected_actor:\s*\n\s*required: true/u);
  assert.match(
    workflow,
    /test "\$\{GITHUB_ACTOR\}" = "\$\{EXPECTED_ACTOR\}"/u,
  );
});

test("the GitHub provider maps A/B slots and rejects a workflow run by the wrong actor", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/git/ref/heads/main")) {
      return jsonResponse(200, {
        object: { sha: "a".repeat(40) },
      });
    }
    if (String(url).endsWith("/dispatches")) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse(200, {
      workflow_runs: [{
        id: 1234,
        display_title:
          `credential-boundary-probe-active-provider-token-new-${"b".repeat(64)}-${"c".repeat(64)}`,
        head_sha: "a".repeat(40),
        created_at: "9999-12-31T23:59:59.999Z",
        status: "completed",
        conclusion: "success",
        actor: { login: "attacker[bot]" },
      }],
    });
  };
  try {
    const proof = await probeGithubInstalledSecret({
      cloudflareAccountId: "0123456789abcdef0123456789abcdef",
      replacementIssuerCredentialId: "provider-token-new",
      planDigest: "c".repeat(64),
      planNonce: "b".repeat(64),
      secretSlot: "a",
      expectedActor: "keepr-rotation[bot]",
      credential: "github-installation-token",
      workflowId: "44444444",
    });
    assert.equal(proof, null);
    const dispatch = JSON.parse(requests[1].init.body);
    assert.equal(dispatch.inputs.secret_slot, "active");
    assert.equal(
      dispatch.inputs.expected_actor,
      "keepr-rotation[bot]",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API and administration issuer identities are fixed catalogue secret slots", () => {
  const context = {
    cloudflare_account_id: "0123456789abcdef0123456789abcdef",
    catalogue_d1_database_id:
      "00000000-0000-0000-0000-000000000001",
    disposable_d1_database_id:
      "00000000-0000-0000-0000-000000000002",
    github_repository_id: "1313489088",
    github_installation_id: "22222222",
    github_environment_id: "33333333",
    github_workflow_id: "44444444",
  };
  assert.deepEqual(
    {
      old: resolveCredentialIdentity("api_bearer_key", context)
        .fixed_old_issuer_credential_id,
      replacement: resolveCredentialIdentity(
        "api_bearer_key",
        context,
      ).fixed_replacement_issuer_credential_id,
    },
    {
      old: "wrangler:apps/api/wrangler.jsonc:API_BEARER_KEY",
      replacement:
        "wrangler:apps/api/wrangler.jsonc:API_BEARER_KEY_REPLACEMENT",
    },
  );
  assert.deepEqual(
    {
      old: resolveCredentialIdentity(
        "ingestion_admin_key",
        context,
      ).fixed_old_issuer_credential_id,
      replacement: resolveCredentialIdentity(
        "ingestion_admin_key",
        context,
      ).fixed_replacement_issuer_credential_id,
    },
    {
      old:
        "wrangler:apps/ingestion/wrangler.jsonc:ADMINISTRATION_KEY",
      replacement:
        "wrangler:apps/ingestion/wrangler.jsonc:ADMINISTRATION_KEY_REPLACEMENT",
    },
  );
});

test("management permissions exactly cover token and Worker secret APIs", () => {
  for (const credentialClass of credentialClasses) {
    assert.deepEqual(
      [...credentialClassDefinitions[credentialClass].management_permissions]
        .sort(),
      [
        "Account API Tokens Read",
        "Account API Tokens Write",
        "Workers Scripts Write",
      ],
    );
  }
});

test("secret-bearing provider operations use direct HTTPS and ignore PATH", () => {
  const sources = [
    "cli/provider-credential-boundary.mjs",
    "cli/provider-cloudflare-boundary.mjs",
    "cli/provider-github-boundary.mjs",
  ].map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(sources, /spawn\(\s*["'](?:gh|wrangler)["']/u);
  assert.doesNotMatch(sources, /process\.env\.PATH/u);
  assert.match(sources, /https:\/\/api\.github\.com/u);
  assert.match(sources, /https:\/\/api\.cloudflare\.com/u);
});

test("no D1 export POST remains in credential code", () => {
  const sources = [
    "cli/provider-cloudflare-boundary.mjs",
    "cli/provider-credential-boundary.mjs",
    "src/credentials/consumer-proof.ts",
  ].map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(sources, /\/export|path:\s*"export"/u);
});

test("partial provider journals keep the global execution claim locked for reconciliation", () => {
  for (const steps of [
    [
      "consumer-secret-put:API_BEARER_KEY_REPLACEMENT",
      "consumer-marker-put:failed",
    ],
    [
      "issuer-delete:provider-token:old",
      "consumer-secret-delete:failed",
    ],
  ]) {
    assert.equal(
      mayReleaseExecutionClaim({
        ok: false,
        mutation_started: true,
        journal: {
          contract: "card-keepr-provider-mutation-journal@1",
          mutation_started: true,
          steps,
        },
      }),
      false,
    );
  }
  assert.equal(
    mayReleaseExecutionClaim({
      ok: false,
      mutation_started: false,
      journal: {
        contract: "card-keepr-provider-mutation-journal@1",
        mutation_started: false,
        steps: [],
      },
    }),
    true,
  );
});

test("production provider cannot self-sign or be replaced through environment", () => {
  const boundary = readFileSync(
    "cli/credential-boundary.mjs",
    "utf8",
  );
  const provider = readFileSync(
    "cli/provider-credential-boundary.mjs",
    "utf8",
  );
  const attestor = readFileSync(
    "cli/credential-boundary-attestor.mjs",
    "utf8",
  );
  assert.doesNotMatch(boundary, /KEEPR_CREDENTIAL_BOUNDARY_EXECUTOR/);
  assert.doesNotMatch(
    provider,
    /CREDENTIAL_BOUNDARY_ATTESTATION_KEY|createHmac/,
  );
  assert.match(
    attestor,
    /readFileSync\(3,\s*"utf8"\)/,
  );
  assert.doesNotMatch(
    attestor,
    /process\.env\.KEEPR_CREDENTIAL_BOUNDARY_ATTESTATION_KEY/,
  );
  assert.match(boundary, /new URL\("\.\/credential-boundary-attestor\.mjs",\s*import\.meta\.url\)/);
  assert.match(attestor, /new URL\("\.\/provider-credential-boundary\.mjs",\s*import\.meta\.url\)/);
  assert.doesNotMatch(boundary, /resolve\("cli\//);
  assert.doesNotMatch(attestor, /resolve\("cli\//);
  assert.doesNotMatch(attestor, /const environment = \{ \.\.\.process\.env \}/);
});

test("attacker-controlled cwd provider and attestor files are ignored", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "keepr-fake-boundary-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "cli"));
  const marker = join(directory, "executed");
  for (const name of [
    "credential-boundary-attestor.mjs",
    "provider-credential-boundary.mjs",
  ]) {
    writeFileSync(
      join(directory, "cli", name),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");`,
    );
  }
  const original = process.cwd();
  process.chdir(directory);
  try {
    const result = await executeCredentialBoundary(
      {
        action: "install",
        id: "credplan_attacker_cwd",
        plan_digest: "a".repeat(64),
        plan_nonce: "b".repeat(64),
        credential_class: "attacker-class",
        cloudflare_account_id: "c".repeat(32),
        resource_identity: "attacker-resource",
        owning_boundary: "attacker-boundary",
        verification_target: "attacker-target",
        production_target_identity: "{}",
        required_permission: "attacker-permission",
        cloudflare_management_required_permissions: "[]",
        consumer_installation_identity: "attacker-consumer",
        execution_mode: "mutation",
        execution_attempt: 1,
        old_fingerprint: `sha256:${"d".repeat(64)}`,
        replacement_fingerprint: `sha256:${"e".repeat(64)}`,
        old_issuer_credential_id: "attacker-old",
        replacement_issuer_credential_id: "attacker-replacement",
        management_credential_id: "attacker-management",
        github_management_credential_id: "not-applicable",
        github_management_credential_fingerprint:
          `sha256:${"0".repeat(64)}`,
        github_management_required_permission: "not-applicable",
      },
      {
        boundary_attestation_key:
          "attacker-cwd-test-boundary-key-000000",
        management_credential: "not-used",
        old_secret: "not-used",
        replacement_secret: "not-used",
      },
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(existsSync(marker), false);
  } finally {
    process.chdir(original);
  }
});

test("the migration credential-class check mirrors the shared catalogue", () => {
  const migration = readFileSync(
    "migrations/0005_credential_rotation.sql",
    "utf8",
  );
  const match =
    /credential_class TEXT NOT NULL CHECK \(\s*credential_class IN \(([^)]+)\)/u.exec(
      migration,
    );
  assert.notEqual(match, null);
  const migrationClasses = Array.from(
    match[1].matchAll(/'([^']+)'/gu),
    (entry) => entry[1],
  ).sort();
  assert.deepEqual(
    migrationClasses,
    [...credentialClasses].sort(),
  );
});

function jsonResponse(status, document) {
  return new Response(JSON.stringify(document), {
    status,
    headers: { "content-type": "application/json" },
  });
}
