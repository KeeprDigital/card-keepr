import {
  AdministrationProblem,
  type CatalogueStore,
  canonicalJson,
  isReleaseHead,
  isReleaseIdentity,
  sha256Text,
} from "../shared";
import {
  freshBaselineHandoffStatement,
  freshBaselineCorrectionByKeyStatement,
  latestFreshBaselineCorrectionStatement,
  recordFreshBaselineCorrectionStatement,
} from "./fresh-baseline-repository";

/** A new owner approval advances the repair chain without rewriting the cutover. */
export async function resolveFreshBaselineCorrection(
  database: CatalogueStore,
  original: Record<string, unknown>,
  choices: unknown,
  confirmation: unknown,
  preview: boolean,
  observedAt: string,
): Promise<Record<string, unknown>> {
  if (!choices || typeof choices !== "object" || Array.isArray(choices)) invalid();
  const input = choices as Record<string, unknown>;
  if (
    Object.keys(input).sort().join("|") !== "expected_head_sha|idempotency_key" ||
    !isReleaseHead(input.expected_head_sha) ||
    !isReleaseIdentity(input.idempotency_key)
  )
    invalid();
  const digest = String(original.dispatch_digest);
  const prior = await freshBaselineCorrectionByKeyStatement(database, String(input.idempotency_key)).first<{
    request_json: string;
    response_json: string;
  }>();
  let request: Record<string, unknown>, response: Record<string, unknown>;
  if (prior !== null) {
    request = JSON.parse(prior.request_json) as Record<string, unknown>;
    response = JSON.parse(prior.response_json) as Record<string, unknown>;
    if (request.handoff_dispatch_digest !== digest || request.expected_head_sha !== input.expected_head_sha)
      throw new AdministrationProblem(
        409,
        "idempotency_key_reused",
        "This correction key belongs to another exact repair.",
      );
  } else {
    const handoff = await freshBaselineHandoffStatement(database).first<{
      release_id: string;
      dispatch_digest: string;
      role: string;
      phase: number;
    }>();
    if (!handoff || handoff.dispatch_digest !== digest || ![4, 5].includes(handoff.phase))
      throw new AdministrationProblem(
        409,
        "fresh_baseline_correction_not_applicable",
        "A SHA correction requires an unfinished handoff with activation intent.",
      );
    const previous = await latestFreshBaselineCorrectionStatement(database, digest).first<{
      generation: number;
      correction_digest: string;
    }>();
    if ((previous?.generation ?? 0) >= 100)
      throw new AdministrationProblem(
        409,
        "fresh_baseline_correction_limit",
        "The repair approval chain has reached its limit.",
      );
    request = {
      contract: "card-keepr-fresh-baseline-correction@1",
      release_id: original.release_id,
      handoff_dispatch_digest: digest,
      idempotency_key: input.idempotency_key,
      expected_head_sha: input.expected_head_sha,
      generation: (previous?.generation ?? 0) + 1,
      previous_correction_digest: previous?.correction_digest ?? null,
      expected_role: handoff.role,
      expected_phase: handoff.phase,
    };
    const requestJson = canonicalJson(request);
    const correctionDigest = await sha256Text(requestJson);
    response = {
      ...original,
      dispatch_inputs: {
        ...(original.dispatch_inputs as Record<string, string>),
        operation: "correct_fresh_baseline_handoff",
        expected_head_sha: String(input.expected_head_sha),
        correction_json: requestJson,
        correction_digest: correctionDigest,
      },
    };
  }
  const expected = canonicalJson({ operation: "correct_fresh_baseline_handoff", correction: request });
  if (preview)
    return {
      contract: "card-keepr-production-release-confirmation@1",
      release_id: original.release_id,
      confirmation: expected,
    };
  if (confirmation !== expected)
    throw new AdministrationProblem(409, "confirmation_required", `Confirmation must exactly equal ${expected}`);
  if (prior === null) {
    const inputs = response.dispatch_inputs as Record<string, string>;
    try {
      await recordFreshBaselineCorrectionStatement(database, {
        digest: inputs.correction_digest!,
        requestJson: inputs.correction_json!,
        responseJson: canonicalJson(response),
        createdAt: observedAt,
      }).run();
    } catch {
      throw new AdministrationProblem(
        409,
        "fresh_baseline_correction_changed",
        "The handoff or correction predecessor changed before approval. Inspect and confirm again.",
      );
    }
  }
  return response;
}
function invalid(): never {
  throw new AdministrationProblem(
    422,
    "invalid_fresh_baseline_correction",
    "A correction requires a new exact SHA and an idempotency key.",
  );
}
