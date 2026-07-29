import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifySecretList,
  classifyTokenLookup,
  cloudflareOperationSucceeded,
  exactTokenPolicy,
} from "../cli/provider-authority.mjs";
import {
  credentialClasses,
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
    /delete environment\.KEEPR_CREDENTIAL_BOUNDARY_ATTESTATION_KEY/,
  );
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
