import { problemResponse } from "./problem";
import {
  credentialSecretMatches,
  type CredentialClass,
} from "../catalogue/credential-rotation";

export type AuthenticationCodes = {
  missing: string;
  invalid: string;
};

export async function authenticateBearer(
  request: Request,
  expectedKey: string,
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

  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  const providedKey = match?.[1];
  if (
    providedKey === undefined ||
    !(await timingSafeSecretEqual(providedKey, expectedKey))
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

export async function authenticateCredentialBearer(
  request: Request,
  database: D1Database,
  credentialClass: CredentialClass,
  bootstrapKey: string,
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
    !(await credentialSecretMatches(
      database,
      credentialClass,
      providedKey,
      bootstrapKey,
    ))
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
