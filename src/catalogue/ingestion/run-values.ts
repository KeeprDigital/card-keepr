import { AdministrationProblem, decodeDocument, type SupportedGame } from "../shared";

export function publicationWriterToken(revisionId: string): string {
  return `writer:${revisionId}`;
}

export function requiredPublicationValue(value: string | null, description: string): string {
  if (value === null || value.length === 0) {
    throw new Error(`The reserved publication ${description} is invalid.`);
  }
  return value;
}

export function parseJson(value: string, description: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${description} is not valid JSON.`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isExactStringTuple(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
  );
}

export function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

export function parseSelectedGames(value: string): readonly SupportedGame[] {
  return decodeDocument("selectedGames", JSON.parse(value), "The persisted selected games are invalid.");
}

export function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

export function isOpaqueIdentity(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

export function isSha256Digest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function assertOpaqueId(value: string, field: string): void {
  if (!isOpaqueIdentity(value)) {
    throw new AdministrationProblem(422, "invalid_parameter", `${field} is not a valid opaque identity.`);
  }
}

export function assertSha256(value: string, field: string): void {
  if (!isSha256Digest(value)) {
    throw new AdministrationProblem(422, "invalid_parameter", `${field} is not a lower-case SHA-256 digest.`);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
