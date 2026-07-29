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
import type {
  ReconciledCardRow,
  ReconciledPrintingRow,
} from "./reconciliation-repository";
import { canonicalJson } from "./serialization";

export type NormalizedLifecycle = {
  first_revision_id: string;
  last_observed_revision_id: string;
  withdrawn: boolean;
};

export type ReconciliationPublicationPlan = {
  cardLifecycles: Record<string, NormalizedLifecycle>;
  printingLifecycles: Record<string, NormalizedLifecycle>;
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
          canonicalJson(JSON.parse(plan.compatibility_json)) !==
            canonicalJson(compatibility),
      )
    ) {
      throw new Error("One Printing has incompatible publication plans.");
    }
    const memberships = mergedMemberships(grouped);
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
      database
        .prepare(
          `UPDATE reconciled_printing_memberships
           SET current = 0, last_missing_revision_id = ?
           WHERE printing_id = ? AND current = 1`,
        )
        .bind(revisionId, printingId),
      ...membershipEntries(memberships).map((membership) =>
        database
          .prepare(
            `INSERT INTO reconciled_printing_memberships (
              printing_id, relationship_kind, relationship_value,
              first_revision_id, last_observed_revision_id,
              current, last_missing_revision_id
            ) VALUES (?, ?, ?, ?, ?, 1, NULL)
            ON CONFLICT (
              printing_id, relationship_kind, relationship_value
            ) DO UPDATE SET
              last_observed_revision_id = excluded.last_observed_revision_id,
              current = 1,
              last_missing_revision_id = NULL`,
          )
          .bind(
            printingId,
            membership.relationship_kind,
            membership.relationship_value,
            revisionId,
            revisionId,
          ),
      ),
    );
  }
  return result;
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

function mergedMemberships(plans: readonly CandidatePlanRow[]): Memberships {
  const products = new Set<string>();
  const distributionContexts = new Set<string>();
  const sourceBuckets = new Set<string>();
  for (const plan of plans) {
    const membership = JSON.parse(plan.memberships_json) as Memberships;
    membership.products.forEach((value) => products.add(value));
    membership.distribution_contexts.forEach((value) =>
      distributionContexts.add(value),
    );
    membership.source_buckets.forEach((value) => sourceBuckets.add(value));
  }
  return {
    products: [...products].sort(),
    distribution_contexts: [...distributionContexts].sort(),
    source_buckets: [...sourceBuckets].sort(),
  };
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
): NormalizedLifecycle {
  return {
    first_revision_id: firstRevisionId,
    last_observed_revision_id: lastObservedRevisionId,
    withdrawn,
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
