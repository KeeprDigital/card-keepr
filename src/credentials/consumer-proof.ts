import type {
  CredentialClass,
} from "../catalogue/credential-rotation";
import {
  credentialClassDefinitions,
} from "./credential-catalogue.mjs";
import {
  probeD1Credential,
} from "./cloudflare-authority.mjs";

type ConsumerProofEnvironment = {
  CREDENTIAL_CONSUMER_PROOF_KEY: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CATALOGUE_D1_DATABASE_ID?: string;
  DISPOSABLE_D1_DATABASE_ID?: string;
  API_BEARER_KEY_REPLACEMENT?: string;
  ADMINISTRATION_KEY_REPLACEMENT?: string;
  D1_EXPORT_TOKEN_REPLACEMENT?: string;
  D1_VERIFICATION_TOKEN_REPLACEMENT?: string;
  API_BEARER_KEY?: string;
  ADMINISTRATION_KEY?: string;
  D1_EXPORT_TOKEN?: string;
  D1_VERIFICATION_TOKEN?: string;
};

export type CredentialConsumerProofRequestClaims = {
  plan_id: string;
  plan_digest: string;
  plan_nonce: string;
  execution_attempt: number;
  execution_expires_at: string;
  credential_class: CredentialClass;
  expected_fingerprint: string;
  slot: "a" | "b";
  expected_status: "usable" | "unusable";
  replacement_issuer_credential_id: string;
  github_management_credential_fingerprint: string;
  github_management_required_permission: string;
};

export type CredentialConsumerProof = {
  contract: "card-keepr-credential-consumer-proof@1";
  credential_class: CredentialClass;
  expected_fingerprint: string;
  challenge: string;
  plan_nonce: string;
  execution_attempt: number;
  execution_expires_at: string;
  slot: "a" | "b";
  status: "usable" | "unusable";
  proof: string;
};

export async function credentialConsumerProofRequests(
  plan: {
    id: string;
    plan_digest: string;
    plan_nonce: string;
    execution_attempt: number;
    execution_expires_at: string | null;
    action: string;
    credential_class: CredentialClass;
    old_fingerprint: string;
    replacement_fingerprint: string;
    old_consumer_slot: "a" | "b";
    replacement_consumer_slot: "a" | "b";
    old_issuer_credential_id: string;
    replacement_issuer_credential_id: string;
    github_management_credential_fingerprint: string;
    github_management_required_permission: string;
  },
  key: string,
): Promise<Array<CredentialConsumerProofRequestClaims & {
  request_token: string;
}>> {
  const requests = [
    {
      expected_fingerprint: plan.replacement_fingerprint,
      slot: plan.replacement_consumer_slot,
      expected_status: "usable" as const,
      replacement_issuer_credential_id:
        plan.replacement_issuer_credential_id,
    },
    ...(plan.action === "verify"
      ? [{
          expected_fingerprint: plan.old_fingerprint,
          slot: plan.old_consumer_slot,
          expected_status: "usable" as const,
          replacement_issuer_credential_id:
            plan.old_issuer_credential_id,
        }]
      : []),
    ...(plan.action === "revoke"
      ? [{
          expected_fingerprint: plan.old_fingerprint,
          slot: plan.old_consumer_slot,
          expected_status: "unusable" as const,
          replacement_issuer_credential_id:
            plan.old_issuer_credential_id,
        }]
      : []),
  ];
  return Promise.all(requests.map(async (request) => {
    const claims: CredentialConsumerProofRequestClaims = {
      plan_id: plan.id,
      plan_digest: plan.plan_digest,
      plan_nonce: plan.plan_nonce,
      execution_attempt: plan.execution_attempt,
      execution_expires_at: plan.execution_expires_at ?? "",
      credential_class: plan.credential_class,
      ...request,
      github_management_credential_fingerprint:
        plan.github_management_credential_fingerprint,
      github_management_required_permission:
        plan.github_management_required_permission,
    };
    return {
      ...claims,
      request_token: await signedRequestToken(claims, key),
    };
  }));
}

export async function handleCredentialConsumerProof(
  request: Request,
  environment: ConsumerProofEnvironment,
  acceptedClasses: readonly CredentialClass[],
  normalBearerProbe: (
    secret: string,
    credentialClass: CredentialClass,
  ) => Promise<boolean>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.pathname !== "/v1/credential-consumer-proof"
  ) {
    return null;
  }
  const text = await readBoundedText(request, 16_384);
  if (text === null) {
    return Response.json({ code: "request_too_large" }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Response.json({ code: "invalid_parameter" }, { status: 422 });
  }
  const claims = await verifiedRequestToken(
    body.request_token,
    environment.CREDENTIAL_CONSUMER_PROOF_KEY,
  );
  if (claims === null) {
    return Response.json(
      { code: "invalid_boundary_challenge" },
      { status: 401 },
    );
  }
  const credentialClass = body.credential_class;
  if (
    typeof credentialClass !== "string" ||
    !acceptedClasses.includes(credentialClass as CredentialClass) ||
    typeof body.expected_fingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(body.expected_fingerprint) ||
    typeof body.challenge !== "string" ||
    !/^[0-9a-f]{64}$/.test(body.challenge) ||
    !["a", "b"].includes(String(body.slot)) ||
    !["usable", "unusable"].includes(String(body.expected_status)) ||
    credentialClass !== claims.credential_class ||
    body.expected_fingerprint !== claims.expected_fingerprint ||
    body.challenge !== claims.plan_digest ||
    body.slot !== claims.slot ||
    body.expected_status !== claims.expected_status
  ) {
    return Response.json({ code: "identity_conflict" }, { status: 409 });
  }
  const secret = replacementSecret(
    credentialClass as CredentialClass,
    environment,
    body.slot as "a" | "b",
  );
  if (
    body.expected_status === "unusable" &&
    secret === undefined
  ) {
    return proofResponse(
      claims,
      environment.CREDENTIAL_CONSUMER_PROOF_KEY,
    );
  }
  if (
    secret === undefined ||
    !(await fixedHexEqual(
      await sha256(secret),
      body.expected_fingerprint.slice("sha256:".length),
    ))
  ) {
    return Response.json(
      { code: "credential_fingerprint_mismatch" },
      { status: 409 },
    );
  }
  const capability =
    credentialClass === "api_bearer_key" ||
    credentialClass === "ingestion_admin_key"
      ? {
          ok: await normalBearerProbe(
            secret,
            credentialClass as CredentialClass,
          ),
          mutation_started: false,
          cleanup: "not-applicable",
        }
      : await probeD1Capability(
          credentialClass,
          secret,
          environment,
          body.expected_fingerprint.slice("sha256:".length),
          body.challenge,
        );
  if (!capability.ok) {
    const unresolvedMutation =
      capability.mutation_started &&
      capability.cleanup !== "complete";
    return Response.json(
      {
        code: "credential_capability_mismatch",
        journal: {
          contract: "card-keepr-provider-mutation-journal@1",
          mutation_started: unresolvedMutation,
          steps: [
            `consumer-proof-cleanup:${capability.cleanup}`,
          ],
        },
      },
      { status: 409 },
    );
  }
  return proofResponse(
    claims,
    environment.CREDENTIAL_CONSUMER_PROOF_KEY,
  );
}

export async function credentialConsumerProofMatches(
  proof: unknown,
  claims: CredentialConsumerProofRequestClaims,
  key: string,
): Promise<boolean> {
  if (
    proof === null ||
    typeof proof !== "object" ||
    Array.isArray(proof)
  ) {
    return false;
  }
  const candidate = proof as Record<string, unknown>;
  const expected = await hmac(key, consumerProofMessage(claims));
  return (
    candidate.contract ===
      "card-keepr-credential-consumer-proof@1" &&
    candidate.credential_class === claims.credential_class &&
    candidate.expected_fingerprint ===
      claims.expected_fingerprint &&
    candidate.challenge === claims.plan_digest &&
    candidate.plan_nonce === claims.plan_nonce &&
    candidate.execution_attempt === claims.execution_attempt &&
    candidate.execution_expires_at === claims.execution_expires_at &&
    candidate.slot === claims.slot &&
    candidate.status === claims.expected_status &&
    typeof candidate.proof === "string" &&
    await fixedHexEqual(candidate.proof, expected)
  );
}

async function signedRequestToken(
  claims: CredentialConsumerProofRequestClaims,
  key: string,
): Promise<string> {
  const encoded = base64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  return `v1.${encoded}.${await hmac(key, `request\0${encoded}`)}`;
}

async function verifiedRequestToken(
  value: unknown,
  key: string,
): Promise<CredentialConsumerProofRequestClaims | null> {
  if (typeof value !== "string") return null;
  const match =
    /^v1\.([A-Za-z0-9_-]{32,4096})\.([0-9a-f]{64})$/.exec(value);
  if (
    match === null ||
    !(await fixedHexEqual(
      match[2]!,
      await hmac(key, `request\0${match[1]!}`),
    ))
  ) {
    return null;
  }
  let claims: CredentialConsumerProofRequestClaims;
  try {
    claims = JSON.parse(
      new TextDecoder().decode(base64UrlBytes(match[1]!)),
    ) as CredentialConsumerProofRequestClaims;
  } catch {
    return null;
  }
  return (
    typeof claims.plan_id === "string" &&
    /^[0-9a-f]{64}$/.test(claims.plan_digest) &&
    /^[0-9a-f]{64}$/.test(claims.plan_nonce) &&
    Number.isSafeInteger(claims.execution_attempt) &&
    claims.execution_attempt > 0 &&
    canonicalTimestamp(claims.execution_expires_at) &&
    credentialClassDefinitions[claims.credential_class] !== undefined &&
    /^sha256:[0-9a-f]{64}$/.test(claims.expected_fingerprint) &&
    ["a", "b"].includes(claims.slot) &&
    ["usable", "unusable"].includes(claims.expected_status) &&
    typeof claims.replacement_issuer_credential_id === "string" &&
    typeof claims.github_management_credential_fingerprint === "string" &&
    typeof claims.github_management_required_permission === "string"
  )
    ? claims
    : null;
}

async function readBoundedText(
  request: Request,
  maximumBytes: number,
): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    /^[0-9]+$/.test(declared) &&
    Number.parseInt(declared, 10) > maximumBytes
  ) {
    await request.body?.cancel();
    return null;
  }
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytesRead += chunk.value.byteLength;
    if (bytesRead > maximumBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

async function proofResponse(
  claims: CredentialConsumerProofRequestClaims,
  key: string,
): Promise<Response> {
  return Response.json({
    contract: "card-keepr-credential-consumer-proof@1",
    credential_class: claims.credential_class,
    expected_fingerprint: claims.expected_fingerprint,
    challenge: claims.plan_digest,
    plan_nonce: claims.plan_nonce,
    execution_attempt: claims.execution_attempt,
    execution_expires_at: claims.execution_expires_at,
    slot: claims.slot,
    status: claims.expected_status,
    proof: await hmac(key, consumerProofMessage(claims)),
  });
}

export function consumerProofMessage(
  claims: CredentialConsumerProofRequestClaims,
): string {
  return (
    `${claims.credential_class}\0${claims.expected_fingerprint}` +
    `\0${claims.plan_digest}\0${claims.plan_nonce}` +
    `\0${claims.execution_attempt}\0${claims.execution_expires_at}` +
    `\0${claims.slot}\0${claims.expected_status}`
  );
}

function replacementSecret(
  credentialClass: CredentialClass,
  environment: ConsumerProofEnvironment,
  slot: "a" | "b",
): string | undefined {
  const definition = credentialClassDefinitions[credentialClass];
  const key =
    slot === "a"
      ? definition.active_environment_key
      : definition.replacement_environment_key;
  return environment[key as keyof ConsumerProofEnvironment] as
    | string
    | undefined;
}

async function probeD1Capability(
  credentialClass: CredentialClass,
  token: string,
  environment: ConsumerProofEnvironment,
  planDigest: string,
  challenge: string,
): Promise<{
  ok: boolean;
  mutation_started: boolean;
  cleanup: string;
}> {
  const definition = credentialClassDefinitions[credentialClass];
  const databaseId = environment[
    definition.database_environment_key as keyof ConsumerProofEnvironment
  ] as string | undefined;
  if (
    environment.CLOUDFLARE_ACCOUNT_ID === undefined ||
    databaseId === undefined
  ) {
    return {
      ok: false,
      mutation_started: false,
      cleanup: "not-started",
    };
  }
  const result = await probeD1Credential({
    request: (pathname: string, init?: RequestInit) =>
      fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(15_000),
      }),
    accountId: environment.CLOUDFLARE_ACCOUNT_ID,
    databaseId,
    permission: definition.required_permission,
    planDigest,
    challenge,
  });
  return result;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return hex(new Uint8Array(digest));
}

async function hmac(key: string, value: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        new TextEncoder().encode(value),
      ),
    ),
  );
}

async function fixedHexEqual(
  left: string,
  right: string,
): Promise<boolean> {
  return crypto.subtle.timingSafeEqual(bytes(left), bytes(right));
}

function bytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) return new Uint8Array(32);
  return Uint8Array.from(
    value.match(/../g)!.map((part) => Number.parseInt(part, 16)),
  );
}

function hex(value: Uint8Array): string {
  return Array.from(value)
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

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.valueOf()) &&
    parsed.toISOString() === value
  );
}
