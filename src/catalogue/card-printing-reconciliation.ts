import { AdministrationProblem } from "./ingestion";
import { retainedReconciliationObservation } from "./reconciliation-evidence";
import {
  cardIdFor,
  compatibilityFor,
  isCompatible,
  printingIdFor,
  type Memberships,
  type PrintingCompatibility,
  type ProvenancedWithdrawal,
} from "./reconciliation-model";
import type {
  FixtureCandidate,
  FixtureCard,
  FixturePrintingImage,
  FixturePrinting,
  SupportedGame,
} from "./fixture";
import {
  compatiblePrintings,
  canonicalCardConflict,
  canonicalPrintingConflict,
  existingCard,
  hasCardObservationFromLineage,
  hasOtherGundamLocaleEvidence,
  hasPrintingLocatorFromLineage,
  printingFactsFormattingEquivalent,
  printingAtLocator,
  printingsWithAppearance,
} from "./reconciliation-repository";
import {
  failReconciliation,
  persistBlockedCandidate,
  persistReviewableCandidate,
} from "./reconciliation-candidate-store";
import {
  cardDisappearanceWarnings,
  printingDisappearanceWarnings,
  publicReconciledPrinting,
  relationshipDisappearanceWarnings,
} from "./reconciliation-read";
import { canonicalJson, sha256Text } from "./serialization";
import { reconcileProductReleaseCatalogue } from "./product-release-catalogue";
import { retainedPayload } from "./reconciliation-payload";

type ActiveRunRow = {
  id: string;
  state: string;
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

  const diagnostics: Diagnostic[] = [];
  const priorCandidate = await candidateAtRevision(
    database,
    run.expected_current_revision_id,
  );
  const cards = new Map<string, FixtureCard>(
    priorCandidate?.cards.map((card) => [card.id, card]) ?? [],
  );
  const printings = new Map<string, FixturePrinting>(
    priorCandidate?.printings.map((printing) => [printing.id, printing]) ?? [],
  );
  const printingImages = new Map<string, FixturePrintingImage>(
    priorCandidate?.printing_images?.map((image) => [image.id, image]) ?? [],
  );
  const localCardFacts = new Map<string, string>();
  const localPrintingFacts = new Map<
    string,
    Omit<FixturePrinting, "id" | "card_id">
  >();
  const localCompatibility = new Map<string, string>();
  const localLocators = new Map<
    string,
    { compatibility: PrintingCompatibility; printingId: string }
  >();
  const plans: {
    sourceObservationSetId: string;
    sourceSnapshotId: string;
    sourceObservationId: string;
    sourceLineage: string;
    supportedGame: SupportedGame;
    cardId: string;
    printingId: string | null;
    locator: string | null;
    variantKey: string | null;
    compatibility: PrintingCompatibility | null;
    memberships: Memberships;
    withdrawal: ProvenancedWithdrawal | null;
  }[] = [];
  const sourceWarnings: Record<string, unknown>[] = [];

  for (const observation of retained.observations) {
    const proposedCard = observation.candidateWithoutIdentities.card;
    if (proposedCard === null) {
      sourceWarnings.push(...observation.sourceWarnings);
      continue;
    }
    if (proposedCard.game !== observation.supportedGame) {
      diagnostics.push({
        code: "retained_evidence_invalid",
        source_observation_id: observation.sourceObservationId,
        locator: observation.locator,
        candidate_printing_ids: [],
        detail:
          "The retained Card Supported Game conflicts with its provenance envelope.",
      });
      continue;
    }
    const existing = await existingCard(database, {
      supportedGame: proposedCard.game,
      identityKind: proposedCard.official_identity.kind,
      identityValue: proposedCard.official_identity.value,
    });
    const cardId = existing?.id ?? (await cardIdFor(proposedCard));
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
    const publishedConflict = await canonicalCardConflict(
      database,
      cardId,
      proposedCard,
      observation.sourceLineage,
    );
    const carriedCard = cards.get(cardId);
    const retainAsiaAuthority =
      proposedCard.game === "gundam" &&
      observation.sourceLineage === "gundam-en-us" &&
      carriedCard !== undefined &&
      (await hasCardObservationFromLineage(
        database,
        cardId,
        "gundam-en-asia",
      ));
    let acceptedCard = proposedCard;
    if (retainAsiaAuthority) {
      const { id: _carriedId, ...authoritativeCard } = carriedCard;
      acceptedCard = fillAuthorityGaps(authoritativeCard, proposedCard);
    }
    const canonicalFacts = canonicalJson(acceptedCard);
    const priorFacts = localCardFacts.get(cardId);
    if (
      publishedConflict !== null ||
      (priorFacts !== undefined &&
        priorFacts !== canonicalFacts &&
        !retainAsiaAuthority)
    ) {
      diagnostics.push({
        code: "canonical_card_conflict",
        source_observation_id: observation.sourceObservationId,
        locator: observation.locator,
        candidate_printing_ids: [],
        detail:
          publishedConflict ??
          "Retained observations disagree on canonical Card facts and no deterministic authority rule resolves them.",
      });
    } else {
      localCardFacts.set(cardId, canonicalFacts);
      cards.set(cardId, { id: cardId, ...acceptedCard });
    }

    let compatibility: PrintingCompatibility | null = null;
    let printingId: string | null = null;
    const proposedPrinting = observation.candidateWithoutIdentities.printing;
    if (proposedPrinting !== null) {
      compatibility = compatibilityFor(
        cardId,
        observation.sourceLineage,
        observation,
      );
      const locator = observation.locator;
      if (locator === null) {
        throw new Error("A Printing observation has no locator.");
      }
      const compatibilityKey = canonicalJson(compatibility);
      const locatorKey = canonicalJson([
        observation.sourceLineage,
        locator,
      ]);
      const localLocated = localLocators.get(locatorKey);
      const [located, unfilteredDatabaseMatches, appearanceMatches] =
        await Promise.all([
          printingAtLocator(
            database,
            observation.sourceLineage,
            locator,
          ),
          compatiblePrintings(database, compatibility),
          printingsWithAppearance(database, compatibility),
        ]);
      const databaseMatches = unfilteredDatabaseMatches;
      const matchIds = new Set(databaseMatches.map((match) => match.id));
      const localMatch = localCompatibility.get(compatibilityKey);
      if (localMatch !== undefined) matchIds.add(localMatch);
      const locatedConflict =
        (located !== null && !isCompatible(located, compatibility)) ||
        (localLocated !== undefined &&
          !isCompatible(localLocated.compatibility, compatibility));
      if (locatedConflict) {
        const locatedId = located?.id ?? localLocated!.printingId;
        diagnostics.push({
          code: "printing_match_contradictory",
          source_observation_id: observation.sourceObservationId,
          locator,
          candidate_printing_ids: [locatedId],
          detail:
            "The retained locator contradicts the Card, Source Lineage, artwork, printed rules, rarity, or treatment of its existing Printing.",
        });
        printingId = locatedId;
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
          candidate_printing_ids: [...matchIds].sort(),
          detail:
            "A new Printing locator without an explicit Official Source artwork identity cannot be matched to an existing compatible Printing.",
        });
      } else if (matchIds.size > 1) {
        diagnostics.push({
          code: "printing_match_ambiguous",
          source_observation_id: observation.sourceObservationId,
          locator,
          candidate_printing_ids: [...matchIds].sort(),
          detail:
            "The retained evidence has more than one exactly compatible Printing.",
        });
        printingId = [...matchIds].sort()[0]!;
      } else if (located !== null || localLocated !== undefined) {
        printingId = located?.id ?? localLocated!.printingId;
      } else if (matchIds.size === 1) {
        printingId = [...matchIds][0]!;
      } else {
        printingId = await printingIdFor(compatibility);
        if (
          appearanceMatches.length > 0
        ) {
          diagnostics.push({
            code: "printing_match_contradictory",
            source_observation_id: observation.sourceObservationId,
            locator,
            candidate_printing_ids: appearanceMatches.map(({ id }) => id),
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
            candidate_printing_ids: [],
            detail:
              "A zero-match requires structurally complete retained adapter evidence and complete official Printing Image proof of a demonstrably novel appearance.",
          });
        }
      }
      localCompatibility.set(compatibilityKey, printingId);
      localLocators.set(locatorKey, { compatibility, printingId });
      const carriedPrinting = printings.get(printingId);
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
        (await hasPrintingLocatorFromLineage(
          database,
          printingId,
          "gundam-en-asia",
        ));
      let acceptedPrinting = proposedPrinting;
      if (retainAsiaPrintingAuthority) {
        const {
          id: _carriedPrintingId,
          card_id: _carriedCardId,
          ...authoritativePrinting
        } = carriedPrinting;
        acceptedPrinting = fillAuthorityGaps(
          authoritativePrinting,
          proposedPrinting,
        );
      }
      const priorPrintingFacts = localPrintingFacts.get(printingId);
      if (
        publishedPrintingConflict !== null ||
        (priorPrintingFacts !== undefined &&
          !retainAsiaPrintingAuthority &&
          !printingFactsFormattingEquivalent(
            priorPrintingFacts,
            acceptedPrinting,
          ))
      ) {
        diagnostics.push({
          code: "printing_match_contradictory",
          source_observation_id: observation.sourceObservationId,
          locator,
          candidate_printing_ids: [printingId],
          detail:
            publishedPrintingConflict ??
            "Retained observations disagree on canonical Printing facts and no deterministic authority rule resolves them.",
        });
      } else {
        localPrintingFacts.set(printingId, acceptedPrinting);
        printings.set(printingId, {
          id: printingId,
          card_id: cardId,
          ...acceptedPrinting,
        });
      }
      for (const image of observation.printingImages) {
        const id =
          `printing_image_${printingId.slice("printing_".length)}_` +
          `${image.role}_${image.content_sha256.slice(0, 12)}`;
        const candidateImage: FixturePrintingImage = {
          id,
          printing_id: printingId,
          object_key: `printing-images/${image.content_sha256}`,
          ...image,
        };
        const existingImage = printingImages.get(id);
        if (
          existingImage !== undefined &&
          !printingImageEvidenceEquivalent(existingImage, candidateImage)
        ) {
          diagnostics.push({
            code: "retained_evidence_invalid",
            source_observation_id: observation.sourceObservationId,
            locator,
            candidate_printing_ids: [printingId],
            detail:
              "A Printing Image identity maps to conflicting immutable bytes or metadata.",
          });
        } else {
          printingImages.set(
            id,
            existingImage === undefined
              ? candidateImage
              : {
                  ...existingImage,
                  source_url:
                    existingImage.source_url.localeCompare(
                      candidateImage.source_url,
                    ) <= 0
                      ? existingImage.source_url
                      : candidateImage.source_url,
                },
          );
        }
      }
      if (
        observation.supportedGame === "gundam" &&
        !(await hasOtherGundamLocaleEvidence(
          database,
          printingId,
          observation.sourceLineage,
        ))
      ) {
        sourceWarnings.push({
          code: "single_locale_gundam_printing",
          printing_id: printingId,
          source_lineage: observation.sourceLineage,
          detail:
            "The Gundam Printing is currently observed on only one English surface; publication retains that provenance for owner review.",
        });
      }
    } else if (!observation.structurallyComplete) {
      diagnostics.push({
        code: "printing_match_insufficient_evidence",
        source_observation_id: observation.sourceObservationId,
        locator: null,
        candidate_printing_ids: [],
        detail:
          "The Card-only retained observation is not structurally complete.",
      });
    }
    plans.push({
      sourceObservationSetId: observation.sourceObservationSetId,
      sourceSnapshotId: observation.sourceSnapshotId,
      sourceObservationId: observation.sourceObservationId,
      sourceLineage: observation.sourceLineage,
      supportedGame: observation.supportedGame,
      cardId,
      printingId,
      locator: observation.locator,
      variantKey: observation.variantKey,
      compatibility,
      memberships: observation.memberships,
      withdrawal:
        observation.withdrawal === null
          ? null
          : {
              ...observation.withdrawal,
              assertion: "withdrawn",
              source_lineage: observation.sourceLineage,
              source_snapshot_id: observation.sourceSnapshotId,
              source_observation_set_id:
                observation.sourceObservationSetId,
              source_observation_id: observation.sourceObservationId,
            },
    });
    sourceWarnings.push(...observation.sourceWarnings);
  }

  diagnostics.push(
    ...withdrawalConflictDiagnostics(plans),
    ...(await publishedWithdrawalConflictDiagnostics(database, plans)),
  );

  let productCatalogue: Awaited<
    ReturnType<typeof reconcileProductReleaseCatalogue>
  > = {
    products: [...(priorCandidate?.products ?? [])],
    observedProducts: [],
    distribution_contexts: [
      ...(priorCandidate?.distribution_contexts ?? []),
    ],
    product_relationships: [
      ...(priorCandidate?.product_relationships ?? []),
    ],
    productSurfaceObserved: false,
    warnings: [] as Record<string, unknown>[],
  };
  const observedProductGames = new Set<SupportedGame>();
  const observedProductLineages = new Set<string>();
  try {
    const plansByObservationId = new Map(
      plans.map((plan) => [plan.sourceObservationId, plan]),
    );
    const observationsByGame = new Map<
      SupportedGame,
      typeof retained.observations
    >();
    for (const observation of retained.observations) {
      observationsByGame.set(observation.supportedGame, [
        ...(observationsByGame.get(observation.supportedGame) ?? []),
        observation,
      ]);
    }
    for (const [game, gameObservations] of observationsByGame) {
      const reconciled = await reconcileProductReleaseCatalogue(
        productCatalogue,
        gameObservations.map((observation) => {
          const plan = plansByObservationId.get(
            observation.sourceObservationId,
          );
          return {
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
        }),
        game,
      );
      productCatalogue = {
        products: reconciled.products,
        observedProducts: [
          ...productCatalogue.observedProducts,
          ...reconciled.observedProducts,
        ],
        distribution_contexts: reconciled.distribution_contexts,
        product_relationships: reconciled.product_relationships,
        productSurfaceObserved:
          productCatalogue.productSurfaceObserved ||
          reconciled.productSurfaceObserved,
        warnings: [
          ...productCatalogue.warnings,
          ...reconciled.warnings,
        ],
      };
      if (reconciled.productSurfaceObserved) {
        observedProductGames.add(game);
        gameObservations
          .filter(
            ({ productReleaseValue }) =>
              productReleaseValue !== undefined,
          )
          .forEach(({ sourceLineage }) =>
            observedProductLineages.add(sourceLineage),
          );
      }
    }
  } catch (error) {
    diagnostics.push({
      code: "retained_evidence_invalid",
      source_observation_id: null,
      locator: null,
      candidate_printing_ids: [],
      detail:
        error instanceof Error
          ? error.message
          : "Retained Product evidence is invalid.",
    });
  }
  const cardSurfaceObservations = retained.observations.filter(
    (observation) =>
      observation.candidateWithoutIdentities.card !== null,
  );
  const productSurfaceObservations = retained.observations.filter(
    (observation) => observation.productReleaseValue !== undefined,
  );
  const candidate: FixtureCandidate = {
    fixture: "first-catalogue",
    selected_games: [
      ...new Set([
        ...(priorCandidate?.selected_games ?? []),
        ...retained.observations.map(
          ({ supportedGame }) => supportedGame,
        ),
      ]),
    ].sort(),
    cards: [...cards.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    printings: [...printings.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    printing_images: [...printingImages.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    products: productCatalogue.products,
    distribution_contexts: productCatalogue.distribution_contexts,
    product_relationships: productCatalogue.product_relationships,
    card_observed_games: [
      ...new Set(
        cardSurfaceObservations.map(
          ({ supportedGame }) => supportedGame,
        ),
      ),
    ].sort(),
    product_observed_games: [...observedProductGames].sort(),
    product_observed_lineages: [...observedProductLineages].sort(),
    source_checks: [
      ...groupObservationsByGame(cardSurfaceObservations).map(
        ([game, observations]) => ({
          game,
          area: "cards-and-printings" as const,
          checked_at: latestCapture(observations),
        }),
      ),
      ...groupObservationsByGame(productSurfaceObservations).map(
        ([game, observations]) => ({
          game,
          area: "products-and-releases" as const,
          checked_at: latestCapture(observations),
        }),
      ),
    ],
  };
  const groupedMemberships = mergedPlanMemberships(plans);
  const relationshipWarnings = (
    await Promise.all(
      groupedMemberships.map(({ printingId, sourceLineage, memberships }) =>
        relationshipDisappearanceWarnings(
          database,
          printingId,
          sourceLineage,
          memberships,
        ),
      ),
    )
  ).flat();
  const checkedSourceLineages = [
    ...new Set(retained.partitions.map(({ sourceLineage }) => sourceLineage)),
  ].sort();
  const plansByLineage = checkedSourceLineages.map(
    (sourceLineage) =>
      [
        sourceLineage,
        plans.filter((plan) => plan.sourceLineage === sourceLineage),
      ] as const,
  );
  const disappearanceWarnings = (
    await Promise.all(
      plansByLineage.map(([lineage, lineagePlans]) =>
        printingDisappearanceWarnings(
          database,
          lineage,
          lineagePlans.flatMap((plan) =>
            plan.printingId === null ? [] : [plan.printingId],
          ),
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
  const warnings = [
    ...new Map(
      [
        ...sourceWarnings,
        ...relationshipWarnings,
        ...disappearanceWarnings,
        ...cardWarnings,
        ...productCatalogue.warnings,
      ].map((warning) => [canonicalJson(warning), warning]),
    ).values(),
  ].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
  const digestPayloadJson = canonicalJson({
    catalogue_data: candidate,
    evidence_partitions: retained.partitions,
    observation_plans: digestObservationPlans(plans),
  });
  const candidateDigest = await sha256Text(digestPayloadJson);
  const candidateCatalogueDigest = await catalogueDataDigest(
    database,
    candidate,
    plans,
    checkedSourceLineages,
  );
  const observedCards = [...cards.values()]
    .filter((card) => localCardFacts.has(card.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const observedPrintings = [...printings.values()]
    .filter((printing) =>
      plans.some((plan) => plan.printingId === printing.id),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (diagnostics.length > 0) {
    const stableDiagnostics = [...diagnostics].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
    await persistBlockedCandidate(database, {
      runId,
      observationSetId: retained.observationSetId,
      sourceSnapshotId: retained.sourceSnapshotId,
      sourceLineage: retained.sourceLineage,
      partitions: retained.partitions,
      plans,
      diagnostics: stableDiagnostics,
      candidate,
      digestPayloadJson,
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
      diagnostics: stableDiagnostics,
      warnings,
    };
  }
  await persistReviewableCandidate(database, {
    runId,
    observationSetId: retained.observationSetId,
    sourceSnapshotId: retained.sourceSnapshotId,
    sourceLineage: retained.sourceLineage,
    partitions: retained.partitions,
    plans,
    warnings,
    candidate,
    digestPayloadJson,
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
    [...new Set([
      ...Object.keys(authoritative),
      ...Object.keys(corroborating),
    ])].map((field) => [
      field,
      fillAuthorityGaps(authoritative[field], corroborating[field]),
    ]),
  ) as T;
}

async function candidateAtRevision(
  database: D1Database,
  revisionId: string,
): Promise<FixtureCandidate | null> {
  const row = await database
    .prepare(
      `SELECT run.id AS ingestion_run_id, run.candidate_json
       FROM catalogue_revisions AS revision
       JOIN ingestion_runs AS run ON run.id = revision.ingestion_run_id
       WHERE revision.id = ?`,
    )
    .bind(revisionId)
    .first<{ ingestion_run_id: string; candidate_json: string }>();
  if (row === null) return null;
  return JSON.parse(
    await retainedPayload(
      database,
      row.ingestion_run_id,
      "candidate",
      row.candidate_json,
    ),
  ) as FixtureCandidate;
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

function digestObservationPlans(
  plans: readonly {
    sourceObservationId: string;
    sourceLineage: string;
    supportedGame: SupportedGame;
    cardId: string;
    printingId: string | null;
    locator: string | null;
    variantKey: string | null;
    compatibility: PrintingCompatibility | null;
    memberships: Memberships;
    withdrawal: ProvenancedWithdrawal | null;
  }[],
): Record<string, unknown>[] {
  return [...plans].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

async function catalogueDataDigest(
  database: D1Database,
  candidate: FixtureCandidate,
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
  const printingIds = new Set(
    candidate.printings.map((printing) => printing.id),
  );
  const cardIds = new Set(candidate.cards.map((card) => card.id));
  const [storedMemberships, storedCards, storedPrintings] =
    await Promise.all([
      database
        .prepare(
          `SELECT printing_id, source_lineage, relationship_kind,
                  relationship_value
           FROM reconciled_printing_memberships
           WHERE current = 1
           ORDER BY printing_id, source_lineage,
                    relationship_kind, relationship_value`,
        )
        .all<{
          printing_id: string;
          source_lineage: string;
          relationship_kind: string;
          relationship_value: string;
        }>(),
      database
        .prepare(
          `SELECT id, withdrawal_evidence_json
           FROM reconciled_cards
           WHERE withdrawn = 1
           ORDER BY id`,
        )
        .all<{ id: string; withdrawal_evidence_json: string | null }>(),
      database
        .prepare(
          `SELECT id, withdrawal_evidence_json
           FROM reconciled_printings
           WHERE withdrawn = 1
           ORDER BY id`,
        )
        .all<{ id: string; withdrawal_evidence_json: string | null }>(),
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
      const evidence = JSON.parse(row.withdrawal_evidence_json) as
        Record<string, unknown>;
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
      ...(plan.withdrawal.entity === "card" ||
      plan.withdrawal.entity === "card_and_printing"
        ? [{ entityType: "card", entityId: plan.cardId }]
        : []),
      ...(plan.printingId !== null &&
      (plan.withdrawal.entity === "printing" ||
        plan.withdrawal.entity === "card_and_printing")
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
  return sha256Text(
    canonicalJson({
      catalogue_data: catalogueCandidate,
      current_memberships: [...memberships.values()].sort(compareCanonical),
      withdrawals: [...withdrawals.values()].sort(compareCanonical),
    }),
  );
}

function semanticCatalogueCandidate(
  candidate: FixtureCandidate,
): Record<string, unknown> {
  return {
    fixture: candidate.fixture,
    selected_games: candidate.selected_games,
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
      releases: product.releases,
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
      ({ source_lineages: _lineages, ...context }) =>
        context,
    ),
    product_relationships: (candidate.product_relationships ?? []).map(
      ({
        source_observation_ids: _observationIds,
        ...relationship
      }) => relationship,
    ),
  };
}

function latestCapture(
  observations: readonly { sourceCapturedAt: string }[],
): string {
  return observations
    .map(({ sourceCapturedAt }) => sourceCapturedAt)
    .sort()
    .at(-1)!;
}

function groupObservationsByGame<
  T extends { supportedGame: SupportedGame },
>(observations: readonly T[]): [SupportedGame, T[]][] {
  const grouped = new Map<SupportedGame, T[]>();
  for (const observation of observations) {
    grouped.set(observation.supportedGame, [
      ...(grouped.get(observation.supportedGame) ?? []),
      observation,
    ]);
  }
  return [...grouped].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function groupPlansByLineage<
  T extends { sourceLineage: string },
>(plans: readonly T[]): [string, T[]][] {
  const grouped = new Map<string, T[]>();
  for (const plan of plans) {
    grouped.set(plan.sourceLineage, [
      ...(grouped.get(plan.sourceLineage) ?? []),
      plan,
    ]);
  }
  return [...grouped].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function compareCanonical(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

async function publishedWithdrawalConflictDiagnostics(
  database: D1Database,
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
      ...(withdrawal.entity === "card" ||
      withdrawal.entity === "card_and_printing"
        ? [{ entityType: "card", entityId: plan.cardId }]
        : []),
      ...(plan.printingId !== null &&
      (withdrawal.entity === "printing" ||
        withdrawal.entity === "card_and_printing")
        ? [{ entityType: "printing", entityId: plan.printingId }]
        : []),
    ];
    for (const target of targets) {
      const prior = await database
        .prepare(
          `SELECT assertion, state, effective_at
           FROM reconciled_withdrawal_assertions
           WHERE entity_type = ? AND entity_id = ?
           ORDER BY published_catalogue_revision_id, source_observation_id`,
        )
        .bind(target.entityType, target.entityId)
        .all<{
          assertion: string;
          state: string;
          effective_at: string;
        }>();
      const proposedSemantic = canonicalJson({
        assertion: withdrawal.assertion,
        state: withdrawal.state,
        effective_at: withdrawal.effective_at,
      });
      if (
        prior.results.some(
          (row) =>
            canonicalJson({
              assertion: row.assertion,
              state: row.state,
              effective_at: row.effective_at,
            }) !== proposedSemantic,
        )
      ) {
        diagnostics.push({
          code: "withdrawal_evidence_conflict",
          source_observation_id: plan.sourceObservationId,
          locator: null,
          candidate_printing_ids:
            target.entityType === "printing" ? [target.entityId] : [],
          detail:
            "The explicit withdrawal assertion conflicts with the published withdrawal history for this identity.",
        });
      }
    }
  }
  return diagnostics.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function withdrawalConflictDiagnostics(
  plans: readonly {
    sourceObservationId: string;
    cardId: string;
    printingId: string | null;
    withdrawal: ProvenancedWithdrawal | null;
  }[],
): Diagnostic[] {
  const assertions = new Map<
    string,
    { semantics: Set<string>; observationIds: Set<string> }
  >();
  for (const plan of plans) {
    const withdrawal = plan.withdrawal;
    if (withdrawal === null) continue;
    const targets = [
      ...(withdrawal.entity === "card" ||
      withdrawal.entity === "card_and_printing"
        ? [`card:${plan.cardId}`]
        : []),
      ...(plan.printingId !== null &&
      (withdrawal.entity === "printing" ||
        withdrawal.entity === "card_and_printing")
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
      candidate_printing_ids: target.startsWith("printing:")
        ? [target.slice("printing:".length)]
        : [],
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
    plan.memberships.products.forEach((value) =>
      membership.products.add(value),
    );
    plan.memberships.distribution_contexts.forEach((value) =>
      membership.distributionContexts.add(value),
    );
    plan.memberships.source_buckets.forEach((value) =>
      membership.sourceBuckets.add(value),
    );
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

function printingImageEvidenceEquivalent(
  left: FixturePrintingImage,
  right: FixturePrintingImage,
): boolean {
  const { source_url: _leftSourceUrl, ...leftEvidence } = left;
  const { source_url: _rightSourceUrl, ...rightEvidence } = right;
  return canonicalJson(leftEvidence) === canonicalJson(rightEvidence);
}

async function requiredActiveParsingRun(
  database: D1Database,
  runId: string,
): Promise<ActiveRunRow> {
  const row = await database
    .prepare(
      `SELECT run.id, run.state, run.expected_current_revision_id,
              operation.active_ingestion_run_id,
              operation.recovery_health
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
  if (row.recovery_health !== "healthy") {
    throw new AdministrationProblem(
      409,
      "recovery_not_verified",
      "Recovery is not healthy, so reconciliation is blocked.",
    );
  }
  return row;
}
