import type { FixtureCandidate } from "./fixture";
import {
  reconciliationCandidatePlans,
  type CandidatePlanRow,
} from "./reconciliation-candidate-store";
import { membershipEntries } from "./reconciliation-read";
import type {
  Memberships,
  PrintingCompatibility,
  Withdrawal,
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

export type RelationshipEvidence = {
  source_lineage: string;
  relationship_kind: "product" | "distribution_context" | "source_bucket";
  relationship_value: string;
  source_observation_ids: string[];
  first_revision_id: string;
  last_observed_revision_id: string;
  current: boolean;
  last_missing_revision_id: string | null;
};

export type ReconciliationPublicationPlan = {
  cardLifecycles: Record<string, NormalizedLifecycle>;
  printingLifecycles: Record<string, NormalizedLifecycle>;
  relationshipEvidence: Record<string, RelationshipEvidence[]>;
  statements: D1PreparedStatement[];
};

export async function reconciliationPublication(
  database: D1Database,
  runId: string,
  revisionId: string,
): Promise<ReconciliationPublicationPlan | null> {
  const plans = await reconciliationCandidatePlans(database, runId);
  if (plans.length === 0) return null;
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
    relationshipEvidence: {},
    statements: [],
  };

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
    result.cardLifecycles[cardId] = normalizedLifecycle(
      existing?.first_revision_id ?? revisionId,
      revisionId,
      existing?.withdrawn === 1 || withdraw,
      withdraw ? revisionId : existing?.withdrawal_revision_id ?? null,
      withdraw && withdrawal !== null
        ? canonicalJson(withdrawal)
        : existing?.withdrawal_evidence_json ?? null,
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
    result.printingLifecycles[printingId] = normalizedLifecycle(
      existing?.first_revision_id ?? revisionId,
      revisionId,
      existing?.withdrawn === 1 || withdraw,
      withdraw ? revisionId : existing?.withdrawal_revision_id ?? null,
      withdraw && withdrawal !== null
        ? canonicalJson(withdrawal)
        : existing?.withdrawal_evidence_json ?? null,
    );
    result.relationshipEvidence[printingId] =
      await nextRelationshipEvidence(
        database,
        printingId,
        grouped,
        revisionId,
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
      ...grouped.map((plan) => {
        if (plan.locator === null) {
          throw new Error("The reconciliation Printing locator disappeared.");
        }
        return database
          .prepare(
            `INSERT INTO reconciled_printing_locators (
              printing_id, source_lineage, locator,
              first_revision_id, last_observed_revision_id
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (source_lineage, locator) DO UPDATE SET
              last_observed_revision_id = excluded.last_observed_revision_id`,
          )
          .bind(
            printingId,
            plan.source_lineage,
            plan.locator,
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
  );
  return result;
}

async function retainCarriedLifecycles(
  database: D1Database,
  runId: string,
  candidate: FixtureCandidate,
  result: ReconciliationPublicationPlan,
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
    }
  }
  for (const row of printings.results) {
    if (
      candidatePrintingIds.has(row.id) &&
      result.printingLifecycles[row.id] === undefined
    ) {
      result.printingLifecycles[row.id] = documentLifecycle(
        row.document_json,
      );
    }
    if (
      candidatePrintingIds.has(row.id) &&
      result.relationshipEvidence[row.id] === undefined
    ) {
      result.relationshipEvidence[row.id] =
        documentRelationshipEvidence(row.document_json);
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
  withdrawal: Withdrawal | null,
): D1PreparedStatement {
  const withdraw =
    withdrawal?.entity === "card" ||
    withdrawal?.entity === "card_and_printing";
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
      withdraw ? revisionId : null,
      withdraw && withdrawal !== null ? canonicalJson(withdrawal) : null,
      withdraw ? 1 : 0,
      withdraw ? 1 : 0,
      revisionId,
      withdraw ? 1 : 0,
      withdraw && withdrawal !== null ? canonicalJson(withdrawal) : null,
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
           SET current = 0
           WHERE card_id = ? AND source_lineage = ? AND current = 1`,
        )
        .bind(card.id, sourceLineage),
    );
  const insertCurrentObservations = plans.map((plan) =>
    database
      .prepare(
        `INSERT INTO reconciled_card_observations (
          card_id, source_lineage, source_observation_id,
          catalogue_revision_id, canonical_facts_json, current
        ) VALUES (?, ?, ?, ?, ?, 1)`,
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

type MembershipEvidenceRow = {
  source_lineage: string;
  source_observation_id: string;
  relationship_kind: RelationshipEvidence["relationship_kind"];
  relationship_value: string;
  first_revision_id: string;
  last_observed_revision_id: string;
  current: number;
  last_missing_revision_id: string | null;
};

async function nextRelationshipEvidence(
  database: D1Database,
  printingId: string,
  plans: readonly CandidatePlanRow[],
  revisionId: string,
): Promise<RelationshipEvidence[]> {
  const existing = await database
    .prepare(
      `SELECT source_lineage, source_observation_id,
              relationship_kind, relationship_value,
              first_revision_id, last_observed_revision_id,
              current, last_missing_revision_id
       FROM reconciled_printing_memberships
       WHERE printing_id = ?`,
    )
    .bind(printingId)
    .all<MembershipEvidenceRow>();
  const observedLineages = new Set(plans.map((plan) => plan.source_lineage));
  const rows: MembershipEvidenceRow[] = existing.results.map((row) =>
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
        current: 1,
        last_missing_revision_id: null,
      });
    }
  }
  return aggregateRelationshipEvidence(rows);
}

function aggregateRelationshipEvidence(
  rows: readonly MembershipEvidenceRow[],
): RelationshipEvidence[] {
  const grouped = new Map<string, MembershipEvidenceRow[]>();
  for (const row of rows) {
    const key = canonicalJson([
      row.source_lineage,
      row.relationship_kind,
      row.relationship_value,
    ]);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return [...grouped.values()]
    .map((evidence) => {
      const current = evidence.filter((row) => row.current === 1);
      const latest = current.at(-1) ?? evidence.at(-1)!;
      return {
        source_lineage: latest.source_lineage,
        relationship_kind: latest.relationship_kind,
        relationship_value: latest.relationship_value,
        source_observation_ids: evidence
          .map((row) => row.source_observation_id)
          .sort(),
        first_revision_id: evidence[0]!.first_revision_id,
        last_observed_revision_id: latest.last_observed_revision_id,
        current: current.length > 0,
        last_missing_revision_id:
          current.length > 0 ? null : latest.last_missing_revision_id,
      };
    })
    .sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
}

function printingPersistenceStatement(
  database: D1Database,
  plan: CandidatePlanRow,
  compatibility: PrintingCompatibility,
  revisionId: string,
  existing: ReconciledPrintingRow | null,
  withdrawal: Withdrawal | null,
): D1PreparedStatement {
  const withdraw =
    withdrawal?.entity === "printing" ||
    withdrawal?.entity === "card_and_printing";
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
      withdraw ? revisionId : null,
      withdraw && withdrawal !== null ? canonicalJson(withdrawal) : null,
      withdraw ? 1 : 0,
      withdraw ? 1 : 0,
      revisionId,
      withdraw ? 1 : 0,
      withdraw && withdrawal !== null ? canonicalJson(withdrawal) : null,
    );
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
): Withdrawal | null {
  const withdrawals = plans
    .filter((plan) => plan.withdrawal_json !== null)
    .map((plan) => JSON.parse(plan.withdrawal_json!) as Withdrawal)
    .filter(
      (withdrawal) =>
        withdrawal.entity === entity ||
        withdrawal.entity === "card_and_printing",
    );
  const unique = new Map(
    withdrawals.map((withdrawal) => [canonicalJson(withdrawal), withdrawal]),
  );
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
