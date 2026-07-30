import type { FixtureCandidate } from "./fixture";
import {
  reconciliationCandidatePlans,
  type CandidatePlanRow,
} from "./reconciliation-candidate-store";
import {
  aggregateRelationshipEvidence,
  membershipEntries,
  type RelationshipEvidence,
  type RelationshipEvidenceRow,
} from "./reconciliation-relationships";
import type {
  Memberships,
  PrintingCompatibility,
  ProvenancedWithdrawal,
} from "./reconciliation-model";
import { isCompatible } from "./reconciliation-model";
import type {
  ReconciledCardRow,
  ReconciledPrintingRow,
} from "./reconciliation-repository";
import {
  byteBoundedJsonArrays,
  retainedPayload,
} from "./reconciliation-payload";
import { canonicalJson } from "./serialization";
import {
  productReleaseLifecyclePlan,
  type ProductRelationshipLifecycle,
} from "./product-release-publication";

export type NormalizedLifecycle = {
  first_revision_id: string;
  last_observed_revision_id: string;
  withdrawn: boolean;
  withdrawal?: {
    revision_id: string;
    evidence: Record<string, unknown>;
  } | null;
};

export type { RelationshipEvidence } from "./reconciliation-relationships";

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
  productRelationshipLifecycles: Record<
    string,
    ProductRelationshipLifecycle
  >;
  relationshipEvidence: Record<string, RelationshipEvidence[]>;
  locatorEvidence: Record<string, LocatorEvidenceCollection>;
  cardEvidence: Record<string, PublicationEvidenceResource[]>;
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
  database: D1Database,
  runId: string,
  revisionId: string,
  revisionOrder = revisionId,
): Promise<ReconciliationPublicationPlan | null> {
  const plans = await reconciliationCandidatePlans(database, runId);
  const evidenceByObservation = await publicationEvidenceResources(
    database,
    plans,
  );
  const context = await database
    .prepare(
      `SELECT source_lineage
       FROM reconciliation_contexts
       WHERE ingestion_run_id = ?`,
    )
    .bind(runId)
    .first<{ source_lineage: string }>();
  if (context === null) return null;
  const evidencePartitions = await database
    .prepare(
      `SELECT DISTINCT source_lineage
       FROM reconciliation_evidence_partitions
       WHERE ingestion_run_id = ?
       ORDER BY source_lineage`,
    )
    .bind(runId)
    .all<{ source_lineage: string }>();
  const observedSourceLineages =
    evidencePartitions.results.length > 0
      ? evidencePartitions.results.map(({ source_lineage }) => source_lineage)
      : [context.source_lineage];
  const candidate = JSON.parse(
    await requiredRunCandidate(database, runId),
  ) as FixtureCandidate;
  const cards = new Map(candidate.cards.map((card) => [card.id, card]));
  const printings = new Map(
    candidate.printings.map((printing) => [printing.id, printing]),
  );
  const cardPlans = groupedPlans(plans, (plan) => plan.card_id);
  const printingPlans = groupedPlans(
    plans.filter((plan) => plan.printing_id !== null),
    (plan) => plan.printing_id!,
  );
  const [existingCards, existingPrintings, existingMemberships, existingLocators] =
    await Promise.all([
      rowsById<ReconciledCardRow>(
        database,
        "reconciled_cards",
        [...cardPlans.keys()],
      ),
      rowsById<ReconciledPrintingRow>(
        database,
        "reconciled_printings",
        [...printingPlans.keys()],
      ),
      relationshipRowsByPrinting(
        database,
        [...printingPlans.keys()],
      ),
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
    relationshipEvidence: {},
    locatorEvidence: {},
    cardEvidence: {},
    printingEvidence: {},
    statements: [],
  };

  for (const [cardId, grouped] of cardPlans) {
    const card = cards.get(cardId);
    if (card === undefined) throw new Error("The reconciliation Card plan changed.");
    const existing = existingCards.get(cardId) ?? null;
    result.cardEvidence[cardId] = grouped.map((plan) =>
      evidenceByObservation.get(plan.source_observation_id)!
    );
    const withdrawal = mergedWithdrawal(grouped, "card");
    const withdraw =
      withdrawal?.entity === "card" ||
      withdrawal?.entity === "card_and_printing";
    const withdrawalLifecycle = resolvedWithdrawalLifecycle(
      existing,
      withdraw,
      withdrawal,
      revisionId,
    );
    result.cardLifecycles[cardId] = normalizedLifecycle(
      existing?.first_revision_id ?? revisionId,
      revisionId,
      existing?.withdrawn === 1 || withdraw,
      withdrawalLifecycle.revisionId,
      withdrawalLifecycle.evidenceJson,
    );
    publicationRows.cards.push(
      cardPersistenceRow(grouped[0]!, card, revisionId, existing, withdrawal),
    );
    for (const sourceLineage of new Set(
      grouped.map((plan) => plan.source_lineage),
    )) {
      publicationRows.cardDeactivations.push({
        card_id: card.id,
        source_lineage: sourceLineage,
      });
    }
    publicationRows.cardObservations.push(
      ...grouped.map((plan) => ({
        card_id: card.id,
        source_lineage: plan.source_lineage,
        source_observation_id: plan.source_observation_id,
        canonical_facts_json: canonicalJson({
          game: card.game,
          official_identity: card.official_identity,
          name: card.name,
          effective_rules_text: card.effective_rules_text,
          game_data: card.game_data,
        }),
      })),
    );
  }

  for (const [printingId, grouped] of printingPlans) {
    const printing = printings.get(printingId);
    if (printing === undefined) {
      throw new Error("The reconciliation Printing plan changed.");
    }
    const first = grouped[0]!;
    result.printingEvidence[printingId] = grouped.map((plan) =>
      evidenceByObservation.get(plan.source_observation_id)!
    );
    if (first.compatibility_json === null) {
      throw new Error("The reconciliation Printing compatibility disappeared.");
    }
    const compatibility = JSON.parse(
      first.compatibility_json,
    ) as PrintingCompatibility;
    if (
      grouped.some(
        (plan) =>
          plan.compatibility_json === null ||
          !isCompatible(
            JSON.parse(plan.compatibility_json) as PrintingCompatibility,
            compatibility,
          ),
      )
    ) {
      throw new Error("One Printing has incompatible publication plans.");
    }
    const withdrawal = mergedWithdrawal(grouped, "printing");
    const withdraw =
      withdrawal?.entity === "printing" ||
      withdrawal?.entity === "card_and_printing";
    const existing = existingPrintings.get(printingId) ?? null;
    const withdrawalLifecycle = resolvedWithdrawalLifecycle(
      existing,
      withdraw,
      withdrawal,
      revisionId,
    );
    result.printingLifecycles[printingId] = normalizedLifecycle(
      existing?.first_revision_id ?? revisionId,
      revisionId,
      existing?.withdrawn === 1 || withdraw,
      withdrawalLifecycle.revisionId,
      withdrawalLifecycle.evidenceJson,
    );
    result.relationshipEvidence[printingId] =
      nextRelationshipEvidence(
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
    publicationRows.printings.push(
      printingPersistenceRow(
        first,
        compatibility,
        revisionId,
        existing,
        withdrawal,
      ),
    );
    for (const sourceLineage of new Set(
      grouped.map((plan) => plan.source_lineage),
    )) {
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
        ...membershipEntries(
          JSON.parse(plan.memberships_json) as Memberships,
        ).map((membership) => ({
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
    revisionId,
  );
  const productReleaseLifecycles = await productReleaseLifecyclePlan(
    database,
    candidate,
    revisionId,
  );
  const inferredProductLifecycles =
    await aggregateInferredProductLifecycles(
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
  result.productRelationshipLifecycles =
    productReleaseLifecycles.relationships;
  result.statements.push(
    ...publicationStatements(
      database,
      publicationRows,
      plans,
      revisionId,
    ),
    ...errataPublicationStatements(
      database,
      candidate.errata ?? [],
      revisionId,
    ),
  );
  return result;
}

async function publicationEvidenceResources(
  database: D1Database,
  plans: readonly CandidatePlanRow[],
): Promise<Map<string, PublicationEvidenceResource>> {
  if (plans.length === 0) return new Map();
  const rows = await database
    .prepare(
      `SELECT plan.source_observation_id AS id,
              plan.source_lineage AS source,
              snapshot.retrieved_at AS captured_at
       FROM reconciliation_candidates AS plan
       JOIN source_snapshots AS snapshot
         ON snapshot.id = plan.source_snapshot_id
       WHERE plan.ingestion_run_id = ?
       ORDER BY plan.source_observation_id`,
    )
    .bind(plans[0]!.ingestion_run_id)
    .all<PublicationEvidenceResource>();
  const resources = new Map(
    rows.results.map((row) => [
      row.id,
      { ...row, type: "source_observation" as const },
    ]),
  );
  for (const plan of plans) {
    if (!resources.has(plan.source_observation_id)) {
      throw new Error("Publication Source Observation evidence disappeared.");
    }
  }
  return resources;
}

function errataPublicationStatements(
  database: D1Database,
  errata: NonNullable<FixtureCandidate["errata"]>,
  revisionId: string,
): D1PreparedStatement[] {
  const statements = (
    values: readonly Record<string, unknown>[],
    prepare: (payload: string) => D1PreparedStatement,
  ) => byteBoundedJsonArrays(values).map(prepare);
  const canonicalRows = errata.map((erratum) => ({
    id: erratum.id,
    game: erratum.game,
    target_type: erratum.target_type,
    target_id: erratum.target_id,
    effective_from: erratum.effective_from,
    official_wording: erratum.official_wording,
    corrected_value_json: canonicalJson(erratum.corrected_value),
  }));
  const provenanceRows = errata.flatMap((erratum) =>
    erratum.provenance.map((provenance) => ({
      erratum_id: erratum.id,
      source_lineage: provenance.source_lineage,
      source_observation_id: provenance.source_observation_id,
    })),
  );
  const revisionRows = errata.map((erratum) => ({
    erratum_id: erratum.id,
  }));
  return [
    ...statements(canonicalRows, (payload) =>
      database
        .prepare(
          `INSERT INTO reconciled_errata (
             id, game, target_type, target_id, effective_from,
             official_wording, corrected_value_json,
             first_revision_id, last_observed_revision_id
           )
           SELECT json_extract(value, '$.id'),
                  json_extract(value, '$.game'),
                  json_extract(value, '$.target_type'),
                  json_extract(value, '$.target_id'),
                  json_extract(value, '$.effective_from'),
                  json_extract(value, '$.official_wording'),
                  json_extract(value, '$.corrected_value_json'), ?, ?
           FROM json_each(?) WHERE true
           ON CONFLICT (id) DO UPDATE SET
             last_observed_revision_id = excluded.last_observed_revision_id`,
        )
        .bind(revisionId, revisionId, payload),
    ),
    ...statements(provenanceRows, (payload) =>
      database
        .prepare(
          `INSERT INTO erratum_provenance (
             erratum_id, source_lineage, source_observation_id,
             first_revision_id, last_observed_revision_id
           )
           SELECT json_extract(value, '$.erratum_id'),
                  json_extract(value, '$.source_lineage'),
                  json_extract(value, '$.source_observation_id'), ?, ?
           FROM json_each(?) WHERE true
           ON CONFLICT (erratum_id, source_lineage, source_observation_id)
           DO UPDATE SET
             last_observed_revision_id = excluded.last_observed_revision_id`,
        )
        .bind(revisionId, revisionId, payload),
    ),
    ...statements(revisionRows, (payload) =>
      database
        .prepare(
          `INSERT OR IGNORE INTO revision_errata (
             catalogue_revision_id, erratum_id
           )
           SELECT ?, json_extract(value, '$.erratum_id')
           FROM json_each(?)`,
        )
        .bind(revisionId, payload),
    ),
  ];
}

async function aggregateInferredProductLifecycles(
  database: D1Database,
  candidate: FixtureCandidate,
  relationships: Readonly<Record<string, readonly RelationshipEvidence[]>>,
  revisionId: string,
  revisionOrder: string,
): Promise<Record<string, NormalizedLifecycle>> {
  const cards = new Map(candidate.cards.map((card) => [card.id, card]));
  const grouped = new Map<
    string,
    { firstRevisionId: string; lastObservedRevisionId: string }[]
  >();
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
      const key = inferredProductLifecycleKey(
        game,
        relationship.relationship_value,
      );
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
        values.flatMap((value) => [
          value.firstRevisionId,
          value.lastObservedRevisionId,
        ]),
      ),
    ),
  ];
  const revisionOrders = new Map<string, string>([
    [revisionId, revisionOrder],
  ]);
  await Promise.all(
    revisionIds
      .filter((id) => id !== revisionId)
      .map(async (id) => {
        const row = await database
          .prepare(
            "SELECT published_at FROM catalogue_revisions WHERE id = ?",
          )
          .bind(id)
          .first<{ published_at: string }>();
        if (row === null) {
          throw new Error(
            "An inferred Product lifecycle revision is unavailable.",
          );
        }
        revisionOrders.set(id, row.published_at);
      }),
  );
  return Object.fromEntries(
    [...grouped]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => {
        const first = [...values].sort((left, right) =>
          revisionOrderKey(
            revisionOrders,
            left.firstRevisionId,
          ).localeCompare(
            revisionOrderKey(revisionOrders, right.firstRevisionId),
          ),
        )[0]!;
        const last = [...values].sort((left, right) =>
          revisionOrderKey(
            revisionOrders,
            left.lastObservedRevisionId,
          ).localeCompare(
            revisionOrderKey(
              revisionOrders,
              right.lastObservedRevisionId,
            ),
          ),
        ).at(-1)!;
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

function revisionOrderKey(
  orders: ReadonlyMap<string, string>,
  revisionId: string,
): string {
  return canonicalJson([orders.get(revisionId) ?? "", revisionId]);
}

function inferredProductLifecycleKey(
  game: string,
  officialCode: string,
): string {
  return canonicalJson([game, officialCode]);
}

async function retainCarriedLifecycles(
  database: D1Database,
  runId: string,
  candidate: FixtureCandidate,
  result: ReconciliationPublicationPlan,
  publicationRows: PublicationRows,
  observedSourceLineages: readonly string[],
  revisionId: string,
): Promise<void> {
  const run = await database
    .prepare(
      "SELECT expected_current_revision_id FROM ingestion_runs WHERE id = ?",
    )
    .bind(runId)
    .first<{ expected_current_revision_id: string }>();
  if (run === null) {
    throw new Error("The reconciliation Ingestion Run disappeared.");
  }
  const [cards, printings] = await Promise.all([
    database
      .prepare(
        `SELECT card_id AS id, document_json
         FROM revision_cards
         WHERE catalogue_revision_id = ?`,
      )
      .bind(run.expected_current_revision_id)
      .all<{ id: string; document_json: string }>(),
    database
      .prepare(
        `SELECT printing_id AS id, document_json
         FROM revision_printings
         WHERE catalogue_revision_id = ?`,
      )
      .bind(run.expected_current_revision_id)
      .all<{ id: string; document_json: string }>(),
  ]);
  const candidateCardIds = new Set(candidate.cards.map((card) => card.id));
  const candidatePrintingIds = new Set(
    candidate.printings.map((printing) => printing.id),
  );
  for (const row of cards.results) {
    if (
      candidateCardIds.has(row.id) &&
      result.cardLifecycles[row.id] === undefined
    ) {
      result.cardLifecycles[row.id] = documentLifecycle(
        row.document_json,
      );
      publicationRows.cardDeactivations.push(
        ...observedSourceLineages.map((sourceLineage) => ({
          card_id: row.id,
          source_lineage: sourceLineage,
        })),
      );
    }
  }
  for (const row of printings.results) {
    const omittedPrinting =
      candidatePrintingIds.has(row.id) &&
      result.printingLifecycles[row.id] === undefined;
    if (omittedPrinting) {
      result.printingLifecycles[row.id] = documentLifecycle(
        row.document_json,
      );
    }
    if (
      candidatePrintingIds.has(row.id) &&
      result.relationshipEvidence[row.id] === undefined
    ) {
      const carried = documentRelationshipEvidence(row.document_json);
      const omittedLineageWasCurrent = carried.some(
        (relationship) =>
          observedSourceLineages.includes(relationship.source_lineage) &&
          relationship.current,
      );
      result.relationshipEvidence[row.id] = carried.map((relationship) =>
        observedSourceLineages.includes(relationship.source_lineage) &&
        relationship.current
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
      if (omittedPrinting) {
        publicationRows.locatorDeactivations.push(
          ...observedSourceLineages.map((sourceLineage) => ({
            printing_id: row.id,
            source_lineage: sourceLineage,
          })),
        );
      }
    }
    if (
      candidatePrintingIds.has(row.id) &&
      result.locatorEvidence[row.id] === undefined
    ) {
      const carried = documentLocatorEvidence(row.document_json);
      result.locatorEvidence[row.id] = {
        current: carried.current.filter(
          (locator) =>
            !observedSourceLineages.includes(locator.source_lineage),
        ),
        historical: [
          ...carried.historical,
          ...carried.current
            .filter(
              (locator) =>
                observedSourceLineages.includes(locator.source_lineage),
            )
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
    withdrawal:
      lifecycle.withdrawal === undefined ? null : lifecycle.withdrawal,
  };
}

function documentRelationshipEvidence(
  documentJson: string,
): RelationshipEvidence[] {
  const document = revisionDocumentData(documentJson) as {
    relationship_evidence?: RelationshipEvidence[];
  };
  return Array.isArray(document.relationship_evidence)
    ? document.relationship_evidence
    : [];
}

function documentLocatorEvidence(
  documentJson: string,
): LocatorEvidenceCollection {
  const document = revisionDocumentData(documentJson) as {
    locator_evidence?: LocatorEvidenceCollection;
  };
  return document.locator_evidence ?? { current: [], historical: [] };
}

function revisionDocumentData(documentJson: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(documentJson);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("A carried revision document is invalid.");
  }
  const document = parsed as Record<string, unknown>;
  if (
    document.data !== null &&
    typeof document.data === "object" &&
    !Array.isArray(document.data)
  ) {
    return document.data as Record<string, unknown>;
  }
  return document;
}

function cardPersistenceRow(
  plan: CandidatePlanRow,
  card: FixtureCandidate["cards"][number],
  revisionId: string,
  existing: ReconciledCardRow | null,
  withdrawal: ProvenancedWithdrawal | null,
): Record<string, unknown> {
  const withdraw =
    withdrawal?.entity === "card" ||
    withdrawal?.entity === "card_and_printing";
  const lifecycle = resolvedWithdrawalLifecycle(
    existing,
    withdraw,
    withdrawal,
    revisionId,
  );
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
  const withdraw =
    withdrawal?.entity === "printing" ||
    withdrawal?.entity === "card_and_printing";
  const lifecycle = resolvedWithdrawalLifecycle(
    existing,
    withdraw,
    withdrawal,
    revisionId,
  );
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
  database: D1Database,
  table: "reconciled_cards" | "reconciled_printings",
  ids: readonly string[],
): Promise<Map<string, T>> {
  if (ids.length === 0) return new Map();
  const rows = await database
    .prepare(
      `SELECT * FROM ${table}
       WHERE id IN (SELECT value FROM json_each(?))
       ORDER BY id`,
    )
    .bind(canonicalJson(ids))
    .all<T>();
  return new Map(rows.results.map((row) => [row.id, row]));
}

async function relationshipRowsByPrinting(
  database: D1Database,
  printingIds: readonly string[],
): Promise<Map<string, RelationshipEvidenceRow[]>> {
  if (printingIds.length === 0) return new Map();
  const rows = await database
    .prepare(
      `SELECT membership.printing_id, source_lineage, source_observation_id,
              relationship_kind, relationship_value,
              membership.first_revision_id,
              membership.last_observed_revision_id,
              first_revision.published_at AS first_revision_order,
              last_revision.published_at AS last_observed_revision_order,
              current, last_missing_revision_id
       FROM reconciled_printing_memberships AS membership
       JOIN catalogue_revisions AS first_revision
         ON first_revision.id = membership.first_revision_id
       JOIN catalogue_revisions AS last_revision
         ON last_revision.id = membership.last_observed_revision_id
       WHERE membership.printing_id IN (SELECT value FROM json_each(?))
       ORDER BY membership.printing_id, source_lineage, relationship_kind,
                relationship_value, first_revision.published_at,
                membership.first_revision_id, last_revision.published_at,
                membership.last_observed_revision_id, source_observation_id`,
    )
    .bind(canonicalJson(printingIds))
    .all<RelationshipEvidenceRow & { printing_id: string }>();
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
  database: D1Database,
  printingIds: readonly string[],
): Promise<Map<string, LocatorRow[]>> {
  if (printingIds.length === 0) return new Map();
  const rows = await database
    .prepare(
      `SELECT printing_id, source_lineage, locator, variant_key,
              first_revision_id, last_observed_revision_id,
              current, last_missing_revision_id
       FROM reconciled_printing_locators
       WHERE printing_id IN (SELECT value FROM json_each(?))
       ORDER BY printing_id, source_lineage, locator,
                COALESCE(variant_key, '')`,
    )
    .bind(canonicalJson(printingIds))
    .all<LocatorRow & { printing_id: string }>();
  const grouped = new Map<string, LocatorRow[]>();
  for (const { printing_id: printingId, ...row } of rows.results) {
    grouped.set(printingId, [...(grouped.get(printingId) ?? []), row]);
  }
  return grouped;
}

function publicationStatements(
  database: D1Database,
  rows: PublicationRows,
  plans: readonly CandidatePlanRow[],
  revisionId: string,
): D1PreparedStatement[] {
  const withdrawals = plans.flatMap((plan) => {
    if (plan.withdrawal_json === null) return [];
    const withdrawal = JSON.parse(
      plan.withdrawal_json,
    ) as ProvenancedWithdrawal;
    const targets = [
      ...(withdrawal.entity === "card" ||
      withdrawal.entity === "card_and_printing"
        ? [{ entity_type: "card", entity_id: plan.card_id }]
        : []),
      ...(plan.printing_id !== null &&
      (withdrawal.entity === "printing" ||
        withdrawal.entity === "card_and_printing")
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
  const unique = (
    values: readonly Record<string, unknown>[],
  ): Record<string, unknown>[] => [
    ...new Map(values.map((value) => [canonicalJson(value), value])).values(),
  ];
  const statements = (
    values: readonly Record<string, unknown>[],
    prepare: (payload: string) => D1PreparedStatement,
  ) => byteBoundedJsonArrays(values).map(prepare);
  return [
    ...statements(withdrawals, (payload) =>
      database
      .prepare(
        `INSERT INTO reconciled_withdrawal_assertions (
           entity_type, entity_id, source_lineage, source_snapshot_id,
           source_observation_set_id, source_observation_id, assertion,
           state, effective_at, evidence_json,
           published_catalogue_revision_id
         )
         SELECT json_extract(value, '$.entity_type'),
                json_extract(value, '$.entity_id'),
                json_extract(value, '$.source_lineage'),
                json_extract(value, '$.source_snapshot_id'),
                json_extract(value, '$.source_observation_set_id'),
                json_extract(value, '$.source_observation_id'),
                json_extract(value, '$.assertion'),
                json_extract(value, '$.state'),
                json_extract(value, '$.effective_at'),
                json_extract(value, '$.evidence_json'), ?
         FROM json_each(?) WHERE true
         ON CONFLICT (entity_type, entity_id, source_observation_id)
         DO NOTHING`,
      )
      .bind(revisionId, payload),
    ),
    ...statements(rows.cards, (payload) =>
      database
      .prepare(
        `INSERT INTO reconciled_cards (
           id, supported_game, official_identity_kind,
           official_identity_value, first_revision_id,
           last_observed_revision_id, withdrawn, withdrawal_revision_id,
           withdrawal_evidence_json
         )
         SELECT json_extract(value, '$.id'),
                json_extract(value, '$.supported_game'),
                json_extract(value, '$.official_identity_kind'),
                json_extract(value, '$.official_identity_value'),
                json_extract(value, '$.first_revision_id'), ?,
                json_extract(value, '$.withdrawn'),
                json_extract(value, '$.withdrawal_revision_id'),
                json_extract(value, '$.withdrawal_evidence_json')
         FROM json_each(?) WHERE true
         ON CONFLICT (id) DO UPDATE SET
           last_observed_revision_id = excluded.last_observed_revision_id,
           withdrawn = CASE
             WHEN reconciled_cards.withdrawn = 0 AND excluded.withdrawn = 1
             THEN 1 ELSE reconciled_cards.withdrawn END,
           withdrawal_revision_id = CASE
             WHEN reconciled_cards.withdrawn = 0 AND excluded.withdrawn = 1
             THEN excluded.withdrawal_revision_id
             ELSE reconciled_cards.withdrawal_revision_id END,
           withdrawal_evidence_json = CASE
             WHEN reconciled_cards.withdrawn = 0 AND excluded.withdrawn = 1
             THEN excluded.withdrawal_evidence_json
             ELSE reconciled_cards.withdrawal_evidence_json END`,
      )
      .bind(revisionId, payload),
    ),
    ...setDeactivationStatements(
      database,
      "reconciled_card_observations",
      "card_id",
      unique(rows.cardDeactivations),
      revisionId,
    ),
    ...statements(rows.cardObservations, (payload) =>
      database
      .prepare(
        `INSERT INTO reconciled_card_observations (
           card_id, source_lineage, source_observation_id,
           catalogue_revision_id, canonical_facts_json, current,
           last_missing_revision_id
         )
         SELECT json_extract(value, '$.card_id'),
                json_extract(value, '$.source_lineage'),
                json_extract(value, '$.source_observation_id'), ?,
                json_extract(value, '$.canonical_facts_json'), 1, NULL
         FROM json_each(?)`,
      )
      .bind(revisionId, payload),
    ),
    ...statements(rows.printings, (payload) =>
      database
      .prepare(
        `INSERT INTO reconciled_printings (
           id, card_id, source_lineage, artwork_fingerprint,
           printed_fields_digest, rarity_normalized, treatment,
           first_revision_id, last_observed_revision_id, withdrawn,
           withdrawal_revision_id, withdrawal_evidence_json
         )
         SELECT json_extract(value, '$.id'),
                json_extract(value, '$.card_id'),
                json_extract(value, '$.source_lineage'),
                json_extract(value, '$.artwork_fingerprint'),
                json_extract(value, '$.printed_fields_digest'),
                json_extract(value, '$.rarity_normalized'),
                json_extract(value, '$.treatment'),
                json_extract(value, '$.first_revision_id'), ?,
                json_extract(value, '$.withdrawn'),
                json_extract(value, '$.withdrawal_revision_id'),
                json_extract(value, '$.withdrawal_evidence_json')
         FROM json_each(?) WHERE true
         ON CONFLICT (id) DO UPDATE SET
           last_observed_revision_id = excluded.last_observed_revision_id,
           withdrawn = CASE
             WHEN reconciled_printings.withdrawn = 0
                  AND excluded.withdrawn = 1
             THEN 1 ELSE reconciled_printings.withdrawn END,
           withdrawal_revision_id = CASE
             WHEN reconciled_printings.withdrawn = 0
                  AND excluded.withdrawn = 1
             THEN excluded.withdrawal_revision_id
             ELSE reconciled_printings.withdrawal_revision_id END,
           withdrawal_evidence_json = CASE
             WHEN reconciled_printings.withdrawn = 0
                  AND excluded.withdrawn = 1
             THEN excluded.withdrawal_evidence_json
             ELSE reconciled_printings.withdrawal_evidence_json END`,
      )
      .bind(revisionId, payload),
    ),
    ...setDeactivationStatements(
      database,
      "reconciled_printing_locators",
      "printing_id",
      unique(rows.locatorDeactivations),
      revisionId,
    ),
    ...statements(rows.locators, (payload) =>
      database
      .prepare(
        `INSERT INTO reconciled_printing_locators (
           printing_id, source_lineage, locator, variant_key,
           variant_identity,
           first_revision_id, last_observed_revision_id, current,
           last_missing_revision_id
         )
         SELECT json_extract(value, '$.printing_id'),
                json_extract(value, '$.source_lineage'),
                json_extract(value, '$.locator'),
                json_extract(value, '$.variant_key'),
                COALESCE(json_extract(value, '$.variant_key'), ''), ?, ?, 1, NULL
         FROM json_each(?) WHERE true
         ON CONFLICT (source_lineage, locator, variant_identity) DO UPDATE SET
           last_observed_revision_id = excluded.last_observed_revision_id,
           current = 1, last_missing_revision_id = NULL`,
      )
      .bind(revisionId, revisionId, payload),
    ),
    ...setDeactivationStatements(
      database,
      "reconciled_printing_memberships",
      "printing_id",
      unique(rows.membershipDeactivations),
      revisionId,
    ),
    ...statements(rows.memberships, (payload) =>
      database
      .prepare(
        `INSERT INTO reconciled_printing_memberships (
           printing_id, source_lineage, source_observation_id,
           relationship_kind, relationship_value, first_revision_id,
           last_observed_revision_id, current, last_missing_revision_id
         )
         SELECT json_extract(value, '$.printing_id'),
                json_extract(value, '$.source_lineage'),
                json_extract(value, '$.source_observation_id'),
                json_extract(value, '$.relationship_kind'),
                json_extract(value, '$.relationship_value'), ?, ?, 1, NULL
         FROM json_each(?) WHERE true
         ON CONFLICT (
           printing_id, source_lineage, source_observation_id,
           relationship_kind, relationship_value
         ) DO UPDATE SET
           last_observed_revision_id = excluded.last_observed_revision_id,
           current = 1, last_missing_revision_id = NULL`,
      )
      .bind(revisionId, revisionId, payload),
    ),
  ];
}

function setDeactivationStatements(
  database: D1Database,
  table:
    | "reconciled_card_observations"
    | "reconciled_printing_locators"
    | "reconciled_printing_memberships",
  idColumn: "card_id" | "printing_id",
  rows: readonly Record<string, unknown>[],
  revisionId: string,
): D1PreparedStatement[] {
  return byteBoundedJsonArrays(rows).map((payload) =>
    database
      .prepare(
        `UPDATE ${table}
         SET current = 0, last_missing_revision_id = ?
         WHERE current = 1
           AND (${idColumn}, source_lineage) IN (
             SELECT json_extract(planned.value, '$.${idColumn}'),
                    json_extract(planned.value, '$.source_lineage')
             FROM json_each(?) AS planned
           )`,
      )
      .bind(revisionId, payload),
  );
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
    byBinding.set(
      canonicalJson([row.source_lineage, row.locator, row.variant_key]),
      {
        ...row,
        current: current && !observedLineages.has(row.source_lineage),
        last_missing_revision_id:
          current && observedLineages.has(row.source_lineage)
            ? revisionId
            : row.last_missing_revision_id,
      },
    );
  }
  for (const plan of plans) {
    if (plan.locator === null) {
      throw new Error("The reconciliation Printing locator disappeared.");
    }
    const key = canonicalJson([
      plan.source_lineage,
      plan.locator,
      plan.variant_key,
    ]);
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

function locatorEvidenceOrder(
  left: LocatorEvidence,
  right: LocatorEvidence,
): number {
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
    revisionId: newTransition
      ? revisionId
      : existing?.withdrawal_revision_id ?? null,
    evidenceJson:
      newTransition && withdrawal !== null
        ? canonicalJson(withdrawal)
        : existing?.withdrawal_evidence_json ?? null,
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
    .map(
      (plan) =>
        JSON.parse(plan.withdrawal_json!) as ProvenancedWithdrawal,
    )
    .filter(
      (withdrawal) =>
        withdrawal.entity === entity ||
        withdrawal.entity === "card_and_printing",
    );
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
            evidence: JSON.parse(
              withdrawalEvidenceJson,
            ) as Record<string, unknown>,
          },
        }),
  };
}

async function requiredRunCandidate(
  database: D1Database,
  runId: string,
): Promise<string> {
  const row = await database
    .prepare("SELECT candidate_json FROM ingestion_runs WHERE id = ?")
    .bind(runId)
    .first<{ candidate_json: string }>();
  if (row === null) throw new Error("Reconciled candidate is unavailable.");
  return retainedPayload(
    database,
    runId,
    "candidate",
    row.candidate_json,
  );
}
