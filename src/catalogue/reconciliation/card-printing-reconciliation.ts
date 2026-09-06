import { ReconciliationCardState } from "./reconciliation-card-state";
import { ReconciliationReducerIndex, ReconciliationReducerStorageError } from "./reconciliation-reducer-state";
import { ReconciliationInputStorageError } from "./reconciliation-input";
import { canonicalValueDigest } from "./reconciliation-preparation";
import { CandidateImageStorageError } from "./reconciliation-images";
import { initializeReconciliationProgress } from "./reconciliation-progress";
import { reconciliationWriterGuard } from "./reconciliation-progress-repository";
import {
  pinCorrectionDecisions,
  applyPinnedIdentityCorrections,
  pinnedCardIdentityResolver,
} from "./identity-correction-pins";
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
  type SourceMapping,
  matchingIdentityDecision,
} from "./canonical-identity";
import {
  applyPinnedCuratedRevisions,
  CuratedRevisionSourceChangeError,
  stripCuratedRevisionEffects,
  restoreCuratedEntitySourceFields,
} from "../curated";
import {
  AdministrationProblem,
  guardedCatalogueStore,
  assertIngestionRunTransition,
  type CatalogueCandidate,
  type CatalogueCard,
  type CatalogueErratum,
  type CataloguePrinting,
  type CataloguePrintingImage,
  type CatalogueStore,
  type CuratedProvenance,
  canonicalJson,
  catalogueCandidateContract,
  type IngestionRunState,
  retainedPayloadChunks,
  streamedObjectMembers,
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
import { type ProductReleaseEvidenceInput, type reconcileProductReleaseCatalogue } from "./product-release-catalogue";
import { reconcileProductReleaseState } from "./product-release-state";
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
  type Memberships,
  type PrintingCompatibility,
  type ProvenancedWithdrawal,
} from "./reconciliation-model";
import {
  cardDisappearanceWarnings,
  printingDisappearanceWarnings,
  publicReconciledPrinting,
  relationshipDisappearanceWarnings,
} from "./reconciliation-read";
import {
  activeParsingRunStatement,
  candidateAtRevisionStatement,
  currentCardWithdrawalEvidenceStatement,
  currentPrintingMembershipsStatement,
  currentPrintingWithdrawalEvidenceStatement,
  errataProvenanceByIdsStatement,
  publishedWithdrawalAssertionsStatement,
  reconciliationRunStateStatement,
} from "./reconciliation-read-repository";
import {
  canonicalCardConflict,
  canonicalPrintingConflict,
  compatiblePrintings,
  crossSourcePrintingCandidates,
  existingCard,
  gundamAffectedPrintingIds,
  gundamCardLineages,
  gundamPrintingLineages,
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

export async function reconcileRetainedCardPrintingEvidence(
  database: CatalogueStore,
  evidenceObjects: R2Bucket,
  runId: string,
  observedAt: string,
  printingImageObjects: R2Bucket,
  generation = 0,
): Promise<Record<string, unknown>> {
  const replay = await finalizedReconciliationResult(database, runId);
  if (replay !== null) return replay;
  const run = await requiredActiveParsingRun(database, runId);
  await initializeReconciliationProgress(database, runId, observedAt);
  const base = database;
  database = guardedCatalogueStore(base, () => reconciliationWriterGuard(base, runId, generation));
  let retained: Awaited<ReturnType<typeof retainedReconciliationObservation>>;
  try {
    retained = await retainedReconciliationObservation(database, evidenceObjects, runId, printingImageObjects);
  } catch (error) {
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

  const diagnostics: Diagnostic[] = [];
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
  const priorPrintings = new ReconciliationReducerIndex<CataloguePrinting>(database, runId, "prior_printings");
  const printingImages = new ReconciliationReducerIndex<CataloguePrintingImage>(database, runId, "printing_images");
  const selectedGames = JSON.parse(run.selected_games_json) as SupportedGame[];
  const priorCandidate = await candidateAtRevision(database, run.expected_current_revision_id, selectedGames, {
    card: async (card) => {
      if (selectedGames.includes(card.game)) restoreCuratedEntitySourceFields(card);
      await priorCards.seed(card);
      await cards.seed(card);
    },
    printing: async (printing) => {
      const card = await priorCards.get(printing.card_id);
      if (card && selectedGames.includes(card.game)) restoreCuratedEntitySourceFields(printing);
      await priorPrintings.seed(printing.id, printing);
      await printings.seed(printing.id, printing);
    },
    image: async (image) => {
      await printingImages.seed(image.id, image);
    },
  });
  const sourceMappings: SourceMapping[] = [];
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
  const plans: {
    sourceObservationSetId: string;
    sourceSnapshotId: string;
    sourceObservationId: string;
    sourceLineage: string;
    supportedGame: SupportedGame;
    observationKind: "card_printing" | "official_erratum";
    cardId: string;
    printingId: string | null;
    locator: string | null;
    variantKey: string | null;
    compatibility: PrintingCompatibility | null;
    memberships: Memberships;
    withdrawal: ProvenancedWithdrawal | null;
    sourceCardFactsJson: string | null;
  }[] = [];
  const sourceWarnings: Record<string, unknown>[] = [
    ...retained.countChangeWarnings,
    // A Printing Image whose transport retries were exhausted never blocks
    // publication: the candidate carries the gap explicitly so the owner can
    // see it and a later run can collect the image.
    ...retained.unavailablePrintingImages.map((image) => ({
      code: "printing_image_unavailable",
      request_id: image.requestId,
      source_url: image.sourceUrl,
      source_lineage: image.sourceLineage,
      failure_code: image.failureCode,
      detail:
        "The Official Source did not serve this Printing Image within its bounded transport retries; the Printing is published without it and a later Ingestion Run can collect it.",
    })),
  ];
  await pinCorrectionDecisions(database, runId, JSON.parse(run.selected_games_json) as string[]);
  const correctedCardIdentity = await pinnedCardIdentityResolver(database, runId);
  await pinEntityAdmissions(database, runId, JSON.parse(run.selected_games_json) as string[]);
  const admittedEntities = await applyPinnedEntityAdmissions(database, runId, cards, printings, sourceWarnings);
  const observedErrata: CatalogueErratum[] = [];
  const targetedCardIds = new Set<string>();
  const targetedPrintingIds = new Set<string>();
  const cardCheckTimes = new Map<SupportedGame, string>();
  const productCheckTimes = new Map<SupportedGame, string>();
  const productGames = new Set<SupportedGame>();
  type RetainedObservation = NormalizedReconciliationObservation;
  for await (const observation of retained.observations()) {
    if (observation.kind !== "card_printing") continue;
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
    const sourceCard = observation.observedCardAndPrinting.card;
    for (const checks of [
      ...(sourceCard === null ? [] : [cardCheckTimes]),
      ...(observation.productReleaseValue === undefined ? [] : [productCheckTimes]),
    ]) {
      if ((checks.get(observation.supportedGame) ?? "") < observation.sourceCapturedAt)
        checks.set(observation.supportedGame, observation.sourceCapturedAt);
    }
    if (sourceCard === null) {
      sourceWarnings.push(...observation.sourceWarnings);
      continue;
    }
    if (sourceCard.game !== observation.supportedGame) {
      diagnostics.push({
        code: "retained_evidence_invalid",
        source_observation_id: observation.sourceObservationId,
        locator: observation.locator,
        matched_printing_ids: [],
        detail: "The retained Card Supported Game conflicts with its provenance envelope.",
      });
      continue;
    }
    const admission = await assessSourceAdmission(database, runId, observation, observedAt);
    if (admission?.identityExceptionConflict) {
      diagnostics.push({
        code: "canonical_card_conflict",
        source_observation_id: observation.sourceObservationId,
        locator: observation.locator,
        matched_printing_ids: admission.decision?.printing ? [admission.decision.printing.id] : [],
        detail:
          "New source evidence contradicts the identity established by an owner admission exception. Resolve the identity conflict before publication.",
      });
      continue;
    }
    if (admission && !admission.permitted) {
      sourceWarnings.push({
        code: "entity_proposal_excluded",
        game: observation.supportedGame,
        proposal_id: admission.proposal.id,
        source_observation_id: observation.sourceObservationId,
        detail: `Entity Proposal ${admission.proposal.id} is ${admission.rejected ? "owner-rejected" : "unresolved"}; its Card and Printing observation is isolated from this candidate.`,
      });
      continue;
    }
    const existing =
      sourceCard.official_identity.kind === "unknown"
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
          for await (const candidate of printings.matchingBeforeObservation(card.id)) {
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
        for (const card of exactUnnumberedCards) {
          const expected = compatibilityFor(card.id, observation.sourceLineage, observation);
          const compatible = await compatiblePrintings(database, expected);
          const local: PrintingCompatibility[] = [];
          for await (const match of localPrintingCompatibility.matchingBeforeObservation(compatibilityGroup(expected)))
            if (isCompatible(match.compatibility, expected)) local.push(match.compatibility);
          const located =
            observation.locator === null
              ? null
              : await printingAtLocatorVariant(
                  database,
                  observation.sourceLineage,
                  observation.locator,
                  observation.variantKey,
                );
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
          diagnostics.push({
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
    observedErrata.push(...currentCardErrata);
    const currentEffectiveAuthority = currentCardErrata.some(
      (erratum) => erratum.effective_from === null || erratum.effective_from <= observedAt.slice(0, 10),
    );
    if (
      proposedCard.official_identity.kind === "functional_designation" &&
      proposedCard.official_identity.value === "DON!!"
    ) {
      sourceWarnings.push({
        code: "printing_coverage_incomplete",
        card_id: cardId,
        detail:
          "Known DON!! Printing evidence is retained when present, but Official Source coverage is incomplete and absence never proves zero Printings.",
      });
    }
    const carriedCard = await cards.get(cardId);
    if (observation.sourceLineage === "gundam-en-asia" || observation.sourceLineage === "gundam-en-us") {
      await addGundamLineage(localGundamCardLineages, cardId, observation.sourceLineage);
    }
    const retainAsiaAuthority =
      proposedCard.game === "gundam" &&
      observation.sourceLineage === "gundam-en-us" &&
      carriedCard !== undefined &&
      ((await gundamCardLineages(database, cardId)).some(
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
        : deriveEffectiveRulesText({ id: cardId, ...proposedCard }, priorCandidate?.errata ?? [], observedAt),
    };
    const publishedConflict = await canonicalCardConflict(
      database,
      cardId,
      proposedForComparison,
      observation.sourceLineage,
      { effectiveRulesText: currentEffectiveAuthority, confirmedPublisherNumber },
    );
    let acceptedCanonicalCard = acceptedCard;
    try {
      acceptedCanonicalCard = {
        ...acceptedCard,
        effective_rules_text: deriveEffectiveRulesText(
          { id: cardId, ...acceptedCard },
          mergeCatalogueErrata(priorCandidate?.errata ?? [], observedErrata),
          observedAt,
        ),
      };
    } catch {
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
        const resolution = reconcileDigimonCardAuthority(priorAuthority, acceptedCanonicalCard, proposedIsBaseRecord, {
          effectiveRulesText: currentEffectiveAuthority ? "official_errata" : "source_consensus",
        });
        if (resolution.kind === "conflict") {
          digimonAuthorityConflict = resolution.detail;
        } else {
          acceptedCanonicalCard = resolution.authority.card;
          await localDigimonCardAuthorities.set(cardId, resolution.authority);
        }
      }
    }
    const canonicalFacts = canonicalJson(acceptedCanonicalCard);
    const priorFacts = await localCardFacts.get(cardId);
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
      diagnostics.push({
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
      await localCardFacts.set(cardId, canonicalFacts);
      await cards.set(cardId, { id: cardId, ...acceptedCanonicalCard });
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
      const [located, unfilteredDatabaseMatches, appearanceMatches, crossSourceCandidates] = await Promise.all([
        printingAtLocatorVariant(database, observation.sourceLineage, locator, observation.variantKey),
        compatiblePrintings(database, compatibility),
        printingsWithAppearance(database, compatibility),
        observation.supportedGame === "gundam"
          ? Promise.resolve([])
          : crossSourcePrintingCandidates(database, compatibility),
      ]);
      const databaseMatches = unfilteredDatabaseMatches;
      const matchIds = new Set(databaseMatches.map((match) => match.id));
      const localMatch = await localCompatibility.get(compatibilityKey);
      if (localMatch !== undefined) matchIds.add(localMatch);
      for await (const match of localPrintingCompatibility.matchingBeforeObservation(
        compatibilityGroup(compatibility),
      )) {
        if (isCompatible(match.compatibility, compatibility)) matchIds.add(match.printingId);
      }
      const unprovenCrossSourceAppearance =
        matchIds.size === 0 && located === null && localLocated === undefined && crossSourceCandidates.length > 0;
      if (unprovenCrossSourceAppearance) crossSourceCandidates.forEach(({ id }) => matchIds.add(id));
      const crossSourceMatches: string[] = [];
      for (const id of matchIds) {
        const matched =
          databaseMatches.find((match) => match.id === id) ?? (await localPrintingCompatibility.get(id))?.compatibility;
        if (matched && matched.source_lineage !== observation.sourceLineage) crossSourceMatches.push(id);
      }
      const insufficientCrossSource =
        unprovenCrossSourceAppearance ||
        (observation.supportedGame !== "gundam" &&
          crossSourceMatches.length > 0 &&
          !hasCrossSourceArtworkEvidence(observation));
      let reviewedPrintingId: string | null = admission?.decision?.printing?.id ?? reviewedCardPrintingId;
      if (
        located === null &&
        localLocated === undefined &&
        reviewedPrintingId === null &&
        (insufficientCrossSource || matchIds.size > 1) &&
        !diagnostics.some(
          (diagnostic) =>
            diagnostic.source_observation_id === observation.sourceObservationId &&
            diagnostic.code === "canonical_card_conflict",
        )
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
          const observedLineages = new Set([
            ...(await gundamPrintingLineages(database, matchId)).map(({ source_lineage }) => source_lineage),
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
            (await gundamPrintingHasProductMembership(database, matchId, observation.memberships.products))
          )
            corroboratedCrossLocaleMatches.push(matchId);
        }
      }
      const uncorroboratedCrossLocaleMatches = crossLocaleMatches.filter(
        (matchId) => !corroboratedCrossLocaleMatches.includes(matchId),
      );
      uncorroboratedCrossLocaleMatches.forEach((matchId) => matchIds.delete(matchId));
      const missingProductCorroboration = uncorroboratedCrossLocaleMatches.length > 0 && matchIds.size === 0;
      const locatedConflict =
        (located !== null &&
          !isCompatible(
            { ...located, card_id: correctedCardIdentity(located.card_id, located.id) },
            { ...compatibility, card_id: correctedCardIdentity(compatibility.card_id, located.id) },
          )) ||
        (localLocated !== undefined &&
          !isCompatible(
            {
              ...localLocated.compatibility,
              card_id: correctedCardIdentity(localLocated.compatibility.card_id, localLocated.printingId),
            },
            { ...compatibility, card_id: correctedCardIdentity(compatibility.card_id, localLocated.printingId) },
          ));
      if (locatedConflict) {
        const locatedId = located?.id ?? localLocated!.printingId;
        diagnostics.push({
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
        diagnostics.push({
          code: "printing_match_insufficient_evidence",
          source_observation_id: observation.sourceObservationId,
          locator,
          matched_printing_ids: [...matchIds].sort(),
          detail:
            "Equal source-local artwork labels do not establish cross-source Printing identity. Inspect and resolve the retained identity review.",
        });
      } else if (missingProductCorroboration) {
        printingId = [...uncorroboratedCrossLocaleMatches].sort()[0]!;
        diagnostics.push({
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
        diagnostics.push({
          code: "printing_match_insufficient_evidence",
          source_observation_id: observation.sourceObservationId,
          locator,
          matched_printing_ids: [...matchIds].sort(),
          detail:
            "A new Printing locator without an explicit Official Source artwork identity cannot be matched to an existing compatible Printing.",
        });
      } else if (matchIds.size > 1) {
        diagnostics.push({
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
          diagnostics.push({
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
          diagnostics.push({
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
      );
      const retainAsiaPrintingAuthority =
        observation.supportedGame === "gundam" &&
        observation.sourceLineage === "gundam-en-us" &&
        carriedPrinting !== undefined &&
        ((await gundamPrintingLineages(database, printingId)).some(
          ({ source_lineage, current }) => source_lineage === "gundam-en-asia" && current === 1,
        ) ||
          (await localGundamPrintingProvenance.get(printingId))?.includes("gundam-en-asia") === true);
      let acceptedPrinting = proposedPrinting;
      if (retainAsiaPrintingAuthority) {
        const { id: _carriedPrintingId, card_id: _carriedCardId, ...authoritativePrinting } = carriedPrinting;
        acceptedPrinting = fillAuthorityGaps(authoritativePrinting, proposedPrinting);
      }
      const priorPrintingFacts = await localPrintingFacts.get(printingId);
      if (
        publishedPrintingConflict !== null ||
        (priorPrintingFacts !== undefined &&
          !retainAsiaPrintingAuthority &&
          !printingFactsFormattingEquivalent(priorPrintingFacts, acceptedPrinting))
      ) {
        diagnostics.push({
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
          diagnostics.push({
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
      diagnostics.push({
        code: "printing_match_insufficient_evidence",
        source_observation_id: observation.sourceObservationId,
        locator: null,
        matched_printing_ids: [],
        detail: "The Card-only retained observation is not structurally complete.",
      });
    }
    if (admission && !diagnostics.some((d) => d.source_observation_id === observation.sourceObservationId)) {
      await completeSourceAdmission(
        database,
        runId,
        admission,
        (await cards.get(cardId))!,
        printingId ? (await printings.get(printingId))! : null,
        observedAt,
      );
      sourceWarnings.push({
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
      if (
        entityId === null ||
        diagnostics.some((diagnostic) => diagnostic.source_observation_id === observation.sourceObservationId)
      )
        continue;
      sourceMappings.push({
        entityId,
        kind,
        runId,
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
      });
    }
    plans.push({
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
      observedErrata.push(
        ...(await identifyRulesTextErrata({
          game: proposedCard.game,
          cardId,
          printingId,
          sourceLineage: observation.sourceLineage,
          sourceObservationId: observation.sourceObservationId,
          errata: observation.errata.filter((erratum) => erratum.targetType === "printing"),
        })),
      );
    } catch (error) {
      diagnostics.push({
        code: "retained_evidence_invalid",
        source_observation_id: observation.sourceObservationId,
        locator: observation.locator,
        matched_printing_ids: printingId === null ? [] : [printingId],
        detail: error instanceof ErratumRulesTextError ? error.message : "Retained Erratum evidence is invalid.",
      });
    }
    sourceWarnings.push(...observation.sourceWarnings);
  }

  for await (const observation of retained.observations()) {
    if (observation.kind !== "official_erratum") continue;
    if (observation.target.type === "card" && !observation.appliesToParallelPrintings) {
      diagnostics.push({
        code: "retained_evidence_invalid",
        source_observation_id: observation.sourceObservationId,
        locator: observation.sourceFragment,
        matched_printing_ids: [],
        detail: "A non-parallel Official Erratum must target exactly one Printing.",
      });
      continue;
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
      diagnostics.push({
        code: "retained_evidence_invalid",
        source_observation_id: observation.sourceObservationId,
        locator: observation.sourceFragment,
        matched_printing_ids: [],
        detail:
          matchingCards.length === 0
            ? "Official Erratum evidence does not resolve one Card in the expected published Catalogue Revision."
            : "Official Erratum evidence resolves more than one Card in the expected published Catalogue Revision.",
      });
      continue;
    }
    const card = (await priorCards.get(matchingCards[0]!.id)) ?? (await cards.get(matchingCards[0]!.id))!;
    targetedCardIds.add(card.id);
    let targetPrintingId: string | null = null;
    if (observation.target.type === "printing") {
      const located = await printingsAtLocator(database, observation.sourceLineage, observation.target.locator);
      const publishedById = new Map<string, CataloguePrinting>();
      for (const locatedPrinting of located) {
        const published = await priorPrintings.get(locatedPrinting.id);
        if (published?.card_id === card.id) publishedById.set(published.id, published);
      }
      const publishedPrintings = [...publishedById.values()];
      if (publishedPrintings.length !== 1) {
        diagnostics.push({
          code: "retained_evidence_invalid",
          source_observation_id: observation.sourceObservationId,
          locator: observation.target.locator,
          matched_printing_ids: publishedPrintings.map((printing) => printing.id).sort(),
          detail:
            "Official Erratum evidence does not resolve exactly one Printing of the Card in the expected published Catalogue Revision.",
        });
        continue;
      }
      const publishedPrinting = publishedPrintings[0]!;
      targetPrintingId = publishedPrinting.id;
      targetedPrintingIds.add(publishedPrinting.id);
    }
    try {
      observedErrata.push(
        ...(await identifyRulesTextErrata({
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
        })),
      );
      plans.push({
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
      diagnostics.push({
        code: "retained_evidence_invalid",
        source_observation_id: observation.sourceObservationId,
        locator: observation.sourceFragment,
        matched_printing_ids: [],
        detail: error instanceof Error ? error.message : "Retained Official Erratum evidence is invalid.",
      });
    }
  }

  diagnostics.push(
    ...withdrawalConflictDiagnostics(plans),
    ...(await publishedWithdrawalConflictDiagnostics(database, plans)),
  );

  let productCatalogue: Awaited<ReturnType<typeof reconcileProductReleaseCatalogue>> = {
    products: [...(priorCandidate?.products ?? [])],
    observedProducts: [],
    distribution_contexts: [...(priorCandidate?.distribution_contexts ?? [])],
    product_relationships: [...(priorCandidate?.product_relationships ?? [])],
    productSurfaceObserved: false,
    warnings: [] as Record<string, unknown>[],
  };
  const observedProductGames = new Set<SupportedGame>();
  const observedProductLineages = new Set<string>();
  try {
    const plansByObservationId = new Map(plans.map((plan) => [plan.sourceObservationId, plan]));
    for (const game of productGames) {
      async function* inputs(): AsyncGenerator<ProductReleaseEvidenceInput> {
        for await (const observation of retained.observations()) {
          if (observation.kind !== "card_printing" || observation.supportedGame !== game) continue;
          const plan = plansByObservationId.get(observation.sourceObservationId);
          yield {
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
          };
        }
      }
      const reconciled = await reconcileProductReleaseState(database, runId, productCatalogue, inputs(), game);
      productCatalogue = {
        products: reconciled.products,
        observedProducts: [...productCatalogue.observedProducts, ...reconciled.observedProducts],
        distribution_contexts: reconciled.distribution_contexts,
        product_relationships: reconciled.product_relationships,
        productSurfaceObserved: productCatalogue.productSurfaceObserved || reconciled.productSurfaceObserved,
        warnings: [...productCatalogue.warnings, ...reconciled.warnings],
      };
      if (reconciled.productSurfaceObserved) {
        observedProductGames.add(game);
        for (const sourceLineage of reconciled.checkedLineages) observedProductLineages.add(sourceLineage);
      }
    }
  } catch (error) {
    if (isStorageOrCapacityFailure(error)) throw error;
    diagnostics.push({
      code: "retained_evidence_invalid",
      source_observation_id: null,
      locator: null,
      matched_printing_ids: [],
      detail: error instanceof Error ? error.message : "Retained Product evidence is invalid.",
    });
  }
  const errata = mergeCatalogueErrata(priorCandidate?.errata ?? [], observedErrata);
  const candidateCards: CatalogueCard[] = [];
  for await (const card of cards.values()) {
    candidateCards.push(
      ((card: CatalogueCard) => {
        if (!retained.partitions.some(({ supportedGame }) => supportedGame === card.game)) return card;
        try {
          return {
            ...card,
            effective_rules_text: deriveEffectiveRulesText(card, errata, observedAt),
          };
        } catch (error) {
          const conflictPlans = plans.filter((plan) => plan.cardId === card.id);
          diagnostics.push({
            code: "canonical_card_conflict",
            source_observation_id: conflictPlans[0]?.sourceObservationId ?? null,
            locator: conflictPlans[0]?.locator ?? null,
            matched_printing_ids: conflictPlans.flatMap((plan) => (plan.printingId === null ? [] : [plan.printingId])),
            detail:
              error instanceof ErratumRulesTextError
                ? error.message
                : "The Card has an unresolved Effective Rules Text conflict.",
          });
          return card;
        }
      })(card),
    );
  }
  candidateCards.sort((left, right) => left.id.localeCompare(right.id));
  const candidatePrintings: CataloguePrinting[] = [];
  for await (const printing of printings.latestValues()) candidatePrintings.push(printing);
  candidatePrintings.sort((left, right) => left.id.localeCompare(right.id));
  const candidateImages: CataloguePrintingImage[] = [];
  for await (const image of printingImages.latestValues()) candidateImages.push(image);
  candidateImages.sort((left, right) => left.id.localeCompare(right.id));
  let candidate: CatalogueCandidate = {
    contract: catalogueCandidateContract,
    selected_games: [
      ...new Set([
        ...(priorCandidate?.selected_games ?? []),
        ...retained.partitions.map(({ supportedGame }) => supportedGame as SupportedGame),
      ]),
    ].sort(),
    ...(priorCandidate?.identity_corrections ? { identity_corrections: priorCandidate.identity_corrections } : {}),
    cards: candidateCards,
    printings: candidatePrintings,
    printing_images: candidateImages,
    products: productCatalogue.products.map((product) => ({
      ...omitUndefinedCuratedProvenance(product),
      releases: product.releases.map(omitUndefinedCuratedProvenance),
    })),
    distribution_contexts: productCatalogue.distribution_contexts.map(omitUndefinedCuratedProvenance),
    product_relationships: productCatalogue.product_relationships.map((relationship) => {
      const sanitized = omitUndefinedCuratedProvenance(relationship);
      const { source_lineage: lineage, ...facts } = sanitized;
      return {
        ...facts,
        ...(lineage === undefined ? {} : { source_lineage: lineage }),
      };
    }),
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
    ],
    errata,
  };
  candidate = omitUndefinedValues(candidate) as CatalogueCandidate;
  const cardPrintingPlans = plans.filter((plan) => plan.observationKind === "card_printing");
  const groupedMemberships = mergedPlanMemberships(cardPrintingPlans);
  const errataOnlyEvidence = retained.evidencePlans.every(
    ({ reconciliationCapability }) => reconciliationCapability === "errata",
  );
  const relationshipWarnings = (
    await Promise.all(
      groupedMemberships.map(({ printingId, sourceLineage, memberships }) =>
        relationshipDisappearanceWarnings(database, printingId, sourceLineage, memberships),
      ),
    )
  ).flat();
  const checkedSourceLineages = errataOnlyEvidence
    ? []
    : [...new Set(retained.partitions.map(({ sourceLineage }) => sourceLineage))].sort();
  const gundamLineageWarnings: Record<string, unknown>[] = [];
  const addLineageWarning = async (printingId: string) => {
    const lineages = new Set(
      (await gundamPrintingLineages(database, printingId))
        .filter(({ source_lineage, current }) => current === 1 && !checkedSourceLineages.includes(source_lineage))
        .map(({ source_lineage }) => source_lineage),
    );
    for (const lineage of (await localGundamPrintingProvenance.get(printingId)) ?? []) lineages.add(lineage);
    if (lineages.size === 1)
      gundamLineageWarnings.push({
        code: "single_locale_gundam_printing",
        printing_id: printingId,
        source_lineage: [...lineages][0]!,
        detail:
          "The Gundam Printing is currently observed on only one English surface; publication retains that provenance for owner review.",
      });
  };
  if (checkedSourceLineages.some((lineage) => lineage === "gundam-en-asia" || lineage === "gundam-en-us")) {
    for await (const printingId of gundamAffectedPrintingIds(database, checkedSourceLineages))
      await addLineageWarning(printingId);
    for await (const { printingId, compatibility } of localPrintingCompatibility.latestValues()) {
      if (compatibility.source_lineage !== "gundam-en-asia" && compatibility.source_lineage !== "gundam-en-us")
        continue;
      const alreadyVisited = (await gundamPrintingLineages(database, printingId)).some(
        ({ source_lineage, current }) => current === 1 && checkedSourceLineages.includes(source_lineage),
      );
      if (!alreadyVisited) await addLineageWarning(printingId);
    }
  }
  const plansByLineage = checkedSourceLineages.map(
    (sourceLineage) =>
      [sourceLineage, cardPrintingPlans.filter((plan) => plan.sourceLineage === sourceLineage)] as const,
  );
  const disappearanceWarnings = (
    await Promise.all(
      plansByLineage.map(([lineage, lineagePlans]) =>
        printingDisappearanceWarnings(
          database,
          lineage,
          lineagePlans.flatMap((plan) => (plan.printingId === null ? [] : [plan.printingId])),
        ),
      ),
    )
  ).flat();
  const cardWarnings = (
    await Promise.all(
      plansByLineage.map(([lineage, lineagePlans]) =>
        cardDisappearanceWarnings(
          database,
          lineage,
          lineagePlans.map((plan) => plan.cardId),
        ),
      ),
    )
  ).flat();
  const erratumWarnings = errataOnlyEvidence
    ? [...new Set(retained.partitions.map(({ sourceLineage }) => sourceLineage))].flatMap((sourceLineage) =>
        erratumDisappearanceWarnings(priorCandidate?.errata ?? [], observedErrata, sourceLineage),
      )
    : [];
  const warnings = [
    ...new Map(
      [
        ...sourceWarnings,
        ...gundamLineageWarnings,
        ...relationshipWarnings,
        ...disappearanceWarnings,
        ...cardWarnings,
        ...productCatalogue.warnings,
        ...erratumWarnings,
      ].map((warning) => [canonicalJson(warning), warning]),
    ).values(),
  ].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  let candidateCatalogueDigest = await catalogueDataDigest(database, candidate, plans, checkedSourceLineages);
  const observedCards: CatalogueCard[] = [];
  for (const card of candidateCards) {
    if (
      (await localCardFacts.has(card.id)) ||
      targetedCardIds.has(card.id) ||
      admittedEntities.some((entity) => entity.card.id === card.id)
    )
      observedCards.push(card);
  }
  observedCards.sort((left, right) => left.id.localeCompare(right.id));
  const observedPrintings = candidatePrintings
    .filter(
      (printing) =>
        plans.some((plan) => plan.observationKind === "card_printing" && plan.printingId === printing.id) ||
        targetedPrintingIds.has(printing.id) ||
        admittedEntities.some((entity) => entity.printing?.id === printing.id),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (diagnostics.length > 0) {
    const stableDiagnostics = [...diagnostics].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
    const digestPayload = reconciliationDigestPayload({
      candidate,
      partitions: retained.partitions,
      plans,
      state: "failed",
      publishable: false,
      sourceObservationSetId: retained.observationSetId,
      observedCards,
      observedPrintings,
      observedProducts: productCatalogue.observedProducts,
      diagnostics: stableDiagnostics,
      warnings,
    });
    const candidateDigest = await canonicalValueDigest(digestPayload);
    await persistBlockedCandidate(database, {
      runId,
      partitions: retained.partitions,
      plans,
      diagnostics: stableDiagnostics,
      candidate,
      digestPayload,
      candidateDigest,
      candidateCatalogueDigest,
      observedAt,
    });
    return {
      contract: "card-keepr-card-printing-reconciliation@2",
      run_id: runId,
      state: "failed",
      publishable: false,
      candidate_digest: candidateDigest,
      expected_current_revision_id: run.expected_current_revision_id,
      source_observation_set_id: retained.observationSetId,
      cards: observedCards,
      printings: observedPrintings,
      products: productCatalogue.observedProducts,
      errata,

      diagnostics: stableDiagnostics,
      warnings,
    };
  }
  try {
    candidate = await applyPinnedCuratedRevisions(database, runId, candidate, observedAt, {
      deferSourceChangeFailure: true,
    });
  } catch (error) {
    if (!(error instanceof CuratedRevisionSourceChangeError)) throw error;
    candidate = error.candidate;
    candidateCatalogueDigest = await catalogueDataDigest(database, candidate, plans, checkedSourceLineages);
    const diagnostics = [...error.diagnostics].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
    const digestPayload = reconciliationDigestPayload({
      candidate,
      partitions: retained.partitions,
      plans,
      state: "failed",
      publishable: false,
      sourceObservationSetId: retained.observationSetId,
      observedCards,
      observedPrintings,
      observedProducts: productCatalogue.observedProducts,
      diagnostics,
      warnings,
    });
    const candidateDigest = await canonicalValueDigest(digestPayload);
    await persistBlockedCandidate(database, {
      runId,
      partitions: retained.partitions,
      plans,
      diagnostics,
      candidate,
      digestPayload,
      candidateDigest,
      candidateCatalogueDigest,
      observedAt,
      failureCode: "curated_revision_reconfirmation_required",
      atomicStatements: error.atomicStatements,
    });
    return {
      contract: "card-keepr-card-printing-reconciliation@2",
      run_id: runId,
      state: "failed",
      publishable: false,
      candidate_digest: candidateDigest,
      expected_current_revision_id: run.expected_current_revision_id,
      source_observation_set_id: retained.observationSetId,
      cards: observedCards,
      printings: observedPrintings,
      products: productCatalogue.observedProducts,
      errata: candidate.errata ?? [],

      diagnostics,
      warnings,
    };
  }
  candidate = await applyPinnedIdentityCorrections(database, runId, candidate, warnings);
  candidateCatalogueDigest = await catalogueDataDigest(database, candidate, plans, checkedSourceLineages);
  const digestPayload = reconciliationDigestPayload({
    candidate,
    partitions: retained.partitions,
    plans,
    state: "awaiting_approval",
    publishable: true,
    sourceObservationSetId: retained.observationSetId,
    observedCards,
    observedPrintings,
    observedProducts: productCatalogue.observedProducts,
    diagnostics: [],
    warnings,
  });
  const candidateDigest = await canonicalValueDigest(digestPayload);
  await retainSourceMappings(database, runId, sourceMappings);
  await persistReviewableCandidate(database, {
    runId,
    partitions: retained.partitions,
    plans,
    warnings,
    candidate,
    digestPayload,
    candidateDigest,
    candidateCatalogueDigest,
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
    cards: observedCards,
    printings: observedPrintings,
    products: productCatalogue.observedProducts,
    errata,

    diagnostics: [],
    warnings,
  };
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

function erratumDisappearanceWarnings(
  priorErrata: readonly CatalogueErratum[],
  observedErrata: readonly CatalogueErratum[],
  sourceLineage: string,
): Record<string, unknown>[] {
  const observedIds = new Set(observedErrata.map((erratum) => erratum.id));
  return priorErrata
    .filter(
      (erratum) =>
        !observedIds.has(erratum.id) &&
        erratum.provenance.some((provenance) => provenance.source_lineage === sourceLineage),
    )
    .map((erratum) => ({
      code: "erratum_not_observed",
      erratum_id: erratum.id,
      source_lineage: sourceLineage,
      detail:
        "The previously published Erratum was not present in this complete Official Errata observation; it was retained without advancing its last-observed revision.",
    }));
}

async function finalizedReconciliationResult(
  database: CatalogueStore,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const row = await reconciliationRunStateStatement(database, runId).first<{ state: string }>();
  return row !== null && (row.state === "awaiting_approval" || row.state === "failed")
    ? retainedReconciliationResult(database, runId)
    : null;
}

function reconciliationDigestPayload(input: {
  candidate: CatalogueCandidate;
  partitions: readonly unknown[];
  plans: Parameters<typeof digestObservationPlans>[0];
  state: "awaiting_approval" | "failed";
  publishable: boolean;
  sourceObservationSetId: string;
  observedCards: readonly CatalogueCard[];
  observedPrintings: readonly CataloguePrinting[];
  observedProducts: readonly { id: string }[];
  diagnostics: readonly Record<string, unknown>[];
  warnings: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  return {
    catalogue_data: input.candidate,
    evidence_partitions: input.partitions,
    observation_plans: digestObservationPlans(input.plans),
    reconciliation_response: {
      state: input.state,
      publishable: input.publishable,
      source_observation_set_id: input.sourceObservationSetId,
      observed_card_ids: input.observedCards.map(({ id }) => id),
      observed_printing_ids: input.observedPrintings.map(({ id }) => id),
      observed_product_ids: input.observedProducts.map(({ id }) => id),
      diagnostics: input.diagnostics,
      warnings: input.warnings,
    },
  };
}

async function candidateAtRevision(
  database: CatalogueStore,
  revisionId: string,
  selectedGames: readonly SupportedGame[],
  seed: {
    card: (card: CatalogueCard) => Promise<void>;
    printing: (printing: CataloguePrinting) => Promise<void>;
    image: (image: CataloguePrintingImage) => Promise<void>;
  },
): Promise<CatalogueCandidate | null> {
  const row = await candidateAtRevisionStatement(database, revisionId).first<{
    ingestion_run_id: string;
    candidate_json: string;
  }>();
  if (row === null) return null;
  const values: Record<string, unknown> = {};
  // Cards are seeded first even for legacy payloads whose object members were not canonicalized.
  // The second pass can therefore resolve each Printing's game without retaining all Cards.
  for (const cardsOnly of [true, false]) {
    for await (const member of streamedObjectMembers(
      retainedPayloadChunks(database, row.ingestion_run_id, "candidate", row.candidate_json),
    )) {
      if ((member.key === "cards") !== cardsOnly) continue;
      if (member.kind === "array") {
        Object.defineProperty(values, member.key, { value: [], writable: true, enumerable: true, configurable: true });
      } else if (member.key === "cards" && member.array) {
        await seed.card(member.value as CatalogueCard);
      } else if (member.key === "printings" && member.array) {
        await seed.printing(member.value as CataloguePrinting);
      } else if (member.key === "printing_images" && member.array) {
        await seed.image(member.value as CataloguePrintingImage);
      } else if (member.array) {
        (values[member.key] as unknown[]).push(member.value);
      } else {
        Object.defineProperty(values, member.key, {
          value: member.value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
  }
  const candidate = stripCuratedRevisionEffects(values as CatalogueCandidate, selectedGames);
  const errata = [...(candidate.errata ?? [])];
  for (let index = 0; index < errata.length; index += 1) {
    const erratum = errata[index]!;
    const rows = await errataProvenanceByIdsStatement(database, canonicalJson([erratum.id])).all<{
      erratum_id: string;
      source_lineage: string;
      source_observation_id: string;
    }>();
    errata[index] = mergeCatalogueErrata(
      [erratum],
      [
        {
          ...erratum,
          provenance: rows.results.map((provenance) => ({
            source_lineage: provenance.source_lineage,
            source_observation_id: provenance.source_observation_id,
          })),
        },
      ],
    )[0]!;
  }
  return { ...candidate, errata };
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

function digestObservationPlans(
  plans: readonly {
    sourceObservationId: string;
    sourceLineage: string;
    supportedGame: SupportedGame;
    observationKind: "card_printing" | "official_erratum";
    cardId: string;
    printingId: string | null;
    locator: string | null;
    variantKey: string | null;
    compatibility: PrintingCompatibility | null;
    memberships: Memberships;
    withdrawal: ProvenancedWithdrawal | null;
  }[],
): Record<string, unknown>[] {
  return [...plans].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

async function catalogueDataDigest(
  database: CatalogueStore,
  candidate: CatalogueCandidate,
  plans: readonly {
    cardId: string;
    printingId: string | null;
    sourceLineage: string;
    locator: string | null;
    variantKey: string | null;
    memberships: Memberships;
    withdrawal: ProvenancedWithdrawal | null;
  }[],
  checkedSourceLineages: readonly string[],
): Promise<string> {
  const printingIds = new Set(candidate.printings.map((printing) => printing.id));
  const cardIds = new Set(candidate.cards.map((card) => card.id));
  const [storedMemberships, storedCards, storedPrintings] = await Promise.all([
    currentPrintingMembershipsStatement(database).all<{
      printing_id: string;
      source_lineage: string;
      relationship_kind: string;
      relationship_value: string;
    }>(),
    currentCardWithdrawalEvidenceStatement(database).all<{ id: string; withdrawal_evidence_json: string | null }>(),
    currentPrintingWithdrawalEvidenceStatement(database).all<{ id: string; withdrawal_evidence_json: string | null }>(),
  ]);
  const memberships = new Map<string, Record<string, unknown>>();
  const observedSourceLineages = new Set(checkedSourceLineages);
  for (const row of storedMemberships.results) {
    if (
      !printingIds.has(row.printing_id) ||
      observedSourceLineages.has(row.source_lineage) ||
      row.relationship_kind === "source_bucket"
    ) {
      continue;
    }
    const semantic = {
      printing_id: row.printing_id,
      source_lineage: row.source_lineage,
      relationship_kind: row.relationship_kind,
      relationship_value: row.relationship_value,
    };
    memberships.set(canonicalJson(semantic), semantic);
  }
  const withdrawals = new Map<string, Record<string, unknown>>();
  for (const [entityType, rows, identities] of [
    ["card", storedCards.results, cardIds],
    ["printing", storedPrintings.results, printingIds],
  ] as const) {
    for (const row of rows) {
      if (!identities.has(row.id) || row.withdrawal_evidence_json === null) {
        continue;
      }
      const evidence = JSON.parse(row.withdrawal_evidence_json) as Record<string, unknown>;
      const semantic = {
        entity_type: entityType,
        entity_id: row.id,
        assertion: evidence.assertion,
        state: evidence.state,
        effective_at: evidence.effective_at,
      };
      withdrawals.set(`${entityType}:${row.id}`, semantic);
    }
  }
  for (const plan of plans) {
    if (plan.printingId !== null) {
      for (const membership of [
        ...plan.memberships.products.map((value) => ({
          kind: "product",
          value,
        })),
        ...plan.memberships.distribution_contexts.map((value) => ({
          kind: "distribution_context",
          value,
        })),
      ]) {
        const semantic = {
          printing_id: plan.printingId,
          source_lineage: plan.sourceLineage,
          relationship_kind: membership.kind,
          relationship_value: membership.value,
        };
        memberships.set(canonicalJson(semantic), semantic);
      }
    }
    if (plan.withdrawal === null) continue;
    const targets = [
      ...(plan.withdrawal.entity === "card" || plan.withdrawal.entity === "card_and_printing"
        ? [{ entityType: "card", entityId: plan.cardId }]
        : []),
      ...(plan.printingId !== null &&
      (plan.withdrawal.entity === "printing" || plan.withdrawal.entity === "card_and_printing")
        ? [{ entityType: "printing", entityId: plan.printingId }]
        : []),
    ];
    for (const target of targets) {
      withdrawals.set(`${target.entityType}:${target.entityId}`, {
        entity_type: target.entityType,
        entity_id: target.entityId,
        assertion: plan.withdrawal.assertion,
        state: plan.withdrawal.state,
        effective_at: plan.withdrawal.effective_at,
      });
    }
  }
  const catalogueCandidate = semanticCatalogueCandidate(candidate);
  return canonicalValueDigest({
    catalogue_data: catalogueCandidate,
    current_memberships: [...memberships.values()].sort(compareCanonical),
    withdrawals: [...withdrawals.values()].sort(compareCanonical),
  });
}

function semanticCatalogueCandidate(candidate: CatalogueCandidate): Record<string, unknown> {
  return {
    contract: candidate.contract,
    selected_games: candidate.selected_games,
    ...(candidate.identity_corrections ? { identity_corrections: candidate.identity_corrections } : {}),
    cards: candidate.cards,
    printings: candidate.printings,
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

function omitUndefinedCuratedProvenance<
  T extends {
    curated_provenance?: readonly CuratedProvenance[];
  },
>(value: T): T {
  const { curated_provenance: provenance, ...facts } = value;
  return {
    ...facts,
    ...(Array.isArray(provenance) ? { curated_provenance: provenance } : {}),
  } as T;
}

function omitUndefinedValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUndefinedValues);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, omitUndefinedValues(item)]),
    );
  }
  return value;
}

function _groupPlansByLineage<T extends { sourceLineage: string }>(plans: readonly T[]): [string, T[]][] {
  const grouped = new Map<string, T[]>();
  for (const plan of plans) {
    grouped.set(plan.sourceLineage, [...(grouped.get(plan.sourceLineage) ?? []), plan]);
  }
  return [...grouped].sort(([left], [right]) => left.localeCompare(right));
}
function compareCanonical(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

async function publishedWithdrawalConflictDiagnostics(
  database: CatalogueStore,
  plans: readonly {
    sourceObservationId: string;
    cardId: string;
    printingId: string | null;
    withdrawal: ProvenancedWithdrawal | null;
  }[],
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const plan of plans) {
    const withdrawal = plan.withdrawal;
    if (withdrawal === null) continue;
    const targets = [
      ...(withdrawal.entity === "card" || withdrawal.entity === "card_and_printing"
        ? [{ entityType: "card", entityId: plan.cardId }]
        : []),
      ...(plan.printingId !== null && (withdrawal.entity === "printing" || withdrawal.entity === "card_and_printing")
        ? [{ entityType: "printing", entityId: plan.printingId }]
        : []),
    ];
    for (const target of targets) {
      const prior = await publishedWithdrawalAssertionsStatement(database, {
        entityType: target.entityType,
        entityId: target.entityId,
      }).all<{
        assertion: string;
        state: string;
        effective_at: string;
      }>();
      const proposedSemantic = canonicalJson({
        assertion: withdrawal.assertion,
        state: withdrawal.state,
        effective_at: withdrawal.effective_at,
      });
      const latest = [...prior.results].sort((left, right) => right.effective_at.localeCompare(left.effective_at))[0];
      const repeated = latest !== undefined && canonicalJson(latest) === proposedSemantic;
      const transition =
        latest !== undefined && latest.state !== withdrawal.state && withdrawal.effective_at > latest.effective_at;
      if (
        (latest === undefined && withdrawal.state === "reinstated") ||
        (latest !== undefined && !repeated && !transition)
      ) {
        diagnostics.push({
          code: "withdrawal_evidence_conflict",
          source_observation_id: plan.sourceObservationId,
          locator: null,
          matched_printing_ids: target.entityType === "printing" ? [target.entityId] : [],
          detail:
            "The explicit withdrawal assertion conflicts with the published withdrawal history for this identity.",
        });
      }
    }
  }
  return diagnostics.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function withdrawalConflictDiagnostics(
  plans: readonly {
    sourceObservationId: string;
    cardId: string;
    printingId: string | null;
    withdrawal: ProvenancedWithdrawal | null;
  }[],
): Diagnostic[] {
  const assertions = new Map<string, { semantics: Set<string>; observationIds: Set<string> }>();
  for (const plan of plans) {
    const withdrawal = plan.withdrawal;
    if (withdrawal === null) continue;
    const targets = [
      ...(withdrawal.entity === "card" || withdrawal.entity === "card_and_printing" ? [`card:${plan.cardId}`] : []),
      ...(plan.printingId !== null && (withdrawal.entity === "printing" || withdrawal.entity === "card_and_printing")
        ? [`printing:${plan.printingId}`]
        : []),
    ];
    for (const target of targets) {
      const grouped = assertions.get(target) ?? {
        semantics: new Set<string>(),
        observationIds: new Set<string>(),
      };
      grouped.semantics.add(
        canonicalJson({
          assertion: withdrawal.assertion,
          state: withdrawal.state,
          effective_at: withdrawal.effective_at,
        }),
      );
      grouped.observationIds.add(plan.sourceObservationId);
      assertions.set(target, grouped);
    }
  }
  return [...assertions]
    .filter(([, assertion]) => assertion.semantics.size > 1)
    .map(([target, assertion]) => ({
      code: "withdrawal_evidence_conflict" as const,
      source_observation_id: [...assertion.observationIds].sort()[0] ?? null,
      locator: null,
      matched_printing_ids: target.startsWith("printing:") ? [target.slice("printing:".length)] : [],
      detail:
        "Retained explicit withdrawal assertions conflict for the same entity and cannot be deterministically reconciled.",
    }));
}

function mergedPlanMemberships(
  plans: readonly {
    printingId: string | null;
    sourceLineage: string;
    memberships: Memberships;
  }[],
): {
  printingId: string;
  sourceLineage: string;
  memberships: Memberships;
}[] {
  const grouped = new Map<
    string,
    {
      printingId: string;
      sourceLineage: string;
      products: Set<string>;
      distributionContexts: Set<string>;
      sourceBuckets: Set<string>;
    }
  >();
  for (const plan of plans) {
    if (plan.printingId === null) continue;
    const key = canonicalJson([plan.sourceLineage, plan.printingId]);
    const membership = grouped.get(key) ?? {
      printingId: plan.printingId,
      sourceLineage: plan.sourceLineage,
      products: new Set<string>(),
      distributionContexts: new Set<string>(),
      sourceBuckets: new Set<string>(),
    };
    plan.memberships.products.forEach((value) => membership.products.add(value));
    plan.memberships.distribution_contexts.forEach((value) => membership.distributionContexts.add(value));
    plan.memberships.source_buckets.forEach((value) => membership.sourceBuckets.add(value));
    grouped.set(key, membership);
  }
  return [...grouped.values()].map((membership) => ({
    sourceLineage: membership.sourceLineage,
    printingId: membership.printingId,
    memberships: {
      products: [...membership.products].sort(),
      distribution_contexts: [...membership.distributionContexts].sort(),
      source_buckets: [...membership.sourceBuckets].sort(),
    },
  }));
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
  if (row === null || row.active_ingestion_run_id !== runId) {
    throw new AdministrationProblem(
      409,
      "run_not_active",
      "Only the active parsing Ingestion Run can reconcile retained evidence.",
    );
  }
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
import { ReconciliationTextStorageError } from "./reconciliation-text";
import { ReconciliationDocumentStorageError } from "./reconciliation-document";
import { ReconciliationNormalizationStorageError } from "./reconciliation-normalized";

function isStorageOrCapacityFailure(error: unknown): boolean {
  return (
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
