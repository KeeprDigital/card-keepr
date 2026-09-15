import { readAdministrationBody } from "../../http/administration";
import { verifyStagingWorkflow } from "../../http/dev-workflow-identity.mjs";
import { AdministrationProblem, type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { showStagingRelease, type StagingIntent } from "./staging-release";
import {
  recordStagingProtocolStatement,
  stagingIntentStartingStateGate,
  stagingRecordStatement,
} from "./staging-release-repository";
import { stagingIntentIdentitySchema } from "./platform-http-contract";

export type StagingAuthorization = {
  contract: "card-keepr-staging-authorization@1";
  intent: StagingIntent;
  intent_digest: string;
  workflow_run_id: string;
  workflow_run_attempt: string;
  authorized_at: string;
  preparation_expires_at: string;
  expires_at: string;
};

/** A short-lived signed identity reads/claims only the retained intent; it grants no owner administration. */
export async function handleStagingAuthorization(
  request: Request,
  env: { KEEPR_ENVIRONMENT?: string; CATALOGUE_DB: CatalogueStore },
  at = new Date().toISOString(),
): Promise<Response> {
  if ((env.KEEPR_ENVIRONMENT ?? "production") !== "production" || request.method !== "POST")
    throw new AdministrationProblem(404, "not_found", "Route not found.");
  const body = await readAdministrationBody(request);
  const { releaseId, intentDigest } = stagingIntentIdentity(body);
  const recorded = await showStagingRelease(env.CATALOGUE_DB, releaseId);
  if (recorded.intent_digest !== intentDigest || (await sha256Text(canonicalJson(recorded.intent))) !== intentDigest)
    throw new AdministrationProblem(409, "staging_intent_mismatch", "The exact staging intent does not match.");
  const intent = recorded.intent;
  const key = `staging-claim:${intentDigest}`;
  const existing = await readClaim(env.CATALOGUE_DB, key);
  if (Date.parse(intent.expires_at) <= Date.parse(at) || Date.parse(intent.authorized_at) > Date.parse(at))
    throw new AdministrationProblem(
      409,
      "staging_intent_expired",
      "A new owner intent is required after this authorization expires.",
    );
  let identity: Awaited<ReturnType<typeof verifyStagingWorkflow>>;
  try {
    identity = await verifyStagingWorkflow(
      request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "",
      request.headers.get("x-github-token") ?? "",
      {
        head_sha: intent.expected_head_sha,
        ci_run_id: intent.ci_run_id,
        expected_actor: intent.expected_actor,
      },
      Date.parse(at),
      existing === null,
    );
  } catch {
    throw new AdministrationProblem(
      403,
      "invalid_staging_workflow_attestation",
      "The manual staging workflow identity or selected-commit CI could not be verified.",
    );
  }
  if (existing !== null)
    return Response.json(exactClaim(existing, identity.runId, identity.runAttempt), {
      headers: { "cache-control": "no-store" },
    });
  const authorization: StagingAuthorization = {
    contract: "card-keepr-staging-authorization@1",
    intent,
    intent_digest: intentDigest,
    workflow_run_id: identity.runId,
    workflow_run_attempt: identity.runAttempt,
    authorized_at: at,
    preparation_expires_at: new Date(
      Math.min(Date.parse(at) + 5 * 60_000, Date.parse(intent.expires_at)),
    ).toISOString(),
    expires_at: intent.expires_at,
  };
  try {
    await env.CATALOGUE_DB.batch([
      stagingIntentStartingStateGate(env.CATALOGUE_DB, intent.production_start.migration_level, at),
      recordStagingProtocolStatement(env.CATALOGUE_DB, {
        key,
        operation: "authorize_staging_release",
        request: canonicalJson({ release_id: releaseId, intent_digest: intentDigest }),
        response: canonicalJson(authorization),
        at,
      }),
    ]);
  } catch {
    const concurrent = await readClaim(env.CATALOGUE_DB, key);
    if (concurrent === null)
      throw new AdministrationProblem(409, "staging_start_changed", "Production changed before staging authorization.");
    return Response.json(exactClaim(concurrent, identity.runId, identity.runAttempt), {
      headers: { "cache-control": "no-store" },
    });
  }
  return Response.json(authorization, { status: 201, headers: { "cache-control": "no-store" } });
}

export function stagingIntentIdentity(body: Record<string, unknown>): { releaseId: string; intentDigest: string } {
  const parsed = stagingIntentIdentitySchema.safeParse(body);
  if (!parsed.success)
    throw new AdministrationProblem(
      422,
      "invalid_staging_intent",
      "The exact release identity and intent digest are required.",
    );
  return { releaseId: parsed.data.release_id, intentDigest: parsed.data.intent_digest };
}
async function readClaim(database: CatalogueStore, key: string): Promise<StagingAuthorization | null> {
  const row = await stagingRecordStatement(database, key).first<{ operation: string; response_json: string }>();
  if (row === null) return null;
  if (row.operation !== "authorize_staging_release")
    throw new AdministrationProblem(409, "staging_claim_conflict", "This staging claim belongs to another operation.");
  return JSON.parse(row.response_json) as StagingAuthorization;
}
function exactClaim(claim: StagingAuthorization, runId: string, attempt: string): StagingAuthorization {
  if (claim.workflow_run_id !== runId || claim.workflow_run_attempt !== attempt)
    throw new AdministrationProblem(
      409,
      "staging_claim_conflict",
      "Another workflow attempt already claimed this intent. Inspect it; a fresh attempt requires new owner intent.",
    );
  return claim;
}
