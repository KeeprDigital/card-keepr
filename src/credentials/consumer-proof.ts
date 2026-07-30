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
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 16_384) {
    return Response.json({ code: "request_too_large" }, { status: 413 });
  }
  const supplied = request.headers.get("x-keepr-boundary-signature");
  const expected = await hmac(
    environment.CREDENTIAL_CONSUMER_PROOF_KEY,
    text,
  );
  if (
    supplied === null ||
    !(await fixedHexEqual(supplied, expected))
  ) {
    return Response.json(
      { code: "invalid_boundary_challenge" },
      { status: 401 },
    );
  }
  let body: {
    credential_class?: unknown;
    expected_fingerprint?: unknown;
    challenge?: unknown;
    slot?: unknown;
    expected_status?: unknown;
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return Response.json({ code: "invalid_parameter" }, { status: 422 });
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
    !["usable", "unusable"].includes(String(body.expected_status))
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
      credentialClass,
      body.expected_fingerprint,
      body.challenge,
      body.slot as string,
      "unusable",
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
    credentialClass,
    body.expected_fingerprint,
    body.challenge,
    body.slot as string,
    "usable",
    environment.CREDENTIAL_CONSUMER_PROOF_KEY,
  );
}

async function proofResponse(
  credentialClass: string,
  expectedFingerprint: string,
  challenge: string,
  slot: string,
  status: string,
  key: string,
): Promise<Response> {
  return Response.json({
    contract: "card-keepr-credential-consumer-proof@1",
    credential_class: credentialClass,
    expected_fingerprint: expectedFingerprint,
    challenge,
    slot,
    status,
    proof: await hmac(
      key,
      `${credentialClass}\0${expectedFingerprint}\0${challenge}\0${slot}\0${status}`,
    ),
  });
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
