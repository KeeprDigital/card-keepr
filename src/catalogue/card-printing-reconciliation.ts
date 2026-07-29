import { AdministrationProblem } from "./ingestion";
import {
  canonicalJson,
  sha256Text,
} from "./serialization";

const supportedGames = new Set([
  "one-piece",
  "fusion-world",
  "digimon",
  "gundam",
]);
const knownObservationFields = new Set([
  "source_observation_id",
  "supported_game",
  "source_lineage",
  "locator",
  "official_identity",
  "artwork_fingerprint",
  "printed_rules_fingerprint",
  "rarity",
  "treatment",
  "memberships",
  "game_profile",
  "withdrawal",
]);
const knownOnePieceGameProfileAttributes = new Set([
  "card_type",
  "colours",
  "cost",
  "life",
  "battle_attributes",
  "power",
  "counter",
  "traits",
  "block_icons",
  "effect_text",
  "trigger_text",
  "illustration_types",
]);

type ReconciliationRequest = {
  catalogueRevisionId: string;
  observedSourceLineages: readonly string[];
  sourceObservations: readonly SourceObservation[];
};

type SourceObservation = {
  sourceObservationId: string;
  supportedGame: string;
  sourceLineage: string;
  locator: string;
  officialIdentity: {
    kind: "card_number" | "functional_designation";
    value: string;
  };
  artworkFingerprint: string | null;
  printedRulesFingerprint: string | null;
  rarity: {
    raw: string | null;
    normalized: string | null;
  };
  treatment: string | null;
  memberships: Memberships;
  withdrawal: {
    explicit: true;
    entity: "card" | "printing" | "card_and_printing";
    evidence: string;
  } | null;
  original: Record<string, unknown>;
  unknownFields: Record<string, unknown>;
};

type CompleteSourceObservation = SourceObservation & {
  artworkFingerprint: string;
  printedRulesFingerprint: string;
  rarity: {
    raw: string;
    normalized: string;
  };
  treatment: string;
};

type Memberships = {
  product_ids: string[];
  distribution_context_ids: string[];
  source_buckets: string[];
};

type CardRow = {
  id: string;
  supported_game: string;
  official_identity_kind: "card_number" | "functional_designation";
  official_identity_value: string;
  first_revision_id: string;
  last_observed_revision_id: string;
  withdrawn: number;
  withdrawn_revision_id: string | null;
  withdrawal_evidence_json: string | null;
};

type PrintingRow = {
  id: string;
  card_id: string;
  source_lineage: string;
  artwork_fingerprint: string;
  printed_rules_fingerprint: string;
  rarity_raw: string;
  rarity_normalized: string;
  treatment: string;
  memberships_json: string;
  first_revision_id: string;
  last_observed_revision_id: string;
  withdrawn: number;
  withdrawn_revision_id: string | null;
  withdrawal_evidence_json: string | null;
};

type LocatorRow = {
  printing_id: string;
};

type SourceObservationRow = {
  source_observation_id: string;
  catalogue_revision_id: string;
  printing_id: string;
  observation_json: string;
  unknown_fields_json: string;
};

type Diagnostic = {
  code:
    | "printing_match_ambiguous"
    | "printing_match_contradictory"
    | "printing_match_insufficient_evidence";
  source_observation_id: string;
  locator: string | null;
  candidate_printing_ids: string[];
  detail: string;
};

type Warning = {
  code: "record_not_observed" | "unknown_source_observation_fields";
  source_observation_id?: string;
  printing_id?: string;
  fields?: string[];
  detail: string;
};

export function parseReconciliationRequest(
  body: Record<string, unknown>,
): ReconciliationRequest {
  assertOnlyRequestFields(body);
  const catalogueRevisionId = requiredString(
    body.catalogue_revision_id,
    "catalogue_revision_id",
  );
  const observedSourceLineages = requiredStringArray(
    body.observed_source_lineages,
    "observed_source_lineages",
  );
  if (!Array.isArray(body.source_observations)) {
    invalidRequest("source_observations must be an array.");
  }
  return {
    catalogueRevisionId,
    observedSourceLineages,
    sourceObservations: body.source_observations.map(
      (value, index) => parseSourceObservation(value, index),
    ),
  };
}

export async function reconcileCardPrintings(
  database: D1Database,
  request: ReconciliationRequest,
): Promise<Record<string, unknown>> {
  const candidateDiagnostics = contradictoryCandidateDiagnostics(
    request.sourceObservations,
  );
  if (candidateDiagnostics.length > 0) {
    return reconciliationDocument(
      false,
      [],
      [],
      candidateDiagnostics,
      [],
    );
  }
  const diagnostics: Diagnostic[] = [];
  const warnings: Warning[] = [];
  const observedPrintingIds = new Set<string>();
  const cards = new Map<string, CardRow>();
  const printings = new Map<string, PrintingRow>();
  const locatorWrites = new Map<string, {
    printingId: string;
    sourceLineage: string;
    locator: string;
  }>();
  const observationWrites: {
    observation: SourceObservation;
    printingId: string;
  }[] = [];

  for (const observation of request.sourceObservations) {
    if (
      !request.observedSourceLineages.includes(
        observation.sourceLineage,
      )
    ) {
      invalidRequest(
        "Every Source Observation lineage must be declared in observed_source_lineages.",
      );
    }
    if (!hasCompletePrintingEvidence(observation)) {
      diagnostics.push({
        code: "printing_match_insufficient_evidence",
        source_observation_id: observation.sourceObservationId,
        locator: observation.locator,
        candidate_printing_ids: [],
        detail:
          "Printing reconciliation requires Card, Source Lineage, artwork, printed rules, rarity, and treatment evidence.",
      });
      continue;
    }
    const card = await findOrCreateCard(
      database,
      cards,
      observation,
      request.catalogueRevisionId,
    );
    const locatorKey =
      `${observation.sourceLineage}\u0000${observation.locator}`;
    const pendingLocator = locatorWrites.get(locatorKey);
    const locator =
      pendingLocator === undefined
        ? await database
            .prepare(
              `SELECT printing_id
               FROM reconciled_printing_locators
               WHERE source_lineage = ? AND locator = ?`,
            )
            .bind(observation.sourceLineage, observation.locator)
            .first<LocatorRow>()
        : { printing_id: pendingLocator.printingId };
    const compatible = await compatiblePrintings(
      database,
      card.id,
      observation,
    );

    let printing: PrintingRow | null = null;
    if (locator !== null) {
      if (compatible.length > 1) {
        diagnostics.push({
          code: "printing_match_ambiguous",
          source_observation_id: observation.sourceObservationId,
          locator: observation.locator,
          candidate_printing_ids: compatible.map(
            (candidate) => candidate.id,
          ),
          detail:
            "More than one compatible Printing matches the complete Source Observation evidence.",
        });
        continue;
      }
      const located =
        printings.get(locator.printing_id) ??
        (await requiredPrinting(database, locator.printing_id));
      if (!isCompatible(located, card.id, observation)) {
        diagnostics.push({
          code: "printing_match_contradictory",
          source_observation_id: observation.sourceObservationId,
          locator: observation.locator,
          candidate_printing_ids: [located.id],
          detail:
            "The locator already identifies a Printing whose Card, Source Lineage, artwork, printed rules, rarity, or treatment evidence contradicts this Source Observation.",
        });
        continue;
      }
      printing = located;
    } else if (compatible.length === 1) {
      printing = compatible[0]!;
    } else if (compatible.length > 1) {
      diagnostics.push({
        code: "printing_match_ambiguous",
        source_observation_id: observation.sourceObservationId,
        locator: observation.locator,
        candidate_printing_ids: compatible.map((candidate) => candidate.id),
        detail:
          "More than one compatible Printing matches the complete Source Observation evidence.",
      });
      continue;
    } else {
      printing = await newPrinting(
        card.id,
        observation,
        request.catalogueRevisionId,
      );
    }

    const existingPending = printings.get(printing.id);
    const merged = mergePrinting(
      existingPending ?? printing,
      observation,
      request.catalogueRevisionId,
    );
    printings.set(merged.id, merged);
    observedPrintingIds.add(merged.id);
    locatorWrites.set(locatorKey, {
        printingId: merged.id,
        sourceLineage: observation.sourceLineage,
        locator: observation.locator,
      });
    observationWrites.push({
      observation,
      printingId: merged.id,
    });
    if (Object.keys(observation.unknownFields).length > 0) {
      warnings.push({
        code: "unknown_source_observation_fields",
        source_observation_id: observation.sourceObservationId,
        fields: Object.keys(observation.unknownFields).sort(),
        detail:
          "Unknown optional Official Source fields remain Source Observations and were not added to the Game Profile.",
      });
    }
  }

  if (diagnostics.length > 0) {
    return reconciliationDocument(
      false,
      [],
      [],
      stableDiagnostics(diagnostics),
      stableWarnings(warnings),
    );
  }

  const missing = await missingObservedPrintings(
    database,
    request.observedSourceLineages,
    observedPrintingIds,
  );
  for (const printing of missing) {
    printings.set(printing.id, printing);
    warnings.push({
      code: "record_not_observed",
      printing_id: printing.id,
      detail:
        "The Printing was not observed in this Catalogue Revision; it remains historical and is not withdrawn.",
    });
  }

  const statements: D1PreparedStatement[] = [];
  for (const card of cards.values()) {
    statements.push(
      database
        .prepare(
          `INSERT INTO reconciled_cards (
            id, supported_game, official_identity_kind,
            official_identity_value, first_revision_id,
            last_observed_revision_id, withdrawn,
            withdrawn_revision_id, withdrawal_evidence_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            last_observed_revision_id = excluded.last_observed_revision_id,
            withdrawn = excluded.withdrawn,
            withdrawn_revision_id = excluded.withdrawn_revision_id,
            withdrawal_evidence_json = excluded.withdrawal_evidence_json`,
        )
        .bind(
          card.id,
          card.supported_game,
          card.official_identity_kind,
          card.official_identity_value,
          card.first_revision_id,
          card.last_observed_revision_id,
          card.withdrawn,
          card.withdrawn_revision_id,
          card.withdrawal_evidence_json,
        ),
    );
  }
  for (const printing of printings.values()) {
    if (!observedPrintingIds.has(printing.id)) continue;
    statements.push(
      database
        .prepare(
          `INSERT INTO reconciled_printings (
            id, card_id, source_lineage, artwork_fingerprint,
            printed_rules_fingerprint, rarity_raw, rarity_normalized,
            treatment, memberships_json, first_revision_id,
            last_observed_revision_id, withdrawn,
            withdrawn_revision_id, withdrawal_evidence_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            memberships_json = excluded.memberships_json,
            last_observed_revision_id = excluded.last_observed_revision_id,
            withdrawn = excluded.withdrawn,
            withdrawn_revision_id = excluded.withdrawn_revision_id,
            withdrawal_evidence_json = excluded.withdrawal_evidence_json`,
        )
        .bind(
          printing.id,
          printing.card_id,
          printing.source_lineage,
          printing.artwork_fingerprint,
          printing.printed_rules_fingerprint,
          printing.rarity_raw,
          printing.rarity_normalized,
          printing.treatment,
          printing.memberships_json,
          printing.first_revision_id,
          printing.last_observed_revision_id,
          printing.withdrawn,
          printing.withdrawn_revision_id,
          printing.withdrawal_evidence_json,
        ),
    );
  }
  for (const locator of locatorWrites.values()) {
    statements.push(
      database
        .prepare(
          `INSERT INTO reconciled_printing_locators (
            printing_id, source_lineage, locator,
            first_observed_revision_id, last_observed_revision_id
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (source_lineage, locator) DO UPDATE SET
            last_observed_revision_id =
              excluded.last_observed_revision_id`,
        )
        .bind(
          locator.printingId,
          locator.sourceLineage,
          locator.locator,
          request.catalogueRevisionId,
          request.catalogueRevisionId,
        ),
    );
  }
  for (const write of observationWrites) {
    statements.push(
      database
        .prepare(
          `INSERT INTO reconciliation_source_observations (
            source_observation_id, catalogue_revision_id, printing_id,
            observation_json, unknown_fields_json
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          write.observation.sourceObservationId,
          request.catalogueRevisionId,
          write.printingId,
          canonicalJson(write.observation.original),
          canonicalJson(write.observation.unknownFields),
        ),
    );
  }
  if (statements.length > 0) await database.batch(statements);

  const publicCards = await publicCardsForPrintings(
    database,
    [...printings.values()],
  );
  const publicPrintings = await Promise.all(
    [...printings.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((printing) => publicPrinting(database, printing)),
  );
  return reconciliationDocument(
    true,
    publicCards,
    publicPrintings,
    [],
    stableWarnings(warnings),
  );
}

function contradictoryCandidateDiagnostics(
  observations: readonly SourceObservation[],
): Diagnostic[] {
  const byLocator = new Map<string, CompleteSourceObservation[]>();
  for (const observation of observations) {
    if (!hasCompletePrintingEvidence(observation)) continue;
    const key =
      `${observation.sourceLineage}\u0000${observation.locator}`;
    const grouped = byLocator.get(key) ?? [];
    grouped.push(observation);
    byLocator.set(key, grouped);
  }
  const diagnostics: Diagnostic[] = [];
  for (const grouped of byLocator.values()) {
    const identities = new Set(
      grouped.map((observation) =>
        canonicalJson({
          supported_game: observation.supportedGame,
          official_identity: observation.officialIdentity,
          source_lineage: observation.sourceLineage,
          artwork_fingerprint: observation.artworkFingerprint,
          printed_rules_fingerprint:
            observation.printedRulesFingerprint,
          rarity: observation.rarity,
          treatment: observation.treatment,
        }),
      ),
    );
    if (identities.size <= 1) continue;
    const ordered = [...grouped].sort((left, right) =>
      left.sourceObservationId.localeCompare(
        right.sourceObservationId,
      ),
    );
    diagnostics.push({
      code: "printing_match_contradictory",
      source_observation_id: ordered[0]!.sourceObservationId,
      locator: ordered[0]!.locator,
      candidate_printing_ids: [],
      detail:
        "The candidate contains contradictory Card, Source Lineage, artwork, printed rules, rarity, or treatment evidence for one locator.",
    });
  }
  return stableDiagnostics(diagnostics);
}

export async function showReconciliationSourceObservation(
  database: D1Database,
  sourceObservationId: string,
): Promise<Record<string, unknown>> {
  const row = await database
    .prepare(
      `SELECT * FROM reconciliation_source_observations
       WHERE source_observation_id = ?`,
    )
    .bind(sourceObservationId)
    .first<SourceObservationRow>();
  if (row === null) {
    throw new AdministrationProblem(
      404,
      "source_observation_not_found",
      "The requested Source Observation does not exist.",
    );
  }
  return {
    contract: "card-keepr-reconciliation-source-observation@1",
    source_observation_id: row.source_observation_id,
    catalogue_revision_id: row.catalogue_revision_id,
    printing_id: row.printing_id,
    observation: JSON.parse(row.observation_json),
    unknown_fields: JSON.parse(row.unknown_fields_json),
  };
}

async function findOrCreateCard(
  database: D1Database,
  pending: Map<string, CardRow>,
  observation: SourceObservation,
  revisionId: string,
): Promise<CardRow> {
  const key = canonicalJson({
    supported_game: observation.supportedGame,
    official_identity: observation.officialIdentity,
  });
  const pendingCard = pending.get(key);
  if (pendingCard !== undefined) {
    const observed = observeCard(pendingCard, observation, revisionId);
    pending.set(key, observed);
    return observed;
  }
  const existing = await database
    .prepare(
      `SELECT * FROM reconciled_cards
       WHERE supported_game = ?
         AND official_identity_kind = ?
         AND official_identity_value = ?`,
    )
    .bind(
      observation.supportedGame,
      observation.officialIdentity.kind,
      observation.officialIdentity.value,
    )
    .first<CardRow>();
  const card =
    existing ??
    ({
      id: `card_${(await sha256Text(key)).slice(0, 32)}`,
      supported_game: observation.supportedGame,
      official_identity_kind: observation.officialIdentity.kind,
      official_identity_value: observation.officialIdentity.value,
      first_revision_id: revisionId,
      last_observed_revision_id: revisionId,
      withdrawn: 0,
      withdrawn_revision_id: null,
      withdrawal_evidence_json: null,
    } satisfies CardRow);
  const observed = observeCard(card, observation, revisionId);
  pending.set(key, observed);
  return observed;
}

function observeCard(
  card: CardRow,
  observation: SourceObservation,
  revisionId: string,
): CardRow {
  return {
    ...card,
    last_observed_revision_id: revisionId,
    ...(!withdrawsCard(observation)
      ? {}
      : {
          withdrawn: 1,
          withdrawn_revision_id: revisionId,
          withdrawal_evidence_json: canonicalJson(
            observation.withdrawal,
          ),
        }),
  };
}

async function compatiblePrintings(
  database: D1Database,
  cardId: string,
  observation: CompleteSourceObservation,
): Promise<PrintingRow[]> {
  const result = await database
    .prepare(
      `SELECT * FROM reconciled_printings
       WHERE card_id = ?
         AND source_lineage = ?
         AND artwork_fingerprint = ?
         AND printed_rules_fingerprint = ?
         AND rarity_raw = ?
         AND rarity_normalized = ?
         AND treatment = ?
       ORDER BY id`,
    )
    .bind(
      cardId,
      observation.sourceLineage,
      observation.artworkFingerprint,
      observation.printedRulesFingerprint,
      observation.rarity.raw,
      observation.rarity.normalized,
      observation.treatment,
    )
    .all<PrintingRow>();
  return result.results;
}

async function requiredPrinting(
  database: D1Database,
  printingId: string,
): Promise<PrintingRow> {
  const printing = await database
    .prepare("SELECT * FROM reconciled_printings WHERE id = ?")
    .bind(printingId)
    .first<PrintingRow>();
  if (printing === null) throw new Error("Printing locator is orphaned.");
  return printing;
}

function isCompatible(
  printing: PrintingRow,
  cardId: string,
  observation: CompleteSourceObservation,
): boolean {
  return (
    printing.card_id === cardId &&
    printing.source_lineage === observation.sourceLineage &&
    printing.artwork_fingerprint === observation.artworkFingerprint &&
    printing.printed_rules_fingerprint ===
      observation.printedRulesFingerprint &&
    printing.rarity_raw === observation.rarity.raw &&
    printing.rarity_normalized === observation.rarity.normalized &&
    printing.treatment === observation.treatment
  );
}

async function newPrinting(
  cardId: string,
  observation: CompleteSourceObservation,
  revisionId: string,
): Promise<PrintingRow> {
  const identityEvidence = canonicalJson({
    card_id: cardId,
    source_lineage: observation.sourceLineage,
    artwork_fingerprint: observation.artworkFingerprint,
    printed_rules_fingerprint: observation.printedRulesFingerprint,
    rarity: observation.rarity,
    treatment: observation.treatment,
  });
  return {
    id: `printing_${(await sha256Text(identityEvidence)).slice(0, 32)}`,
    card_id: cardId,
    source_lineage: observation.sourceLineage,
    artwork_fingerprint: observation.artworkFingerprint,
    printed_rules_fingerprint: observation.printedRulesFingerprint,
    rarity_raw: observation.rarity.raw,
    rarity_normalized: observation.rarity.normalized,
    treatment: observation.treatment,
    memberships_json: canonicalJson(observation.memberships),
    first_revision_id: revisionId,
    last_observed_revision_id: revisionId,
    withdrawn: withdrawsPrinting(observation) ? 1 : 0,
    withdrawn_revision_id:
      withdrawsPrinting(observation) ? revisionId : null,
    withdrawal_evidence_json:
      withdrawsPrinting(observation)
        ? canonicalJson(observation.withdrawal)
        : null,
  };
}

function mergePrinting(
  printing: PrintingRow,
  observation: CompleteSourceObservation,
  revisionId: string,
): PrintingRow {
  const existingMemberships = parseMemberships(printing.memberships_json);
  return {
    ...printing,
    memberships_json: canonicalJson({
      product_ids: union(
        existingMemberships.product_ids,
        observation.memberships.product_ids,
      ),
      distribution_context_ids: union(
        existingMemberships.distribution_context_ids,
        observation.memberships.distribution_context_ids,
      ),
      source_buckets: union(
        existingMemberships.source_buckets,
        observation.memberships.source_buckets,
      ),
    }),
    last_observed_revision_id: revisionId,
    ...(!withdrawsPrinting(observation)
      ? {}
      : {
          withdrawn: 1,
          withdrawn_revision_id: revisionId,
          withdrawal_evidence_json: canonicalJson(
            observation.withdrawal,
          ),
        }),
  };
}

async function missingObservedPrintings(
  database: D1Database,
  sourceLineages: readonly string[],
  observedPrintingIds: ReadonlySet<string>,
): Promise<PrintingRow[]> {
  const missing: PrintingRow[] = [];
  for (const lineage of [...new Set(sourceLineages)].sort()) {
    const result = await database
      .prepare(
        `SELECT * FROM reconciled_printings
         WHERE source_lineage = ?
         ORDER BY id`,
      )
      .bind(lineage)
      .all<PrintingRow>();
    for (const printing of result.results) {
      if (!observedPrintingIds.has(printing.id)) missing.push(printing);
    }
  }
  return missing;
}

async function publicCardsForPrintings(
  database: D1Database,
  printings: readonly PrintingRow[],
): Promise<Record<string, unknown>[]> {
  const cards = new Map<string, CardRow>();
  for (const printing of printings) {
    const card = await database
      .prepare("SELECT * FROM reconciled_cards WHERE id = ?")
      .bind(printing.card_id)
      .first<CardRow>();
    if (card !== null) cards.set(card.id, card);
  }
  return [...cards.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(publicCard);
}

function publicCard(card: CardRow): Record<string, unknown> {
  return {
    id: card.id,
    supported_game: card.supported_game,
    official_identity: {
      kind: card.official_identity_kind,
      value: card.official_identity_value,
    },
    lifecycle: lifecycle(card),
  };
}

async function publicPrinting(
  database: D1Database,
  printing: PrintingRow,
): Promise<Record<string, unknown>> {
  const locators = await database
    .prepare(
      `SELECT locator FROM reconciled_printing_locators
       WHERE printing_id = ?
       ORDER BY locator`,
    )
    .bind(printing.id)
    .all<{ locator: string }>();
  return {
    id: printing.id,
    card_id: printing.card_id,
    source_lineage: printing.source_lineage,
    artwork_fingerprint: printing.artwork_fingerprint,
    printed_rules_fingerprint: printing.printed_rules_fingerprint,
    rarity: {
      raw: printing.rarity_raw,
      normalized: printing.rarity_normalized,
    },
    treatment: printing.treatment,
    locators: locators.results.map((row) => row.locator),
    memberships: parseMemberships(printing.memberships_json),
    lifecycle: lifecycle(printing),
  };
}

function lifecycle(
  value: CardRow | PrintingRow,
): Record<string, unknown> {
  return {
    first_revision_id: value.first_revision_id,
    last_observed_revision_id: value.last_observed_revision_id,
    withdrawn: value.withdrawn === 1,
    withdrawal:
      value.withdrawal_evidence_json === null
        ? null
        : {
            revision_id: value.withdrawn_revision_id,
            evidence: JSON.parse(value.withdrawal_evidence_json),
          },
  };
}

function reconciliationDocument(
  publishable: boolean,
  cards: readonly Record<string, unknown>[],
  printings: readonly Record<string, unknown>[],
  diagnostics: readonly Diagnostic[],
  warnings: readonly Warning[],
): Record<string, unknown> {
  return {
    contract: "card-keepr-card-printing-reconciliation@1",
    publishable,
    cards,
    printings,
    diagnostics,
    warnings,
  };
}

function parseSourceObservation(
  value: unknown,
  index: number,
): SourceObservation {
  if (!isRecord(value)) {
    invalidRequest(`source_observations[${index}] must be an object.`);
  }
  const supportedGame = requiredString(
    value.supported_game,
    `source_observations[${index}].supported_game`,
  );
  if (!supportedGames.has(supportedGame)) {
    invalidRequest(
      `source_observations[${index}].supported_game is not a Supported Game.`,
    );
  }
  const identity = requiredRecord(
    value.official_identity,
    `source_observations[${index}].official_identity`,
  );
  const kind = requiredString(
    identity.kind,
    `source_observations[${index}].official_identity.kind`,
  );
  const identityValue = requiredString(
    identity.value,
    `source_observations[${index}].official_identity.value`,
  );
  if (
    kind !== "card_number" &&
    kind !== "functional_designation"
  ) {
    invalidRequest("official_identity.kind is not supported.");
  }
  if (
    kind === "functional_designation" &&
    (supportedGame !== "one-piece" || identityValue !== "DON!!")
  ) {
    invalidRequest(
      "Only the One Piece DON!! Card uses functional_designation identity.",
    );
  }
  if (
    kind === "card_number" &&
    !/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(identityValue)
  ) {
    invalidRequest(
      "official_identity.value must be an official uppercase card number.",
    );
  }
  const rarity = requiredRecord(
    value.rarity,
    `source_observations[${index}].rarity`,
  );
  const memberships =
    value.memberships === undefined
      ? emptyMemberships()
      : parseMembershipRecord(value.memberships, index);
  const withdrawal =
    value.withdrawal === undefined
      ? null
      : parseWithdrawal(value.withdrawal, index);
  const unknownFields = extractUnknownFields(value, supportedGame);
  return {
    sourceObservationId: requiredString(
      value.source_observation_id,
      `source_observations[${index}].source_observation_id`,
    ),
    supportedGame,
    sourceLineage: requiredString(
      value.source_lineage,
      `source_observations[${index}].source_lineage`,
    ),
    locator: requiredString(
      value.locator,
      `source_observations[${index}].locator`,
    ),
    officialIdentity: {
      kind,
      value: identityValue,
    },
    artworkFingerprint: optionalEvidenceString(
      value.artwork_fingerprint,
      `source_observations[${index}].artwork_fingerprint`,
    ),
    printedRulesFingerprint: optionalEvidenceString(
      value.printed_rules_fingerprint,
      `source_observations[${index}].printed_rules_fingerprint`,
    ),
    rarity: {
      raw: optionalEvidenceString(
        rarity.raw,
        `source_observations[${index}].rarity.raw`,
      ),
      normalized: optionalEvidenceString(
        rarity.normalized,
        `source_observations[${index}].rarity.normalized`,
      ),
    },
    treatment: optionalEvidenceString(
      value.treatment,
      `source_observations[${index}].treatment`,
    ),
    memberships,
    withdrawal,
    original: value,
    unknownFields,
  };
}

function extractUnknownFields(
  observation: Record<string, unknown>,
  supportedGame: string,
): Record<string, unknown> {
  const unknown = Object.fromEntries(
    Object.entries(observation).filter(
      ([field]) => !knownObservationFields.has(field),
    ),
  );
  if (observation.game_profile === undefined) return unknown;
  if (!isRecord(observation.game_profile)) {
    invalidRequest("game_profile must be an object when supplied.");
  }
  const attributes = observation.game_profile.attributes;
  if (attributes === undefined) return unknown;
  if (!isRecord(attributes)) {
    invalidRequest("game_profile.attributes must be an object.");
  }
  const knownAttributes =
    supportedGame === "one-piece"
      ? knownOnePieceGameProfileAttributes
      : new Set<string>();
  for (const [field, value] of Object.entries(attributes)) {
    if (!knownAttributes.has(field)) {
      unknown[`game_profile.attributes.${field}`] = value;
    }
  }
  return unknown;
}

function parseMembershipRecord(
  value: unknown,
  index: number,
): Memberships {
  const record = requiredRecord(
    value,
    `source_observations[${index}].memberships`,
  );
  return {
    product_ids: optionalStringArray(
      record.product_ids,
      `source_observations[${index}].memberships.product_ids`,
    ),
    distribution_context_ids: optionalStringArray(
      record.distribution_context_ids,
      `source_observations[${index}].memberships.distribution_context_ids`,
    ),
    source_buckets: optionalStringArray(
      record.source_buckets,
      `source_observations[${index}].memberships.source_buckets`,
    ),
  };
}

function parseWithdrawal(
  value: unknown,
  index: number,
): {
  explicit: true;
  entity: "card" | "printing" | "card_and_printing";
  evidence: string;
} {
  const record = requiredRecord(
    value,
    `source_observations[${index}].withdrawal`,
  );
  if (record.explicit !== true) {
    invalidRequest("withdrawal must contain explicit: true.");
  }
  const entity = requiredString(
    record.entity,
    `source_observations[${index}].withdrawal.entity`,
  );
  if (
    entity !== "card" &&
    entity !== "printing" &&
    entity !== "card_and_printing"
  ) {
    invalidRequest(
      "withdrawal.entity must identify card, printing, or card_and_printing.",
    );
  }
  return {
    explicit: true,
    entity,
    evidence: requiredString(
      record.evidence,
      `source_observations[${index}].withdrawal.evidence`,
    ),
  };
}

function withdrawsCard(observation: SourceObservation): boolean {
  return (
    observation.withdrawal?.entity === "card" ||
    observation.withdrawal?.entity === "card_and_printing"
  );
}

function withdrawsPrinting(observation: SourceObservation): boolean {
  return (
    observation.withdrawal?.entity === "printing" ||
    observation.withdrawal?.entity === "card_and_printing"
  );
}

function parseMemberships(value: string): Memberships {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("Invalid stored memberships.");
  return {
    product_ids: storedStringArray(parsed.product_ids),
    distribution_context_ids: storedStringArray(
      parsed.distribution_context_ids,
    ),
    source_buckets: storedStringArray(parsed.source_buckets),
  };
}

function hasCompletePrintingEvidence(
  observation: SourceObservation,
): observation is CompleteSourceObservation {
  return (
    observation.artworkFingerprint !== null &&
    observation.printedRulesFingerprint !== null &&
    observation.rarity.raw !== null &&
    observation.rarity.normalized !== null &&
    observation.treatment !== null
  );
}

function emptyMemberships(): Memberships {
  return {
    product_ids: [],
    distribution_context_ids: [],
    source_buckets: [],
  };
}

function union(
  left: readonly string[],
  right: readonly string[],
): string[] {
  return [...new Set([...left, ...right])].sort();
}

function stableDiagnostics(
  values: readonly Diagnostic[],
): Diagnostic[] {
  return [...values].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function stableWarnings(values: readonly Warning[]): Warning[] {
  return [...values].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function assertOnlyRequestFields(body: Record<string, unknown>): void {
  const accepted = new Set([
    "catalogue_revision_id",
    "observed_source_lineages",
    "source_observations",
  ]);
  for (const field of Object.keys(body)) {
    if (!accepted.has(field)) invalidRequest(`Unknown field: ${field}`);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalidRequest(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalEvidenceString(
  value: unknown,
  field: string,
): string | null {
  return value === undefined ? null : requiredString(value, field);
}

function requiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalidRequest(`${field} must be a non-empty string array.`);
  }
  return value.map((entry, index) =>
    requiredString(entry, `${field}[${index}]`),
  );
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidRequest(`${field} must be an array.`);
  return union(
    [],
    value.map((entry, index) =>
      requiredString(entry, `${field}[${index}]`),
    ),
  );
}

function storedStringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new Error("Invalid stored membership list.");
  }
  return [...value].sort();
}

function requiredRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) invalidRequest(`${field} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function invalidRequest(message: string): never {
  throw new AdministrationProblem(
    422,
    "invalid_reconciliation_request",
    message,
  );
}
