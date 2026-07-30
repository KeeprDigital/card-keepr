export type BoundaryAttestationPlan = {
  id: string;
  plan_digest: string;
  plan_nonce: string;
  action: "install" | "verify" | "revoke";
  credential_class: string;
  cloudflare_account_id: string;
  resource_identity: string;
  verification_target: string;
  production_target_identity: string;
  required_permission: string;
  cloudflare_management_required_permissions: string;
  consumer_installation_identity: string;
  old_consumer_slot: "a" | "b";
  replacement_consumer_slot: "a" | "b";
  old_fingerprint: string;
  replacement_fingerprint: string;
  old_issuer_credential_id: string;
  replacement_issuer_credential_id: string;
  management_credential_id: string;
  github_management_credential_id: string;
  github_management_credential_fingerprint: string;
  github_management_required_permission: string;
  execution_started_at: string | null;
  execution_expires_at: string | null;
  execution_attempt: number;
};

type BoundaryAttestation = {
  version: 1;
  plan_id: string;
  plan_digest: string;
  plan_nonce: string;
  action: string;
  credential_class: string;
  cloudflare_account_id: string;
  resource_identity: string;
  verification_target: string;
  production_target_identity: string;
  required_permission: string;
  cloudflare_management_required_permissions: string;
  consumer_installation_identity: string;
  old_consumer_slot: "a" | "b";
  replacement_consumer_slot: "a" | "b";
  old_fingerprint: string;
  replacement_fingerprint: string;
  installed_fingerprint: string;
  old_issuer_credential_id: string;
  replacement_issuer_credential_id: string;
  management_credential_id: string;
  github_management_credential_id: string;
  github_management_credential_fingerprint: string;
  github_management_required_permission: string;
  consumer_installation_id: string;
  scope_evidence_digest: string;
  old_credential_status: string;
  replacement_credential_status: string;
  observed_at: string;
  execution_attempt: number;
  execution_mode: string;
};

export async function signCredentialBoundaryFacts(
  plan: BoundaryAttestationPlan,
  facts: unknown,
  key: string,
  observedAt: string,
): Promise<string | null> {
  const encoded = base64Url(
    new TextEncoder().encode(JSON.stringify(facts)),
  );
  const attestation =
    `v1.${encoded}.${await hmacHex(key, encoded)}`;
  return (await credentialBoundaryAttestationFailure(
    plan,
    attestation,
    key,
    observedAt,
  )) === null
    ? attestation
    : null;
}

export async function credentialBoundaryAttestationFailure(
  plan: BoundaryAttestationPlan,
  encoded: string,
  key: string,
  observedAt: string,
): Promise<"invalid_boundary_attestation" | "credential_boundary_mismatch" | null> {
  const match = /^v1\.([A-Za-z0-9_-]{32,8192})\.([0-9a-f]{64})$/.exec(
    encoded,
  );
  if (match === null) return "invalid_boundary_attestation";
  if (
    !(await fixedHexEqual(
      match[2]!,
      await hmacHex(key, match[1]!),
    ))
  ) {
    return "invalid_boundary_attestation";
  }
  let attestation: BoundaryAttestation;
  try {
    attestation = JSON.parse(
      new TextDecoder().decode(base64UrlBytes(match[1]!)),
    ) as BoundaryAttestation;
  } catch {
    return "invalid_boundary_attestation";
  }
  const expectedOldStatus =
    plan.action === "revoke" ? "unusable" : "usable";
  const expectedExecutionMode =
    plan.execution_attempt === 1 ? "mutation" : "reconciliation";
  const exact =
    attestation.version === 1 &&
    attestation.plan_id === plan.id &&
    attestation.action === plan.action &&
    attestation.credential_class === plan.credential_class &&
    attestation.cloudflare_account_id ===
      plan.cloudflare_account_id &&
    attestation.resource_identity === plan.resource_identity &&
    attestation.verification_target === plan.verification_target &&
    attestation.production_target_identity ===
      plan.production_target_identity &&
    attestation.required_permission === plan.required_permission &&
    attestation.cloudflare_management_required_permissions ===
      plan.cloudflare_management_required_permissions &&
    attestation.consumer_installation_identity ===
      plan.consumer_installation_identity &&
    attestation.old_consumer_slot === plan.old_consumer_slot &&
    attestation.replacement_consumer_slot ===
      plan.replacement_consumer_slot &&
    attestation.consumer_installation_id ===
      plan.consumer_installation_identity &&
    attestation.old_issuer_credential_id ===
      plan.old_issuer_credential_id &&
    attestation.replacement_issuer_credential_id ===
      plan.replacement_issuer_credential_id &&
    attestation.management_credential_id ===
      plan.management_credential_id &&
    attestation.github_management_credential_id ===
      plan.github_management_credential_id &&
    attestation.github_management_required_permission ===
      plan.github_management_required_permission &&
    attestation.old_credential_status === expectedOldStatus &&
    attestation.replacement_credential_status === "usable" &&
    attestation.execution_attempt === plan.execution_attempt &&
    attestation.execution_mode === expectedExecutionMode &&
    plan.execution_started_at !== null &&
    plan.execution_expires_at !== null &&
    canonicalTimestamp(attestation.observed_at) &&
    attestation.observed_at >= plan.execution_started_at &&
    attestation.observed_at <= plan.execution_expires_at &&
    attestation.observed_at <= observedAt &&
    safeIdentity(attestation.old_issuer_credential_id) &&
    safeIdentity(attestation.replacement_issuer_credential_id) &&
    safeIdentity(attestation.management_credential_id) &&
    safeIdentity(attestation.consumer_installation_id) &&
    /^sha256:[0-9a-f]{64}$/.test(
      attestation.scope_evidence_digest,
    ) &&
    !(
      plan.action === "revoke" &&
      attestation.old_issuer_credential_id ===
        attestation.replacement_issuer_credential_id
    );
  if (!exact) return "credential_boundary_mismatch";
  const fixedFieldsMatch = (
    await Promise.all([
      fixedHexEqual(attestation.plan_digest, plan.plan_digest),
      fixedHexEqual(attestation.plan_nonce, plan.plan_nonce),
      fixedFingerprintEqual(
        attestation.old_fingerprint,
        plan.old_fingerprint,
      ),
      fixedFingerprintEqual(
        attestation.replacement_fingerprint,
        plan.replacement_fingerprint,
      ),
      fixedFingerprintEqual(
        attestation.installed_fingerprint,
        plan.replacement_fingerprint,
      ),
      fixedFingerprintEqual(
        attestation.github_management_credential_fingerprint,
        plan.github_management_credential_fingerprint,
      ),
    ])
  ).every(Boolean);
  return fixedFieldsMatch ? null : "credential_boundary_mismatch";
}

function fixedFingerprintEqual(left: string, right: string) {
  return fixedHexEqual(
    fingerprintHash(left),
    fingerprintHash(right),
  );
}

function fingerprintHash(value: string): string {
  return /^sha256:[0-9a-f]{64}$/.test(value)
    ? value.slice("sha256:".length)
    : "0".repeat(64);
}

async function fixedHexEqual(left: string, right: string) {
  const leftBytes = hexBytes(left);
  const rightBytes = hexBytes(right);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < 32; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0 && /^[0-9a-f]{64}$/.test(left);
}

function hexBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) return new Uint8Array(32);
  return Uint8Array.from(
    value.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)),
  );
}

async function hmacHex(key: string, value: string) {
  const imported = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    imported,
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function canonicalTimestamp(value: string): boolean {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.valueOf()) &&
    parsed.toISOString() === value
  );
}

function safeIdentity(value: string): boolean {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/.test(value)
  );
}
