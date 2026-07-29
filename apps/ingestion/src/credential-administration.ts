import {
  CredentialRotationProblem,
  installCredentialRotation,
  isCredentialClass,
  revokeOldCredential,
  showCredentialRotation,
  verifyCredentialRotation,
  type CredentialClass,
} from "../../../src/catalogue/credential-rotation";

export async function handleCredentialAdministration(
  request: Request,
  database: D1Database,
  observedAt: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    request.method === "POST" &&
    url.pathname === "/v1/credential-rotations"
  ) {
    const body = await readBody(request);
    assertOnlyFields(body, [
      "rotation_id",
      "credential_class",
      "environment",
      "resource_identity",
      "owning_boundary",
      "expected_old_fingerprint",
      "old_secret",
      "replacement_secret",
    ]);
    return Response.json(
      await installCredentialRotation(
        database,
        {
          rotation_id: requiredString(body, "rotation_id"),
          credential_class: requiredCredentialClass(body),
          environment: requiredProduction(body),
          resource_identity: requiredString(body, "resource_identity"),
          owning_boundary: requiredString(body, "owning_boundary"),
          expected_old_fingerprint: requiredString(
            body,
            "expected_old_fingerprint",
          ),
          old_secret: requiredString(body, "old_secret"),
          replacement_secret: requiredString(
            body,
            "replacement_secret",
          ),
        },
        observedAt,
      ),
      { status: 201 },
    );
  }

  const verification =
    /^\/v1\/credential-rotations\/([^/]+)\/verification$/.exec(
      url.pathname,
    );
  if (request.method === "POST" && verification !== null) {
    const body = await readBody(request);
    assertOnlyFields(body, [
      "credential_class",
      "environment",
      "resource_identity",
      "owning_boundary",
      "replacement_secret",
    ]);
    return Response.json(
      await verifyCredentialRotation(
        database,
        decodeURIComponent(verification[1]!),
        {
          credential_class: requiredCredentialClass(body),
          environment: requiredProduction(body),
          resource_identity: requiredString(body, "resource_identity"),
          owning_boundary: requiredString(body, "owning_boundary"),
          replacement_secret: requiredString(
            body,
            "replacement_secret",
          ),
        },
        observedAt,
      ),
    );
  }

  const revocation =
    /^\/v1\/credential-rotations\/([^/]+)\/revocation$/.exec(
      url.pathname,
    );
  if (request.method === "POST" && revocation !== null) {
    const body = await readBody(request);
    assertOnlyFields(body, [
      "credential_class",
      "environment",
      "resource_identity",
      "owning_boundary",
      "expected_old_fingerprint",
    ]);
    return Response.json(
      await revokeOldCredential(
        database,
        decodeURIComponent(revocation[1]!),
        {
          credential_class: requiredCredentialClass(body),
          environment: requiredProduction(body),
          resource_identity: requiredString(body, "resource_identity"),
          owning_boundary: requiredString(body, "owning_boundary"),
          expected_old_fingerprint: requiredString(
            body,
            "expected_old_fingerprint",
          ),
        },
        observedAt,
      ),
    );
  }

  const rotation = /^\/v1\/credential-rotations\/([^/]+)$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && rotation !== null) {
    return Response.json(
      await showCredentialRotation(
        database,
        decodeURIComponent(rotation[1]!),
      ),
    );
  }
  return null;
}

async function readBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const maximumBytes = 16_384;
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.parseInt(declaredLength, 10) > maximumBytes
  ) {
    throw new CredentialRotationProblem(
      413,
      "request_too_large",
      "The credential request body exceeds 16 KiB.",
    );
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  if (reader !== undefined) {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel();
        throw new CredentialRotationProblem(
          413,
          "request_too_large",
          "The credential request body exceeds 16 KiB.",
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    const value: unknown = JSON.parse(text);
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new CredentialRotationProblem(
      400,
      "invalid_json",
      "The credential request body must be a JSON object.",
    );
  }
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new CredentialRotationProblem(
      422,
      "invalid_parameter",
      `${field} must be a non-empty string.`,
    );
  }
  return value;
}

function requiredCredentialClass(
  body: Record<string, unknown>,
): CredentialClass {
  const value = requiredString(body, "credential_class");
  if (!isCredentialClass(value)) {
    throw new CredentialRotationProblem(
      422,
      "invalid_credential_class",
      "credential_class is not a supported isolated credential class.",
    );
  }
  return value;
}

function requiredProduction(
  body: Record<string, unknown>,
): "production" {
  const value = requiredString(body, "environment");
  if (value !== "production") {
    throw new CredentialRotationProblem(
      422,
      "production_target_required",
      "Credential mutation requires the production environment.",
    );
  }
  return value;
}

function assertOnlyFields(
  body: Record<string, unknown>,
  allowedFields: readonly string[],
): void {
  const unexpected = Object.keys(body).find(
    (field) => !allowedFields.includes(field),
  );
  if (unexpected !== undefined) {
    throw new CredentialRotationProblem(
      422,
      "invalid_parameter",
      `${unexpected} is not accepted for this credential operation.`,
    );
  }
}
