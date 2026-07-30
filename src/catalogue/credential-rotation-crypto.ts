import {
  CredentialRotationProblem,
  credentialConflict,
} from "./credential-rotation-problem";

export function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function secretHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function fixedHashEqual(
  left: string,
  right: string,
): Promise<boolean> {
  return crypto.subtle.timingSafeEqual(hashBytes(left), hashBytes(right));
}

export async function fixedIdentityEqual(
  left: string,
  right: string,
): Promise<boolean> {
  return fixedHashEqual(
    await secretHash(left),
    await secretHash(right),
  );
}

export async function assertFingerprint(
  expectedHash: string,
  fingerprint: string,
  code: string,
): Promise<void> {
  if (
    !(await fixedHashEqual(
      hashFromFingerprint(fingerprint),
      expectedHash,
    ))
  ) {
    throw credentialConflict(
      code,
      "The expected credential fingerprint is stale.",
    );
  }
}

export function hashFromFingerprint(fingerprint: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(fingerprint);
  if (match === null) {
    throw new CredentialRotationProblem(
      422,
      "invalid_credential_fingerprint",
      "Credential fingerprints must be full SHA-256 fingerprints.",
    );
  }
  return match[1]!;
}

export async function requestDigest(value: unknown): Promise<string> {
  return secretHash(JSON.stringify(value));
}

function hashBytes(hash: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hash)) return new Uint8Array(32);
  return Uint8Array.from(
    hash.match(/../g)!.map((byte) => Number.parseInt(byte, 16)),
  );
}
