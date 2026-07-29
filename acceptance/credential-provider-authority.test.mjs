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
} from "../cli/credential-boundary.mjs";
import {
  githubAuthorityMatches,
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
  resolveCredentialIdentity,
} from "../src/credentials/credential-catalogue.mjs";

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
