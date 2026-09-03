import { problemResponse } from "./problem";

export type AuthenticationCodes = {
  missing: string;
  invalid: string;
};

// Dual-key bearer authentication (ADR 0005): each worker accepts a primary
// key and an optional replacement key so an operator rotation never has a
// gap. Every accepted key is compared so the response time does not reveal
// which slot, if any, matched.
export async function authenticateBearer(
  request: Request,
  acceptedKeys: readonly (string | undefined)[],
  requestId: string,
  codes: AuthenticationCodes,
): Promise<Response | null> {
  const authorization = request.headers.get("authorization");
  if (authorization === null) {
    return problemResponse({
      requestId,
      status: 401,
      code: codes.missing,
      title: "Authentication required",
      detail: "Supply a bearer credential in the Authorization header.",
    });
  }

  const providedKey = /^Bearer ([^\s]+)$/.exec(authorization)?.[1];
  if (
    providedKey === undefined ||
    !(await matchesAnyKey(providedKey, acceptedKeys))
  ) {
    return problemResponse({
      requestId,
      status: 401,
      code: codes.invalid,
      title: "Invalid credential",
      detail: "The supplied bearer credential is not valid.",
    });
  }

  return null;
}

async function matchesAnyKey(
  provided: string,
  acceptedKeys: readonly (string | undefined)[],
): Promise<boolean> {
  const definedKeys = acceptedKeys.filter(
    (key): key is string => key !== undefined,
  );
  const comparisons = await Promise.all(
    definedKeys.map((key) => timingSafeSecretEqual(provided, key)),
  );
  let matched = false;
  for (const comparison of comparisons) {
    matched = matched || comparison;
  }
  return matched;
}

async function timingSafeSecretEqual(
  provided: string,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}
