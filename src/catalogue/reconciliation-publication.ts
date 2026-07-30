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
import { canonicalJson } from "./serialization";

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

export type ReconciliationPublicationPlan = {
  cardLifecycles: Record<string, NormalizedLifecycle>;
  printingLifecycles: Record<string, NormalizedLifecycle>;
  productLifecycles: Record<string, NormalizedLifecycle>;
  relationshipEvidence: Record<string, RelationshipEvidence[]>;
  statements: D1PreparedStatement[];
};

export async function reconciliationPublication(
  database: D1Database,
  runId: string,
  revisionId: string,
  revisionOrder = revisionId,
): Promise<ReconciliationPublicationPlan | null> {
  const plans = await reconciliationCandidatePlans(database, runId);
  const context = await database
    .prepare(
      `SELECT source_lineage
       FROM reconciliation_contexts
       WHERE ingestion_run_id = ?`,
    )
    .bind(runId)
    .first<{ source_lineage: string }>();
  if (context === null) return null;
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
  const result: ReconciliationPublicationPlan = {
    cardLifecycles: {},
    printingLifecycles: {},
    productLifecycles: {},
    relationshipEvidence: {},
    statements: [],
  };
  result.statements.push(
    ...(await withdrawalAssertionStatements(database, runId, revisionId)),
  );

  for (const [cardId, grouped] of cardPlans) {
    const card = cards.get(cardId);
    if (card === undefined) throw new Error("The reconciliation Card plan changed.");
    const existing = await database
      .prepare("SELECT * FROM reconciled_cards WHERE id = ?")
      .bind(cardId)
      .first<ReconciledCardRow>();
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
    result.statements.push(
      cardPersistenceStatement(
        database,
        grouped[0]!,
        card,
        revisionId,
        existing,
        withdrawal,
      ),
      ...cardObservationStatements(
        database,
        grouped,
        card,
        revisionId,
      ),
    );
  }

  for (const [printingId, grouped] of printingPlans) {
    const printing = printings.get(printingId);
    if (printing === undefined) {
      throw new Error("The reconciliation Printing plan changed.");
    }
    const first = grouped[0]!;
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
    const existing = await database
      .prepare("SELECT * FROM reconciled_printings WHERE id = ?")
      .bind(printingId)
      .first<ReconciledPrintingRow>();
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
      await nextRelationshipEvidence(
        database,
        printingId,
        grouped,
        revisionId,
        revisionOrder,
      );
    result.statements.push(
      printingPersistenceStatement(
        database,
        first,
        compatibility,
        revisionId,
        existing,
        withdrawal,
      ),
      ...[...new Set(grouped.map((plan) => plan.source_lineage))]
        .sort()
        .map((sourceLineage) =>
          database
            .prepare(
              `UPDATE reconciled_printing_locators
               SET current = 0, last_missing_revision_id = ?
               WHERE printing_id = ?
                 AND source_lineage = ?
                 AND current = 1`,
            )
            .bind(revisionId, printingId, sourceLineage),
        ),
      ...grouped.map((plan) => {
        if (plan.locator === null) {
          throw new Error("The reconciliation Printing locator disappeared.");
        }
        return database
          .prepare(
            `INSERT INTO reconciled_printing_locators (
              printing_id, source_lineage, locator,
              variant_key, first_revision_id, last_observed_revision_id,
              current, last_missing_revision_id
            ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)
            ON CONFLICT (source_lineage, locator) DO UPDATE SET
              variant_key = excluded.variant_key,
              last_observed_revision_id = excluded.last_observed_revision_id,
              current = 1,
              last_missing_revision_id = NULL`,
          )
          .bind(
            printingId,
            plan.source_lineage,
            plan.locator,
            plan.variant_key,
            revisionId,
            revisionId,
          );
      }),
      ...[...new Set(grouped.map((plan) => plan.source_lineage))]
        .sort()
        .map((sourceLineage) =>
          database
            .prepare(
              `UPDATE reconciled_printing_memberships
               SET current = 0, last_missing_revision_id = ?
               WHERE printing_id = ? AND source_lineage = ? AND current = 1`,
            )
            .bind(revisionId, printingId, sourceLineage),
        ),
      ...grouped.flatMap((plan) =>
        membershipEntries(
          JSON.parse(plan.memberships_json) as Memberships,
        ).map((membership) =>
          database
            .prepare(
              `INSERT INTO reconciled_printing_memberships (
                printing_id, source_lineage, source_observation_id,
                relationship_kind, relationship_value,
                first_revision_id, last_observed_revision_id,
                current, last_missing_revision_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)
              ON CONFLICT (
                printing_id, source_lineage, source_observation_id,
                relationship_kind, relationship_value
              ) DO UPDATE SET
                last_observed_revision_id = excluded.last_observed_revision_id,
                current = 1,
                last_missing_revision_id = NULL`,
            )
            .bind(
              printingId,
              plan.source_lineage,
              plan.source_observation_id,
              membership.relationship_kind,
              membership.relationship_value,
              revisionId,
              revisionId,
            ),
        ),
      ),
    );
  }
  await retainCarriedLifecycles(
    database,
    runId,
    candidate,
    result,
    context.source_lineage,
    revisionId,
  );
  result.productLifecycles = await aggregateProductLifecycles(
    database,
    candidate,
    result.relationshipEvidence,
    revisionId,
    revisionOrder,
  );
  return result;
}

async function aggregateProductLifecycles(
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
      const key = productLifecycleKey(game, relationship.relationship_value);
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
          throw new Error("A Product lifecycle revision is unavailable.");
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

function productLifecycleKey(game: string, officialCode: string): string {
  return canonicalJson([game, officialCode]);
}

async function retainCarriedLifecycles(
  database: D1Database,
  runId: string,
  candidate: FixtureCandidate,
  result: ReconciliationPublicationPlan,
  observedSourceLineage: string,
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
      result.statements.push(
        database
          .prepare(
            `UPDATE reconciled_card_observations
             SET current = 0, last_missing_revision_id = ?
             WHERE card_id = ?
               AND source_lineage = ?
               AND current = 1`,
          )
          .bind(revisionId, row.id, observedSourceLineage),
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
          relationship.source_lineage === observedSourceLineage &&
          relationship.current,
      );
      result.relationshipEvidence[row.id] = carried.map((relationship) =>
        relationship.source_lineage === observedSourceLineage &&
        relationship.current
          ? {
              ...relationship,
              current: false,
              last_missing_revision_id: revisionId,
            }
          : relationship,
      );
      if (omittedLineageWasCurrent) {
        result.statements.push(
          database
            .prepare(
              `UPDATE reconciled_printing_memberships
               SET current = 0, last_missing_revision_id = ?
               WHERE printing_id = ?
                 AND source_lineage = ?
                 AND current = 1`,
            )
            .bind(revisionId, row.id, observedSourceLineage),
        );
      }
      if (omittedPrinting) {
        result.statements.push(
          database
            .prepare(
              `UPDATE reconciled_printing_locators
               SET current = 0, last_missing_revision_id = ?
               WHERE printing_id = ?
                 AND source_lineage = ?
                 AND current = 1`,
            )
            .bind(revisionId, row.id, observedSourceLineage),
        );
      }
    }
  }
}

function documentLifecycle(documentJson: string): NormalizedLifecycle {
  const document = JSON.parse(documentJson) as {
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
  const document = JSON.parse(documentJson) as {
    relationship_evidence?: RelationshipEvidence[];
  };
  return Array.isArray(document.relationship_evidence)
    ? document.relationship_evidence
    : [];
}

function cardPersistenceStatement(
  database: D1Database,
  plan: CandidatePlanRow,
  card: FixtureCandidate["cards"][number],
  revisionId: string,
  existing: ReconciledCardRow | null,
  withdrawal: ProvenancedWithdrawal | null,
): D1PreparedStatement {
  const withdraw =
    withdrawal?.entity === "card" ||
    withdrawal?.entity === "card_and_printing";
  const lifecycle = resolvedWithdrawalLifecycle(
    existing,
    withdraw,
    withdrawal,
    revisionId,
  );
  return database
    .prepare(
      `INSERT INTO reconciled_cards (
        id, supported_game, official_identity_kind,
        official_identity_value, first_revision_id,
        last_observed_revision_id, withdrawn,
        withdrawal_revision_id, withdrawal_evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        last_observed_revision_id = excluded.last_observed_revision_id,
        withdrawn = CASE WHEN ? = 1 THEN 1 ELSE reconciled_cards.withdrawn END,
        withdrawal_revision_id = CASE
          WHEN ? = 1 THEN ? ELSE reconciled_cards.withdrawal_revision_id
        END,
        withdrawal_evidence_json = CASE
          WHEN ? = 1 THEN ? ELSE reconciled_cards.withdrawal_evidence_json
        END`,
    )
    .bind(
      plan.card_id,
      card.game,
      card.official_identity.kind,
      card.official_identity.value,
      existing?.first_revision_id ?? revisionId,
      revisionId,
      withdraw ? 1 : 0,
      lifecycle.revisionId,
      lifecycle.evidenceJson,
      lifecycle.newTransition ? 1 : 0,
      lifecycle.newTransition ? 1 : 0,
      lifecycle.revisionId,
      lifecycle.newTransition ? 1 : 0,
      lifecycle.evidenceJson,
    );
}

function cardObservationStatements(
  database: D1Database,
  plans: readonly CandidatePlanRow[],
  card: FixtureCandidate["cards"][number],
  revisionId: string,
): D1PreparedStatement[] {
  const deactivatePriorLineageObservations = [
    ...new Set(plans.map((plan) => plan.source_lineage)),
  ]
    .sort()
    .map((sourceLineage) =>
      database
        .prepare(
          `UPDATE reconciled_card_observations
           SET current = 0, last_missing_revision_id = ?
           WHERE card_id = ? AND source_lineage = ? AND current = 1`,
        )
        .bind(revisionId, card.id, sourceLineage),
    );
  const insertCurrentObservations = plans.map((plan) =>
    database
      .prepare(
        `INSERT INTO reconciled_card_observations (
          card_id, source_lineage, source_observation_id,
          catalogue_revision_id, canonical_facts_json, current,
          last_missing_revision_id
        ) VALUES (?, ?, ?, ?, ?, 1, NULL)`,
      )
      .bind(
        card.id,
        plan.source_lineage,
        plan.source_observation_id,
        revisionId,
        canonicalJson({
          game: card.game,
          official_identity: card.official_identity,
          name: card.name,
          effective_rules_text: card.effective_rules_text,
          game_data: card.game_data,
        }),
      ),
  );
  return [
    ...deactivatePriorLineageObservations,
    ...insertCurrentObservations,
  ];
}

async function nextRelationshipEvidence(
  database: D1Database,
  printingId: string,
  plans: readonly CandidatePlanRow[],
  revisionId: string,
  revisionOrder: string,
): Promise<RelationshipEvidence[]> {
  const existing = await database
    .prepare(
      `SELECT source_lineage, source_observation_id,
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
       WHERE printing_id = ?
       ORDER BY source_lineage, relationship_kind, relationship_value,
                first_revision.published_at, membership.first_revision_id,
                last_revision.published_at,
                membership.last_observed_revision_id,
                source_observation_id`,
    )
    .bind(printingId)
    .all<RelationshipEvidenceRow>();
  const observedLineages = new Set(plans.map((plan) => plan.source_lineage));
  const rows: RelationshipEvidenceRow[] = existing.results.map((row) =>
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

function printingPersistenceStatement(
  database: D1Database,
  plan: CandidatePlanRow,
  compatibility: PrintingCompatibility,
  revisionId: string,
  existing: ReconciledPrintingRow | null,
  withdrawal: ProvenancedWithdrawal | null,
): D1PreparedStatement {
  const withdraw =
    withdrawal?.entity === "printing" ||
    withdrawal?.entity === "card_and_printing";
  const lifecycle = resolvedWithdrawalLifecycle(
    existing,
    withdraw,
    withdrawal,
    revisionId,
  );
  return database
    .prepare(
      `INSERT INTO reconciled_printings (
        id, card_id, source_lineage, artwork_fingerprint,
        printed_fields_digest, rarity_normalized, treatment,
        first_revision_id, last_observed_revision_id, withdrawn,
        withdrawal_revision_id, withdrawal_evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        last_observed_revision_id = excluded.last_observed_revision_id,
        withdrawn = CASE WHEN ? = 1 THEN 1 ELSE reconciled_printings.withdrawn END,
        withdrawal_revision_id = CASE
          WHEN ? = 1 THEN ? ELSE reconciled_printings.withdrawal_revision_id
        END,
        withdrawal_evidence_json = CASE
          WHEN ? = 1 THEN ? ELSE reconciled_printings.withdrawal_evidence_json
        END`,
    )
    .bind(
      plan.printing_id,
      compatibility.card_id,
      compatibility.source_lineage,
      compatibility.artwork_fingerprint,
      compatibility.printed_fields_digest,
      compatibility.rarity_normalized,
      compatibility.treatment,
      existing?.first_revision_id ?? revisionId,
      revisionId,
      withdraw ? 1 : 0,
      lifecycle.revisionId,
      lifecycle.evidenceJson,
      lifecycle.newTransition ? 1 : 0,
      lifecycle.newTransition ? 1 : 0,
      lifecycle.revisionId,
      lifecycle.newTransition ? 1 : 0,
      lifecycle.evidenceJson,
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

export async function withdrawalAssertionStatements(
  database: D1Database,
  runId: string,
  publishedRevisionId: string,
): Promise<D1PreparedStatement[]> {
  const plans = await reconciliationCandidatePlans(database, runId);
  return plans.flatMap((plan) => {
    if (plan.withdrawal_json === null) return [];
    const withdrawal = JSON.parse(
      plan.withdrawal_json,
    ) as ProvenancedWithdrawal;
    const targets = [
      ...(withdrawal.entity === "card" ||
      withdrawal.entity === "card_and_printing"
        ? [{ entityType: "card", entityId: plan.card_id }]
        : []),
      ...(plan.printing_id !== null &&
      (withdrawal.entity === "printing" ||
        withdrawal.entity === "card_and_printing")
        ? [{ entityType: "printing", entityId: plan.printing_id }]
        : []),
    ];
    return targets.map(({ entityType, entityId }) =>
      database
        .prepare(
          `INSERT INTO reconciled_withdrawal_assertions (
            entity_type, entity_id, source_lineage,
            source_snapshot_id, source_observation_set_id,
            source_observation_id, assertion, state, effective_at,
            evidence_json, published_catalogue_revision_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (
            entity_type, entity_id, source_observation_id
          ) DO NOTHING`,
        )
        .bind(
          entityType,
          entityId,
          withdrawal.source_lineage,
          withdrawal.source_snapshot_id,
          withdrawal.source_observation_set_id,
          withdrawal.source_observation_id,
          withdrawal.assertion,
          withdrawal.state,
          withdrawal.effective_at,
          canonicalJson(withdrawal.evidence),
          publishedRevisionId,
        ),
    );
  });
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
  return row.candidate_json;
}
