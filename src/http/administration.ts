import { readBoundedJsonObject } from "./bounded-json";

export async function readAdministrationBody(request: Request): Promise<Record<string, unknown>> {
  return readBoundedJsonObject(
    request,
    16_384,
    (status, code, detail) => new AdministrationRequestProblem(status, code, detail),
  );
}

export function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AdministrationRequestProblem(422, "invalid_parameter", `${field} must be a non-empty string.`);
  }
  return value;
}

export function requiredStringArray(body: Record<string, unknown>, field: string): readonly string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    throw new AdministrationRequestProblem(422, "invalid_parameter", `${field} must be a non-empty array of strings.`);
  }
  return value;
}

export function assertOnlyFields(body: Record<string, unknown>, allowedFields: readonly string[]): void {
  const unexpected = Object.keys(body).find((field) => !allowedFields.includes(field));
  if (unexpected !== undefined) {
    throw new AdministrationRequestProblem(
      422,
      "invalid_parameter",
      `${unexpected} is not accepted for this administration operation.`,
    );
  }
}

export function administrationResultStatus(result: Record<string, unknown>, completedStatus: number): number {
  return result.contract === "card-keepr-administration-operation@1" && result.status === "in_progress"
    ? 202
    : completedStatus;
}

export function catalogueExportDeletionResultStatus(result: Record<string, unknown>): number {
  return result.contract === "card-keepr-catalogue-export-deletion@1" && result.state === "deleting" ? 202 : 200;
}

// Request validation crosses the worker boundary through the problem shape.
// It does not depend on catalogue administration error classes.
class AdministrationRequestProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}
