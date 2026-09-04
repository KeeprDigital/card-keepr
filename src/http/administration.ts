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

export function requiredEvidencePlans(
  body: Record<string, unknown>,
  field: string,
): {
  supported_game: string;
  source_lineage: string;
  adapter_version: string;
  requests: ReturnType<typeof requiredSourceRequests>;
}[] {
  const value = body[field];
  if (!Array.isArray(value)) {
    throw new AdministrationRequestProblem(422, "invalid_parameter", `${field} must be an array.`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new AdministrationRequestProblem(422, "invalid_parameter", `${field}[${index}] must be an object.`);
    }
    const plan = item as Record<string, unknown>;
    assertOnlyFields(plan, ["supported_game", "source_lineage", "adapter_version", "requests"]);
    return {
      supported_game: requiredString(plan, "supported_game"),
      source_lineage: requiredString(plan, "source_lineage"),
      adapter_version: requiredString(plan, "adapter_version"),
      requests: requiredSourceRequests(plan, "requests"),
    };
  });
}

export function requiredSourceRequests(
  body: Record<string, unknown>,
  field: string,
): {
  id: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
}[] {
  const value = body[field];
  if (!Array.isArray(value)) {
    throw new AdministrationRequestProblem(422, "invalid_parameter", `${field} must be an array.`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new AdministrationRequestProblem(422, "invalid_parameter", `${field}[${index}] must be an object.`);
    }
    const sourceRequest = item as Record<string, unknown>;
    assertOnlyFields(sourceRequest, ["id", "url", "method", "headers"]);
    const headersValue = sourceRequest.headers;
    let headers: Record<string, string> | undefined;
    if (headersValue !== undefined) {
      if (
        headersValue === null ||
        typeof headersValue !== "object" ||
        Array.isArray(headersValue) ||
        Object.values(headersValue).some((header) => typeof header !== "string")
      ) {
        throw new AdministrationRequestProblem(
          422,
          "invalid_parameter",
          `${field}[${index}].headers must contain only string values.`,
        );
      }
      headers = headersValue as Record<string, string>;
    }
    return {
      id: requiredString(sourceRequest, "id"),
      url: requiredString(sourceRequest, "url"),
      ...(sourceRequest.method === undefined ? {} : { method: requiredString(sourceRequest, "method") }),
      ...(headers === undefined ? {} : { headers }),
    };
  });
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
