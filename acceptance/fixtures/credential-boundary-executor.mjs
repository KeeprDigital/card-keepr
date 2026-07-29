import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { appendFileSync } from "node:fs";

const [
  action,
  planId,
  planDigest,
  planNonce,
  credentialClass,
  cloudflareAccountId,
  resourceIdentity,
  owningBoundary,
  verificationTarget,
  requiredPermission,
  oldFingerprint,
  replacementFingerprint,
  oldIssuerCredentialId,
  replacementIssuerCredentialId,
  managementCredentialId,
] = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const secrets = JSON.parse(input);

if (process.env.KEEPR_TEST_BOUNDARY_LOG) {
  appendFileSync(
    process.env.KEEPR_TEST_BOUNDARY_LOG,
    `${JSON.stringify({ action, plan_id: planId })}\n`,
  );
}
if (
  action === "install" &&
  (!equalFingerprint(
    fingerprint(secrets.old_secret),
    oldFingerprint,
  ) ||
    !equalFingerprint(
      fingerprint(secrets.replacement_secret),
      replacementFingerprint,
    ))
) {
  process.exit(3);
}
if (
  !process.env.KEEPR_CREDENTIAL_BOUNDARY_ATTESTATION_KEY ||
  typeof secrets.management_credential !== "string"
) {
  process.exit(4);
}

const scopeEvidenceDigest = fingerprint(
  [
    cloudflareAccountId,
    resourceIdentity,
    verificationTarget,
    requiredPermission,
    replacementIssuerCredentialId,
  ].join("\0"),
);
const payload = {
  version: 1,
  plan_id: planId,
  plan_digest: planDigest,
  plan_nonce: planNonce,
  action,
  credential_class: credentialClass,
  cloudflare_account_id: cloudflareAccountId,
  resource_identity: resourceIdentity,
  verification_target: verificationTarget,
  required_permission: requiredPermission,
  old_fingerprint: oldFingerprint,
  replacement_fingerprint: replacementFingerprint,
  installed_fingerprint: replacementFingerprint,
  old_issuer_credential_id: oldIssuerCredentialId,
  replacement_issuer_credential_id: replacementIssuerCredentialId,
  management_credential_id: managementCredentialId,
  consumer_installation_id: `fake-consumer:${planId}`,
  scope_evidence_digest: scopeEvidenceDigest,
  old_credential_status: action === "revoke" ? "unusable" : "usable",
  replacement_credential_status: "usable",
  observed_at: "2026-07-29T00:00:00.000Z",
};
const encoded = Buffer.from(JSON.stringify(payload)).toString(
  "base64url",
);
const signature = createHmac(
  "sha256",
  process.env.KEEPR_CREDENTIAL_BOUNDARY_ATTESTATION_KEY,
)
  .update(encoded)
  .digest("hex");
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    plan_id: planId,
    plan_digest: planDigest,
    boundary_attestation: `v1.${encoded}.${signature}`,
  })}\n`,
);

function fingerprint(value) {
  return `sha256:${createHash("sha256").update(value ?? "").digest("hex")}`;
}

function equalFingerprint(left, right) {
  return timingSafeEqual(bytes(left), bytes(right));
}

function bytes(value) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(value ?? "");
  return match === null
    ? Buffer.alloc(32)
    : Buffer.from(match[1], "hex");
}
