import {
  CredentialRotationProblem,
  installCredentialRotation,
  isCredentialClass,
  revokeOldCredential,
  showCredentialRotation,
  verifyCredentialRotation,
  type CredentialClass,
} from "../../../src/catalogue/credential-rotation";
import { readBoundedJsonObject } from "../../../src/http/bounded-json";

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
      "verification_target",
      "old_fingerprint",
      "replacement_fingerprint",
      "boundary_receipt",
      "idempotency_key",
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
          verification_target: requiredString(
            body,
            "verification_target",
          ),
          old_fingerprint: requiredString(body, "old_fingerprint"),
          replacement_fingerprint: requiredString(
            body,
            "replacement_fingerprint",
          ),
          boundary_receipt: requiredBoundaryReceipt(body),
          idempotency_key: requiredIdempotencyKey(body),
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
      "verification_target",
      "replacement_fingerprint",
      "boundary_receipt",
      "idempotency_key",
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
          verification_target: requiredString(
            body,
            "verification_target",
          ),
          replacement_fingerprint: requiredString(
            body,
            "replacement_fingerprint",
          ),
          boundary_receipt: requiredBoundaryReceipt(body),
          idempotency_key: requiredIdempotencyKey(body),
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
      "verification_target",
      "old_fingerprint",
      "replacement_fingerprint",
      "boundary_receipt",
      "idempotency_key",
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
          verification_target: requiredString(
            body,
            "verification_target",
          ),
          old_fingerprint: requiredString(body, "old_fingerprint"),
          replacement_fingerprint: requiredString(
            body,
            "replacement_fingerprint",
          ),
          boundary_receipt: requiredBoundaryReceipt(body),
          idempotency_key: requiredIdempotencyKey(body),
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
  return readBoundedJsonObject(
    request,
    16_384,
    (status, code, detail) =>
      new CredentialRotationProblem(status, code, detail),
  );
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

function requiredBoundaryReceipt(
  body: Record<string, unknown>,
): string {
  const value = requiredString(body, "boundary_receipt");
  if (!/^receipt:[A-Za-z0-9._:-]{8,200}$/.test(value)) {
    throw new CredentialRotationProblem(
      422,
      "invalid_boundary_receipt",
      "boundary_receipt must be a safe owning-boundary receipt.",
    );
  }
  return value;
}

function requiredIdempotencyKey(
  body: Record<string, unknown>,
): string {
  const value = requiredString(body, "idempotency_key");
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(value)) {
    throw new CredentialRotationProblem(
      422,
      "invalid_idempotency_key",
      "idempotency_key must be an opaque 8 to 200 character key.",
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
