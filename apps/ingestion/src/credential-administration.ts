import {
  beginCredentialRotationPlanExecution,
  CredentialRotationProblem,
  finalizeCredentialRotationPlan,
  isCredentialClass,
  reserveCredentialRotationPlan,
  releaseCredentialRotationPlanExecution,
  showCredentialRotation,
  type CredentialClass,
} from "../../../src/catalogue/credential-rotation";
import type {
  CredentialDeploymentContext,
} from "../../../src/credentials/credential-catalogue.mjs";
import { readBoundedJsonObject } from "../../../src/http/bounded-json";

export async function handleCredentialAdministration(
  request: Request,
  database: D1Database,
  observedAt: string,
  context: CredentialDeploymentContext,
  attestationKey: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const planExecution =
    /^\/v1\/credential-rotation-plans\/([^/]+)\/execution$/.exec(
      url.pathname,
    );
  if (request.method === "POST" && planExecution !== null) {
    const body = await readBody(request);
    assertOnlyFields(body, ["plan_digest"]);
    return Response.json(
      await beginCredentialRotationPlanExecution(
        database,
        decodeURIComponent(planExecution[1]!),
        requiredSha256(body, "plan_digest"),
        observedAt,
      ),
    );
  }
  const planFinalization =
    /^\/v1\/credential-rotation-plans\/([^/]+)\/finalization$/.exec(
      url.pathname,
    );
  if (request.method === "POST" && planFinalization !== null) {
    const body = await readBody(request);
    assertOnlyFields(body, [
      "plan_digest",
      "boundary_attestation",
    ]);
    return Response.json(
      await finalizeCredentialRotationPlan(
        database,
        decodeURIComponent(planFinalization[1]!),
        requiredSha256(body, "plan_digest"),
        requiredString(body, "boundary_attestation"),
        attestationKey,
        observedAt,
      ),
    );
  }
  const planFailure =
    /^\/v1\/credential-rotation-plans\/([^/]+)\/execution-failure$/.exec(
      url.pathname,
    );
  if (request.method === "POST" && planFailure !== null) {
    const body = await readBody(request);
    assertOnlyFields(body, ["plan_digest"]);
    return Response.json(
      await releaseCredentialRotationPlanExecution(
        database,
        decodeURIComponent(planFailure[1]!),
        requiredSha256(body, "plan_digest"),
        observedAt,
      ),
    );
  }
  if (
    request.method === "POST" &&
    url.pathname === "/v1/credential-rotation-plans"
  ) {
    const body = await readBody(request);
    assertOnlyFields(body, [
      "action",
      "rotation_id",
      "credential_class",
      "environment",
      "cloudflare_account_id",
      "resource_identity",
      "owning_boundary",
      "verification_target",
      "expected_catalogue_revision_id",
      "expected_state_generation",
      "old_fingerprint",
      "replacement_fingerprint",
      "old_issuer_credential_id",
      "replacement_issuer_credential_id",
      "management_credential_id",
      "idempotency_key",
    ]);
    return Response.json(
      await reserveCredentialRotationPlan(
        database,
        {
          action: requiredPlanAction(body),
          rotation_id: requiredString(body, "rotation_id"),
          credential_class: requiredCredentialClass(body),
          environment: requiredProduction(body),
          cloudflare_account_id: requiredString(
            body,
            "cloudflare_account_id",
          ),
          resource_identity: requiredString(body, "resource_identity"),
          owning_boundary: requiredString(body, "owning_boundary"),
          verification_target: requiredString(
            body,
            "verification_target",
          ),
          expected_catalogue_revision_id: requiredString(
            body,
            "expected_catalogue_revision_id",
          ),
          expected_state_generation: requiredInteger(
            body,
            "expected_state_generation",
          ),
          old_fingerprint: requiredString(body, "old_fingerprint"),
          replacement_fingerprint: requiredString(
            body,
            "replacement_fingerprint",
          ),
          old_issuer_credential_id: requiredString(
            body,
            "old_issuer_credential_id",
          ),
          replacement_issuer_credential_id: requiredString(
            body,
            "replacement_issuer_credential_id",
          ),
          management_credential_id: requiredString(
            body,
            "management_credential_id",
          ),
          idempotency_key: requiredIdempotencyKey(body),
        },
        context,
        observedAt,
      ),
      { status: 201 },
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

function requiredPlanAction(
  body: Record<string, unknown>,
): "install" | "verify" | "revoke" {
  const action = requiredString(body, "action");
  if (!["install", "verify", "revoke"].includes(action)) {
    throw new CredentialRotationProblem(
      422,
      "invalid_credential_action",
      "action must be install, verify, or revoke.",
    );
  }
  return action as "install" | "verify" | "revoke";
}

function requiredInteger(
  body: Record<string, unknown>,
  field: string,
): number {
  const value = body[field];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new CredentialRotationProblem(
      422,
      "invalid_parameter",
      `${field} must be a non-negative integer.`,
    );
  }
  return value;
}

function requiredSha256(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = requiredString(body, field);
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new CredentialRotationProblem(
      422,
      "invalid_parameter",
      `${field} must be a full SHA-256 digest.`,
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
