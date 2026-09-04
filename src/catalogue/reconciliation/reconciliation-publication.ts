import { requiredSourceAdapter } from "../adapters";
import { curatedPublicationStatements } from "../curated";
import {
  byteBoundedJsonArrays,
  type CatalogueCandidate,
  type CatalogueStore,
  canonicalJson,
  retainedPayload,
} from "../shared";
import { applicableRulesTextErrata, erratumTargetLifecycleKey } from "./errata-rules-text";
import { type ProductRelationshipLifecycle, productReleaseLifecyclePlan } from "./product-release-publication";
import type { NormalizedLifecycle } from "./publication-lifecycle-types";
import { type CandidatePlanRow, reconciliationCandidatePlans } from "./reconciliation-candidate-store";
import {
  isCompatible,
  type Memberships,
  type PrintingCompatibility,
  type ProvenancedWithdrawal,
} from "./reconciliation-model";
import {
  carriedCardLifecyclesStatement,
  carriedPrintingLifecyclesStatement,
  carriedRevisionStatement,
  deactivatePublicationEvidenceStatements,
  erratumTargetLifecycleStatement,
  inferredProductRevisionTimeStatement,
  printingLocatorLifecycleStatement,
  printingRelationshipLifecycleStatement,
  publicationContextStatement,
  type PublicationContextRow,
  type PublicationLineageRow,
  publicationEntityLifecyclesStatement,
  publicationEvidenceByIdsStatement,
  publicationEvidenceStatement,
  publicationLineagesStatement,
  publishCardObservationsStatement,
  publishErratumProvenanceStatement,
  publishPrintingLocatorsStatement,
  publishPrintingMembershipsStatement,
  publishReconciledCardsStatement,
  publishReconciledErrataStatement,
  publishReconciledPrintingsStatement,
  publishRevisionErrataStatement,
  publishWithdrawalAssertionsStatement,
  requiredPublicationCandidateStatement,
} from "./reconciliation-publication-repository";
import {
  aggregateRelationshipEvidence,
  membershipEntries,
  type RelationshipEvidence,
  type RelationshipEvidenceRow,
} from "./reconciliation-relationships";
import type { ReconciledCardRow, ReconciledPrintingRow } from "./reconciliation-repository";

export type LocatorEvidence = {
  source_lineage: string;
  locator: string;
  variant_key: string | null;
  first_revision_id: string;
  last_observed_revision_id: string;
  current: boolean;
  last_missing_revision_id: string | null;
};

export type LocatorEvidenceCollection = {
  current: LocatorEvidence[];
  historical: LocatorEvidence[];
};

export type ReconciliationPublicationPlan = {
  cardLifecycles: Record<string, NormalizedLifecycle>;
  printingLifecycles: Record<string, NormalizedLifecycle>;
  productLifecycles: Record<string, NormalizedLifecycle>;
  releaseLifecycles: Record<
    string,
    {
      first_revision_id: string;
      last_observed_revision_id: string;
    }
  >;
  productRelationshipLifecycles: Record<string, ProductRelationshipLifecycle>;
  erratumTargetLifecycles: Record<string, NormalizedLifecycle>;
  relationshipEvidence: Record<string, RelationshipEvidence[]>;
  locatorEvidence: Record<string, LocatorEvidenceCollection>;
  cardEvidence: Record<string, PublicationEvidenceResource[]>;
  cardEffectiveRulesEvidence: Record<string, PublicationEvidenceResource[]>;
  printingEvidence: Record<string, PublicationEvidenceResource[]>;
  statements: D1PreparedStatement[];
};

export type PublicationEvidenceResource = {
  type: "source_observation";
  id: string;
  captured_at: string;
  source: string;
};

type PublicationRows = {
  cards: Record<string, unknown>[];
  cardDeactivations: Record<string, unknown>[];
  cardObservations: Record<string, unknown>[];
  printings: Record<string, unknown>[];
  locatorDeactivations: Record<string, unknown>[];
  locators: Record<string, unknown>[];
  membershipDeactivations: Record<string, unknown>[];
  memberships: Record<string, unknown>[];
};

export async function reconciliationPublication(
  database: CatalogueStore,
  runId: string,
  revisionId: string,
  revisionOrder = revisionId,
): Promise<ReconciliationPublicationPlan | null> {
  const plans = await reconciliationCandidatePlans(database, runId);
  const currentEvidenceByObservation = await publicationEvidenceResources(database, plans);
  const context = await publicationContextStatement(database, runId).first<PublicationContextRow>();
  if (context === null) return null;
  const evidencePartitions = await publicationLineagesStatement(database, runId).all<PublicationLineageRow>();
  if (evidencePartitions.results.length === 0)
    throw new Error("The Reconciliation Context has no evidence partitions.");
  const observedSourceLineages = [...new Set(evidencePartitions.results.map(({ source_lineage }) => source_lineage))];
  const candidate = JSON.parse(await requiredRunCandidate(database, runId)) as CatalogueCandidate;
  const erratumObservationIds = [
    ...new Set(
      (candidate.errata ?? []).flatMap((erratum) =>
        erratum.provenance.map(({ source_observation_id }) => source_observation_id),
      ),
    ),
  ].sort();
  const evidenceByObservation = await publicationEvidenceResourcesByIds(database, erratumObservationIds);
  for (const [id, evidence] of currentEvidenceByObservation) {
    evidenceByObservation.set(id, evidence);
  }
  const cards = new Map(candidate.cards.map((card) => [card.id, card]));
  const printings = new Map(candidate.printings.map((printing) => [printing.id, printing]));
  const cardPlans = groupedPlans(
    plans.filter((plan) => plan.observation_kind === "card_printing"),
    (plan) => plan.card_id,
  );
  const cardEvidencePlans = groupedPlans(
    plans.filter((plan) => plan.observation_kind === "card_printing"),
    (plan) => plan.card_id,
  );
  const printingPlans = groupedPlans(
    plans.filter((plan) => plan.observation_kind === "card_printing" && plan.printing_id !== null),
    (plan) => plan.printing_id!,
  );
  const [existingCards, existingPrintings, existingMemberships, existingLocators] = await Promise.all([
    rowsById<ReconciledCardRow>(database, "card", [...cardPlans.keys()]),
    rowsById<ReconciledPrintingRow>(database, "printing", [...printingPlans.keys()]),
    relationshipRowsByPrinting(database, [...printingPlans.keys()]),
    locatorRowsByPrinting(database, [...printingPlans.keys()]),
  ]);
  const publicationRows: PublicationRows = {
    cards: [],
    cardDeactivations: [],
    cardObservations: [],
    printings: [],
    locatorDeactivations: [],
    locators: [],
    membershipDeactivations: [],
    memberships: [],
  };
  const result: ReconciliationPublicationPlan = {
    cardLifecycles: {},
    printingLifecycles: {},
    productLifecycles: {},
    releaseLifecycles: {},
    productRelationshipLifecycles: {},
    erratumTargetLifecycles: {},
    relationshipEvidence: {},
    locatorEvidence: {},
    cardEvidence: {},
    cardEffectiveRulesEvidence: {},
    printingEvidence: {},
    statements: [],
  };

  for (const [cardId, grouped] of cardEvidencePlans) {
    const evidence = grouped.map((plan) => evidenceByObservation.get(plan.source_observation_id)!);
    result.cardEvidence[cardId] = evidence;
  }
  for (const card of candidate.cards) {
    const applicableErrata = applicableRulesTextErrata(card, candidate.errata ?? [], context.observed_at);
    if (applicableErrata.length === 0) {
      const currentCardEvidence = result.cardEvidence[card.id];
      if (currentCardEvidence !== undefined) {
        result.cardEffectiveRulesEvidence[card.id] = currentCardEvidence;
      }
      continue;
    }
    const observationIds = [
      ...new Set(
        applicableErrata.flatMap((erratum) =>
          erratum.provenance.map(({ source_observation_id }) => source_observation_id),
        ),
      ),
    ].sort();
    result.cardEffectiveRulesEvidence[card.id] = observationIds.map((id) => {
      const evidence = evidenceByObservation.get(id);
      if (evidence === undefined) {
        throw new Error("Applicable Erratum publication evidence disappeared.");
      }
      return evidence;
    });
  }

  for (const [cardId, grouped] of cardPlans) {
    const card = cards.get(cardId);
    if (card === undefined) throw new Error("The reconciliation Card plan changed.");
    const existing = existingCards.get(cardId) ?? null;
    const withdrawal = mergedWithdrawal(grouped, "card");
    const withdraw = withdrawal?.entity === "card" || withdrawal?.entity === "card_and_printing";
    const withdrawalLifecycle = resolvedWithdrawalLifecycle(existing, withdraw, withdrawal, revisionId);
    result.cardLifecycles[cardId] = normalizedLifecycle(
      existing?.first_revision_id ?? revisionId,
      revisionId,
      existing?.withdrawn === 1 || withdraw,
      withdrawalLifecycle.revisionId,
      withdrawalLifecycle.evidenceJson,
    );
    publicationRows.cards.push(cardPersistenceRow(grouped[0]!, card, revisionId, existing, withdrawal));
    for (const sourceLineage of new Set(grouped.map((plan) => plan.source_lineage))) {
      publicationRows.cardDeactivations.push({
        card_id: card.id,
        source_lineage: sourceLineage,
      });
    }
    publicationRows.cardObservations.push(
      ...grouped.map((plan) => {
        if (plan.source_card_facts_json === null) {
          throw new Error("The source-observed Card facts are unavailable.");
        }
        return {
          card_id: card.id,
          source_lineage: plan.source_lineage,
          source_observation_id: plan.source_observation_id,
          canonical_facts_json: plan.source_card_facts_json,
        };
      }),
    );
  }

  for (const [printingId, grouped] of printingPlans) {
    const printing = printings.get(printingId);
    if (printing === undefined) {
      throw new Error("The reconciliation Printing plan changed.");
    }
    const first = grouped[0]!;
    result.printingEvidence[printingId] = grouped.map((plan) => evidenceByObservation.get(plan.source_observation_id)!);
    if (first.compatibility_json === null) {
      throw new Error("The reconciliation Printing compatibility disappeared.");
    }
    const compatibility = JSON.parse(first.compatibility_json) as PrintingCompatibility;
    if (
      grouped.some(
        (plan) =>
          plan.compatibility_json === null ||
          !isCompatible(JSON.parse(plan.compatibility_json) as PrintingCompatibility, compatibility),
      )
    ) {
      throw new Error("One Printing has incompatible publication plans.");
    }
    const withdrawal = mergedWithdrawal(grouped, "printing");
    const withdraw = withdrawal?.entity === "printing" || withdrawal?.entity === "card_and_printing";
    const existing = existingPrintings.get(printingId) ?? null;
    const withdrawalLifecycle = resolvedWithdrawalLifecycle(existing, withdraw, withdrawal, revisionId);
    result.printingLifecycles[printingId] = normalizedLifecycle(
      existing?.first_revision_id ?? revisionId,
      revisionId,
      existing?.withdrawn === 1 || withdraw,
      withdrawalLifecycle.revisionId,
      withdrawalLifecycle.evidenceJson,
    );
    result.relationshipEvidence[printingId] = nextRelationshipEvidence(
      existingMemberships.get(printingId) ?? [],
      grouped,
      revisionId,
      revisionOrder,
    );
    result.locatorEvidence[printingId] = nextLocatorEvidence(
      existingLocators.get(printingId) ?? [],
      grouped,
      revisionId,
    );
    publicationRows.printings.push(printingPersistenceRow(first, compatibility, revisionId, existing, withdrawal));
    for (const sourceLineage of new Set(grouped.map((plan) => plan.source_lineage))) {
      publicationRows.locatorDeactivations.push({
        printing_id: printingId,
        source_lineage: sourceLineage,
      });
      publicationRows.membershipDeactivations.push({
        printing_id: printingId,
        source_lineage: sourceLineage,
      });
    }
    for (const plan of grouped) {
      if (plan.locator === null) {
        throw new Error("The reconciliation Printing locator disappeared.");
      }
      publicationRows.locators.push({
        printing_id: printingId,
        source_lineage: plan.source_lineage,
        locator: plan.locator,
        variant_key: plan.variant_key,
      });
      publicationRows.memberships.push(
        ...membershipEntries(JSON.parse(plan.memberships_json) as Memberships).map((membership) => ({
          printing_id: printingId,
          source_lineage: plan.source_lineage,
          source_observation_id: plan.source_observation_id,
          relationship_kind: membership.relationship_kind,
          relationship_value: membership.relationship_value,
        })),
      );
    }
  }
  await retainCarriedLifecycles(
    database,
    runId,
    candidate,
    result,
    publicationRows,
    observedSourceLineages,
    evidencePartitions.results.every(
      ({ adapter_version }) => requiredSourceAdapter(adapter_version).reconciliationCapability === "catalogue",
    ),
    revisionId,
  );
  const productReleaseLifecycles = await productReleaseLifecyclePlan(database, candidate, revisionId);
  const inferredProductLifecycles = await aggregateInferredProductLifecycles(
    database,
    candidate,
    result.relationshipEvidence,
    revisionId,
    revisionOrder,
  );
  result.productLifecycles = {
    ...inferredProductLifecycles,
    ...productReleaseLifecycles.products,
  };
  result.releaseLifecycles = productReleaseLifecycles.releases;
  result.productRelationshipLifecycles = productReleaseLifecycles.relationships;
  const observedProvenance = new Set(
    plans.map((plan) => provenanceKey(plan.source_lineage, plan.source_observation_id)),
  );
  result.erratumTargetLifecycles = await erratumTargetLifecycles(
    database,
    candidate.errata ?? [],
    observedProvenance,
    revisionId,
  );
  result.statements.push(
    ...publicationStatements(database, publicationRows, plans, revisionId),
    ...errataPublicationStatements(database, candidate.errata ?? [], observedProvenance, revisionId),
    ...(await curatedPublicationStatements(database, runId, revisionId)),
  );
  return result;
}

async function publicationEvidenceResources(
  database: CatalogueStore,
  plans: readonly CandidatePlanRow[],
): Promise<Map<string, PublicationEvidenceResource>> {
  if (plans.length === 0) return new Map();
  const rows = await publicationEvidenceStatement(
    database,
    plans[0]!.ingestion_run_id,
  ).all<PublicationEvidenceResource>();
  const resources = new Map(rows.results.map((row) => [row.id, { ...row, type: "source_observation" as const }]));
  for (const plan of plans) {
    if (!resources.has(plan.source_observation_id)) {
      throw new Error("Publication Source Observation evidence disappeared.");
    }
  }
  return resources;
}

async function publicationEvidenceResourcesByIds(
  database: CatalogueStore,
  observationIds: readonly string[],
): Promise<Map<string, PublicationEvidenceResource>> {
  const resources = new Map<string, PublicationEvidenceResource>();
  for (const idsJson of observationIds.length === 0 ? [] : byteBoundedJsonArrays(observationIds)) {
    const rows = await publicationEvidenceByIdsStatement(database, idsJson).all<PublicationEvidenceResource>();
    for (const row of rows.results) {
      const resource = {
        ...row,
        type: "source_observation" as const,
      };
      const existing = resources.get(row.id);
      if (existing !== undefined && canonicalJson(existing) !== canonicalJson(resource)) {
        throw new Error("Immutable publication evidence changed.");
      }
      resources.set(row.id, resource);
    }
  }
  for (const id of observationIds) {
    if (!resources.has(id)) {
      throw new Error("Applicable Erratum publication evidence disappeared.");
    }
  }
  return resources;
}

function errataPublicationStatements(
  database: CatalogueStore,
  errata: NonNullable<CatalogueCandidate["errata"]>,
  observedProvenance: ReadonlySet<string>,
  revisionId: string,
): D1PreparedStatement[] {
  const statements = (values: readonly Record<string, unknown>[], prepare: (payload: string) => D1PreparedStatement) =>
    byteBoundedJsonArrays(values).map(prepare);
  const observedErrata = errata
    .map((erratum) => ({
      erratum,
      provenance: erratum.provenance.filter((provenance) =>
        observedProvenance.has(provenanceKey(provenance.source_lineage, provenance.source_observation_id)),
      ),
    }))
    .filter(({ provenance }) => provenance.length > 0);
  const canonicalRows = observedErrata.map(({ erratum }) => ({
    id: erratum.id,
    game: erratum.game,
    target_type: erratum.target_type,
    target_id: erratum.target_id,
    effective_from: erratum.effective_from,
    official_wording: erratum.official_wording,
    corrected_value_json: canonicalJson(erratum.corrected_value),
  }));
  const provenanceRows = observedErrata.flatMap(({ erratum, provenance }) =>
    provenance.map((item) => ({
      erratum_id: erratum.id,
      source_lineage: item.source_lineage,
      source_observation_id: item.source_observation_id,
    })),
  );
  const revisionRows = errata.map((erratum) => ({
    erratum_id: erratum.id,
  }));
  return [
    ...statements(canonicalRows, (payload) =>
      publishReconciledErrataStatement(database, {
        revisionId: revisionId,
        observedRevisionId: revisionId,
        payload: payload,
      }),
    ),
    ...statements(provenanceRows, (payload) =>
      publishErratumProvenanceStatement(database, {
        revisionId: revisionId,
        observedRevisionId: revisionId,
        payload: payload,
      }),
    ),
    ...statements(revisionRows, (payload) =>
      publishRevisionErrataStatement(database, { revisionId: revisionId, payload: payload }),
    ),
  ];
}

async function erratumTargetLifecycles(
  database: CatalogueStore,
  errata: NonNullable<CatalogueCandidate["errata"]>,
  observedProvenance: ReadonlySet<string>,
  revisionId: string,
): Promise<Record<string, NormalizedLifecycle>> {
  const ids = [...new Set(errata.map((erratum) => erratum.id))];
  const existing: {
    erratum_id: string;
    source_lineage: string;
    first_revision_id: string;
    last_observed_revision_id: string;
    first_order: string;
    last_order: string;
  }[] = [];
  for (const idChunk of ids.length === 0 ? [] : byteBoundedJsonArrays(ids)) {
    const rows = await erratumTargetLifecycleStatement(database, idChunk).all<{
      erratum_id: string;
      source_lineage: string;
      first_revision_id: string;
      last_observed_revision_id: string;
      first_order: string;
      last_order: string;
    }>();
    existing.push(...rows.results);
  }
  const result: Record<string, NormalizedLifecycle> = {};
  for (const erratum of errata) {
    const lineages = new Set(erratum.provenance.map((item) => item.source_lineage));
    for (const sourceLineage of lineages) {
      const prior = existing.filter((row) => row.erratum_id === erratum.id && row.source_lineage === sourceLineage);
      const first = [...prior].sort((left, right) =>
        canonicalJson([left.first_order, left.first_revision_id]).localeCompare(
          canonicalJson([right.first_order, right.first_revision_id]),
        ),
      )[0];
      const last = [...prior].sort((left, right) =>
        canonicalJson([right.last_order, right.last_observed_revision_id]).localeCompare(
          canonicalJson([left.last_order, left.last_observed_revision_id]),
        ),
      )[0];
      const observed = erratum.provenance.some(
        (item) =>
          item.source_lineage === sourceLineage &&
          observedProvenance.has(provenanceKey(item.source_lineage, item.source_observation_id)),
      );
      result[erratumTargetLifecycleKey(erratum.id, sourceLineage)] = normalizedLifecycle(
        first?.first_revision_id ?? revisionId,
        observed ? revisionId : (last?.last_observed_revision_id ?? revisionId),
        false,
        null,
        null,
      );
    }
  }
  return result;
}

function provenanceKey(sourceLineage: string, sourceObservationId: string): string {
  return canonicalJson([sourceLineage, sourceObservationId]);
}

async function aggregateInferredProductLifecycles(
  database: CatalogueStore,
  candidate: CatalogueCandidate,
  relationships: Readonly<Record<string, readonly RelationshipEvidence[]>>,
  revisionId: string,
  revisionOrder: string,
): Promise<Record<string, NormalizedLifecycle>> {
  const cards = new Map(candidate.cards.map((card) => [card.id, card]));
  const grouped = new Map<string, { firstRevisionId: string; lastObservedRevisionId: string }[]>();
  for (const printing of candidate.printings) {
    const game = cards.get(printing.card_id)?.game;
    if (game === undefined) continue;
    for (const relationship of relationships[printing.id] ?? []) {
      if (relationship.relationship_kind !== "product") continue;
      const declared = candidate.products?.some(
        (product) =>
          product.game === game &&
          (product.official_code === relationship.relationship_value ||
            product.name === relationship.relationship_value),
      );
      if (declared === true) continue;
      const key = inferredProductLifecycleKey(game, relationship.relationship_value);
      grouped.set(key, [
        ...(grouped.get(key) ?? []),
        {
          firstRevisionId: relationship.first_revision_id,
          lastObservedRevisionId: relationship.last_observed_revision_id,
        },
      ]);
    }
  }
  const revisionIds = [
    ...new Set(
      [...grouped.values()].flatMap((values) =>
        values.flatMap((value) => [value.firstRevisionId, value.lastObservedRevisionId]),
      ),
    ),
  ];
  const revisionOrders = new Map<string, string>([[revisionId, revisionOrder]]);
  await Promise.all(
    revisionIds
      .filter((id) => id !== revisionId)
      .map(async (id) => {
        const row = await inferredProductRevisionTimeStatement(database, id).first<{ published_at: string }>();
        if (row === null) {
          throw new Error("An inferred Product lifecycle revision is unavailable.");
        }
        revisionOrders.set(id, row.published_at);
      }),
  );
  return Object.fromEntries(
    [...grouped]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => {
        const first = [...values].sort((left, right) =>
          revisionOrderKey(revisionOrders, left.firstRevisionId).localeCompare(
            revisionOrderKey(revisionOrders, right.firstRevisionId),
          ),
        )[0]!;
        const last = [...values]
          .sort((left, right) =>
            revisionOrderKey(revisionOrders, left.lastObservedRevisionId).localeCompare(
              revisionOrderKey(revisionOrders, right.lastObservedRevisionId),
            ),
          )
          .at(-1)!;
        return [
          key,
          {
            first_revision_id: first.firstRevisionId,
            last_observed_revision_id: last.lastObservedRevisionId,
            withdrawn: false,
          },
        ];
      }),
  );
}

function revisionOrderKey(orders: ReadonlyMap<string, string>, revisionId: string): string {
  return canonicalJson([orders.get(revisionId) ?? "", revisionId]);
}

function inferredProductLifecycleKey(game: string, officialCode: string): string {
  return canonicalJson([game, officialCode]);
}

async function retainCarriedLifecycles(
  database: CatalogueStore,
  runId: string,
  candidate: CatalogueCandidate,
  result: ReconciliationPublicationPlan,
  publicationRows: PublicationRows,
  observedSourceLineages: readonly string[],
  inferCanonicalDisappearance: boolean,
  revisionId: string,
): Promise<void> {
  const run = await carriedRevisionStatement(database, runId).first<{ expected_current_revision_id: string }>();
  if (run === null) {
    throw new Error("The reconciliation Ingestion Run disappeared.");
  }
  const [cards, printings] = await Promise.all([
    carriedCardLifecyclesStatement(database, run.expected_current_revision_id).all<{
      id: string;
      document_json: string;
    }>(),
    carriedPrintingLifecyclesStatement(database, run.expected_current_revision_id).all<{
      id: string;
      document_json: string;
    }>(),
  ]);
  const candidateCardIds = new Set(candidate.cards.map((card) => card.id));
  const candidatePrintingIds = new Set(candidate.printings.map((printing) => printing.id));
  for (const row of cards.results) {
    if (!candidateCardIds.has(row.id)) continue;
    const carriedEvidence = documentPublicationEvidence(row.document_json);
    if (result.cardEvidence[row.id] === undefined) {
      const effectiveRulesEvidence = documentFieldEvidence(row.document_json, "/data/effective_rules_text");
      const effectiveRulesIds = new Set(effectiveRulesEvidence.map(({ id }) => id));
      const generalEvidence = carriedEvidence.filter(({ id }) => !effectiveRulesIds.has(id));
      result.cardEvidence[row.id] = generalEvidence.length === 0 ? carriedEvidence : generalEvidence;
    }
    if (result.cardEffectiveRulesEvidence[row.id] === undefined) {
      result.cardEffectiveRulesEvidence[row.id] = documentFieldEvidence(
        row.document_json,
        "/data/effective_rules_text",
      );
    }
    if (result.cardLifecycles[row.id] === undefined) {
      result.cardLifecycles[row.id] = documentLifecycle(row.document_json);
      if (inferCanonicalDisappearance) {
        publicationRows.cardDeactivations.push(
          ...observedSourceLineages.map((sourceLineage) => ({
            card_id: row.id,
            source_lineage: sourceLineage,
          })),
        );
      }
    }
  }
  for (const row of printings.results) {
    if (candidatePrintingIds.has(row.id) && result.printingEvidence[row.id] === undefined) {
      result.printingEvidence[row.id] = documentPublicationEvidence(row.document_json);
    }
    const omittedPrinting = candidatePrintingIds.has(row.id) && result.printingLifecycles[row.id] === undefined;
    if (omittedPrinting) {
      result.printingLifecycles[row.id] = documentLifecycle(row.document_json);
    }
    if (candidatePrintingIds.has(row.id) && result.relationshipEvidence[row.id] === undefined) {
      const carried = documentRelationshipEvidence(row.document_json);
      if (!inferCanonicalDisappearance) {
        result.relationshipEvidence[row.id] = carried;
      } else {
        const omittedLineageWasCurrent = carried.some(
          (relationship) => observedSourceLineages.includes(relationship.source_lineage) && relationship.current,
        );
        result.relationshipEvidence[row.id] = carried.map((relationship) =>
          observedSourceLineages.includes(relationship.source_lineage) && relationship.current
            ? {
                ...relationship,
                current: false,
                last_missing_revision_id: revisionId,
              }
            : relationship,
        );
        if (omittedLineageWasCurrent) {
          publicationRows.membershipDeactivations.push(
            ...observedSourceLineages.map((sourceLineage) => ({
              printing_id: row.id,
              source_lineage: sourceLineage,
            })),
          );
        }
      }
    }
    if (omittedPrinting && inferCanonicalDisappearance) {
      publicationRows.locatorDeactivations.push(
        ...observedSourceLineages.map((sourceLineage) => ({
          printing_id: row.id,
          source_lineage: sourceLineage,
        })),
      );
    }
    if (candidatePrintingIds.has(row.id) && result.locatorEvidence[row.id] === undefined) {
      const carried = documentLocatorEvidence(row.document_json);
      result.locatorEvidence[row.id] = !inferCanonicalDisappearance
        ? carried
        : {
            current: carried.current.filter((locator) => !observedSourceLineages.includes(locator.source_lineage)),
            historical: [
              ...carried.historical,
              ...carried.current
                .filter((locator) => observedSourceLineages.includes(locator.source_lineage))
                .map((locator) => ({
                  ...locator,
                  current: false as const,
                  last_missing_revision_id: revisionId,
                })),
            ].sort(locatorEvidenceOrder),
          };
    }
  }
}

function documentLifecycle(documentJson: string): NormalizedLifecycle {
  const document = revisionDocumentData(documentJson) as {
    lifecycle?: Partial<NormalizedLifecycle>;
  };
  const lifecycle = document.lifecycle;
  if (
    lifecycle === undefined ||
    typeof lifecycle.first_revision_id !== "string" ||
    typeof lifecycle.last_observed_revision_id !== "string" ||
    typeof lifecycle.withdrawn !== "boolean"
  ) {
    throw new Error("A carried Catalogue lifecycle is invalid.");
  }
  return {
    first_revision_id: lifecycle.first_revision_id,
    last_observed_revision_id: lifecycle.last_observed_revision_id,
    withdrawn: lifecycle.withdrawn,
    ...(lifecycle.withdrawal === undefined ? {} : { withdrawal: lifecycle.withdrawal }),
  };
}

function documentPublicationEvidence(documentJson: string): PublicationEvidenceResource[] {
  const parsed: unknown = JSON.parse(documentJson);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("A carried revision document is invalid.");
  }
  const included = (parsed as { included?: unknown }).included;
  if (included === undefined) return [];
  if (!Array.isArray(included)) {
    throw new Error("Carried publication evidence is invalid.");
  }
  return included.flatMap((resource): PublicationEvidenceResource[] => {
    if (
      resource === null ||
      typeof resource !== "object" ||
      Array.isArray(resource) ||
      (resource as { type?: unknown }).type !== "source_observation"
    ) {
      return [];
    }
    const evidence = resource as Partial<PublicationEvidenceResource>;
    if (
      typeof evidence.id !== "string" ||
      typeof evidence.captured_at !== "string" ||
      typeof evidence.source !== "string"
    ) {
      throw new Error("Carried publication evidence is invalid.");
    }
    return [
      {
        type: "source_observation",
        id: evidence.id,
        captured_at: evidence.captured_at,
        source: evidence.source,
      },
    ];
  });
}

function documentFieldEvidence(documentJson: string, pointer: string): PublicationEvidenceResource[] {
  const parsed: unknown = JSON.parse(documentJson);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("A carried revision document is invalid.");
  }
  const provenance = (parsed as { provenance?: unknown }).provenance;
  if (provenance === undefined) return [];
  if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new Error("Carried publication provenance is invalid.");
  }
  const observationIds = (provenance as Record<string, unknown>)[pointer];
  if (observationIds === undefined) return [];
  if (!Array.isArray(observationIds) || observationIds.some((id) => typeof id !== "string")) {
    throw new Error("Carried publication provenance is invalid.");
  }
  const evidenceById = new Map(documentPublicationEvidence(documentJson).map((evidence) => [evidence.id, evidence]));
  return observationIds.map((id) => {
    const evidence = evidenceById.get(id as string);
    if (evidence === undefined) {
      throw new Error("Carried publication provenance is invalid.");
    }
    return evidence;
  });
}

function documentRelationshipEvidence(documentJson: string): RelationshipEvidence[] {
  const document = revisionDocumentData(documentJson) as {
    relationship_evidence?: RelationshipEvidence[];
  };
  return Array.isArray(document.relationship_evidence) ? document.relationship_evidence : [];
}

function documentLocatorEvidence(documentJson: string): LocatorEvidenceCollection {
  const document = revisionDocumentData(documentJson) as {
    locator_evidence?: LocatorEvidenceCollection;
  };
  return document.locator_evidence ?? { current: [], historical: [] };
}

function revisionDocumentData(documentJson: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(documentJson);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("A carried revision document is invalid.");
  }
  const document = parsed as Record<string, unknown>;
  if (document.data !== null && typeof document.data === "object" && !Array.isArray(document.data)) {
    return document.data as Record<string, unknown>;
  }
  return document;
}

function cardPersistenceRow(
  plan: CandidatePlanRow,
  card: CatalogueCandidate["cards"][number],
  revisionId: string,
  existing: ReconciledCardRow | null,
  withdrawal: ProvenancedWithdrawal | null,
): Record<string, unknown> {
  const withdraw = withdrawal?.entity === "card" || withdrawal?.entity === "card_and_printing";
  const lifecycle = resolvedWithdrawalLifecycle(existing, withdraw, withdrawal, revisionId);
  return {
    id: plan.card_id,
    supported_game: card.game,
    official_identity_kind: card.official_identity.kind,
    official_identity_value: card.official_identity.value,
    first_revision_id: existing?.first_revision_id ?? revisionId,
    withdrawn: withdraw ? 1 : 0,
    withdrawal_revision_id: lifecycle.revisionId,
    withdrawal_evidence_json: lifecycle.evidenceJson,
    new_transition: lifecycle.newTransition ? 1 : 0,
  };
}

function printingPersistenceRow(
  plan: CandidatePlanRow,
  compatibility: PrintingCompatibility,
  revisionId: string,
  existing: ReconciledPrintingRow | null,
  withdrawal: ProvenancedWithdrawal | null,
): Record<string, unknown> {
  const withdraw = withdrawal?.entity === "printing" || withdrawal?.entity === "card_and_printing";
  const lifecycle = resolvedWithdrawalLifecycle(existing, withdraw, withdrawal, revisionId);
  return {
    id: plan.printing_id,
    card_id: compatibility.card_id,
    source_lineage: compatibility.source_lineage,
    artwork_fingerprint: compatibility.artwork_fingerprint,
    printed_fields_digest: compatibility.printed_fields_digest,
    rarity_normalized: compatibility.rarity_normalized,
    treatment: compatibility.treatment,
    first_revision_id: existing?.first_revision_id ?? revisionId,
    withdrawn: withdraw ? 1 : 0,
    withdrawal_revision_id: lifecycle.revisionId,
    withdrawal_evidence_json: lifecycle.evidenceJson,
    new_transition: lifecycle.newTransition ? 1 : 0,
  };
}

async function rowsById<T extends { id: string }>(
  database: CatalogueStore,
  kind: "card" | "printing",
  ids: readonly string[],
): Promise<Map<string, T>> {
  if (ids.length === 0) return new Map();
  const rows = await publicationEntityLifecyclesStatement(database, kind, canonicalJson(ids)).all<T>();
  return new Map(rows.results.map((row) => [row.id, row]));
}

async function relationshipRowsByPrinting(
  database: CatalogueStore,
  printingIds: readonly string[],
): Promise<Map<string, RelationshipEvidenceRow[]>> {
  if (printingIds.length === 0) return new Map();
  const rows = await printingRelationshipLifecycleStatement(database, canonicalJson(printingIds)).all<
    RelationshipEvidenceRow & { printing_id: string }
  >();
  const grouped = new Map<string, RelationshipEvidenceRow[]>();
  for (const { printing_id: printingId, ...row } of rows.results) {
    grouped.set(printingId, [...(grouped.get(printingId) ?? []), row]);
  }
  return grouped;
}

type LocatorRow = {
  source_lineage: string;
  locator: string;
  variant_key: string | null;
  first_revision_id: string;
  last_observed_revision_id: string;
  current: number;
  last_missing_revision_id: string | null;
};

async function locatorRowsByPrinting(
  database: CatalogueStore,
  printingIds: readonly string[],
): Promise<Map<string, LocatorRow[]>> {
  if (printingIds.length === 0) return new Map();
  const rows = await printingLocatorLifecycleStatement(database, canonicalJson(printingIds)).all<
    LocatorRow & { printing_id: string }
  >();
  const grouped = new Map<string, LocatorRow[]>();
  for (const { printing_id: printingId, ...row } of rows.results) {
    grouped.set(printingId, [...(grouped.get(printingId) ?? []), row]);
  }
  return grouped;
}

function publicationStatements(
  database: CatalogueStore,
  rows: PublicationRows,
  plans: readonly CandidatePlanRow[],
  revisionId: string,
): D1PreparedStatement[] {
  const withdrawals = plans.flatMap((plan) => {
    if (plan.withdrawal_json === null) return [];
    const withdrawal = JSON.parse(plan.withdrawal_json) as ProvenancedWithdrawal;
    const targets = [
      ...(withdrawal.entity === "card" || withdrawal.entity === "card_and_printing"
        ? [{ entity_type: "card", entity_id: plan.card_id }]
        : []),
      ...(plan.printing_id !== null && (withdrawal.entity === "printing" || withdrawal.entity === "card_and_printing")
        ? [{ entity_type: "printing", entity_id: plan.printing_id }]
        : []),
    ];
    return targets.map((target) => ({
      ...target,
      source_lineage: withdrawal.source_lineage,
      source_snapshot_id: withdrawal.source_snapshot_id,
      source_observation_set_id: withdrawal.source_observation_set_id,
      source_observation_id: withdrawal.source_observation_id,
      assertion: withdrawal.assertion,
      state: withdrawal.state,
      effective_at: withdrawal.effective_at,
      evidence_json: canonicalJson(withdrawal.evidence),
    }));
  });
  const unique = (values: readonly Record<string, unknown>[]): Record<string, unknown>[] => [
    ...new Map(values.map((value) => [canonicalJson(value), value])).values(),
  ];
  const statements = (values: readonly Record<string, unknown>[], prepare: (payload: string) => D1PreparedStatement) =>
    byteBoundedJsonArrays(values).map(prepare);
  return [
    ...statements(withdrawals, (payload) =>
      publishWithdrawalAssertionsStatement(database, { revisionId: revisionId, payload: payload }),
    ),
    ...statements(rows.cards, (payload) =>
      publishReconciledCardsStatement(database, { revisionId: revisionId, payload: payload }),
    ),
    ...deactivatePublicationEvidenceStatements(
      database,
      "card-observation",
      unique(rows.cardDeactivations),
      revisionId,
    ),
    ...statements(rows.cardObservations, (payload) =>
      publishCardObservationsStatement(database, { revisionId: revisionId, payload: payload }),
    ),
    ...statements(rows.printings, (payload) =>
      publishReconciledPrintingsStatement(database, { revisionId: revisionId, payload: payload }),
    ),
    ...deactivatePublicationEvidenceStatements(
      database,
      "printing-locator",
      unique(rows.locatorDeactivations),
      revisionId,
    ),
    ...statements(rows.locators, (payload) =>
      publishPrintingLocatorsStatement(database, {
        revisionId: revisionId,
        observedRevisionId: revisionId,
        payload: payload,
      }),
    ),
    ...deactivatePublicationEvidenceStatements(
      database,
      "printing-membership",
      unique(rows.membershipDeactivations),
      revisionId,
    ),
    ...statements(rows.memberships, (payload) =>
      publishPrintingMembershipsStatement(database, {
        revisionId: revisionId,
        observedRevisionId: revisionId,
        payload: payload,
      }),
    ),
  ];
}

function nextRelationshipEvidence(
  existing: readonly RelationshipEvidenceRow[],
  plans: readonly CandidatePlanRow[],
  revisionId: string,
  revisionOrder: string,
): RelationshipEvidence[] {
  const observedLineages = new Set(plans.map((plan) => plan.source_lineage));
  const rows: RelationshipEvidenceRow[] = existing.map((row) =>
    row.current === 1 && observedLineages.has(row.source_lineage)
      ? {
          ...row,
          current: 0,
          last_missing_revision_id: revisionId,
        }
      : row,
  );
  for (const plan of plans) {
    const memberships = JSON.parse(plan.memberships_json) as Memberships;
    for (const membership of membershipEntries(memberships)) {
      rows.push({
        source_lineage: plan.source_lineage,
        source_observation_id: plan.source_observation_id,
        relationship_kind: membership.relationship_kind,
        relationship_value: membership.relationship_value,
        first_revision_id: revisionId,
        last_observed_revision_id: revisionId,
        first_revision_order: revisionOrder,
        last_observed_revision_order: revisionOrder,
        current: 1,
        last_missing_revision_id: null,
      });
    }
  }
  return aggregateRelationshipEvidence(rows).filter(
    (relationship) => relationship.relationship_kind !== "source_bucket",
  );
}

function nextLocatorEvidence(
  existing: readonly {
    source_lineage: string;
    locator: string;
    variant_key: string | null;
    first_revision_id: string;
    last_observed_revision_id: string;
    current: number;
    last_missing_revision_id: string | null;
  }[],
  plans: readonly CandidatePlanRow[],
  revisionId: string,
): LocatorEvidenceCollection {
  const observedLineages = new Set(plans.map((plan) => plan.source_lineage));
  const byBinding = new Map<string, LocatorEvidence>();
  for (const row of existing) {
    const current = row.current === 1;
    byBinding.set(canonicalJson([row.source_lineage, row.locator, row.variant_key]), {
      ...row,
      current: current && !observedLineages.has(row.source_lineage),
      last_missing_revision_id:
        current && observedLineages.has(row.source_lineage) ? revisionId : row.last_missing_revision_id,
    });
  }
  for (const plan of plans) {
    if (plan.locator === null) {
      throw new Error("The reconciliation Printing locator disappeared.");
    }
    const key = canonicalJson([plan.source_lineage, plan.locator, plan.variant_key]);
    const previous = byBinding.get(key);
    byBinding.set(key, {
      source_lineage: plan.source_lineage,
      locator: plan.locator,
      variant_key: plan.variant_key,
      first_revision_id: previous?.first_revision_id ?? revisionId,
      last_observed_revision_id: revisionId,
      current: true,
      last_missing_revision_id: null,
    });
  }
  const evidence = [...byBinding.values()].sort(locatorEvidenceOrder);
  return {
    current: evidence.filter((locator) => locator.current),
    historical: evidence.filter((locator) => !locator.current),
  };
}

function locatorEvidenceOrder(left: LocatorEvidence, right: LocatorEvidence): number {
  return (
    left.source_lineage.localeCompare(right.source_lineage) ||
    left.locator.localeCompare(right.locator) ||
    (left.variant_key ?? "").localeCompare(right.variant_key ?? "")
  );
}

function resolvedWithdrawalLifecycle(
  existing: Pick<
    ReconciledCardRow | ReconciledPrintingRow,
    "withdrawn" | "withdrawal_revision_id" | "withdrawal_evidence_json"
  > | null,
  withdraw: boolean,
  withdrawal: ProvenancedWithdrawal | null,
  revisionId: string,
): {
  newTransition: boolean;
  revisionId: string | null;
  evidenceJson: string | null;
} {
  const newTransition = withdraw && existing?.withdrawn !== 1;
  return {
    newTransition,
    revisionId: newTransition ? revisionId : (existing?.withdrawal_revision_id ?? null),
    evidenceJson:
      newTransition && withdrawal !== null ? canonicalJson(withdrawal) : (existing?.withdrawal_evidence_json ?? null),
  };
}

function groupedPlans(
  plans: readonly CandidatePlanRow[],
  key: (plan: CandidatePlanRow) => string,
): Map<string, CandidatePlanRow[]> {
  const grouped = new Map<string, CandidatePlanRow[]>();
  for (const plan of plans) {
    const id = key(plan);
    const values = grouped.get(id) ?? [];
    values.push(plan);
    grouped.set(id, values);
  }
  return grouped;
}

function mergedWithdrawal(
  plans: readonly CandidatePlanRow[],
  entity: "card" | "printing",
): ProvenancedWithdrawal | null {
  const withdrawals = plans
    .filter((plan) => plan.withdrawal_json !== null)
    .map((plan) => JSON.parse(plan.withdrawal_json!) as ProvenancedWithdrawal)
    .filter((withdrawal) => withdrawal.entity === entity || withdrawal.entity === "card_and_printing");
  const unique = new Map<string, ProvenancedWithdrawal>();
  for (const withdrawal of [...withdrawals].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  )) {
    const semantic = canonicalJson({
      entity,
      assertion: withdrawal.assertion,
      state: withdrawal.state,
      effective_at: withdrawal.effective_at,
    });
    if (!unique.has(semantic)) unique.set(semantic, withdrawal);
  }
  if (unique.size > 1) {
    throw new Error("Conflicting explicit withdrawal evidence was retained.");
  }
  return [...unique.values()][0] ?? null;
}

function normalizedLifecycle(
  firstRevisionId: string,
  lastObservedRevisionId: string,
  withdrawn: boolean,
  withdrawalRevisionId: string | null,
  withdrawalEvidenceJson: string | null,
): NormalizedLifecycle {
  return {
    first_revision_id: firstRevisionId,
    last_observed_revision_id: lastObservedRevisionId,
    withdrawn,
    ...(withdrawalRevisionId === null || withdrawalEvidenceJson === null
      ? {}
      : {
          withdrawal: {
            revision_id: withdrawalRevisionId,
            evidence: JSON.parse(withdrawalEvidenceJson) as Record<string, unknown>,
          },
        }),
  };
}

async function requiredRunCandidate(database: CatalogueStore, runId: string): Promise<string> {
  const row = await requiredPublicationCandidateStatement(database, runId).first<{ candidate_json: string }>();
  if (row === null) throw new Error("Reconciled candidate is unavailable.");
  return retainedPayload(database, runId, "candidate", row.candidate_json);
}
