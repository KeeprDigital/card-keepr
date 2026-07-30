import {
  beginCredentialRotationPlanExecution,
  consumeCredentialRotationExecutionCapability,
  CredentialRotationProblem,
  finalizeCredentialRotationPlan,
  isCredentialClass,
  issueCredentialBoundaryAttestation,
  reserveCredentialRotationPlan,
  releaseCredentialRotationPlanExecution,
  showCredentialRotation,
  type CredentialClass,
} from "../../../src/catalogue/credential-rotation";
import type {
  CredentialDeploymentContext,
} from "../../../src/credentials/credential-catalogue.mjs";
import { readBoundedJsonObject } from "../../../src/http/bounded-json";
import {
  credentialConsumerProofRequests,
} from "../../../src/credentials/consumer-proof";
import {
  observeGithubCredentialRuns,
} from "./github-credential-observation";
import {
  observeCloudflareCredentialBoundary,
} from "./cloudflare-credential-observation";

export async function handleCredentialExecutionCapability(
  request: Request,
  database: D1Database,
  observedAt: string,
  attestationKey: string,
  consumerProofKey: string,
  cloudflareObservationToken: string,
  githubObservationToken: string,
  githubWorkflowId: string,
  githubObservationActor: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match =
    /^\/v1\/credential-rotation-plans\/([^/]+)\/execution-capability$/.exec(
      url.pathname,
    );
  const attestationMatch =
    /^\/v1\/credential-rotation-plans\/([^/]+)\/boundary-attestation$/.exec(
      url.pathname,
    );
  if (
    request.method !== "POST" ||
    (match === null && attestationMatch === null)
  ) {
    return null;
  }
  const body = await readBody(request);
  if (attestationMatch !== null) {
    assertOnlyFields(body, [
      "plan_digest",
      "execution_attempt",
      "execution_capability",
      "consumer_proofs",
    ]);
    const consumerProofs = body.consumer_proofs;
    if (!Array.isArray(consumerProofs)) {
      throw new CredentialRotationProblem(
        422,
        "invalid_parameter",
        "consumer_proofs must be an array",
      );
    }
    return Response.json({
      contract: "card-keepr-boundary-attestation@1",
      boundary_attestation:
        await issueCredentialBoundaryAttestation(
          database,
          decodeURIComponent(attestationMatch[1]!),
          requiredSha256(body, "plan_digest"),
          requiredInteger(body, "execution_attempt"),
          requiredOwnerToken(body, "execution_capability"),
          consumerProofs,
          attestationKey,
          consumerProofKey,
          observedAt,
          async (plan, expected) => {
            const cloudflare =
              await observeCloudflareCredentialBoundary(
                plan,
                cloudflareObservationToken,
                undefined,
                expected,
              );
            if (cloudflare === null) return null;
            if (
              plan.credential_class !==
                "github_deployment_token"
            ) {
              return cloudflare;
            }
            const github = await observeGithubCredentialRuns(
              plan,
              expected,
              githubObservationToken,
              githubWorkflowId,
              githubObservationActor,
            );
            return github === null
              ? null
              : [...cloudflare, ...github];
          },
        ),
    });
  }
  assertOnlyFields(body, [
    "plan_digest",
    "execution_attempt",
    "execution_capability",
  ]);
  await consumeCredentialRotationExecutionCapability(
    database,
    decodeURIComponent(match![1]!),
    requiredSha256(body, "plan_digest"),
    requiredInteger(body, "execution_attempt"),
    requiredOwnerToken(body, "execution_capability"),
    observedAt,
  );
  return Response.json({
    contract: "card-keepr-credential-execution-capability@1",
    consumed: true,
  });
}

export async function handleCredentialAdministration(
  request: Request,
  database: D1Database,
  observedAt: string,
  context: CredentialDeploymentContext,
  attestationKey: string,
  consumerProofKey: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const planExecution =
    /^\/v1\/credential-rotation-plans\/([^/]+)\/execution$/.exec(
      url.pathname,
    );
  if (request.method === "POST" && planExecution !== null) {
    const body = await readBody(request);
    assertOnlyFields(body, [
      "plan_digest",
      "execution_owner_token",
      "expected_execution_attempt",
    ]);
    const plan = await beginCredentialRotationPlanExecution(
      database,
      decodeURIComponent(planExecution[1]!),
      requiredSha256(body, "plan_digest"),
      requiredOwnerToken(body),
      requiredInteger(body, "expected_execution_attempt"),
      observedAt,
    );
    return Response.json({
      ...plan,
      consumer_proof_requests:
        await credentialConsumerProofRequests(
          plan,
          consumerProofKey,
        ),
    });
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
    assertOnlyFields(body, [
      "plan_digest",
      "execution_owner_token",
      "execution_attempt",
      "mutation_started",
    ]);
    return Response.json(
      await releaseCredentialRotationPlanExecution(
        database,
        decodeURIComponent(planFailure[1]!),
        requiredSha256(body, "plan_digest"),
        requiredOwnerToken(body),
        requiredInteger(body, "execution_attempt"),
        requiredFalse(body, "mutation_started"),
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
      "production_target_identity",
      "expected_catalogue_revision_id",
      "expected_state_generation",
      "old_fingerprint",
      "replacement_fingerprint",
      "old_issuer_credential_id",
      "replacement_issuer_credential_id",
      "management_credential_id",
      "github_management_credential_id",
      "github_management_credential_fingerprint",
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
          production_target_identity: requiredString(
            body,
            "production_target_identity",
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
          github_management_credential_id: requiredString(
            body,
            "github_management_credential_id",
          ),
          github_management_credential_fingerprint: requiredString(
            body,
            "github_management_credential_fingerprint",
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

function requiredOwnerToken(
  body: Record<string, unknown>,
  field = "execution_owner_token",
): string {
  const value = requiredString(body, field);
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new CredentialRotationProblem(
      422,
      "invalid_parameter",
      "execution_owner_token must be a 256-bit opaque token.",
    );
  }
  return value;
}

function requiredFalse(
  body: Record<string, unknown>,
  field: string,
): false {
  if (body[field] !== false) {
    throw new CredentialRotationProblem(
      422,
      "invalid_parameter",
      `${field} must authoritatively be false.`,
    );
  }
  return false;
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
