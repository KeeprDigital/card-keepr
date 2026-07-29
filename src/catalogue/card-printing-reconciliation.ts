import { AdministrationProblem } from "./ingestion";
import { retainedReconciliationObservation } from "./reconciliation-evidence";
import {
  candidateWithIdentities,
  cardIdFor,
  compatibilityFor,
  isCompatible,
  printingIdFor,
} from "./reconciliation-model";
import {
  compatiblePrintings,
  existingCard,
  failReconciliation,
  persistReviewableCandidate,
  printingDisappearanceWarnings,
  printingAtLocator,
  publicReconciledPrinting,
  relationshipDisappearanceWarnings,
} from "./reconciliation-repository";
import { canonicalJson, sha256Text } from "./serialization";

type ActiveRunRow = {
  id: string;
  state: string;
  expected_current_revision_id: string;
  active_ingestion_run_id: string | null;
};

type Diagnostic = {
  code:
    | "printing_match_ambiguous"
    | "printing_match_contradictory"
    | "printing_match_insufficient_evidence"
    | "retained_evidence_invalid";
  source_observation_id: string | null;
  locator: string | null;
  candidate_printing_ids: string[];
  detail: string;
};

export async function reconcileRetainedCardPrintingEvidence(
  database: D1Database,
  evidenceObjects: R2Bucket,
  runId: string,
  observedAt: string,
): Promise<Record<string, unknown>> {
  const run = await requiredActiveParsingRun(database, runId);
  let retained: Awaited<
    ReturnType<typeof retainedReconciliationObservation>
  >;
  try {
    retained = await retainedReconciliationObservation(
      database,
      evidenceObjects,
      runId,
    );
  } catch (error) {
    const diagnostics: Diagnostic[] = [
      {
        code: "retained_evidence_invalid",
        source_observation_id: null,
        locator: null,
        candidate_printing_ids: [],
        detail:
          error instanceof Error
            ? error.message
            : "Retained reconciliation evidence is invalid.",
      },
    ];
    return blockedResult(database, runId, diagnostics, observedAt);
  }

  const observation = retained.observation;
  const existing = await existingCard(database, {
    supportedGame: observation.candidateWithoutIdentities.card.game,
    identityKind:
      observation.candidateWithoutIdentities.card.official_identity.kind,
    identityValue:
      observation.candidateWithoutIdentities.card.official_identity.value,
  });
  const cardId =
    existing?.id ??
    (await cardIdFor(observation.candidateWithoutIdentities.card));
  const compatibility = compatibilityFor(
    cardId,
    retained.sourceLineage,
    observation,
  );
  const [located, matches] = await Promise.all([
    printingAtLocator(
      database,
      retained.sourceLineage,
      observation.locator,
    ),
    compatiblePrintings(database, compatibility),
  ]);

  let printingId: string;
  const diagnostics: Diagnostic[] = [];
  if (located !== null && !isCompatible(located, compatibility)) {
    diagnostics.push({
      code: "printing_match_contradictory",
      source_observation_id: observation.sourceObservationId,
      locator: observation.locator,
      candidate_printing_ids: [located.id],
      detail:
        "The retained locator contradicts the Card, Source Lineage, artwork, printed rules, rarity, or treatment of its existing Printing.",
    });
    printingId = located.id;
  } else if (matches.length > 1) {
    diagnostics.push({
      code: "printing_match_ambiguous",
      source_observation_id: observation.sourceObservationId,
      locator: observation.locator,
      candidate_printing_ids: matches.map((match) => match.id),
      detail:
        "The retained evidence has more than one exactly compatible Printing.",
    });
    printingId = matches[0]!.id;
  } else if (located !== null) {
    printingId = located.id;
  } else if (matches.length === 1) {
    printingId = matches[0]!.id;
  } else if (
    !observation.demonstrablyNovel ||
    observation.noveltyBasis === null
  ) {
    diagnostics.push({
      code: "printing_match_insufficient_evidence",
      source_observation_id: observation.sourceObservationId,
      locator: observation.locator,
      candidate_printing_ids: [],
      detail:
        "A complete zero-match can create a Printing only with retained evidence that its appearance is demonstrably novel.",
    });
    printingId = await printingIdFor(compatibility);
  } else {
    printingId = await printingIdFor(compatibility);
  }

  if (diagnostics.length > 0) {
    return blockedResult(database, runId, diagnostics, observedAt);
  }

  const candidate = candidateWithIdentities(
    observation,
    cardId,
    printingId,
  );
  const [relationshipWarnings, disappearanceWarnings] = await Promise.all([
    relationshipDisappearanceWarnings(
      database,
      printingId,
      observation.memberships,
    ),
    printingDisappearanceWarnings(
      database,
      retained.sourceLineage,
      printingId,
    ),
  ]);
  const warnings = [
    ...observation.vocabularyWarnings,
    ...relationshipWarnings,
    ...disappearanceWarnings,
  ].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
  const candidateDigest = await sha256Text(
    canonicalJson({
      catalogue_data: candidate,
      printing_identity_evidence: compatibility,
      locator: observation.locator,
      memberships: observation.memberships,
      withdrawal: observation.withdrawal,
    }),
  );
  await persistReviewableCandidate(database, {
    runId,
    observationSetId: retained.observationSetId,
    sourceSnapshotId: retained.sourceSnapshotId,
    sourceObservationId: observation.sourceObservationId,
    sourceLineage: retained.sourceLineage,
    locator: observation.locator,
    compatibility,
    memberships: observation.memberships,
    withdrawal: observation.withdrawal,
    warnings,
    candidate,
    candidateDigest,
    observedAt,
  });
  return {
    contract: "card-keepr-card-printing-reconciliation@2",
    run_id: runId,
    state: "awaiting_approval",
    publishable: true,
    candidate_digest: candidateDigest,
    expected_current_revision_id: run.expected_current_revision_id,
    source_observation_set_id: retained.observationSetId,
    cards: candidate.cards,
    printings: candidate.printings,
    diagnostics: [],
    warnings,
  };
}

export async function showReconciledPrinting(
  database: D1Database,
  printingId: string,
): Promise<Record<string, unknown>> {
  const printing = await publicReconciledPrinting(database, printingId);
  if (printing === null) {
    throw new AdministrationProblem(
      404,
      "printing_not_found",
      "The reconciled Printing does not exist in a published Catalogue Revision.",
    );
  }
  return {
    contract: "card-keepr-reconciled-printing@1",
    ...printing,
  };
}

async function blockedResult(
  database: D1Database,
  runId: string,
  diagnostics: readonly Diagnostic[],
  observedAt: string,
): Promise<Record<string, unknown>> {
  const stable = [...diagnostics].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
  await failReconciliation(database, runId, stable, observedAt);
  return {
    contract: "card-keepr-card-printing-reconciliation@2",
    run_id: runId,
    state: "failed",
    publishable: false,
    cards: [],
    printings: [],
    diagnostics: stable,
    warnings: [],
  };
}

async function requiredActiveParsingRun(
  database: D1Database,
  runId: string,
): Promise<ActiveRunRow> {
  const row = await database
    .prepare(
      `SELECT run.id, run.state, run.expected_current_revision_id,
              operation.active_ingestion_run_id
       FROM ingestion_runs AS run
       JOIN operation_state AS operation ON operation.singleton = 1
       WHERE run.id = ?`,
    )
    .bind(runId)
    .first<ActiveRunRow>();
  if (
    row === null ||
    row.state !== "parsing" ||
    row.active_ingestion_run_id !== runId
  ) {
    throw new AdministrationProblem(
      409,
      "run_not_active",
      "Only the active parsing Ingestion Run can reconcile retained evidence.",
    );
  }
  return row;
}
