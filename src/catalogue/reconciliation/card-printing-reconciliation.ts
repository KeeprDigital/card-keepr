import { prepareNativeSourceHistory } from "./native-source-history";
import { type CheckedCardScope } from "./scoped-disappearance";
import {
  nativePrintingMatches,
  nativePrintingsAtLocator,
  nativePrintingLocatorKey,
  nativePrintingLocatorStateKey,
  retainPrintingLocator,
} from "./native-printing-locators";
import {
  nativePreparationFailureCode,
  type NativePreparationGuardState,
  failIndependentGamePreparation,
  independentGamePreparationResult,
} from "./game-reconciliation-outcome";
import {
  type CanonicalRecordSource,
  canonicalRecordSource,
  prepareCanonicalDigest,
} from "./reconciliation-canonical-digest";
import { prepareSemanticState } from "./reconciliation-semantic-state";
import { applyPinnedIdentityCorrectionsToDraft } from "./identity-correction-application";
import { prepareCuratedDraft, prepareCuratedConflictDiagnostics } from "./reconciliation-curated";
import { prepareInitialWarnings } from "./reconciliation-initial-warnings";
import { prepareDisappearanceWarnings } from "./reconciliation-disappearance";
import { prepareOfficialCandidate, omitUndefinedValues } from "./reconciliation-official-assembly";
import { prepareWithdrawalDiagnostics } from "./reconciliation-withdrawals";
import {
  reconciliationCheckpoint,
  retainReconciliationCheckpoint,
  prepareCheckpointReadWindow,
} from "./reconciliation-checkpoint";
import type { NativePrintingIdentity } from "./prior-state-types";
import { candidateAtRevision, type PriorStatePositions } from "./reconciliation-prior-state";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { ReconciliationRecordCollection } from "./reconciliation-record-collection";
import { ReconciliationSortedRecords } from "./reconciliation-sorted-records";
import { ReconciliationPlanState, type ObservationPlan } from "./reconciliation-plan-state";
import { ReconciliationRecordLog } from "./reconciliation-record-log";
import { ReconciliationErrataState } from "./reconciliation-errata-state";
import { ReconciliationCandidateState } from "./reconciliation-candidate-state";
import { ReconciliationCardState } from "./reconciliation-card-state";
import { ReconciliationReducerIndex, ReconciliationReducerStorageError } from "./reconciliation-reducer-state";
import {
  ReconciliationInputStorageError,
  verifiedReconciliationRecordEntries,
  scannedReconciliationRecordEntries,
  type ReconciliationInputRecordCursor,
} from "./reconciliation-input";
import { CandidateImageStorageError } from "./reconciliation-images";
import { productReleaseHasNoRelationships } from "./product-release-catalogue";
import { initializeReconciliationProgress } from "./reconciliation-progress";
import { reconciliationWriterGuard } from "./reconciliation-progress-repository";
import { pinCorrectionDecisions, pinnedCardIdentityResolver } from "./identity-correction-pins";
import {
  assessSourceAdmission,
  completeSourceAdmission,
  publisherConfirmation,
  publisherLineage,
} from "./entity-admission-source";
import { pinEntityAdmissions, applyPinnedEntityAdmissions } from "./entity-admission-pins";
import {
  allocateCanonicalIdentity,
  retainSourceMappings,
  boundedSourceMapping,
  type SourceMapping,
  matchingIdentityDecision,
} from "./canonical-identity";
import {
  CuratedDraftSourceChangeError,
  CuratedDraftInvalidError,
  CuratedConflictStorageError,
  restoreCuratedEntitySourceFields,
} from "../curated";
import {
  AdministrationProblem,
  guardedCatalogueStore,
  assertIngestionRunTransition,
  type CatalogueCandidate,
  type CatalogueErratum,
  type CataloguePrinting,
  type CataloguePrintingImage,
  type CatalogueStore,
  canonicalJson,
  catalogueCandidateContract,
  type IngestionRunState,
  type SupportedGame,
} from "../shared";
import { type DigimonCardAuthority, reconcileDigimonCardAuthority } from "./digimon-reconciliation";
import {
  canonicalErratum,
  deriveEffectiveRulesText,
  ErratumRulesTextError,
  identifyRulesTextErrata,
  mergeCatalogueErrata,
} from "./errata-rules-text";
import { reconcileProductReleaseState, type ProductInputEntry } from "./product-release-state";
import {
  failReconciliation,
  persistBlockedCandidate,
  persistReviewableCandidate,
  retainedReconciliationResult,
} from "./reconciliation-candidate-store";
import { retainedReconciliationObservation, type NormalizedReconciliationObservation } from "./reconciliation-evidence";
import {
  compatibilityFor,
  hasCrossSourceArtworkEvidence,
  isCompatible,
  type PrintingCompatibility,
} from "./reconciliation-model";
import { publicReconciledPrinting } from "./reconciliation-read";
import {
  activeParsingRunStatement,
  errataProvenanceByIdsStatement,
  reconciliationRunStateStatement,
} from "./reconciliation-read-repository";
import {
  gundamPrintingLineages,
  canonicalCardConflict,
  canonicalPrintingConflict,
  compatiblePrintings,
  crossSourcePrintingCandidates,
  existingCard,
  publishedCardPresentStatement,
  gundamCardLineages,
  gundamPrintingHasProductMembership,
  printingAtLocatorVariant,
  printingFactsFormattingEquivalent,
  printingsAtLocator,
  printingsWithAppearance,
} from "./reconciliation-repository";

type ActiveRunRow = {
  id: string;
  state: IngestionRunState;
  selected_games_json: string;
  expected_current_revision_id: string;
  active_ingestion_run_id: string | null;
  recovery_health: string;
  supported_game: string | null;
  preparation_state: string | null;
};

type Diagnostic = {
  code:
    | "printing_match_ambiguous"
    | "printing_match_contradictory"
    | "printing_match_insufficient_evidence"
    | "canonical_card_conflict"
    | "withdrawal_evidence_conflict"
    | "retained_evidence_invalid";
  source_observation_id: string | null;
  locator: string | null;
  matched_printing_ids: string[];
  detail: string;
};

type OfficialReductionCursor = {
  prior: PriorStatePositions;
  priorCandidate: CatalogueCandidate | null;
  input: Record<string, unknown>;
  indexes: Record<string, number>;
  mappings: number;
  warnings: { position: number; count: number };
  diagnostics: { position: number; count: number };
  admissions: { cards: number; printings: number };
  cardCheckTimes: [SupportedGame, string][];
  productCheckTimes: [SupportedGame, string][];
  errataCheckTimes?: [SupportedGame, string][];
  productGames: SupportedGame[];
  publishedCardGames?: SupportedGame[];
  after: ReconciliationInputRecordCursor | null;
  processedObservations: number;
  pendingSourceWarning: number | null;
  dedicatedErrata: number;
  hasWithdrawals: boolean;
  complete: boolean;
  errataAfter?: ReconciliationInputRecordCursor | null;
  processedErrata?: number;
  errataComplete?: boolean;
  errataChecksAfter?: ReconciliationInputRecordCursor | null;
  errataChecksComplete?: boolean;
};

export async function reconcileRetainedCardPrintingEvidence(
  database: CatalogueStore,
  evidenceObjects: R2Bucket,
  runId: string,
  observedAt: string,
  printingImageObjects: R2Bucket,
  generation = 0,
  yieldAtCheckpoint = false,
): Promise<Record<string, unknown>> {
  const replay = await finalizedReconciliationResult(database, runId, generation);
  if (replay !== null) return replay;
  const run = await requiredActiveParsingRun(database, runId);
  await initializeReconciliationProgress(database, runId, observedAt);
  const base = database;
  database = guardedCatalogueStore(base, () => reconciliationWriterGuard(base, runId, generation));
  const errataReduction = await reconciliationCheckpoint<OfficialReductionCursor>(database, runId, "official_errata");
  const reduction =
    errataReduction ?? (await reconciliationCheckpoint<OfficialReductionCursor>(database, runId, "official_reduction"));
  if (errataReduction?.value.errataComplete && yieldAtCheckpoint) {
    await prepareCheckpointReadWindow(database, runId, [
      ...errataReduction.value.productGames.map((game) => `product_reduction:${game}`),
      "withdrawal_diagnostics",
      "official_assembly",
      "disappearance_warnings",
      "curated_revisions",
      "semantic_preparation",
      "record_sorting:warning_records_sorted",
      "canonical_digest:catalogue",
      "canonical_digest:candidate",
      "source_mappings",
      "candidate_partitions",
      "game_preparation",
    ]);
  }
  let retained: Awaited<ReturnType<typeof retainedReconciliationObservation>>;
  try {
    retained = await retainedReconciliationObservation(
      database,
      evidenceObjects,
      runId,
      printingImageObjects,
      yieldAtCheckpoint,
      reduction?.value.input,
    );
  } catch (error) {
    if (error instanceof ReconciliationContinuation) return { continuation: error.checkpoint };
    if (isStorageOrCapacityFailure(error)) throw error;
    const diagnostics: Diagnostic[] = [
      {
        code: "retained_evidence_invalid",
        source_observation_id: null,
        locator: null,
        matched_printing_ids: [],
        detail: error instanceof Error ? error.message : "Retained reconciliation evidence is invalid.",
      },
    ];
    return blockedResult(database, runId, diagnostics, observedAt);
  }

  const diagnostics = new ReconciliationRecordCollection<Diagnostic>(database, runId, "diagnostic_records", false);
  const localGundamCardLineages = new ReconciliationReducerIndex<("gundam-en-asia" | "gundam-en-us")[]>(
    database,
    runId,
    "gundam_card_lineages",
  );
  const localGundamPrintingProvenance = new ReconciliationReducerIndex<("gundam-en-asia" | "gundam-en-us")[]>(
    database,
    runId,
    "gundam_printing_lineages",
  );
  const localGundamProducts = new ReconciliationReducerIndex<string[]>(database, runId, "gundam_products");
  const localPrintingCompatibility = new ReconciliationReducerIndex<{
    printingId: string;
    compatibility: PrintingCompatibility;
  }>(database, runId, "printing_compatibility", ({ compatibility }) => compatibilityGroup(compatibility));
  const cards = new ReconciliationCardState(database, runId, "cards");
  const priorCards = new ReconciliationCardState(database, runId, "prior_cards");
  const printings = new ReconciliationReducerIndex<CataloguePrinting>(
    database,
    runId,
    "printings",
    (printing) => printing.card_id,
  );
  const priorPrintings = new ReconciliationReducerIndex<CataloguePrinting>(
    database,
    runId,
    "prior_printings",
    (printing) => printing.card_id,
  );
  const priorPrintingIdentities = new ReconciliationReducerIndex<NativePrintingIdentity>(
    database,
    runId,
    "prior_printing_identities",
    (identity) => identity.compatibility.card_id,
  );
  const priorPrintingLocators = new ReconciliationReducerIndex<NativePrintingIdentity>(
    database,
    runId,
    "prior_printing_locators",
    (identity) => nativePrintingLocatorKey(identity.locators[0]!),
  );
  const printingImages = new ReconciliationReducerIndex<CataloguePrintingImage>(database, runId, "printing_images");
  const selectedGames = JSON.parse(run.selected_games_json) as SupportedGame[];
  const priorErrata = new ReconciliationErrataState(database, runId, "prior_errata");
  const currentErrata = new ReconciliationErrataState(database, runId, "current_errata");
  const observedErrata = new ReconciliationErrataState(database, runId, "observed_errata");
  const retainObservedErrata = async (records: readonly CatalogueErratum[]) => {
    for (const record of records) {
      await observedErrata.merge(record);
      await currentErrata.merge(record);
    }
  };
  const priorProducts = new ReconciliationCandidateState(database, runId, "prior_products");
  const priorPositions = () => ({
    cards: cards.position,
    priorCards: priorCards.position,
    printings: printings.position,
    priorPrintings: priorPrintings.position,
    priorPrintingIdentities: priorPrintingIdentities.position,
    priorPrintingLocators: priorPrintingLocators.position,
    printingImages: printingImages.position,
    priorProducts: priorProducts.positions,
    priorErrata: priorErrata.position,
    currentErrata: currentErrata.position,
  });
  const restorePriorPositions = (positions: PriorStatePositions) => {
    cards.resumeAt(positions.cards);
    priorCards.resumeAt(positions.priorCards);
    printings.resumeAt(positions.printings);
    priorPrintings.resumeAt(positions.priorPrintings);
    priorPrintingIdentities.resumeAt(positions.priorPrintingIdentities ?? 0);
    priorPrintingLocators.resumeAt(positions.priorPrintingLocators ?? 0);
    printingImages.resumeAt(positions.printingImages);
    priorProducts.resumeAt(positions.priorProducts);
    priorErrata.resumeAt(positions.priorErrata);
    currentErrata.resumeAt(positions.currentErrata);
  };
  let priorCandidate: CatalogueCandidate | null;
  try {
    priorCandidate = reduction
      ? reduction.value.priorCandidate
      : await candidateAtRevision(
          database,
          run.expected_current_revision_id,
          selectedGames,
          {
            card: async (card) => {
              if (selectedGames.includes(card.game)) restoreCuratedEntitySourceFields(card);
              await priorCards.seed(card);
              await cards.seed(card);
            },
            printing: async (printing, identity) => {
              const card = await priorCards.get(printing.card_id);
              if (card && selectedGames.includes(card.game)) restoreCuratedEntitySourceFields(printing);
              await priorPrintings.seed(printing.id, printing);
              await printings.seed(printing.id, printing);
              if (identity) await priorPrintingIdentities.seed(printing.id, identity);
            },
            printingLocator: async (identity) => {
              await priorPrintingLocators.seed(nativePrintingLocatorStateKey(identity), identity);
            },
            image: async (image) => {
              await printingImages.seed(image.id, image);
            },
            product: async (product) => {
              if (selectedGames.includes(product.game)) {
                restoreCuratedEntitySourceFields(product);
                for (const release of product.releases) restoreCuratedEntitySourceFields(release);
              }
              await priorProducts.set("products", product);
            },
            context: async (context) => {
              if (selectedGames.includes(context.game)) restoreCuratedEntitySourceFields(context);
              await priorProducts.set("distribution_contexts", context);
            },
            relationship: async (relationship) => {
              if (selectedGames.includes(relationship.game)) {
                if (relationship.evidence_category === "curated") return;
                const reviewed = relationship.curated_provenance?.at(-1)?.reviewed_source_value;
                delete relationship.curated_provenance;
                if (reviewed === "present" || reviewed === "absent") relationship.observed = reviewed === "present";
              }
              await priorProducts.set("product_relationships", relationship);
            },
            correction: async (correction) => {
              await priorProducts.set("identity_corrections", correction);
            },
            erratum: async (erratum) => {
              if (selectedGames.includes(erratum.game)) restoreCuratedEntitySourceFields(erratum);
              let provenance: D1Result<{ source_lineage: string; source_observation_id: string; total: number }>;
              try {
                provenance = await errataProvenanceByIdsStatement(database, canonicalJson([erratum.id])).all();
              } catch (cause) {
                throw new ReconciliationReducerStorageError(cause);
              }
              if ((provenance.results[0]?.total ?? 0) > 500)
                throw new Error("reconciliation_capacity_exceeded: one Erratum has too many provenance records.");
              const restored = mergeCatalogueErrata(
                [erratum],
                [
                  {
                    ...erratum,
                    provenance: provenance.results.map(({ source_lineage, source_observation_id }) => ({
                      source_lineage,
                      source_observation_id,
                    })),
                  },
                ],
              )[0]!;
              await priorErrata.merge(restored);
              await currentErrata.merge(restored);
            },
          },
          { runId, capture: priorPositions, restore: restorePriorPositions, yieldAtCheckpoint },
        );
  } catch (error) {
    if (error instanceof ReconciliationContinuation) return { continuation: error.checkpoint };
    throw error;
  }
  const sourceMappings = new ReconciliationRecordLog<SourceMapping>(database, runId, "source_mappings");
  const localCardFacts = new ReconciliationReducerIndex<string>(database, runId, "card_facts");
  const localDigimonCardAuthorities = new ReconciliationReducerIndex<DigimonCardAuthority>(
    database,
    runId,
    "digimon_authorities",
  );
  const localPrintingFacts = new ReconciliationReducerIndex<Omit<CataloguePrinting, "id" | "card_id">>(
    database,
    runId,
    "printing_facts",
  );
  const localCompatibility = new ReconciliationReducerIndex<string>(database, runId, "compatibility");
  const localLocators = new ReconciliationReducerIndex<{ compatibility: PrintingCompatibility; printingId: string }>(
    database,
    runId,
    "locators",
  );
  const plans = new ReconciliationPlanState(database, runId);
  const sourceWarnings = new ReconciliationRecordCollection<Record<string, unknown>>(
    database,
    runId,
    "warning_records",
  );
  if (!reduction) {
    try {
      await prepareInitialWarnings(database, runId, sourceWarnings, yieldAtCheckpoint);
    } catch (error) {
      if (error instanceof ReconciliationContinuation) return { continuation: error.checkpoint };
      throw error;
    }
  }
  const evidenceGames = new Set<SupportedGame>();
  const evidenceLineages = new Set<string>();
  const completeLineages = new Set<string>();
  const checkedCardScopes: CheckedCardScope[] = [];
  const ownerReviewedPrintingLineages = new Set<string>();
  let errataOnlyEvidence = true;
  const evidencePlanSnapshot: unknown[] = [];
  for await (const plan of retained.evidencePlans) {
    evidencePlanSnapshot.push(plan);
    evidenceGames.add(plan.supportedGame);
    evidenceLineages.add(plan.sourceLineage);
    if (plan.printingAdmission === "owner_review") ownerReviewedPrintingLineages.add(plan.sourceLineage);
    if ((plan.subset ?? "complete") === "complete") completeLineages.add(plan.sourceLineage);
    if (plan.reconciliationCapability !== "errata") {
      errataOnlyEvidence = false;
      if (plan.cardIdentities?.length) checkedCardScopes.push({ ...plan, cardIdentities: plan.cardIdentities });
    }
  }
  if (!reduction) await pinCorrectionDecisions(database, runId, JSON.parse(run.selected_games_json) as string[]);
  let correctedCardIdentity: Awaited<ReturnType<typeof pinnedCardIdentityResolver>>;
  try {
    correctedCardIdentity = await pinnedCardIdentityResolver(database, runId, yieldAtCheckpoint);
  } catch (error) {
    if (error instanceof ReconciliationContinuation) return { continuation: error.checkpoint };
    throw error;
  }
  if (!reduction) {
    try {
      await pinEntityAdmissions(database, runId, JSON.parse(run.selected_games_json) as string[], yieldAtCheckpoint);
    } catch (error) {
      if (error instanceof ReconciliationContinuation) return { continuation: error.checkpoint };
      throw error;
    }
  }
  let admittedEntities: Awaited<ReturnType<typeof applyPinnedEntityAdmissions>>;
  try {
    admittedEntities = await applyPinnedEntityAdmissions(database, runId, cards, printings, sourceWarnings, {
      cursor: reduction?.value.admissions,
      yieldAtCheckpoint,
    });
  } catch (error) {
    if (error instanceof ReconciliationContinuation) return { continuation: error.checkpoint };
    throw error;
  }
  const targetedCardIds = new ReconciliationReducerIndex<boolean>(database, runId, "erratum_target_cards");
  const targetedPrintingIds = new ReconciliationReducerIndex<boolean>(database, runId, "erratum_target_printings");
  const cardCheckTimes = new Map<SupportedGame, string>(reduction?.value.cardCheckTimes);
  const productCheckTimes = new Map<SupportedGame, string>(reduction?.value.productCheckTimes);
  const errataCheckTimes = new Map<SupportedGame, string>(reduction?.value.errataCheckTimes);
  const productGames = new Set<SupportedGame>(reduction?.value.productGames);
  const publishedCardGames = reduction ? (reduction.value.publishedCardGames ?? selectedGames) : [];
  if (!reduction) {
    // Pin only existence, including withdrawn identities. The preparation's
    // head fence prevents publication from changing this absence observation.
    for (const game of selectedGames)
      if (
        await documentStorage(() =>
          publishedCardPresentStatement(database, game, runId, run.expected_current_revision_id).first(),
        )
      )
        publishedCardGames.push(game);
  }
  type RetainedObservation = NormalizedReconciliationObservation;
  const reductionIndexes = {
    localGundamCardLineages,
    localGundamPrintingProvenance,
    localGundamProducts,
    localPrintingCompatibility,
    localCardFacts,
    localDigimonCardAuthorities,
    localPrintingFacts,
    localCompatibility,
    localLocators,
    plans,
    observedErrata,
    targetedCardIds,
    targetedPrintingIds,
  };
  if (reduction) {
    restorePriorPositions(reduction.value.prior);
    for (const [name, index] of Object.entries(reductionIndexes)) index.resumeAt(reduction.value.indexes[name]!);
    sourceMappings.resumeAt(reduction.value.mappings);
    sourceWarnings.resumeAt(reduction.value.warnings);
    diagnostics.resumeAt(reduction.value.diagnostics);
  }
  let sourceHistory: Awaited<ReturnType<typeof prepareNativeSourceHistory>>;
  try {
    sourceHistory = await prepareNativeSourceHistory(database, runId, false, yieldAtCheckpoint);
  } catch (error) {
    if (error instanceof ReconciliationContinuation) return { continuation: error.checkpoint };
    throw error;
  }
  let reductionOrdinal = (reduction?.ordinal ?? -1) + 1;
  let processedObservations = reduction?.value.processedObservations ?? 0;
  let pendingSourceWarning = reduction?.value.pendingSourceWarning ?? null;
  let dedicatedErrata = reduction?.value.dedicatedErrata ?? 0;
  let hasWithdrawals = reduction?.value.hasWithdrawals ?? false;
  const saveReduction = async (
    after: ReconciliationInputRecordCursor | null,
    complete: boolean,
    errata?: {
      errataAfter: ReconciliationInputRecordCursor | null;
      processedErrata: number;
      errataComplete: boolean;
      errataChecksAfter: ReconciliationInputRecordCursor | null;
      errataChecksComplete: boolean;
    },
  ) => {
    const phase = errata ? "official_errata" : "official_reduction";
    const mappings = await sourceMappings.checkpoint();
    await retainReconciliationCheckpoint(database, runId, phase, reductionOrdinal, {
      prior: priorPositions(),
      priorCandidate,
      input: {
        observationSetId: retained.observationSetId,
        sourceSnapshotId: retained.sourceSnapshotId,
        sourceLineage: retained.sourceLineage,
        supportedGame: retained.supportedGame,
        reconciliationCapability: retained.reconciliationCapability,
        structurallyComplete: retained.structurallyComplete,
        ...(retained.hasCardErrata === undefined ? {} : { hasCardErrata: retained.hasCardErrata }),
        evidencePlans: evidencePlanSnapshot,
      },
      indexes: Object.fromEntries(Object.entries(reductionIndexes).map(([name, index]) => [name, index.position])),
      mappings,
      warnings: sourceWarnings.cursor,
      diagnostics: diagnostics.cursor,
      admissions: admittedEntities.cursor,
      cardCheckTimes: [...cardCheckTimes],
      productCheckTimes: [...productCheckTimes],
      errataCheckTimes: [...errataCheckTimes],
      productGames: [...productGames],
      publishedCardGames,
      after,
      processedObservations,
      pendingSourceWarning,
      dedicatedErrata,
      hasWithdrawals,
      complete,
      ...errata,
    } satisfies OfficialReductionCursor);
    return { continuation: { phase, ordinal: reductionOrdinal++ } };
  };
  if (!reduction) {
    const next = await saveReduction(null, false);
    if (yieldAtCheckpoint) return next;
  }

  if (!reduction?.value.complete) {
    let inUnit = 0;
    let bytes = 0;
    let after = reduction?.value.after ?? null;
    for await (const {
      value: observation,
      cursor,
      byteLength,
    } of verifiedReconciliationRecordEntries<NormalizedReconciliationObservation>(
      database,
      runId,
      "observations",
      after,
    )) {
      if (observation.kind === "card_printing" && observation.errata.length > 8)
        throw new Error("reconciliation_capacity_exceeded: one observation contains more than eight Errata.");
      const work =
        observation.kind === "card_printing" &&
        (observation.sourceWarnings.length > 1 ||
          observation.errata.length > 0 ||
          retained.hasCardErrata === true ||
          observation.observedCardAndPrinting.card?.official_identity.kind === "unknown")
          ? 16
          : observation.kind === "card_printing" && observation.observedCardAndPrinting.card !== null
            ? observation.observedCardAndPrinting.printing === null
              ? observation.sourceWarnings.length
                ? 3
                : 2
              : 8
            : 1;
      if (inUnit > 0 && (inUnit + work > 16 || bytes + byteLength > 512000)) {
        const next = await saveReduction(after, false);
        if (yieldAtCheckpoint) return next;
        inUnit = 0;
        bytes = 0;
      }
      const resumingWarnings = pendingSourceWarning !== null;
      observationUnit: {
        if (resumingWarnings) break observationUnit;
        if (observation.kind !== "card_printing") break observationUnit;
        productGames.add(observation.supportedGame);
        for (const index of [
          cards,
          printings,
          printingImages,
          localCardFacts,
          localDigimonCardAuthorities,
          localPrintingFacts,
          localCompatibility,
          localLocators,
          localPrintingCompatibility,
          localGundamCardLineages,
          localGundamPrintingProvenance,
          localGundamProducts,
        ])
          index.beginObservation();
        let identityMatchWork = 0;
        const consumeIdentityMatch = () => {
          if (++identityMatchWork > 8)
            throw new Error(
              "reconciliation_capacity_exceeded: one observation requires too many nested identity matches.",
            );
        };
        const sourceCard = observation.observedCardAndPrinting.card;
        for (const checks of [
          ...(sourceCard === null ? [] : [cardCheckTimes]),
          ...(observation.productReleaseValue === undefined ? [] : [productCheckTimes]),
        ]) {
          if ((checks.get(observation.supportedGame) ?? "") < observation.sourceCapturedAt)
            checks.set(observation.supportedGame, observation.sourceCapturedAt);
        }
        if (sourceCard === null) {
          pendingSourceWarning = 0;
          break observationUnit;
        }
        if (sourceCard.game !== observation.supportedGame) {
          await diagnostics.push({
            code: "retained_evidence_invalid",
            source_observation_id: observation.sourceObservationId,
            locator: observation.locator,
            matched_printing_ids: [],
            detail: "The retained Card Supported Game conflicts with its provenance envelope.",
          });
          break observationUnit;
        }
        const admission = await assessSourceAdmission(database, runId, observation, observedAt, {
          printingAdmission: ownerReviewedPrintingLineages.has(observation.sourceLineage)
            ? "owner_review"
            : "source_qualification",
        });
        if (admission?.identityExceptionConflict) {
          await diagnostics.push({
            code: "canonical_card_conflict",
            source_observation_id: observation.sourceObservationId,
            locator: observation.locator,
            matched_printing_ids: admission.decision?.printing ? [admission.decision.printing.id] : [],
            detail:
              "New source evidence contradicts the identity established by an owner admission exception. Resolve the identity conflict before publication.",
          });
          break observationUnit;
        }
        if (admission && !admission.permitted) {
          await sourceWarnings.push({
            code: "entity_proposal_excluded",
            game: observation.supportedGame,
            proposal_id: admission.proposal.id,
            source_observation_id: observation.sourceObservationId,
            detail: `Entity Proposal ${admission.proposal.id} is ${admission.rejected ? "owner-rejected" : "unresolved"}; its Card and Printing observation is isolated from this candidate.`,
          });
          break observationUnit;
        }
        const existing =
          sourceCard.official_identity.kind === "unknown" || !publishedCardGames.includes(sourceCard.game)
            ? null
            : await existingCard(database, {
                supportedGame: sourceCard.game,
                identityKind: sourceCard.official_identity.kind,
                identityValue: sourceCard.official_identity.value,
              });
        const localOfficialCards =
          sourceCard.official_identity.kind === "unknown"
            ? []
            : await cards.sameOfficialIdentity(sourceCard.game, sourceCard.official_identity);
        const canConfirmPublisherNumber =
          sourceCard.official_identity.kind !== "unknown" &&
          publisherLineage(observation.sourceLineage) &&
          existing === null &&
          localOfficialCards.length === 0;
        const exactUnnumberedCards =
          sourceCard.official_identity.kind === "unknown" || canConfirmPublisherNumber
            ? await cards.sameFacts(sourceCard, canConfirmPublisherNumber)
            : [];
        let unnumberedCard: (typeof exactUnnumberedCards)[number] | undefined;
        let reviewedCardPrintingId: string | null = null;
        if (exactUnnumberedCards.length > 0) {
          const printing = observation.observedCardAndPrinting.printing;
          const candidates: Pick<CataloguePrinting, "id" | "card_id">[] = [];
          if (printing !== null)
            for (const card of exactUnnumberedCards) {
              consumeIdentityMatch();
              for await (const candidate of printings.matchingBeforeObservation(card.id, {
                records: 8,
                bytes: 512000,
              })) {
                consumeIdentityMatch();
                if (
                  printingFactsFormattingEquivalent(
                    {
                      rarity: candidate.rarity,
                      printed_rules_text: candidate.printed_rules_text,
                      game_data: candidate.game_data,
                    },
                    printing,
                  )
                ) {
                  if (candidates.length === 500)
                    throw new Error(
                      "reconciliation_capacity_exceeded: one Card identity has too many Printing candidates.",
                    );
                  candidates.push({ id: candidate.id, card_id: candidate.card_id });
                }
              }
            }
          const provenCards: typeof exactUnnumberedCards = [];
          if (printing !== null) {
            const locator = observation.locator;
            if (locator === null) throw new Error("A Printing observation has no locator.");
            for (const card of exactUnnumberedCards) {
              consumeIdentityMatch();
              const expected = compatibilityFor(card.id, observation.sourceLineage, observation);
              const nativeMatches = await nativePrintingMatches(
                database,
                {
                  preparationId: runId,
                  revision: run.expected_current_revision_id,
                  game: observation.supportedGame,
                  through: priorPrintingIdentities.position,
                  locatorThrough: priorPrintingLocators.position,
                },
                expected,
                { locator, variantKey: observation.variantKey, reviewed: false },
              );
              const [located, compatible] =
                nativeMatches ??
                (await Promise.all([
                  printingAtLocatorVariant(database, observation.sourceLineage, locator, observation.variantKey),
                  compatiblePrintings(database, expected),
                ]));
              const local: PrintingCompatibility[] = [];
              for await (const match of localPrintingCompatibility.matchingBeforeObservation(
                compatibilityGroup(expected),
                { records: 8, bytes: 512000 },
              )) {
                consumeIdentityMatch();
                if (isCompatible(match.compatibility, expected)) local.push(match.compatibility);
              }
              const mapped = located !== null && isCompatible(located, expected);
              if (
                mapped ||
                (observation.artworkIdentityExplicit &&
                  [...compatible, ...local].some(
                    (value) =>
                      value.source_lineage === observation.sourceLineage || hasCrossSourceArtworkEvidence(observation),
                  ))
              )
                provenCards.push(card);
            }
          }
          if (provenCards.length === 1) unnumberedCard = provenCards[0];
          else {
            reviewedCardPrintingId =
              candidates.length === 0
                ? null
                : await matchingIdentityDecision(database, {
                    runId,
                    sourceLineage: observation.sourceLineage,
                    sourceObservationId: observation.sourceObservationId,
                    sourceSnapshotId: observation.sourceSnapshotId,
                    evidence: {
                      card: sourceCard,
                      printing,
                      locator: observation.locator,
                      variant_key: observation.variantKey,
                      artwork_fingerprint: observation.artworkFingerprint,
                      printed_fields_digest: observation.printedFieldsDigest,
                      treatment: observation.treatment,
                    },
                    candidates: candidates.map(({ id }) => id).sort(),
                    at: observedAt,
                  });
            if (reviewedCardPrintingId)
              unnumberedCard = exactUnnumberedCards.find(
                (card) => card.id === candidates.find(({ id }) => id === reviewedCardPrintingId)!.card_id,
              );
            else {
              await diagnostics.push({
                code: "canonical_card_conflict",
                source_observation_id: observation.sourceObservationId,
                locator: observation.locator,
                matched_printing_ids: candidates.map(({ id }) => id),
                detail:
                  "Equal Card facts without a publisher number identify candidates, not equivalence. Resolve the retained identity review before publication.",
              });
              // Diagnostic-only provisional association; no mapping is persisted and
              // the blocked candidate cannot publish.
              unnumberedCard = exactUnnumberedCards[0];
            }
          }
        }
        // Missing incoming evidence cannot erase an already established publisher number.
        const confirmedPublisherNumber = canConfirmPublisherNumber && unnumberedCard !== undefined;
        const proposedCard =
          unnumberedCard && sourceCard.official_identity.kind === "unknown"
            ? { ...sourceCard, official_identity: (await cards.get(unnumberedCard.id))!.official_identity }
            : sourceCard;
        const cardId =
          admission?.decision?.card.id ??
          existing?.id ??
          localOfficialCards[0]?.id ??
          unnumberedCard?.id ??
          (await allocateCanonicalIdentity(
            database,
            "card",
            [
              proposedCard.game,
              proposedCard.official_identity,
              ...(proposedCard.official_identity.kind === "unknown"
                ? [observation.sourceLineage, observation.locator ?? observation.sourceObservationId]
                : []),
            ],
            runId,
            observedAt,
          ));
        const matchingStandaloneErrata: Extract<RetainedObservation, { kind: "official_erratum" }>[] = [];
        for await (const erratum of retained.cardErrata(proposedCard.game, proposedCard.official_identity))
          matchingStandaloneErrata.push(erratum);
        const currentCardErrata = (
          await Promise.all([
            identifyRulesTextErrata({
              game: proposedCard.game,
              cardId,
              printingId: null,
              sourceLineage: observation.sourceLineage,
              sourceObservationId: observation.sourceObservationId,
              errata: observation.errata.filter((erratum) => erratum.targetType === "card"),
            }),
            ...matchingStandaloneErrata.map((erratum) =>
              identifyRulesTextErrata({
                game: proposedCard.game,
                cardId,
                printingId: null,
                sourceLineage: erratum.sourceLineage,
                sourceObservationId: erratum.sourceObservationId,
                errata: [
                  {
                    targetType: "card" as const,
                    effectiveFrom: erratum.effectiveFrom,
                    officialWording: erratum.officialWording,
                    correctedValue: erratum.correctedRulesText,
                  },
                ],
              }),
            ),
          ])
        ).flat();
        await retainObservedErrata(currentCardErrata);
        const currentEffectiveAuthority = currentCardErrata.some(
          (erratum) => erratum.effective_from === null || erratum.effective_from <= observedAt.slice(0, 10),
        );
        if (
          proposedCard.official_identity.kind === "functional_designation" &&
          proposedCard.official_identity.value === "DON!!"
        ) {
          await sourceWarnings.push({
            code: "printing_coverage_incomplete",
            card_id: cardId,
            detail:
              "Known DON!! Printing evidence is retained when present, but Official Source coverage is incomplete and absence never proves zero Printings.",
          });
        }
        // With no published or admitted identities, an unmatched publisher
        // number cannot have earlier local facts: accepted numbered Cards are
        // indexed by that exact identity, and unknown observations never erase it.
        const newPublisherIdentity =
          proposedCard.official_identity.kind !== "unknown" &&
          !publishedCardGames.includes(proposedCard.game) &&
          admittedEntities.cursor.cards === 0 &&
          admission === null &&
          localOfficialCards.length === 0 &&
          unnumberedCard === undefined;
        const carriedCard = newPublisherIdentity ? undefined : await cards.get(cardId);
        if (observation.sourceLineage === "gundam-en-asia" || observation.sourceLineage === "gundam-en-us") {
          await addGundamLineage(localGundamCardLineages, cardId, observation.sourceLineage);
        }
        const retainAsiaAuthority =
          proposedCard.game === "gundam" &&
          observation.sourceLineage === "gundam-en-us" &&
          carriedCard !== undefined &&
          ((await gundamCardLineages(database, cardId, sourceHistory?.prior)).some(
            ({ source_lineage, current }) => source_lineage === "gundam-en-asia" && current === 1,
          ) ||
            (await localGundamCardLineages.get(cardId))?.includes("gundam-en-asia") === true);
        let acceptedCard = proposedCard;
        if (retainAsiaAuthority) {
          const { id: _carriedId, ...authoritativeCard } = carriedCard;
          acceptedCard = fillAuthorityGaps(authoritativeCard, proposedCard);
        }
        const proposedForComparison = {
          ...proposedCard,
          effective_rules_text: currentEffectiveAuthority
            ? proposedCard.effective_rules_text
            : deriveEffectiveRulesText(
                { id: cardId, ...proposedCard },
                await priorErrata.forCard(proposedCard.game, cardId),
                observedAt,
              ),
        };
        const publishedConflict = publishedCardGames.includes(proposedCard.game)
          ? await canonicalCardConflict(
              database,
              cardId,
              proposedForComparison,
              observation.sourceLineage,
              {
                effectiveRulesText: currentEffectiveAuthority,
                confirmedPublisherNumber,
              },
              sourceHistory ? { history: sourceHistory.prior, card: await priorCards.get(cardId) } : undefined,
            )
          : null;
        let acceptedCanonicalCard = acceptedCard;
        try {
          acceptedCanonicalCard = {
            ...acceptedCard,
            effective_rules_text: deriveEffectiveRulesText(
              { id: cardId, ...acceptedCard },
              await currentErrata.forCard(acceptedCard.game, cardId),
              observedAt,
            ),
          };
        } catch (error) {
          if (isStorageOrCapacityFailure(error)) throw error;
          // Final candidate derivation below is the single diagnostic authority.
        }
        let digimonAuthorityConflict: string | null = null;
        if (proposedCard.game === "digimon") {
          const priorAuthority = await localDigimonCardAuthorities.get(cardId);
          const proposedIsBaseRecord = observation.variantKey === "base";
          if (priorAuthority === undefined) {
            await localDigimonCardAuthorities.set(cardId, {
              card: acceptedCanonicalCard,
              hasBaseRecord: proposedIsBaseRecord,
            });
          } else {
            const resolution = reconcileDigimonCardAuthority(
              priorAuthority,
              acceptedCanonicalCard,
              proposedIsBaseRecord,
              {
                effectiveRulesText: currentEffectiveAuthority ? "official_errata" : "source_consensus",
              },
            );
            if (resolution.kind === "conflict") {
              digimonAuthorityConflict = resolution.detail;
            } else {
              acceptedCanonicalCard = resolution.authority.card;
              await localDigimonCardAuthorities.set(cardId, resolution.authority);
            }
          }
        }
        const canonicalFacts = canonicalJson(acceptedCanonicalCard);
        const priorFacts = newPublisherIdentity ? undefined : await localCardFacts.get(cardId);
        if (
          publishedConflict !== null ||
          digimonAuthorityConflict !== null ||
          (proposedCard.game !== "digimon" &&
            priorFacts !== undefined &&
            priorFacts !== canonicalFacts &&
            !(
              confirmedPublisherNumber &&
              priorFacts ===
                canonicalJson({ ...acceptedCanonicalCard, official_identity: { kind: "unknown", value: null } })
            ) &&
            !retainAsiaAuthority)
        ) {
          await diagnostics.push({
            code: "canonical_card_conflict",
            source_observation_id: observation.sourceObservationId,
            locator: observation.locator,
            matched_printing_ids: [],
            detail:
              publishedConflict ??
              digimonAuthorityConflict ??
              "Retained observations disagree on canonical Card facts and no deterministic authority rule resolves them.",
          });
        } else {
          await cards.set(
            cardId,
            { id: cardId, ...acceptedCanonicalCard },
            {
              index: localCardFacts,
              value: canonicalFacts,
            },
          );
        }

        let compatibility: PrintingCompatibility | null = null;
        let printingId: string | null = null;
        const proposedPrinting = observation.observedCardAndPrinting.printing;
        if (proposedPrinting !== null) {
          compatibility = compatibilityFor(cardId, observation.sourceLineage, observation);
          const locator = observation.locator;
          if (locator === null) {
            throw new Error("A Printing observation has no locator.");
          }
          const compatibilityKey = canonicalJson(compatibility);
          const locatorVariantKey = canonicalJson([observation.sourceLineage, locator, observation.variantKey]);
          const localLocated = await localLocators.get(locatorVariantKey);
          // A pinned admission already resolves identity. Keep exact locator and
          // canonical-fact checks, without spending the ambiguous-match budget
          // scanning every other appearance of this Card.
          let reviewedPrintingId: string | null = admission?.decision?.printing?.id ?? reviewedCardPrintingId;
          const nativeMatches = await nativePrintingMatches(
            database,
            {
              preparationId: runId,
              revision: run.expected_current_revision_id,
              game: observation.supportedGame,
              through: priorPrintingIdentities.position,
              locatorThrough: priorPrintingLocators.position,
            },
            compatibility,
            { locator, variantKey: observation.variantKey, reviewed: reviewedPrintingId !== null },
          );
          const [located, unfilteredDatabaseMatches, appearanceMatches, crossSourceCandidates] =
            nativeMatches ??
            (await Promise.all([
              printingAtLocatorVariant(database, observation.sourceLineage, locator, observation.variantKey),
              reviewedPrintingId === null ? compatiblePrintings(database, compatibility) : Promise.resolve([]),
              reviewedPrintingId === null ? printingsWithAppearance(database, compatibility) : Promise.resolve([]),
              reviewedPrintingId !== null || observation.supportedGame === "gundam"
                ? Promise.resolve([])
                : crossSourcePrintingCandidates(database, compatibility),
            ]));
          const databaseMatches = unfilteredDatabaseMatches;
          const matchIds = new Set(databaseMatches.map((match) => match.id));
          if (reviewedPrintingId === null) {
            const localMatch = await localCompatibility.get(compatibilityKey);
            if (localMatch !== undefined) matchIds.add(localMatch);
            for await (const match of localPrintingCompatibility.matchingBeforeObservation(
              compatibilityGroup(compatibility),
              { records: 8, bytes: 512000 },
            )) {
              consumeIdentityMatch();
              if (isCompatible(match.compatibility, compatibility)) matchIds.add(match.printingId);
            }
          }
          const unprovenCrossSourceAppearance =
            matchIds.size === 0 && located === null && localLocated === undefined && crossSourceCandidates.length > 0;
          if (unprovenCrossSourceAppearance) crossSourceCandidates.forEach(({ id }) => matchIds.add(id));
          const crossSourceMatches: string[] = [];
          for (const id of matchIds) {
            consumeIdentityMatch();
            const matched =
              databaseMatches.find((match) => match.id === id) ??
              (await localPrintingCompatibility.get(id))?.compatibility;
            if (matched && matched.source_lineage !== observation.sourceLineage) crossSourceMatches.push(id);
          }
          const insufficientCrossSource =
            unprovenCrossSourceAppearance ||
            (observation.supportedGame !== "gundam" &&
              crossSourceMatches.length > 0 &&
              !hasCrossSourceArtworkEvidence(observation));
          if (
            located === null &&
            localLocated === undefined &&
            reviewedPrintingId === null &&
            (insufficientCrossSource || matchIds.size > 1) &&
            !(await diagnostics.hasObservation(observation.sourceObservationId, "canonical_card_conflict"))
          ) {
            reviewedPrintingId = await matchingIdentityDecision(database, {
              runId,
              sourceLineage: observation.sourceLineage,
              sourceObservationId: observation.sourceObservationId,
              sourceSnapshotId: observation.sourceSnapshotId,
              evidence: {
                locator,
                variant_key: observation.variantKey,
                card: proposedCard,
                printing: proposedPrinting,
                compatibility,
              },
              candidates: [...matchIds].sort(),
              at: observedAt,
            });
          }
          const crossLocaleMatches: string[] = [];
          const corroboratedCrossLocaleMatches: string[] = [];
          if (observation.supportedGame === "gundam") {
            for (const matchId of matchIds) {
              consumeIdentityMatch();
              const observedLineages = new Set([
                ...(await gundamPrintingLineages(database, matchId, sourceHistory?.prior)).map(
                  ({ source_lineage }) => source_lineage,
                ),
                ...((await localGundamPrintingProvenance.get(matchId)) ?? []),
              ]);
              if (
                !observedLineages.size ||
                observedLineages.has(observation.sourceLineage as "gundam-en-asia" | "gundam-en-us")
              )
                continue;
              crossLocaleMatches.push(matchId);
              const localProducts = new Set((await localGundamProducts.get(matchId)) ?? []);
              if (
                observation.memberships.products.some((product) => localProducts.has(product)) ||
                (await gundamPrintingHasProductMembership(
                  database,
                  matchId,
                  observation.memberships.products,
                  sourceHistory?.prior,
                ))
              )
                corroboratedCrossLocaleMatches.push(matchId);
            }
          }
          const uncorroboratedCrossLocaleMatches = crossLocaleMatches.filter(
            (matchId) => !corroboratedCrossLocaleMatches.includes(matchId),
          );
          uncorroboratedCrossLocaleMatches.forEach((matchId) => matchIds.delete(matchId));
          const missingProductCorroboration = uncorroboratedCrossLocaleMatches.length > 0 && matchIds.size === 0;
          let locatedConflict: boolean;
          try {
            locatedConflict =
              (located !== null &&
                !isCompatible(
                  { ...located, card_id: await correctedCardIdentity(located.card_id, located.id) },
                  { ...compatibility, card_id: await correctedCardIdentity(compatibility.card_id, located.id) },
                )) ||
              (localLocated !== undefined &&
                !isCompatible(
                  {
                    ...localLocated.compatibility,
                    card_id: await correctedCardIdentity(localLocated.compatibility.card_id, localLocated.printingId),
                  },
                  {
                    ...compatibility,
                    card_id: await correctedCardIdentity(compatibility.card_id, localLocated.printingId),
                  },
                ));
          } catch (error) {
            if (error instanceof ReconciliationContinuation) return { continuation: error.checkpoint };
            throw error;
          }
          if (locatedConflict) {
            const locatedId = located?.id ?? localLocated!.printingId;
            await diagnostics.push({
              code: "printing_match_contradictory",
              source_observation_id: observation.sourceObservationId,
              locator,
              matched_printing_ids: [locatedId],
              detail:
                "The retained locator contradicts the Card, Source Lineage, artwork, printed rules, rarity, or treatment of its existing Printing.",
            });
            printingId = locatedId;
          } else if (located !== null || localLocated !== undefined) {
            printingId = located?.id ?? localLocated!.printingId;
          } else if (reviewedPrintingId !== null) {
            printingId = reviewedPrintingId;
          } else if (insufficientCrossSource) {
            printingId = [...matchIds].sort()[0]!;
            await diagnostics.push({
              code: "printing_match_insufficient_evidence",
              source_observation_id: observation.sourceObservationId,
              locator,
              matched_printing_ids: [...matchIds].sort(),
              detail:
                "Equal source-local artwork labels do not establish cross-source Printing identity. Inspect and resolve the retained identity review.",
            });
          } else if (missingProductCorroboration) {
            printingId = [...uncorroboratedCrossLocaleMatches].sort()[0]!;
            await diagnostics.push({
              code: "printing_match_insufficient_evidence",
              source_observation_id: observation.sourceObservationId,
              locator,
              matched_printing_ids: [...uncorroboratedCrossLocaleMatches].sort(),
              detail:
                "Cross-locale Gundam Printing evidence requires a corroborating Product membership before two locale observations can merge.",
            });
          } else if (
            !observation.artworkIdentityExplicit &&
            located === null &&
            localLocated === undefined &&
            matchIds.size > 0
          ) {
            printingId = [...matchIds].sort()[0]!;
            await diagnostics.push({
              code: "printing_match_insufficient_evidence",
              source_observation_id: observation.sourceObservationId,
              locator,
              matched_printing_ids: [...matchIds].sort(),
              detail:
                "A new Printing locator without an explicit Official Source artwork identity cannot be matched to an existing compatible Printing.",
            });
          } else if (matchIds.size > 1) {
            await diagnostics.push({
              code: "printing_match_ambiguous",
              source_observation_id: observation.sourceObservationId,
              locator,
              matched_printing_ids: [...matchIds].sort(),
              detail: "The retained evidence has more than one exactly compatible Printing.",
            });
            printingId = [...matchIds].sort()[0]!;
          } else if (matchIds.size === 1) {
            printingId = [...matchIds][0]!;
          } else {
            printingId = await allocateCanonicalIdentity(database, "printing", compatibility, runId, observedAt);
            if (appearanceMatches.length > 0) {
              await diagnostics.push({
                code: "printing_match_contradictory",
                source_observation_id: observation.sourceObservationId,
                locator,
                matched_printing_ids: appearanceMatches.map(({ id }) => id),
                detail:
                  "The claimed novel appearance already exists with materially incompatible rules, rarity, lineage, or treatment evidence.",
              });
            } else if (
              !observation.demonstrablyNovel ||
              !observation.structurallyComplete ||
              !observation.noveltyProofComplete
            ) {
              await diagnostics.push({
                code: "printing_match_insufficient_evidence",
                source_observation_id: observation.sourceObservationId,
                locator,
                matched_printing_ids: [],
                detail:
                  "A zero-match requires structurally complete retained adapter evidence and complete official Printing Image proof of a demonstrably novel appearance.",
              });
            }
          }
          await localCompatibility.set(compatibilityKey, printingId);
          await localPrintingCompatibility.set(printingId, { printingId, compatibility });
          await localLocators.set(locatorVariantKey, { compatibility, printingId });
          if (observation.sourceLineage === "gundam-en-asia" || observation.sourceLineage === "gundam-en-us") {
            await addGundamLineage(localGundamPrintingProvenance, printingId, observation.sourceLineage);
            await addGundamProducts(localGundamProducts, printingId, observation.memberships.products);
          }
          const carriedPrinting = await printings.get(printingId);
          const publishedPrintingConflict = await canonicalPrintingConflict(
            database,
            printingId,
            proposedPrinting,
            observation.sourceLineage,
            sourceHistory
              ? { history: sourceHistory.prior, printing: await priorPrintings.get(printingId) }
              : undefined,
          );
          const retainAsiaPrintingAuthority =
            observation.supportedGame === "gundam" &&
            observation.sourceLineage === "gundam-en-us" &&
            carriedPrinting !== undefined &&
            ((await gundamPrintingLineages(database, printingId, sourceHistory?.prior)).some(
              ({ source_lineage, current }) => source_lineage === "gundam-en-asia" && current === 1,
            ) ||
              (await localGundamPrintingProvenance.get(printingId))?.includes("gundam-en-asia") === true);
          let acceptedPrinting = proposedPrinting;
          if (retainAsiaPrintingAuthority) {
            const { id: _carriedPrintingId, card_id: _carriedCardId, ...authoritativePrinting } = carriedPrinting;
            acceptedPrinting = fillAuthorityGaps(authoritativePrinting, proposedPrinting);
          }
          const priorPrintingFacts = await localPrintingFacts.get(printingId);
          // Reviewed identity permits complementary source facts, not competing
          // known values. Symmetric gap filling makes this independent of source
          // observation order and keeps explicit unknowns from erasing facts.
          const complementaryReviewedFacts =
            reviewedPrintingId !== null &&
            priorPrintingFacts !== undefined &&
            printingFactsFormattingEquivalent(
              fillAuthorityGaps(priorPrintingFacts, acceptedPrinting),
              fillAuthorityGaps(acceptedPrinting, priorPrintingFacts),
            );
          if (complementaryReviewedFacts) acceptedPrinting = fillAuthorityGaps(priorPrintingFacts!, acceptedPrinting);
          if (
            publishedPrintingConflict !== null ||
            (priorPrintingFacts !== undefined &&
              !retainAsiaPrintingAuthority &&
              !complementaryReviewedFacts &&
              !printingFactsFormattingEquivalent(priorPrintingFacts, acceptedPrinting))
          ) {
            await diagnostics.push({
              code: "printing_match_contradictory",
              source_observation_id: observation.sourceObservationId,
              locator,
              matched_printing_ids: [printingId],
              detail:
                publishedPrintingConflict ??
                "Retained observations disagree on canonical Printing facts and no deterministic authority rule resolves them.",
            });
          } else {
            await localPrintingFacts.set(printingId, acceptedPrinting);
            await printings.set(printingId, {
              id: printingId,
              card_id: cardId,
              ...acceptedPrinting,
              ...(run.supported_game !== null
                ? {
                    locator_evidence: retainPrintingLocator(await printings.get(printingId), {
                      source_lineage: observation.sourceLineage,
                      locator,
                      variant_key: observation.variantKey,
                      source_observation_id: observation.sourceObservationId,
                    }),
                  }
                : {}),
            });
          }
          if (observation.printingImages.length > 500)
            throw new Error("reconciliation_capacity_exceeded: one Printing has too many images.");
          const pendingImages = new Map<string, CataloguePrintingImage>();
          for (const image of observation.printingImages) {
            const id =
              `printing_image_${printingId.slice("printing_".length)}_` +
              `${image.role}_${image.content_sha256.slice(0, 12)}`;
            const observedImage: CataloguePrintingImage = {
              id,
              printing_id: printingId,
              object_key: `printing-images/${image.content_sha256}`,
              ...image,
            };
            const existingImage = pendingImages.get(id) ?? (await printingImages.get(id));
            if (existingImage !== undefined && !printingImageEvidenceEquivalent(existingImage, observedImage)) {
              await diagnostics.push({
                code: "retained_evidence_invalid",
                source_observation_id: observation.sourceObservationId,
                locator,
                matched_printing_ids: [printingId],
                detail: "A Printing Image identity maps to conflicting immutable bytes or metadata.",
              });
            } else {
              pendingImages.set(
                id,
                existingImage === undefined
                  ? observedImage
                  : {
                      ...existingImage,
                      source_url:
                        existingImage.source_url.localeCompare(observedImage.source_url) <= 0
                          ? existingImage.source_url
                          : observedImage.source_url,
                    },
              );
            }
          }
          for (const [id, image] of pendingImages) await printingImages.set(id, image);
        } else if (!observation.structurallyComplete) {
          await diagnostics.push({
            code: "printing_match_insufficient_evidence",
            source_observation_id: observation.sourceObservationId,
            locator: null,
            matched_printing_ids: [],
            detail: "The Card-only retained observation is not structurally complete.",
          });
        }
        if (admission && !(await diagnostics.hasObservation(observation.sourceObservationId))) {
          await completeSourceAdmission(
            database,
            runId,
            admission,
            (await cards.get(cardId))!,
            printingId ? (await printings.get(printingId))! : null,
            observedAt,
          );
          await sourceWarnings.push({
            code: "entity_admission",
            proposal_id: admission.proposal.id,
            card_id: cardId,
            printing_id: printingId,
            detail: `Entity Proposal ${admission.proposal.id} admitted; source evidence and authority remain separate from publisher confirmation.`,
          });
        }
        for (const [kind, entityId] of [
          ["card", cardId],
          ["printing", printingId],
        ] as const) {
          if (entityId === null || (await diagnostics.hasObservation(observation.sourceObservationId))) continue;
          const mapping: SourceMapping = {
            entityId,
            kind,
            runId: run.id,
            sourceObservationId: observation.sourceObservationId,
            sourceLineage: observation.sourceLineage,
            sourceSnapshotId: observation.sourceSnapshotId,
            sourceObservationSetId: observation.sourceObservationSetId,
            locator: observation.locator,
            variantKey: observation.variantKey,
            evidenceJson: canonicalJson({
              card: observation.observedCardAndPrinting.card,
              printing: proposedPrinting,
              compatibility,
              publisher_confirmation: publisherConfirmation(
                observation.sourceLineage,
                kind === "card" ? observation.observedCardAndPrinting.card : proposedPrinting,
                kind === "card" ? await cards.get(cardId) : printingId ? await printings.get(printingId) : null,
              ),
            }),
            mappedAt: observedAt,
          };
          await sourceMappings.append(await boundedSourceMapping(mapping));
        }
        await plans.append({
          sourceObservationSetId: observation.sourceObservationSetId,
          sourceSnapshotId: observation.sourceSnapshotId,
          sourceObservationId: observation.sourceObservationId,
          sourceLineage: observation.sourceLineage,
          supportedGame: observation.supportedGame,
          observationKind: "card_printing",
          cardId,
          printingId,
          locator: observation.locator,
          variantKey: observation.variantKey,
          compatibility,
          memberships: observation.memberships,
          sourceCardFactsJson: canonicalJson(proposedCard),
          withdrawal:
            observation.withdrawal === null
              ? null
              : {
                  ...observation.withdrawal,
                  assertion: observation.withdrawal.state,
                  source_lineage: observation.sourceLineage,
                  source_snapshot_id: observation.sourceSnapshotId,
                  source_observation_set_id: observation.sourceObservationSetId,
                  source_observation_id: observation.sourceObservationId,
                },
        });
        try {
          await retainObservedErrata(
            await identifyRulesTextErrata({
              game: proposedCard.game,
              cardId,
              printingId,
              sourceLineage: observation.sourceLineage,
              sourceObservationId: observation.sourceObservationId,
              errata: observation.errata.filter((erratum) => erratum.targetType === "printing"),
            }),
          );
        } catch (error) {
          if (isStorageOrCapacityFailure(error)) throw error;
          await diagnostics.push({
            code: "retained_evidence_invalid",
            source_observation_id: observation.sourceObservationId,
            locator: observation.locator,
            matched_printing_ids: printingId === null ? [] : [printingId],
            detail: error instanceof ErratumRulesTextError ? error.message : "Retained Erratum evidence is invalid.",
          });
        }
        pendingSourceWarning = 0;
      }
      if (pendingSourceWarning !== null && observation.kind === "card_printing") {
        if (!resumingWarnings && observation.sourceWarnings.length > 8) {
          const next = await saveReduction(after, false);
          if (yieldAtCheckpoint) return next;
        }
        let warningCount = 0;
        let warningBytes = 0;
        while (pendingSourceWarning < observation.sourceWarnings.length) {
          const warning = observation.sourceWarnings[pendingSourceWarning]!;
          const size = new TextEncoder().encode(canonicalJson(warning)).byteLength;
          if (warningCount > 0 && (warningCount === 8 || warningBytes + size > 512000)) {
            const next = await saveReduction(after, false);
            if (yieldAtCheckpoint) return next;
            warningCount = 0;
            warningBytes = 0;
          }
          await sourceWarnings.push(warning);
          pendingSourceWarning++;
          warningCount++;
          warningBytes += size;
        }
        pendingSourceWarning = null;
      }
      processedObservations++;
      if (observation.kind === "official_erratum") dedicatedErrata++;
      else if (observation.withdrawal !== null) hasWithdrawals = true;
      after = cursor;
      inUnit += work;
      bytes += byteLength;
      if (inUnit === 16 || bytes >= 512000) {
        const next = await saveReduction(after, false);
        if (yieldAtCheckpoint) return next;
        inUnit = 0;
        bytes = 0;
      }
    }
    const next = await saveReduction(after, true);
    if (yieldAtCheckpoint) return next;
  }

  if (!errataReduction?.value.errataComplete) {
    reductionOrdinal = (errataReduction?.ordinal ?? -1) + 1;
    let after = errataReduction?.value.errataAfter ?? null;
    let processedErrata = errataReduction?.value.processedErrata ?? 0;
    let scanned = 0;
    let reduced = 0;
    let bytes = 0;
    let errataChecksAfter = errataReduction?.value.errataChecksAfter ?? null;
    let errataChecksComplete = errataReduction?.value.errataChecksComplete ?? false;
    const saveErrata = (complete: boolean) =>
      saveReduction(reduction?.value.after ?? null, true, {
        errataAfter: after,
        processedErrata,
        errataComplete: complete,
        errataChecksAfter,
        errataChecksComplete,
      });
    // A successful Errata surface check still counts when its retained record set is empty.
    // Scan the frozen partition receipts through the same bounded durable phase.
    if (!errataChecksComplete) {
      let checked = 0,
        checkedBytes = 0;
      for await (const entry of verifiedReconciliationRecordEntries<{
        supportedGame: SupportedGame;
        capturedAt?: string;
        reconciliationCapability?: string;
      }>(database, runId, "partitions", errataChecksAfter)) {
        if (checked > 0 && (checked === 8 || checkedBytes + entry.byteLength > 512000)) {
          const next = await saveErrata(false);
          if (yieldAtCheckpoint) return next;
          checked = 0;
          checkedBytes = 0;
        }
        const receipt = entry.value;
        if (
          receipt.reconciliationCapability === "errata" &&
          receipt.capturedAt &&
          (errataCheckTimes.get(receipt.supportedGame) ?? "") < receipt.capturedAt
        )
          errataCheckTimes.set(receipt.supportedGame, receipt.capturedAt);
        checked++;
        checkedBytes += entry.byteLength;
        errataChecksAfter = entry.cursor;
      }
      errataChecksComplete = true;
      const next = await saveErrata(false);
      if (yieldAtCheckpoint) return next;
    }
    if (dedicatedErrata > 0)
      for await (const entry of scannedReconciliationRecordEntries<
        Extract<RetainedObservation, { kind: "official_erratum" }>
      >(database, runId, "observations", after, (value) => value.kind === "official_erratum")) {
        if (scanned > 0 && bytes + entry.byteLength > 512000) {
          const next = await saveErrata(false);
          if (yieldAtCheckpoint) return next;
          scanned = 0;
          reduced = 0;
          bytes = 0;
        }
        const observation = entry.value;
        erratumUnit: {
          if (observation === null) break erratumUnit;
          if ((errataCheckTimes.get(observation.supportedGame) ?? "") < observation.sourceCapturedAt)
            errataCheckTimes.set(observation.supportedGame, observation.sourceCapturedAt);
          if (observation.target.type === "card" && !observation.appliesToParallelPrintings) {
            await diagnostics.push({
              code: "retained_evidence_invalid",
              source_observation_id: observation.sourceObservationId,
              locator: observation.sourceLocator,
              matched_printing_ids: [],
              detail: "A non-parallel Official Erratum must target exactly one Printing.",
            });
            break erratumUnit;
          }
          const matchingCards = [
            ...new Map(
              [
                ...(await cards.sameOfficialIdentity(observation.game, observation.target.officialIdentity, true)),
                ...(await priorCards.sameOfficialIdentity(observation.game, observation.target.officialIdentity, true)),
              ].map((card) => [card.id, card]),
            ).values(),
          ];
          if (matchingCards.length !== 1) {
            await diagnostics.push({
              code: "retained_evidence_invalid",
              source_observation_id: observation.sourceObservationId,
              locator: observation.sourceLocator,
              matched_printing_ids: [],
              detail:
                matchingCards.length === 0
                  ? "Official Erratum evidence does not resolve one Card in the expected published Catalogue Revision."
                  : "Official Erratum evidence resolves more than one Card in the expected published Catalogue Revision.",
            });
            break erratumUnit;
          }
          const card = (await priorCards.get(matchingCards[0]!.id)) ?? (await cards.get(matchingCards[0]!.id))!;
          await targetedCardIds.seed(card.id, true);
          let targetPrintingId: string | null = null;
          if (observation.target.type === "printing") {
            const located =
              (await nativePrintingsAtLocator(
                database,
                {
                  preparationId: runId,
                  revision: run.expected_current_revision_id,
                  game: observation.game,
                  cardId: card.id,
                  through: priorPrintings.position,
                },
                observation.sourceLineage,
                observation.target.locator,
              )) ?? (await printingsAtLocator(database, observation.sourceLineage, observation.target.locator));
            const publishedById = new Map<string, CataloguePrinting>();
            for (const locatedPrinting of located) {
              const published = await priorPrintings.get(locatedPrinting.id);
              if (published?.card_id === card.id) publishedById.set(published.id, published);
            }
            const publishedPrintings = [...publishedById.values()];
            if (publishedPrintings.length !== 1) {
              await diagnostics.push({
                code: "retained_evidence_invalid",
                source_observation_id: observation.sourceObservationId,
                locator: observation.target.locator,
                matched_printing_ids: publishedPrintings.map((printing) => printing.id).sort(),
                detail:
                  "Official Erratum evidence does not resolve exactly one Printing of the Card in the expected published Catalogue Revision.",
              });
              break erratumUnit;
            }
            const publishedPrinting = publishedPrintings[0]!;
            targetPrintingId = publishedPrinting.id;
            await targetedPrintingIds.seed(publishedPrinting.id, true);
          }
          try {
            await retainObservedErrata(
              await identifyRulesTextErrata({
                game: observation.game,
                cardId: card.id,
                printingId: targetPrintingId,
                sourceLineage: observation.sourceLineage,
                sourceObservationId: observation.sourceObservationId,
                errata: [
                  {
                    targetType: observation.target.type,
                    effectiveFrom: observation.effectiveFrom,
                    officialWording: observation.officialWording,
                    correctedValue: observation.correctedRulesText,
                  },
                ],
              }),
            );
            await plans.append({
              sourceObservationSetId: observation.sourceObservationSetId,
              sourceSnapshotId: observation.sourceSnapshotId,
              sourceObservationId: observation.sourceObservationId,
              sourceLineage: observation.sourceLineage,
              supportedGame: observation.supportedGame,
              observationKind: "official_erratum",
              cardId: card.id,
              printingId: targetPrintingId,
              locator: null,
              variantKey: null,
              compatibility: null,
              sourceCardFactsJson: null,
              memberships: {
                products: [],
                distribution_contexts: [],
                source_buckets: [],
              },
              withdrawal: null,
            });
          } catch (error) {
            if (isStorageOrCapacityFailure(error)) throw error;
            await diagnostics.push({
              code: "retained_evidence_invalid",
              source_observation_id: observation.sourceObservationId,
              locator: observation.sourceLocator,
              matched_printing_ids: [],
              detail: error instanceof Error ? error.message : "Retained Official Erratum evidence is invalid.",
            });
          }
        }
        after = entry.cursor;
        scanned++;
        if (observation !== null) {
          reduced++;
          processedErrata++;
        }
        bytes += entry.byteLength;
        if (scanned >= 500 || reduced >= 2 || bytes >= 512000) {
          const next = await saveErrata(false);
          if (yieldAtCheckpoint) return next;
          scanned = 0;
          reduced = 0;
          bytes = 0;
        }
      }
    const next = await saveErrata(true);
    if (yieldAtCheckpoint) return next;
  }

  try {
    await prepareWithdrawalDiagnostics(database, runId, plans, diagnostics, hasWithdrawals, yieldAtCheckpoint);
  } catch (error) {
    if (error instanceof ReconciliationContinuation) return { continuation: error.checkpoint };
    throw error;
  }

  let productCatalogue = {
    draft: priorProducts,
    productSurfaceObserved: false,
  };
  const observedProductGroups = new Map<SupportedGame, CanonicalRecordSource<string>>();
  const observedProducts = canonicalRecordSource(async function* (after) {
    const cursor: [number, string] = after ? JSON.parse(after) : [0, ""];
    let index = 0;
    for (const records of observedProductGroups.values()) {
      const group = index++;
      if (group < cursor[0]) continue;
      for await (const entry of records.canonicalEntries(group === cursor[0] ? cursor[1] : ""))
        yield { key: canonicalJson([group, entry.key]), value: entry.value };
    }
  });
  const observedProductGames = new Set<SupportedGame>();
  const observedProductLineages = new Set<string>();
  try {
    for (const game of new Set([
      ...productGames,
      ...(run.supported_game === null ? [] : [run.supported_game as SupportedGame]),
    ])) {
      async function* inputs(after: ReconciliationInputRecordCursor | null): AsyncGenerator<ProductInputEntry> {
        for await (const entry of scannedReconciliationRecordEntries<
          Extract<RetainedObservation, { kind: "card_printing" }>
        >(
          database,
          runId,
          "observations",
          after,
          (value) =>
            value.kind === "card_printing" && value.supportedGame === game && value.productReleaseValue !== undefined,
        )) {
          const observation = entry.value;
          if (observation === null) {
            yield { input: null, cursor: entry.cursor, byteLength: entry.byteLength };
            continue;
          }
          const plan = productReleaseHasNoRelationships(observation.productReleaseValue)
            ? null
            : await plans.get(observation.sourceObservationId);
          yield {
            cursor: entry.cursor,
            byteLength: entry.byteLength,
            input: {
              value: observation.productReleaseValue,
              sourceObservationId: observation.sourceObservationId,
              sourceObservationSetId: observation.sourceObservationSetId,
              sourceSnapshotId: observation.sourceSnapshotId,
              sourceLineage: observation.sourceLineage,
              sourceSurface: observation.sourceSurface,
              requestRole: observation.sourceRequestRole,
              capturedAt: observation.sourceCapturedAt,
              currentCardId: plan?.cardId ?? null,
              currentPrintingId: plan?.printingId ?? null,
            },
          };
        }
      }
      const reconciled = await reconcileProductReleaseState(
        database,
        runId,
        productCatalogue.draft,
        inputs,
        game,
        sourceWarnings,
        {
          hasInputs: productCheckTimes.has(game),
          yieldAtCheckpoint,
          ...(run.supported_game === null
            ? {}
            : {
                membershipEvidence: { plans, checkedLineages: errataOnlyEvidence ? [] : [...completeLineages].sort() },
              }),
        },
      );
      productCatalogue = {
        draft: reconciled.draft,
        productSurfaceObserved: productCatalogue.productSurfaceObserved || reconciled.productSurfaceObserved,
      };
      observedProductGroups.set(game, reconciled.observedProducts);
      if (reconciled.productSurfaceObserved) {
        observedProductGames.add(game);
        for (const sourceLineage of reconciled.checkedLineages) observedProductLineages.add(sourceLineage);
      }
    }
  } catch (error) {
    if (error instanceof ReconciliationContinuation) return { continuation: error.checkpoint };
    if (isStorageOrCapacityFailure(error)) throw error;
    await diagnostics.push({
      code: "retained_evidence_invalid",
      source_observation_id: null,
      locator: null,
      matched_printing_ids: [],
      detail: error instanceof Error ? error.message : "Retained Product evidence is invalid.",
    });
  }
  let candidate: CatalogueCandidate = {
    contract: catalogueCandidateContract,
    selected_games: [...new Set([...(priorCandidate?.selected_games ?? []), ...evidenceGames])].sort(),
    ...(priorCandidate?.identity_corrections ? { identity_corrections: priorCandidate.identity_corrections } : {}),
    cards: [],
    printings: [],
    printing_images: [],
    products: [],
    distribution_contexts: [],
    product_relationships: [],
    card_observed_games: [...cardCheckTimes.keys()].sort(),
    product_observed_games: [...observedProductGames].sort(),
    product_observed_lineages: [...observedProductLineages].sort(),
    source_checks: [
      ...[...cardCheckTimes]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([game, checked_at]) => ({
          game,
          area: "cards-and-printings" as const,
          checked_at,
        })),
      ...[...productCheckTimes]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([game, checked_at]) => ({
          game,
          area: "products-and-releases" as const,
          checked_at,
        })),
      ...[...errataCheckTimes]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([game, checked_at]) => ({ game, area: "errata" as const, checked_at })),
    ],
    errata: [],
  };

  candidate = omitUndefinedValues(candidate) as CatalogueCandidate;
  let assembled: Awaited<ReturnType<typeof prepareOfficialCandidate>>;
  try {
    assembled = await prepareOfficialCandidate(
      database,
      runId,
      productCatalogue.draft,
      {
        cards,
        printings,
        images: printingImages,
        errata: currentErrata,
        plans,
        games: evidenceGames,
        observedCard: async (id) =>
          (await localCardFacts.has(id)) || (await targetedCardIds.has(id)) || (await admittedEntities.hasCard(id)),
        observedPrinting: async (id) =>
          (await plans.hasObserved("printing", id)) ||
          (await targetedPrintingIds.has(id)) ||
          (await admittedEntities.hasPrinting(id)),
      },
      diagnostics,
      observedAt,
      yieldAtCheckpoint,
    );
  } catch (error) {
    if (error instanceof ReconciliationContinuation) return { continuation: error.checkpoint };
    throw error;
  }
  const { draft: official, observedCards, observedPrintings } = assembled;
  const checkedSourceLineages = errataOnlyEvidence ? [] : [...completeLineages].sort();
  try {
    sourceHistory = await prepareNativeSourceHistory(database, runId, true, yieldAtCheckpoint);
    await prepareDisappearanceWarnings(
      database,
      runId,
      {
        plans,
        history: sourceHistory?.prior,
        cardScopes: { scopes: checkedCardScopes, priorCards, priorPrintings },
        hasPrintings: (official.positions.printings ?? 0) > 0,
        checkedLineages: checkedSourceLineages,
        errataLineages: errataOnlyEvidence ? [...evidenceLineages] : [],
        priorErrata,
        observedErrata,
        gundamProvenance: localGundamPrintingProvenance,
        printingCompatibility: localPrintingCompatibility,
      },
      sourceWarnings,
      yieldAtCheckpoint,
    );
  } catch (error) {
    if (error instanceof ReconciliationContinuation) return { continuation: error.checkpoint };
    throw error;
  }
  try {
    const warnings = sourceWarnings;
    let candidateCatalogueDigest: string;
    if (diagnostics.length > 0) {
      await diagnostics.prepareSorted(yieldAtCheckpoint);
      await warnings.prepareSorted(yieldAtCheckpoint);
      candidateCatalogueDigest = await catalogueDataDigest(
        database,
        runId,
        official,
        candidate,
        plans,
        checkedSourceLineages,
        yieldAtCheckpoint,
      );
      const stableDiagnostics = diagnostics;
      const digestPayload = reconciliationDigestPayload({
        candidate: await official.document(candidate),
        partitions: retained.partitions,
        plans,
        state: "failed",
        publishable: false,
        sourceObservationSetId: retained.observationSetId,
        observedCards,
        observedPrintings,
        observedProducts,
        diagnostics: stableDiagnostics,
        warnings,
      });
      const candidateDigest = await prepareCanonicalDigest(
        database,
        runId,
        "candidate",
        digestPayload,
        yieldAtCheckpoint,
        run.supported_game === null,
      );
      const failed = await persistBlockedCandidate(database, {
        runId,
        independentGame: run.supported_game !== null,
        printingImageObjects,
        partitions: retained.partitions,
        plans,
        diagnostics: stableDiagnostics,
        candidate: await official.document(candidate),
        draft: official,
        digestPayload,
        candidateDigest,
        candidateCatalogueDigest,
        observedAt,
        yieldAtCheckpoint,
      });
      return failed ?? { run_id: runId, candidate_digest: candidateDigest };
    }
    const curated = new ReconciliationCandidateState(database, runId, "curated", official);
    try {
      await prepareCuratedDraft(
        database,
        runId,
        official,
        curated,
        observedAt,
        yieldAtCheckpoint,
        run.supported_game !== null,
        priorCandidate === null && admittedEntities.cursor.cards === 0 && admittedEntities.cursor.printings === 0,
      );
    } catch (error) {
      if (error instanceof CuratedDraftInvalidError && run.supported_game !== null) {
        const failed = await failIndependentGamePreparation(database, runId, error.message, [
          {
            code: error.message,
            detail: "The pinned curated corrections produce an invalid candidate with the retained source facts.",
          },
        ]);
        if (failed) return failed;
        throw error;
      }
      if (!(error instanceof CuratedDraftSourceChangeError)) throw error;
      const diagnostics = await prepareCuratedConflictDiagnostics(
        database,
        runId,
        error.diagnostics,
        yieldAtCheckpoint,
      );
      await diagnostics.prepareSorted(yieldAtCheckpoint);
      await warnings.prepareSorted(yieldAtCheckpoint);
      candidateCatalogueDigest = await catalogueDataDigest(
        database,
        runId,
        official,
        candidate,
        plans,
        checkedSourceLineages,
        yieldAtCheckpoint,
      );
      const digestPayload = reconciliationDigestPayload({
        candidate: await official.document(candidate),
        partitions: retained.partitions,
        plans,
        state: "failed",
        publishable: false,
        sourceObservationSetId: retained.observationSetId,
        observedCards,
        observedPrintings,
        observedProducts,
        diagnostics,
        warnings,
      });
      const candidateDigest = await prepareCanonicalDigest(
        database,
        runId,
        "candidate",
        digestPayload,
        yieldAtCheckpoint,
        run.supported_game === null,
      );
      const failed = await persistBlockedCandidate(database, {
        runId,
        independentGame: run.supported_game !== null,
        printingImageObjects,
        partitions: retained.partitions,
        plans,
        diagnostics,
        candidate: await official.document(candidate),
        draft: official,
        digestPayload,
        candidateDigest,
        candidateCatalogueDigest,
        observedAt,
        yieldAtCheckpoint,
        failureCode: "curated_revision_reconfirmation_required",
      });
      return failed ?? { run_id: runId, candidate_digest: candidateDigest };
    }
    const corrected = new ReconciliationCandidateState(database, runId, "corrections", curated);
    await applyPinnedIdentityCorrectionsToDraft(database, runId, corrected, warnings, yieldAtCheckpoint);
    await warnings.prepareSorted(yieldAtCheckpoint);
    candidateCatalogueDigest = await catalogueDataDigest(
      database,
      runId,
      corrected,
      candidate,
      plans,
      checkedSourceLineages,
      yieldAtCheckpoint,
    );
    const candidateDocument = await corrected.document(candidate);
    const digestPayload = reconciliationDigestPayload({
      candidate: candidateDocument,
      partitions: retained.partitions,
      plans,
      state: "awaiting_approval",
      publishable: true,
      sourceObservationSetId: retained.observationSetId,
      observedCards,
      observedPrintings,
      observedProducts,
      diagnostics: [],
      warnings,
    });
    const candidateDigest = await prepareCanonicalDigest(
      database,
      runId,
      "candidate",
      digestPayload,
      yieldAtCheckpoint,
      run.supported_game === null,
    );
    await retainSourceMappings(database, runId, sourceMappings, yieldAtCheckpoint);
    await persistReviewableCandidate(database, {
      runId,
      independentGame: run.supported_game !== null,
      printingImageObjects,
      partitions: retained.partitions,
      plans,
      warnings,
      candidate: candidateDocument,
      draft: corrected,
      digestPayload,
      candidateDigest,
      candidateCatalogueDigest,
      observedAt,
      yieldAtCheckpoint,
    });
    return { run_id: runId, candidate_digest: candidateDigest };
  } catch (error) {
    if (error instanceof ReconciliationContinuation) return { continuation: error.checkpoint };
    throw error;
  }
}
function fillAuthorityGaps<T>(authority: T, fallback: T): T {
  if (authority === null || authority === undefined) return fallback;
  if (
    Array.isArray(authority) ||
    Array.isArray(fallback) ||
    typeof authority !== "object" ||
    authority === null ||
    typeof fallback !== "object" ||
    fallback === null
  ) {
    return authority;
  }
  const authoritative = authority as Record<string, unknown>;
  const corroborating = fallback as Record<string, unknown>;
  return Object.fromEntries(
    [...new Set([...Object.keys(authoritative), ...Object.keys(corroborating)])].map((field) => [
      field,
      fillAuthorityGaps(authoritative[field], corroborating[field]),
    ]),
  ) as T;
}

async function finalizedReconciliationResult(
  database: CatalogueStore,
  runId: string,
  generation: number,
): Promise<Record<string, unknown> | null> {
  const row = await reconciliationRunStateStatement(database, runId).first<NativePreparationGuardState>();
  if (row?.supported_game) {
    const terminal = independentGamePreparationResult(runId, row, generation);
    if (terminal) return terminal;
    const failureCode = nativePreparationFailureCode(row);
    if (failureCode) {
      const scoped = guardedCatalogueStore(database, () =>
        reconciliationWriterGuard(database, runId, generation, true),
      );
      return failIndependentGamePreparation(scoped, runId, failureCode, [
        {
          code: failureCode,
          detail:
            failureCode === "reconciliation_deadline_expired"
              ? "The original preparation deadline expired."
              : "The expected Game Catalogue Revision changed.",
        },
      ]);
    }
    return null;
  }
  return row !== null && (row.state === "awaiting_approval" || row.state === "failed")
    ? row.candidate_digest
      ? { run_id: runId, candidate_digest: row.candidate_digest }
      : retainedReconciliationResult(database, runId)
    : null;
}

function reconciliationDigestPayload(input: {
  candidate: Record<string, unknown>;
  partitions: AsyncIterable<unknown>;
  plans: Parameters<typeof digestObservationPlans>[0];
  state: "awaiting_approval" | "failed";
  publishable: boolean;
  sourceObservationSetId: string;
  observedCards: AsyncIterable<string>;
  observedPrintings: AsyncIterable<string>;
  observedProducts: AsyncIterable<string>;
  diagnostics: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>;
  warnings: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    catalogue_data: input.candidate,
    evidence_partitions: input.partitions,
    observation_plans: digestObservationPlans(input.plans),
    reconciliation_response: {
      state: input.state,
      publishable: input.publishable,
      source_observation_set_id: input.sourceObservationSetId,
      observed_card_ids: input.observedCards,
      observed_printing_ids: input.observedPrintings,
      observed_product_ids: input.observedProducts,
      diagnostics: input.diagnostics,
      warnings: input.warnings,
    },
  };
}

export async function showReconciledPrinting(
  database: CatalogueStore,
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

function digestObservationPlans(plans: AsyncIterable<ObservationPlan>): AsyncIterable<ObservationPlan> {
  return plans;
}

async function catalogueDataDigest(
  database: CatalogueStore,
  runId: string,
  draft: ReconciliationCandidateState,
  candidate: CatalogueCandidate,
  plans: ReconciliationPlanState,
  checkedSourceLineages: readonly string[],
  yieldAtCheckpoint: boolean,
): Promise<string> {
  // The completed digest pins this immutable draft. Later phases need its
  // receipt, without reopening semantic sources whose preparation is finished.
  const completed = await reconciliationCheckpoint<{ digest?: string }>(database, runId, "canonical_digest:catalogue");
  if (completed?.value.digest) return completed.value.digest;
  const { memberships, withdrawals } = await prepareSemanticState(
    database,
    runId,
    draft,
    plans,
    checkedSourceLineages,
    yieldAtCheckpoint,
  );
  const sortedMemberships = new ReconciliationSortedRecords<Record<string, unknown>>(
    database,
    runId,
    "semantic_memberships",
  );
  const sortedWithdrawals = new ReconciliationSortedRecords<Record<string, unknown>>(
    database,
    runId,
    "semantic_withdrawals",
  );
  await sortedMemberships.prepareRuns(
    memberships.position,
    async function* (after) {
      for await (const entry of memberships.insertionEntries(after))
        yield { ordinal: entry.ordinal, value: entry.value.value };
    },
    yieldAtCheckpoint,
  );
  await sortedWithdrawals.prepareRuns(
    withdrawals.position,
    async function* (after) {
      for await (const entry of withdrawals.insertionEntries(after))
        yield { ordinal: entry.ordinal, value: entry.value.value };
    },
    yieldAtCheckpoint,
  );
  const catalogueCandidate = await semanticDraftDocument(draft, candidate);
  return prepareCanonicalDigest(
    database,
    runId,
    "catalogue",
    {
      catalogue_data: catalogueCandidate,
      current_memberships: sortedMemberships,
      withdrawals: sortedWithdrawals,
    },
    yieldAtCheckpoint,
  );
}

async function semanticDraftDocument(draft: ReconciliationCandidateState, metadata: CatalogueCandidate) {
  const document = await draft.document(metadata);
  const shell: CatalogueCandidate = {
    contract: metadata.contract,
    selected_games: metadata.selected_games,
    cards: [],
    printings: [],
    ...(metadata.identity_corrections ? { identity_corrections: [] } : {}),
  };
  const result = semanticCatalogueCandidate(shell);
  for (const kind of [
    "cards",
    "printings",
    "printing_images",
    "products",
    "distribution_contexts",
    "product_relationships",
    "errata",
    "identity_corrections",
  ] as const) {
    if (!(kind in document)) continue;
    if (kind === "identity_corrections") {
      // Native predecessors retain an empty collection. Its absence and []
      // express the same facts; keep the historical empty canonical form.
      const corrections = draft.values(kind);
      try {
        if ((await corrections.next()).done) continue;
      } finally {
        await corrections.return(undefined);
      }
    }
    result[kind] = canonicalRecordSource(async function* (after) {
      for await (const entity of draft.values(kind, after)) {
        const value = semanticCatalogueCandidate({ ...shell, [kind]: [entity] });
        yield { key: entity.id, value: (value[kind] as unknown[])[0] };
      }
    });
  }
  return result;
}

function semanticCatalogueCandidate(candidate: CatalogueCandidate): Record<string, unknown> {
  return {
    contract: candidate.contract,
    selected_games: candidate.selected_games,
    ...(candidate.identity_corrections?.length ? { identity_corrections: candidate.identity_corrections } : {}),
    cards: candidate.cards,
    printings: candidate.printings.map(({ locator_evidence: _locators, ...printing }) => printing),
    printing_images: (candidate.printing_images ?? []).map((image) => ({
      id: image.id,
      printing_id: image.printing_id,
      role: image.role,
      media_type: image.media_type,
      width: image.width,
      height: image.height,
      content_sha256: image.content_sha256,
      content_byte_length: image.content_byte_length,
      object_key: image.object_key,
    })),
    products: (candidate.products ?? []).map((product) => ({
      reference: product.reference,
      id: product.id,
      game: product.game,
      official_code: product.official_code,
      name: product.name,
      releases: product.releases.map((release) => {
        const { curated_provenance: provenance, ...facts } = release;
        return {
          ...facts,
          ...(Array.isArray(provenance) ? { curated_provenance: provenance } : {}),
        };
      }),
      ...(Array.isArray(product.curated_provenance) ? { curated_provenance: product.curated_provenance } : {}),
      withdrawal:
        product.withdrawal === null
          ? null
          : {
              assertion: product.withdrawal.evidence.assertion,
              effective_at: product.withdrawal.evidence.effective_at,
              evidence: product.withdrawal.evidence.evidence,
            },
      disagreements: product.disagreements.map((disagreement) => ({
        path: disagreement.path,
        status: disagreement.status,
        candidates: disagreement.candidates.map(({ value }) => ({ value })),
      })),
    })),
    distribution_contexts: (candidate.distribution_contexts ?? []).map(
      ({ source_lineages: _lineages, curated_provenance: provenance, ...context }) => ({
        ...context,
        ...(Array.isArray(provenance) ? { curated_provenance: provenance } : {}),
      }),
    ),
    product_relationships: (candidate.product_relationships ?? []).map(
      ({
        source_observation_ids: _observationIds,
        source_lineage: lineage,
        curated_provenance: provenance,
        ...relationship
      }) => ({
        ...relationship,
        ...(lineage === undefined ? {} : { source_lineage: lineage }),
        ...(Array.isArray(provenance) ? { curated_provenance: provenance } : {}),
      }),
    ),
    errata: (candidate.errata ?? []).map((erratum) => JSON.parse(canonicalErratum(erratum))),
  };
}

async function addGundamProducts(
  grouped: ReconciliationReducerIndex<string[]>,
  printingId: string,
  products: readonly string[],
): Promise<void> {
  const retained = new Set((await grouped.get(printingId)) ?? []);
  products.forEach((product) => retained.add(product));
  await grouped.set(printingId, [...retained]);
}

async function addGundamLineage(
  grouped: ReconciliationReducerIndex<("gundam-en-asia" | "gundam-en-us")[]>,
  printingId: string,
  sourceLineage: "gundam-en-asia" | "gundam-en-us",
): Promise<void> {
  const lineages = new Set((await grouped.get(printingId)) ?? []);
  lineages.add(sourceLineage);
  await grouped.set(printingId, [...lineages]);
}

async function blockedResult(
  database: CatalogueStore,
  runId: string,
  diagnostics: readonly Diagnostic[],
  observedAt: string,
): Promise<Record<string, unknown>> {
  const stable = [...diagnostics].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return failReconciliation(database, runId, stable, observedAt);
}

function printingImageEvidenceEquivalent(left: CataloguePrintingImage, right: CataloguePrintingImage): boolean {
  const { source_url: _leftSourceUrl, ...leftEvidence } = left;
  const { source_url: _rightSourceUrl, ...rightEvidence } = right;
  return canonicalJson(leftEvidence) === canonicalJson(rightEvidence);
}

async function requiredActiveParsingRun(database: CatalogueStore, runId: string): Promise<ActiveRunRow> {
  const row = await activeParsingRunStatement(database, runId).first<ActiveRunRow>();
  if (
    row === null ||
    (row.supported_game === null && row.active_ingestion_run_id !== runId) ||
    (row.supported_game !== null && row.preparation_state !== "preparing")
  ) {
    throw new AdministrationProblem(
      409,
      "run_not_active",
      "Only the active parsing Ingestion Run can reconcile retained evidence.",
    );
  }
  if (row.supported_game === null)
    assertIngestionRunTransition(row.state, "reconciling", {
      invalid: () =>
        new AdministrationProblem(
          409,
          "run_not_active",
          "Only the active parsing Ingestion Run can reconcile retained evidence.",
        ),
    });
  if (row.recovery_health !== "healthy") {
    throw new AdministrationProblem(
      409,
      "recovery_not_verified",
      "Recovery is not healthy, so reconciliation is blocked.",
    );
  }
  return row;
}

import { documentStorage, ReconciliationDocumentStorageError } from "./reconciliation-document";
import { ReconciliationNormalizationStorageError } from "./reconciliation-normalized";
import { ReconciliationTextStorageError } from "./reconciliation-text";

function isStorageOrCapacityFailure(error: unknown): boolean {
  return (
    error instanceof CuratedConflictStorageError ||
    error instanceof ReconciliationReducerStorageError ||
    error instanceof CandidateImageStorageError ||
    error instanceof ReconciliationInputStorageError ||
    error instanceof ReconciliationTextStorageError ||
    error instanceof ReconciliationDocumentStorageError ||
    error instanceof ReconciliationNormalizationStorageError ||
    (error instanceof Error && error.message.startsWith("reconciliation_capacity_exceeded:"))
  );
}

function compatibilityGroup(compatibility: PrintingCompatibility): string {
  const { source_lineage: _lineage, ...fields } = compatibility;
  return canonicalJson(fields);
}
