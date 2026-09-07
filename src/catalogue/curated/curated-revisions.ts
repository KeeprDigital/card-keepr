import { materializeCuratedConflictStatements } from "./curated-conflict-preparation-repository";
import {
  CuratedConflictPreparation,
  sourceChangeDetails,
  sourceChangeDiagnostic,
  type PendingConflict,
} from "./curated-conflict-preparation";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  AdministrationProblem,
  type CatalogueCandidate,
  type CatalogueDraft,
  type CatalogueEntityCollection,
  type CatalogueDraftEntity,
  type CatalogueStore,
  type CuratedEvidence,
  type CuratedFieldTarget,
  type CuratedProvenance,
  type CuratedRelationshipTarget,
  canonicalJson,
  canonicalProfileAttributes,
  decodeDocument,
  exportedGameProfileSchema,
  type ProductRelationship,
  replayByDigest,
  retainedPayload,
  type SupportedGame,
  sha256Text,
} from "../shared";
import * as curatedStatements from "./curated-repository";
import {
  curatedLifecycleMutationStatements,
  curatedRevisionStatement,
  type CuratedRevisionRow as RevisionRow,
} from "./curated-repository";

const games = new Set(["one-piece", "fusion-world", "digimon", "gundam"]);
const forbiddenRoots = new Set([
  "id",
  "game",
  "official_identity",
  "source_snapshots",
  "source_observations",
  "provenance",
  "curated_provenance",
  "evidence",
  "lifecycle",
  "links",
  "source_lineages",
  "printing_ids",
  "relationship_evidence",
  "locator_evidence",
  "included",
  "disagreements",
  "withdrawal",
  "observed",
  "resolution",
  "evidence_category",
  "source_lineage",
  "source_observation_id",
  "source_observation_ids",
  "source_observation_pointer",
  "source_field_pointers",
]);
const identityRootsByType: Readonly<Record<string, ReadonlySet<string>>> = {
  card: new Set(["official_identity"]),
  printing: new Set(["card_id"]),
  product: new Set(["reference", "official_code"]),
  release: new Set(["event_key", "product_id", "region"]),
  distribution_context: new Set(["key", "product_id"]),
  erratum: new Set(["target_type", "target_id"]),
};
const relationshipEndpointPairs: Readonly<Record<string, string>> = {
  "printing-product": "printing->product",
  "printing-distribution-context": "printing->distribution_context",
  "distribution-context-product": "distribution_context->product",
  "product-card": "product->card",
};
export const curatedSourceAbsence = Object.freeze({
  contract: "card-keepr-curated-source-absence@1" as const,
});
const fieldAjv = new Ajv2020({ allErrors: true, strict: false });
addFormats(fieldAjv);

type FieldTarget = CuratedFieldTarget;
type RelationshipTarget = CuratedRelationshipTarget;
/**
 * The Curated Revision Proposal (CONTEXT.md). Inside this module, and in the
 * administration routes and CLI it serves, the bare names `proposal`,
 * `proposal_json`, and `proposal_digest` are its short form; `Proposal` is
 * the structurally validated document, never a Curated Revision itself.
 */
type Proposal = {
  game: SupportedGame;
  target: FieldTarget | RelationshipTarget;
  assertion:
    | { kind: "field"; value: unknown }
    | {
        kind: "relationship";
        presence: "present" | "absent";
      };
  rationale: string;
  evidence: readonly CuratedEvidence[];
  effective_interval: { from: string | null; to: string | null };
  reviewed_source_digest: string;
  supersedes_revision_id: string | null;
};

type MutationResult = {
  operation_id: string;
  curated_revision_id: string;
  status: "active" | "reconfirmation_required" | "superseded" | "retired";
  event_version: number;
  content_digest: string;
  current_catalogue_revision_id: string;
  code: string;
};

export async function validateCuratedRevision(
  database: CatalogueStore,
  proposalValue: unknown,
  expectedCurrentRevisionId: string,
): Promise<Record<string, unknown>> {
  const proposal = structuralProposal(proposalValue);
  await assertRetainedCuratedEvidence(database, proposal.evidence);
  const currentRevisionId = await currentCatalogueRevisionId(database);
  if (expectedCurrentRevisionId !== currentRevisionId) {
    throw new AdministrationProblem(
      409,
      "current_revision_mismatch",
      "The expected current Catalogue Revision is stale.",
    );
  }
  const target = await currentTarget(database, currentRevisionId, proposal);
  const schemaBinding = {
    catalogue_revision_id: currentRevisionId,
    game_profile: `${proposal.game}@1`,
  };
  if (proposal.target.kind === "field") {
    const path = pointerParts(proposal.target.path);
    if (protectedPath(path) || identityRootsByType[proposal.target.entity_type]?.has(path[0] ?? "")) {
      throw new AdministrationProblem(
        422,
        "curated_revision_identity_forbidden",
        `The protected field ${proposal.target.path} cannot be curated.`,
      );
    }
    const sourceValue = valueAt(target, path);
    const fieldSchema = curatedFieldSchema(proposal.target.entity_type, target, path);
    if (fieldSchema === null) {
      throw new AdministrationProblem(
        422,
        "curated_revision_field_not_in_schema",
        "A Curated Revision cannot invent a Game Profile field.",
      );
    }
    const assertionValue = (proposal.assertion as { kind: "field"; value: unknown }).value;
    if (!validCuratedFieldAssertion(proposal.target.entity_type, target, path, assertionValue, fieldSchema)) {
      throw new AdministrationProblem(
        422,
        "curated_revision_assertion_type_invalid",
        "The assertion value does not match the shared schema field type.",
      );
    }
    const digest = await sha256Text(canonicalJson(reviewedFieldSource(sourceValue)));
    if (digest !== proposal.reviewed_source_digest) {
      throw new AdministrationProblem(
        409,
        "curated_revision_reviewed_source_mismatch",
        "The reviewed Official Source value does not match the current Catalogue Revision.",
      );
    }
  } else {
    const candidate = target as unknown as CatalogueCandidate;
    assertRelationshipRepresentable(candidate, proposal);
    const digest = await sha256Text(canonicalJson(relationshipPresent(candidate, proposal) ? "present" : "absent"));
    if (digest !== proposal.reviewed_source_digest) {
      throw new AdministrationProblem(
        409,
        "curated_revision_reviewed_source_mismatch",
        "The reviewed Official Source relationship does not match the current Catalogue Revision.",
      );
    }
  }
  const proposalDigest = await sha256Text(canonicalJson(proposal));
  return {
    contract: "card-keepr-curated-revision-validation@1",
    valid: true,
    target_key: targetKey(proposal),
    proposal_digest: proposalDigest,
    schema_binding: schemaBinding,
  };
}

export async function createCuratedRevision(
  database: CatalogueStore,
  input: Record<string, unknown>,
  observedAt: string,
): Promise<{ created: boolean; document: MutationResult }> {
  onlyFields(input, ["environment", "expected_current_revision_id", "proposal", "proposal_digest", "idempotency_key"]);
  const idempotencyKey = requiredString(input.idempotency_key, "idempotency_key");
  const requestDigest = await sha256Text(canonicalJson(input));
  const replay = await idempotencyReplay(database, idempotencyKey, requestDigest);
  if (replay !== null) return replay;
  if (input.environment !== "production") {
    throw new AdministrationProblem(
      422,
      "production_target_required",
      "Curated Revision mutations require environment production.",
    );
  }
  const expected = requiredString(input.expected_current_revision_id, "expected_current_revision_id");
  const validation = await validateCuratedRevision(database, input.proposal, expected);
  const suppliedDigest = requiredString(input.proposal_digest, "proposal_digest");
  if (suppliedDigest !== validation.proposal_digest) {
    throw new AdministrationProblem(
      409,
      "curated_revision_content_digest_mismatch",
      "The supplied proposal digest does not match the canonical proposal.",
    );
  }
  const operation = await curatedStatements.curatedMutationOperationStateStatement(database).first<{
    active_ingestion_run_id: string | null;
    active_production_release_id: string | null;
    active_production_release_expires_at: string | null;
    recovery_health: string;
  }>();
  if (operation?.recovery_health === "blocked") {
    throw new AdministrationProblem(409, "recovery_in_progress", "Recovery blocks Curated Revision mutation.");
  }
  if (operation?.active_ingestion_run_id !== null) {
    throw new AdministrationProblem(
      409,
      "active_ingestion_run",
      "An active Ingestion Run blocks Curated Revision mutation.",
    );
  }
  if (
    operation?.active_production_release_id !== null &&
    operation?.active_production_release_expires_at !== null &&
    operation.active_production_release_expires_at > observedAt
  ) {
    throw new AdministrationProblem(
      409,
      "release_not_idle",
      "An active production release blocks Curated Revision mutation.",
    );
  }
  const proposal = structuralProposal(input.proposal);
  if (proposal.supersedes_revision_id) {
    throw new AdministrationProblem(
      422,
      "curated_revision_schema_invalid",
      "Use supersession for a proposal with supersedes_revision_id.",
    );
  }
  const id = `currev_${crypto.randomUUID()}`;
  const interval = proposal.effective_interval ?? { from: null, to: null };
  const schemaBinding = validation.schema_binding as Record<string, unknown>;
  const document: MutationResult = {
    operation_id: await operationIdentity(idempotencyKey),
    curated_revision_id: id,
    status: "active",
    event_version: 1,
    content_digest: suppliedDigest,
    current_catalogue_revision_id: expected,
    code: "curated_revision_created",
  };
  try {
    await database.batch([
      curatedStatements.insertAuthoredCuratedRevisionStatement(database, {
        revisionId: id,
        game: proposal.game,
        targetKey: targetKey(proposal),
        targetKind: proposal.target.kind,
        effectiveFrom: interval.from,
        effectiveTo: interval.to,
        proposalJson: canonicalJson(proposal),
        contentDigest: suppliedDigest,
        reviewedSourceDigest: proposal.reviewed_source_digest,
        schemaBindingJson: canonicalJson(schemaBinding),
        observedAt,
      }),
      curatedStatements.insertCuratedAuthoredEventStatement(database, {
        revisionId: id,
        eventJson: canonicalJson({ reviewed_source_digest: proposal.reviewed_source_digest }),
        observedAt,
      }),
      curatedStatements.insertCuratedCreationResponseStatement(database, {
        idempotencyKey,
        requestDigest,
        documentJson: canonicalJson(document),
        observedAt,
      }),
    ]);
  } catch (error) {
    const concurrentReplay = await idempotencyReplay(database, idempotencyKey, requestDigest);
    if (concurrentReplay !== null) return concurrentReplay;
    throw lifecycleWriteProblem(error);
  }
  return { created: true, document };
}

export async function reaffirmCuratedRevision(
  database: CatalogueStore,
  revisionId: string,
  input: Record<string, unknown>,
  observedAt: string,
): Promise<{ created: boolean; document: MutationResult }> {
  onlyFields(input, [
    "environment",
    "expected_current_revision_id",
    "expected_event_version",
    "conflict_digest",
    "rationale",
    "idempotency_key",
  ]);
  const mutation = await existingRevisionMutation(database, revisionId, input, observedAt);
  if (mutation.replay !== null) return mutation.replay;
  if (mutation.row.status !== "reconfirmation_required" || mutation.conflict === null) {
    throw new AdministrationProblem(
      409,
      "curated_revision_state_conflict",
      "Only a Curated Revision requiring reconfirmation may be reaffirmed.",
    );
  }
  const rationale = requiredString(input.rationale, "rationale");
  const conflictDigest = requiredString(input.conflict_digest, "conflict_digest");
  if (conflictDigest !== mutation.conflict.conflict_digest) {
    throw new AdministrationProblem(
      409,
      "curated_revision_conflict_digest_mismatch",
      "The exact pending conflict digest is required.",
    );
  }
  const version = mutation.row.event_version + 1;
  const result = mutationResult(
    mutation.operationId,
    mutation.row,
    "active",
    version,
    mutation.currentRevisionId,
    "curated_revision_reaffirmed",
  );
  await appendLifecycleMutation(database, mutation, result, {
    status: "active",
    kind: "reaffirmed",
    version,
    details: {
      conflict_id: mutation.conflict.conflict_id,
      conflict_digest: conflictDigest,
      reviewed_source_digest: mutation.conflict.observed_source_digest,
      rationale,
      expected_current_revision_id: mutation.currentRevisionId,
    },
    observedAt,
  });
  return { created: true, document: result };
}

export async function retireCuratedRevision(
  database: CatalogueStore,
  revisionId: string,
  input: Record<string, unknown>,
  observedAt: string,
): Promise<{ created: boolean; document: MutationResult }> {
  onlyFields(input, [
    "environment",
    "expected_current_revision_id",
    "expected_event_version",
    "conflict_digest",
    "rationale",
    "idempotency_key",
  ]);
  requiredOwnField(input, "conflict_digest");
  const mutation = await existingRevisionMutation(database, revisionId, input, observedAt);
  if (mutation.replay !== null) return mutation.replay;
  assertConflictBinding(mutation.conflict, input.conflict_digest);
  const rationale = requiredString(input.rationale, "rationale");
  const version = mutation.row.event_version + 1;
  const result = mutationResult(
    mutation.operationId,
    mutation.row,
    "retired",
    version,
    mutation.currentRevisionId,
    "curated_revision_retired",
  );
  await appendLifecycleMutation(database, mutation, result, {
    status: "retired",
    kind: "retired",
    version,
    details: {
      conflict_id: mutation.conflict?.conflict_id ?? null,
      conflict_digest: mutation.conflict?.conflict_digest ?? null,
      rationale,
      expected_current_revision_id: mutation.currentRevisionId,
    },
    observedAt,
  });
  return { created: true, document: result };
}

export async function supersedeCuratedRevision(
  database: CatalogueStore,
  revisionId: string,
  input: Record<string, unknown>,
  observedAt: string,
): Promise<{ created: boolean; document: MutationResult }> {
  onlyFields(input, [
    "environment",
    "expected_current_revision_id",
    "expected_event_version",
    "conflict_digest",
    "proposal",
    "proposal_digest",
    "rationale",
    "idempotency_key",
  ]);
  requiredOwnField(input, "conflict_digest");
  const mutation = await existingRevisionMutation(database, revisionId, input, observedAt);
  if (mutation.replay !== null) return mutation.replay;
  assertConflictBinding(mutation.conflict, input.conflict_digest);
  requiredString(input.rationale, "rationale");
  const proposal = structuralProposal(input.proposal);
  if (proposal.supersedes_revision_id !== revisionId) {
    throw new AdministrationProblem(
      409,
      "curated_revision_supersession_mismatch",
      "The proposal must bind the exact prior Curated Revision identity.",
    );
  }
  const proposalDigest = await sha256Text(canonicalJson(proposal));
  if (requiredString(input.proposal_digest, "proposal_digest") !== proposalDigest) {
    throw new AdministrationProblem(
      409,
      "curated_revision_content_digest_mismatch",
      "The supplied proposal digest does not match the canonical proposal.",
    );
  }
  await validateSupersedingProposal(database, mutation, proposal);
  const replacementId = `currev_${crypto.randomUUID()}`;
  const interval = proposal.effective_interval ?? { from: null, to: null };
  const oldVersion = mutation.row.event_version + 1;
  const schemaBinding = {
    catalogue_revision_id: mutation.currentRevisionId,
    game_profile: `${proposal.game}@1`,
  };
  const result: MutationResult = {
    operation_id: mutation.operationId,
    curated_revision_id: replacementId,
    status: "active",
    event_version: 1,
    content_digest: proposalDigest,
    current_catalogue_revision_id: mutation.currentRevisionId,
    code: "curated_revision_superseded",
  };
  try {
    await database.batch([
      curatedStatements.supersedeCuratedRevisionStatement(database, {
        eventVersion: oldVersion,
        revisionId,
        expectedEventVersion: mutation.row.event_version,
      }),
      curatedStatements.insertCuratedSupersededEventStatement(database, {
        revisionId,
        eventVersion: oldVersion,
        eventJson: canonicalJson({
          superseded_by_revision_id: replacementId,
          rationale: input.rationale,
          conflict_digest: mutation.conflict?.conflict_digest ?? null,
          expected_current_revision_id: mutation.currentRevisionId,
        }),
        observedAt,
      }),
      curatedStatements.insertAuthoredCuratedRevisionStatement(database, {
        revisionId: replacementId,
        game: proposal.game,
        targetKey: targetKey(proposal),
        targetKind: proposal.target.kind,
        effectiveFrom: interval.from,
        effectiveTo: interval.to,
        proposalJson: canonicalJson(proposal),
        contentDigest: proposalDigest,
        reviewedSourceDigest: proposal.reviewed_source_digest,
        schemaBindingJson: canonicalJson(schemaBinding),
        observedAt,
      }),
      curatedStatements.insertCuratedReplacementAuthoredEventStatement(database, {
        revisionId: replacementId,
        eventJson: canonicalJson({
          reviewed_source_digest: proposal.reviewed_source_digest,
          supersedes_revision_id: revisionId,
        }),
        observedAt,
      }),
      curatedStatements.insertCuratedReplacementResponseStatement(database, {
        idempotencyKey: mutation.idempotencyKey,
        requestDigest: mutation.requestDigest,
        responseJson: canonicalJson(result),
        observedAt,
      }),
    ]);
  } catch (error) {
    const replay = await idempotencyReplay(database, mutation.idempotencyKey, mutation.requestDigest);
    if (replay !== null) return replay;
    throw lifecycleWriteProblem(error);
  }
  return { created: true, document: result };
}

export async function listCuratedRevisions(
  database: CatalogueStore,
  filters: { game?: string; target?: string; status?: string },
): Promise<Record<string, unknown>> {
  if (filters.game !== undefined && !games.has(filters.game)) {
    throw new AdministrationProblem(422, "invalid_supported_game", "The Supported Game filter is invalid.");
  }
  if (
    filters.status !== undefined &&
    !["active", "superseded", "retired", "reconfirmation_required"].includes(filters.status)
  ) {
    throw new AdministrationProblem(422, "invalid_parameter", "The Curated Revision status filter is invalid.");
  }
  const rows = await curatedStatements
    .filteredCuratedRevisionsStatement(database, {
      game: filters.game ?? null,
      target: filters.target ?? null,
      status: filters.status ?? null,
    })
    .all<RevisionRow>();
  return {
    items: await Promise.all(rows.results.map(async (row) => withoutEvents(await revisionContent(database, row)))),
    next_cursor: null,
  };
}

export async function showCuratedRevision(database: CatalogueStore, id: string): Promise<Record<string, unknown>> {
  const row = await curatedRevisionStatement(database, id).first<RevisionRow>();
  if (row === null)
    throw new AdministrationProblem(
      404,
      "curated_revision_not_found",
      "The requested Curated Revision does not exist.",
    );
  const revision = await revisionContent(database, row);
  return {
    revision: withoutEvents(revision),
    events: revision.events,
  };
}

export async function pinCuratedRevisionsForRun(
  database: CatalogueStore,
  runId: string,
  observedAt: string,
): Promise<{ revision_ids: string[]; set_digest: string }> {
  if (!(await curatedRevisionSchemaAvailable(database))) {
    return { revision_ids: [], set_digest: await sha256Text(canonicalJson([])) };
  }
  const existing = await curatedStatements
    .curatedPinnedSetStatement(database, { runId })
    .first<{ revision_ids_json: string; set_digest: string }>();
  if (existing !== null) {
    const revisionIds = JSON.parse(existing.revision_ids_json) as string[];
    const digest = await sha256Text(canonicalJson(revisionIds));
    if (existing.set_digest !== digest) {
      throw new Error("The immutable Curated Revision pin-set digest is invalid.");
    }
    return { revision_ids: revisionIds, set_digest: digest };
  }
  const run = await curatedStatements
    .curatedRunSelectedGamesStatement(database, { runId })
    .first<{ selected_games_json: string }>();
  if (run === null)
    throw new AdministrationProblem(404, "ingestion_run_not_found", "The requested Ingestion Run does not exist.");
  const statements = await curatedRevisionPinStatementsForNewRun(
    database,
    runId,
    JSON.parse(run.selected_games_json) as string[],
    observedAt,
  );
  await database.batch(statements);
  const pinned = await curatedRevisionSetForRun(database, runId);
  if (pinned === null) throw new Error("The Curated Revision set was not pinned.");
  return pinned;
}

export async function curatedRevisionPinStatementsForNewRun(
  database: CatalogueStore,
  runId: string,
  selectedGames: readonly string[],
  observedAt: string,
): Promise<D1PreparedStatement[]> {
  if (!(await curatedRevisionSchemaAvailable(database))) return [];
  const rows = await activeCuratedRevisionRows(database, selectedGames, observedAt);
  return curatedRevisionPinStatements(database, runId, rows, observedAt);
}

export async function prepareCuratedRevisionRunStart(
  database: CatalogueStore,
  runId: string,
  selectedGames: readonly SupportedGame[],
  candidate: CatalogueCandidate,
  observedAt: string,
): Promise<{
  candidate: CatalogueCandidate;
  statements: D1PreparedStatement[];
  conflictRevisionIds: readonly string[];
  diagnostics: readonly Record<string, unknown>[];
  failureCode: string | null;
}> {
  if (!(await curatedRevisionSchemaAvailable(database))) {
    return {
      candidate,
      statements: [],
      conflictRevisionIds: [],
      diagnostics: [],
      failureCode: null,
    };
  }
  const rows = await activeCuratedRevisionRows(database, selectedGames, observedAt);
  const official = stripCuratedRevisionEffects(candidate, selectedGames);
  const result = structuredClone(official) as CatalogueCandidate;
  const prepared: {
    row: ActiveCuratedRevisionRow;
    proposal: Proposal;
    reviewedSourceValue: unknown;
  }[] = [];
  const conflicts: typeof prepared = [];
  for (const row of rows) {
    const proposal = structuralProposal(JSON.parse(row.proposal_json));
    const officialTarget = candidateTarget(official, proposal);
    let reviewedSourceValue: unknown;
    if (proposal.target.kind === "field") {
      const source = valueAt(officialTarget, pointerParts(proposal.target.path));
      reviewedSourceValue = reviewedFieldSource(source);
    } else {
      reviewedSourceValue = relationshipPresent(official, proposal) ? "present" : "absent";
    }
    const item = { row, proposal, reviewedSourceValue };
    prepared.push(item);
    if ((await sha256Text(canonicalJson(reviewedSourceValue))) !== row.reviewed_source_digest) conflicts.push(item);
  }
  const pinStatements = await curatedRevisionPinStatements(database, runId, rows, observedAt);
  if (conflicts.length > 0) {
    const sourceChanges = await preparedSourceChangeStatements(database, runId, conflicts, observedAt);
    return {
      candidate: official,
      statements: [...pinStatements, ...sourceChanges.statements],
      conflictRevisionIds: conflicts.map(({ row }) => row.id),
      diagnostics: sourceChanges.diagnostics,
      failureCode: "curated_revision_reconfirmation_required",
    };
  }
  for (const { row, proposal, reviewedSourceValue } of prepared) {
    const target = candidateTarget(result, proposal);
    if (proposal.target.kind === "field") {
      setAt(
        target,
        pointerParts(proposal.target.path),
        (proposal.assertion as { kind: "field"; value: unknown }).value,
      );
      const entity = target as Record<string, unknown> & {
        curated_provenance?: readonly CuratedProvenance[];
      };
      entity.curated_provenance = [
        ...(entity.curated_provenance ?? []),
        provenanceFor(proposal, row, reviewedSourceValue),
      ];
    } else {
      applyRelationship(result, proposal, row, String(reviewedSourceValue));
    }
  }
  if (!validComposedCuratedCandidate(result)) {
    return {
      candidate: official,
      statements: pinStatements,
      conflictRevisionIds: [],
      diagnostics: [],
      failureCode: "curated_revision_composed_candidate_invalid",
    };
  }
  return {
    candidate: result,
    statements: pinStatements,
    conflictRevisionIds: [],
    diagnostics: [],
    failureCode: null,
  };
}

type ActiveCuratedRevisionRow = {
  id: string;
  proposal_json: string;
  content_digest: string;
  reviewed_source_digest: string;
  event_version: number;
};

async function activeCuratedRevisionRows(
  database: CatalogueStore,
  selectedGames: readonly string[],
  observedAt: string,
): Promise<ActiveCuratedRevisionRow[]> {
  const gamesJson = canonicalJson([...new Set(selectedGames)].sort());
  const on = observedAt.slice(0, 10);
  const rows = await curatedStatements
    .activeCuratedRevisionsStatement(database, { gamesJson, on })
    .all<ActiveCuratedRevisionRow>();
  return rows.results;
}

async function preparedSourceChangeStatements(
  database: CatalogueStore,
  runId: string,
  conflicts: readonly {
    row: ActiveCuratedRevisionRow;
    reviewedSourceValue: unknown;
  }[],
  at: string,
): Promise<{
  statements: D1PreparedStatement[];
  diagnostics: Record<string, unknown>[];
}> {
  const statements: D1PreparedStatement[] = [];
  const diagnostics: Record<string, unknown>[] = [];
  for (const conflict of conflicts) {
    const observed = await sha256Text(canonicalJson(conflict.reviewedSourceValue));
    const version = conflict.row.event_version + 1;
    const conflictId = `crconf_${crypto.randomUUID()}`;
    const details = {
      conflict_id: conflictId,
      conflict_digest: await sha256Text(
        canonicalJson({
          conflict_id: conflictId,
          run_id: runId,
          revision_id: conflict.row.id,
          previous_source_digest: conflict.row.reviewed_source_digest,
          observed_source_digest: observed,
        }),
      ),
      run_id: runId,
      previous_source_digest: conflict.row.reviewed_source_digest,
      observed_source_digest: observed,
    };
    diagnostics.push(sourceChangeDiagnostic(conflict.row.id, details));
    statements.push(
      curatedStatements.markCuratedSourceChangeStatement(database, {
        eventVersion: version,
        revisionId: conflict.row.id,
        expectedEventVersion: conflict.row.event_version,
      }),
      curatedStatements.insertCuratedSourceChangeEventStatement(database, {
        revisionId: conflict.row.id,
        eventVersion: version,
        eventJson: canonicalJson(details),
        observedAt: at,
      }),
    );
  }
  return { statements, diagnostics };
}

async function curatedRevisionPinStatements(
  database: CatalogueStore,
  runId: string,
  rows: readonly ActiveCuratedRevisionRow[],
  observedAt: string,
): Promise<D1PreparedStatement[]> {
  const ids = rows.map(({ id }) => id);
  const setDigest = await sha256Text(canonicalJson(ids));
  return [
    ...rows.map((row, ordinal) =>
      curatedStatements.insertCuratedRunPinStatement(database, {
        runId,
        ordinal,
        id: row.id,
        content_digest: row.content_digest,
        reviewed_source_digest: row.reviewed_source_digest,
      }),
    ),
    curatedStatements.insertCuratedRunPinSetStatement(database, {
      runId,
      idsJson: canonicalJson(ids),
      setDigest,
      observedAt,
    }),
  ];
}

export async function assertCuratedGamesUnblocked(
  database: CatalogueStore,
  selectedGames: readonly string[],
): Promise<void> {
  if (!(await curatedRevisionSchemaAvailable(database))) return;
  const conflict = await curatedStatements
    .blockingCuratedRevisionStatement(database, { selectedGamesJson: canonicalJson(selectedGames) })
    .first<{ id: string; game: string }>();
  if (conflict !== null) {
    throw new AdministrationProblem(
      409,
      "curated_revision_reconfirmation_required",
      `Curated Revision ${conflict.id} requires reconfirmation for ${conflict.game}.`,
    );
  }
}

export async function applyPinnedCuratedRevisions(
  database: CatalogueStore,
  runId: string,
  candidate: CatalogueCandidate,
  observedAt: string,
  options: { deferSourceChangeFailure?: boolean } = {},
): Promise<CatalogueCandidate> {
  if (!(await curatedRevisionSchemaAvailable(database))) return candidate;
  const [rows, run] = await Promise.all([
    curatedStatements.pinnedCuratedRevisionsStatement(database, { runId }).all<{
      id: string;
      proposal_json: string;
      content_digest: string;
      reviewed_source_digest: string;
    }>(),
    curatedStatements.curatedRunSelectedGamesStatement(database, { runId }).first<{ selected_games_json: string }>(),
  ]);
  if (run === null) {
    throw new AdministrationProblem(404, "ingestion_run_not_found", "The requested Ingestion Run does not exist.");
  }
  const selectedGames = JSON.parse(run.selected_games_json) as SupportedGame[];
  const official = stripCuratedRevisionEffects(candidate, selectedGames);
  const planned = rows.results.map((row) => ({
    row,
    proposal: structuralProposal(JSON.parse(row.proposal_json)),
  }));
  const comparisons: {
    row: (typeof rows.results)[number];
    proposal: Proposal;
    reviewedSourceValue: unknown;
    changed: boolean;
  }[] = [];
  for (const { row, proposal } of planned) {
    const target = candidateTarget(official, proposal);
    if (proposal.target.kind === "field") {
      const parts = pointerParts(proposal.target.path);
      const source = valueAt(target, parts);
      const reviewedSourceValue = reviewedFieldSource(source);
      comparisons.push({
        row,
        proposal,
        reviewedSourceValue,
        changed: (await sha256Text(canonicalJson(reviewedSourceValue))) !== row.reviewed_source_digest,
      });
    } else {
      const sourcePresence = relationshipPresent(official, proposal) ? "present" : "absent";
      comparisons.push({
        row,
        proposal,
        reviewedSourceValue: sourcePresence,
        changed: (await sha256Text(canonicalJson(sourcePresence))) !== row.reviewed_source_digest,
      });
    }
  }
  const conflicts = comparisons.filter(({ changed }) => changed);
  if (conflicts.length > 0) {
    if (options.deferSourceChangeFailure === true) {
      const persistence = await sourceChangePersistence(database, runId, conflicts, observedAt);
      throw new CuratedRevisionSourceChangeError(official, persistence.statements, persistence.diagnostics);
    }
    await recordSourceChanges(database, runId, conflicts, observedAt);
    throw new Error("curated_revision_reconfirmation_required");
  }
  const result = structuredClone(official) as CatalogueCandidate;
  for (const { row, proposal, reviewedSourceValue } of comparisons) {
    const target = candidateTarget(result, proposal);
    if (proposal.target.kind === "field") {
      setAt(
        target,
        pointerParts(proposal.target.path),
        (proposal.assertion as { kind: "field"; value: unknown }).value,
      );
      const entity = target as Record<string, unknown> & {
        curated_provenance?: readonly CuratedProvenance[];
      };
      entity.curated_provenance = [
        ...(entity.curated_provenance ?? []),
        provenanceFor(proposal, row, reviewedSourceValue),
      ];
    } else {
      applyRelationship(result, proposal, row, String(reviewedSourceValue));
    }
  }
  if (!validComposedCuratedCandidate(result)) {
    await database.batch([
      curatedStatements.failInvalidCuratedCandidateStatement(database, { observedAt, runId }),
      curatedStatements.releaseCuratedRunStatement(database, { runId }),
    ]);
    throw new Error("curated_revision_composed_candidate_invalid");
  }
  return result;
}

type PinnedDraftRevision = {
  ordinal: number;
  id: string;
  proposal_json: string;
  content_digest: string;
  reviewed_source_digest: string;
};

export class CuratedDraftSourceChangeError extends Error {
  constructor(readonly diagnostics: AsyncIterable<Record<string, unknown>>) {
    super("curated_revision_reconfirmation_required");
  }
}

export type CuratedDraftCursor = {
  stage: "strip" | "compare" | "apply" | "validate" | "conflict" | "complete";
  kind: number;
  after: string;
  revision: number;
  sourceChanged: boolean;
};

/** Replay resumes after the completed entity or revision; the caller retains draft positions with this cursor. */
export async function applyPinnedCuratedRevisionsToDraft(
  database: CatalogueStore,
  runId: string,
  official: CatalogueDraft,
  result: CatalogueDraft,
  observedAt: string,
  progress?: { cursor: CuratedDraftCursor; checkpoint(cursor: CuratedDraftCursor, record?: unknown): Promise<void> },
): Promise<void> {
  const cursor = progress?.cursor ?? { stage: "strip", kind: 0, after: "", revision: -1, sourceChanged: false };
  if (cursor.stage === "complete") return;
  const checkpoint = async (record?: unknown) => {
    await progress?.checkpoint(cursor, record);
  };
  const advance = async (stage: CuratedDraftCursor["stage"]) => {
    cursor.stage = stage;
    cursor.kind = 0;
    cursor.after = "";
    cursor.revision = -1;
    await checkpoint();
  };
  const conflicts = new CuratedConflictPreparation(database, runId, observedAt);
  if (cursor.stage === "strip") {
    const run = await curatedStatements
      .curatedRunSelectedGamesStatement(database, { runId })
      .first<{ selected_games_json: string }>();
    if (!run)
      throw new AdministrationProblem(404, "ingestion_run_not_found", "The requested Ingestion Run does not exist.");
    for await (const entry of stripCuratedDraft(
      official,
      JSON.parse(run.selected_games_json) as SupportedGame[],
      cursor,
    )) {
      cursor.kind = entry.kind;
      cursor.after = entry.entity.id;
      await checkpoint(entry.entity);
    }
    await advance("compare");
  }
  if (cursor.stage === "compare") {
    for await (const row of pinnedDraftRevisions(database, runId, cursor.revision)) {
      const proposal = structuralProposal(JSON.parse(row.proposal_json));
      const snapshot = await draftProposalSnapshot(official, proposal);
      const reviewedSourceValue = draftReviewedValue(snapshot, proposal);
      if ((await sha256Text(canonicalJson(reviewedSourceValue))) !== row.reviewed_source_digest) {
        cursor.sourceChanged = true;
        await conflicts.record(row.id, row.reviewed_source_digest, reviewedSourceValue);
      }
      cursor.revision = row.ordinal;
      await checkpoint(row);
    }
    await advance(cursor.sourceChanged ? "conflict" : "apply");
  }
  if (cursor.stage === "conflict")
    throw new CuratedDraftSourceChangeError({ [Symbol.asyncIterator]: () => conflicts.diagnostics() });
  if (cursor.stage === "apply") {
    for await (const row of pinnedDraftRevisions(database, runId, cursor.revision)) {
      const proposal = structuralProposal(JSON.parse(row.proposal_json));
      const reviewedSourceValue = draftReviewedValue(await draftProposalSnapshot(official, proposal), proposal);
      const snapshot = await draftProposalSnapshot(result, proposal);
      if (proposal.target.kind === "field") {
        const entity = candidateTarget(snapshot, proposal);
        setAt(
          entity,
          pointerParts(proposal.target.path),
          (proposal.assertion as { kind: "field"; value: unknown }).value,
        );
        entity.curated_provenance = [
          ...(Array.isArray(entity.curated_provenance) ? entity.curated_provenance : []),
          provenanceFor(proposal, row, reviewedSourceValue),
        ];
        const kind = draftCollection(proposal.target.entity_type);
        const changed = proposal.target.entity_type === "release" ? snapshot.products![0]! : entity;
        await result.set(kind, changed as CatalogueDraftEntity<typeof kind>);
      } else {
        applyRelationship(snapshot, proposal, row, String(reviewedSourceValue));
        for (const relationship of snapshot.product_relationships ?? [])
          await result.set("product_relationships", relationship);
      }

      cursor.revision = row.ordinal;
      await checkpoint(row);
    }
    await advance("validate");
  }
  if (cursor.stage === "validate") {
    for await (const entry of validateCuratedDraft(result, cursor)) {
      if (!entry.valid) {
        await database.batch([
          curatedStatements.failInvalidCuratedCandidateStatement(database, { observedAt, runId }),
          curatedStatements.releaseCuratedRunStatement(database, { runId }),
        ]);
        throw new Error("curated_revision_composed_candidate_invalid");
      }
      cursor.kind = entry.kind;
      cursor.after = entry.entity.id;
      await checkpoint(entry.entity);
    }
    await advance("complete");
  }
}

async function* pinnedDraftRevisions(
  database: CatalogueStore,
  runId: string,
  after = -1,
): AsyncGenerator<PinnedDraftRevision> {
  while (true) {
    const row = await curatedStatements
      .nextPinnedCuratedRevisionStatement(database, runId, after)
      .first<PinnedDraftRevision>();
    if (!row) return;
    yield row;
    after = row.ordinal;
  }
}

function draftCollection(type: string): CatalogueEntityCollection {
  if (type === "card") return "cards";
  if (type === "printing") return "printings";
  if (type === "product" || type === "release") return "products";
  if (type === "distribution_context") return "distribution_contexts";
  if (type === "erratum") return "errata";
  throw new Error("Unknown Curated Revision entity type.");
}

function draftReviewedValue(snapshot: CatalogueCandidate, proposal: Proposal): unknown {
  return proposal.target.kind === "field"
    ? reviewedFieldSource(valueAt(candidateTarget(snapshot, proposal), pointerParts(proposal.target.path)))
    : relationshipPresent(snapshot, proposal)
      ? "present"
      : "absent";
}

/** Existing target and relationship validators operate on just the proposal's bounded local entities. */
async function draftProposalSnapshot(draft: CatalogueDraft, proposal: Proposal): Promise<CatalogueCandidate> {
  const snapshot: CatalogueCandidate = {
    contract: "card-keepr-catalogue-candidate@1",
    selected_games: [proposal.game],
    cards: [],
    printings: [],
  };
  const add = async (type: string, id: string) => {
    const kind = draftCollection(type);
    if (type === "release") {
      for await (const product of draft.values("products")) {
        if (product.game === proposal.game && product.releases.some((release) => release.id === id)) {
          snapshot.products = [product];
          return;
        }
      }
      return;
    }
    const entity = await draft.get(kind, id);
    if (!entity) return;
    const previous = snapshot[kind] ?? [];
    if (!previous.some((value) => value.id === id))
      Object.defineProperty(snapshot, kind, {
        value: [...previous, entity],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    if (type === "printing") {
      const printing = entity as CatalogueCandidate["printings"][number];
      const card = await draft.get("cards", printing.card_id);
      if (card && !snapshot.cards.some((existing) => existing.id === card.id))
        snapshot.cards = [...snapshot.cards, card];
    }
  };
  if (proposal.target.kind === "field") await add(proposal.target.entity_type, proposal.target.entity_id);
  else {
    const target = proposal.target;
    await add(target.from.type, target.from.id);
    await add(target.to.type, target.to.id);
    const relationships: ProductRelationship[] = [];
    let bytes = 2;
    for await (const relationship of draft.values("product_relationships")) {
      if (
        relationship.kind !== target.relationship_kind ||
        relationship.from.type !== target.from.type ||
        relationship.from.id !== target.from.id ||
        relationship.to.type !== target.to.type ||
        relationship.to.id !== target.to.id
      )
        continue;
      bytes += new TextEncoder().encode(canonicalJson(relationship)).byteLength + 1;
      if (relationships.length >= 500 || bytes > 1048576)
        throw new Error("reconciliation_capacity_exceeded: one curated relationship target has too much evidence.");
      relationships.push(relationship);
    }
    snapshot.product_relationships = relationships;
  }
  return snapshot;
}

const curatedDraftKinds = [
  "cards",
  "printings",
  "products",
  "distribution_contexts",
  "errata",
  "product_relationships",
] as const;
async function* stripCuratedDraft(
  draft: CatalogueDraft,
  selectedGames: readonly SupportedGame[],
  cursor: CuratedDraftCursor,
) {
  for (let kind = cursor.kind; kind < curatedDraftKinds.length; kind++) {
    const collection = curatedDraftKinds[kind]!;
    for await (const entity of draft.values(collection, kind === cursor.kind ? cursor.after : "")) {
      if (collection === "product_relationships") {
        const relationship = entity as ProductRelationship;
        if (selectedGames.includes(relationship.game)) {
          if (relationship.evidence_category === "curated")
            await draft.delete("product_relationships", relationship.id);
          else if (Object.hasOwn(relationship, "curated_provenance")) {
            const reviewed = relationship.curated_provenance?.at(-1)?.reviewed_source_value;
            const { curated_provenance: _provenance, ...official } = relationship;
            await draft.set("product_relationships", {
              ...official,
              ...(reviewed === "present" ? { observed: true } : reviewed === "absent" ? { observed: false } : {}),
            });
          }
        }
      } else {
        const game =
          collection === "printings"
            ? (await draft.get("cards", (entity as CatalogueCandidate["printings"][number]).card_id))?.game
            : (entity as { game: SupportedGame }).game;
        const product =
          collection === "products" ? (entity as NonNullable<CatalogueCandidate["products"]>[number]) : undefined;
        if (
          game &&
          selectedGames.includes(game) &&
          (Object.hasOwn(entity, "curated_provenance") ||
            product?.releases.some((release) => Object.hasOwn(release, "curated_provenance")))
        ) {
          restoreCuratedEntitySourceFields(entity);
          for (const release of product?.releases ?? []) restoreCuratedEntitySourceFields(release);
          await draft.set(collection, entity as CatalogueDraftEntity<typeof collection>);
        }
      }
      yield { kind, entity };
    }
  }
}

async function* validateCuratedDraft(draft: CatalogueDraft, cursor: CuratedDraftCursor) {
  const types = ["card", "printing", "product", "distribution_context", "erratum"] as const;
  for (let kind = cursor.kind; kind < curatedDraftKinds.length; kind++) {
    const collection = curatedDraftKinds[kind]!;
    for await (const entity of draft.values(collection, kind === cursor.kind ? cursor.after : "")) {
      let valid = true;
      if (collection === "product_relationships") {
        const relationship = entity as ProductRelationship;
        valid = relationshipEndpointPairs[relationship.kind] === `${relationship.from.type}->${relationship.to.type}`;
        for (const endpoint of [relationship.from, relationship.to]) {
          const target = await draft.get(draftCollection(endpoint.type), endpoint.id);
          if (!target) {
            valid = false;
            break;
          }
          const game =
            endpoint.type === "printing"
              ? (await draft.get("cards", (target as CatalogueCandidate["printings"][number]).card_id))?.game
              : (target as { game: SupportedGame }).game;
          if (game !== relationship.game) {
            valid = false;
            break;
          }
        }
      } else {
        valid = validCompleteCuratedEntity(types[kind]!, entity);
        if (collection === "products")
          valid &&= (entity as NonNullable<CatalogueCandidate["products"]>[number]).releases.every((release) =>
            validCompleteCuratedEntity("release", release),
          );
      }
      yield { kind, entity, valid };
    }
  }
}

export async function curatedRevisionSetForRun(
  database: CatalogueStore,
  runId: string,
): Promise<{ revision_ids: string[]; set_digest: string } | null> {
  if (!(await curatedRevisionSchemaAvailable(database))) return null;
  const row = await curatedStatements
    .curatedRevisionSetStatement(database, { runId })
    .first<{ revision_ids_json: string; set_digest: string }>();
  return row === null ? null : { revision_ids: JSON.parse(row.revision_ids_json), set_digest: row.set_digest };
}

export async function curatedRevisionInspectionForRun(
  database: CatalogueStore,
  runId: string,
  candidate: CatalogueCandidate,
): Promise<{
  revision_ids: string[];
  set_digest: string;
  effects: Record<string, unknown>[];
} | null> {
  const set = await curatedRevisionSetForRun(database, runId);
  if (set === null) return null;
  const run = await curatedStatements
    .curatedRunStateStatement(database, { runId })
    .first<{ state: string; failure_code: string | null }>();
  const sourceChangeFailure =
    run?.state === "failed" && run.failure_code === "curated_revision_reconfirmation_required";
  const expectedDigest = await sha256Text(canonicalJson(set.revision_ids));
  if (expectedDigest !== set.set_digest) {
    throw new Error("The immutable Curated Revision pin-set digest is invalid.");
  }
  const rows = await curatedStatements.curatedRunPinInspectionStatement(database, { runId }).all<{
    ordinal: number;
    revision_id: string;
    content_digest: string;
    proposal_json: string;
  }>();
  if (canonicalJson(rows.results.map(({ revision_id }) => revision_id)) !== canonicalJson(set.revision_ids)) {
    throw new Error("The immutable Curated Revision pin-set rows are invalid.");
  }
  const effects = rows.results.flatMap((row) => {
    const proposal = structuralProposal(JSON.parse(row.proposal_json));
    if (!candidateContainsCuratedRevision(candidate, proposal, row.revision_id, row.content_digest)) {
      if (sourceChangeFailure) return [];
      throw new Error(`Candidate is missing applied Curated Revision ${row.revision_id}.`);
    }
    return [
      {
        revision_id: row.revision_id,
        target: targetKey(proposal),
        assertion: structuredClone(proposal.assertion),
        evidence_category: "curated",
      },
    ];
  });
  return {
    revision_ids: set.revision_ids,
    set_digest: set.set_digest,
    effects,
  };
}

function candidateContainsCuratedRevision(
  candidate: CatalogueCandidate,
  proposal: Proposal,
  revisionId: string,
  contentDigest: string,
): boolean {
  const matches = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.some(
      (item) =>
        record(item) &&
        item.curated_revision_id === revisionId &&
        item.content_digest === contentDigest &&
        record(item.target) &&
        canonicalJson(item.target) === canonicalJson(proposal.target),
    );
  if (proposal.target.kind === "field") {
    try {
      return matches(candidateTarget(candidate, proposal).curated_provenance);
    } catch {
      return false;
    }
  }
  const target = proposal.target;
  return (candidate.product_relationships ?? []).some(
    (relationship) =>
      relationship.kind === target.relationship_kind &&
      relationship.from.type === target.from.type &&
      relationship.from.id === target.from.id &&
      relationship.to.type === target.to.type &&
      relationship.to.id === target.to.id &&
      matches(relationship.curated_provenance),
  );
}

export async function curatedPublicationStatements(
  database: CatalogueStore,
  runId: string,
  revisionId: string,
): Promise<D1PreparedStatement[]> {
  if (!(await curatedRevisionSchemaAvailable(database))) return [];
  return [curatedStatements.insertPublishedCuratedProvenanceStatement(database, { revisionId, runId })];
}

export function stripCuratedRevisionEffects(
  input: CatalogueCandidate,
  selectedGames?: readonly SupportedGame[],
): CatalogueCandidate {
  const candidate = structuredClone(input) as CatalogueCandidate;
  const selected = selectedGames === undefined ? null : new Set<SupportedGame>(selectedGames);
  const entities: Record<string, unknown>[] = [
    ...candidate.cards.filter((card) => selected === null || selected.has(card.game)),
    ...candidate.printings.filter((printing) => {
      const game = candidate.cards.find((card) => card.id === printing.card_id)?.game;
      return selected === null || (game !== undefined && selected.has(game));
    }),
    ...(candidate.products ?? []).filter((product) => selected === null || selected.has(product.game)),
    ...(candidate.products ?? [])
      .filter((product) => selected === null || selected.has(product.game))
      .flatMap((product) => product.releases),
    ...(candidate.distribution_contexts ?? []).filter((context) => selected === null || selected.has(context.game)),
    ...(candidate.errata ?? []).filter((erratum) => selected === null || selected.has(erratum.game)),
  ] as Record<string, unknown>[];
  for (const entity of entities) restoreCuratedEntitySourceFields(entity);
  if (candidate.product_relationships !== undefined) {
    candidate.product_relationships = candidate.product_relationships
      .filter(
        (relationship) =>
          (selected !== null && !selected.has(relationship.game)) || relationship.evidence_category !== "curated",
      )
      .map((relationship) => {
        if (selected !== null && !selected.has(relationship.game)) {
          return relationship;
        }
        const reviewed = relationship.curated_provenance?.at(-1)?.reviewed_source_value;
        const { curated_provenance: _provenance, ...official } = relationship;
        return {
          ...official,
          ...(reviewed === "present" ? { observed: true } : reviewed === "absent" ? { observed: false } : {}),
        };
      });
  }
  return candidate;
}

/** Restore a freshly decoded entity's reviewed official fields before applying the pinned revisions. */
export function restoreCuratedEntitySourceFields(entity: Record<string, unknown>): void {
  const provenance = Array.isArray(entity.curated_provenance) ? (entity.curated_provenance as CuratedProvenance[]) : [];
  for (const item of provenance) {
    const target = item.target;
    if (target.kind === "field" && typeof target.path === "string") {
      restoreReviewedField(entity, pointerParts(target.path), item.reviewed_source_value);
    }
  }
  delete entity.curated_provenance;
}

async function curatedRevisionSchemaAvailable(database: CatalogueStore): Promise<boolean> {
  const row = await curatedStatements.curatedSchemaAvailableStatement(database).first<{ present: number }>();
  return row?.present === 1;
}

async function recordSourceChanges(
  database: CatalogueStore,
  runId: string,
  conflicts: readonly {
    row: { id: string; reviewed_source_digest: string };
    reviewedSourceValue: unknown;
  }[],
  at: string,
) {
  const persistence = await sourceChangePersistence(database, runId, conflicts, at);
  await database.batch([...persistence.statements, ...sourceChangeRunFailureStatements(database, runId, at)]);
}

async function sourceChangePersistence(
  database: CatalogueStore,
  runId: string,
  conflicts: readonly {
    row: { id: string; reviewed_source_digest: string };
    reviewedSourceValue: unknown;
  }[],
  at: string,
): Promise<{
  statements: D1PreparedStatement[];
  diagnostics: Record<string, unknown>[];
}> {
  const statements: D1PreparedStatement[] = [];
  const diagnostics: Record<string, unknown>[] = [];
  for (const conflict of conflicts) {
    const revision = await curatedStatements
      .curatedRevisionStatusStatement(database, { revisionId: conflict.row.id })
      .first<{ status: string; event_version: number }>();
    if (revision?.status === "reconfirmation_required") continue;
    const version = (revision?.event_version ?? 0) + 1;
    const details = await sourceChangeDetails(
      runId,
      conflict.row.id,
      conflict.row.reviewed_source_digest,
      conflict.reviewedSourceValue,
    );
    diagnostics.push(sourceChangeDiagnostic(conflict.row.id, details));
    statements.push(
      curatedStatements.markActiveCuratedSourceChangeStatement(database, {
        eventVersion: version,
        revisionId: conflict.row.id,
      }),
      curatedStatements.insertLegacyCuratedSourceChangeEventStatement(database, {
        revisionId: conflict.row.id,
        eventVersion: version,
        eventJson: canonicalJson(details),
        observedAt: at,
      }),
    );
  }
  return { statements, diagnostics };
}

function sourceChangeRunFailureStatements(database: CatalogueStore, runId: string, at: string): D1PreparedStatement[] {
  return [
    curatedStatements.failCuratedSourceChangeRunStatement(database, { at, runId }),
    curatedStatements.releaseCuratedRunStatement(database, { runId }),
  ];
}

export class CuratedRevisionSourceChangeError extends Error {
  constructor(
    readonly candidate: CatalogueCandidate,
    readonly atomicStatements: readonly D1PreparedStatement[],
    readonly diagnostics: readonly Record<string, unknown>[],
  ) {
    super("curated_revision_reconfirmation_required");
  }
}

type ExistingMutation = {
  replay: { created: boolean; document: MutationResult } | null;
  row: RevisionRow;
  conflict: PendingConflict | null;
  currentRevisionId: string;
  idempotencyKey: string;
  requestDigest: string;
  operationId: string;
};

async function existingRevisionMutation(
  database: CatalogueStore,
  revisionId: string,
  input: Record<string, unknown>,
  observedAt: string,
): Promise<ExistingMutation> {
  const idempotencyKey = requiredString(input.idempotency_key, "idempotency_key");
  const requestDigest = await sha256Text(canonicalJson({ revision_id: revisionId, ...input }));
  const replay = await idempotencyReplay(database, idempotencyKey, requestDigest);
  if (replay !== null) {
    return {
      replay,
      row: {} as RevisionRow,
      conflict: null,
      currentRevisionId: "",
      idempotencyKey,
      requestDigest,
      operationId: replay.document.operation_id,
    };
  }
  if (input.environment !== "production") {
    throw new AdministrationProblem(
      422,
      "production_target_required",
      "Curated Revision mutations require environment production.",
    );
  }
  const currentRevisionId = await currentCatalogueRevisionId(database);
  if (requiredString(input.expected_current_revision_id, "expected_current_revision_id") !== currentRevisionId) {
    throw new AdministrationProblem(
      409,
      "current_revision_mismatch",
      "The expected current Catalogue Revision is stale.",
    );
  }
  const operation = await curatedStatements.curatedMutationOperationStateStatement(database).first<{
    active_ingestion_run_id: string | null;
    active_production_release_id: string | null;
    active_production_release_expires_at: string | null;
    recovery_health: string;
  }>();
  if (operation?.recovery_health === "blocked") {
    throw new AdministrationProblem(409, "recovery_in_progress", "Recovery blocks Curated Revision mutation.");
  }
  if (operation?.active_ingestion_run_id !== null) {
    throw new AdministrationProblem(
      409,
      "active_ingestion_run",
      "An active Ingestion Run blocks Curated Revision mutation.",
    );
  }
  if (
    operation?.active_production_release_id !== null &&
    operation?.active_production_release_expires_at !== null &&
    operation.active_production_release_expires_at > observedAt
  ) {
    throw new AdministrationProblem(
      409,
      "release_not_idle",
      "An active production release blocks Curated Revision mutation.",
    );
  }
  await database.batch(materializeCuratedConflictStatements(database, revisionId));
  const row = await curatedRevisionStatement(database, revisionId).first<RevisionRow>();
  if (row === null)
    throw new AdministrationProblem(
      404,
      "curated_revision_not_found",
      "The requested Curated Revision does not exist.",
    );
  if (row.status !== "active" && row.status !== "reconfirmation_required") {
    throw new AdministrationProblem(
      409,
      "curated_revision_state_conflict",
      "The Curated Revision is no longer applicable.",
    );
  }
  if (!Number.isInteger(input.expected_event_version) || input.expected_event_version !== row.event_version) {
    throw new AdministrationProblem(
      409,
      "curated_revision_event_version_mismatch",
      "The expected lifecycle event version is stale.",
    );
  }
  const conflict = await pendingConflict(database, row);
  return {
    replay: null,
    row,
    conflict,
    currentRevisionId,
    idempotencyKey,
    requestDigest,
    operationId: await operationIdentity(idempotencyKey),
  };
}

async function pendingConflict(database: CatalogueStore, row: RevisionRow): Promise<PendingConflict | null> {
  if (row.status !== "reconfirmation_required") return null;
  const event = await curatedStatements
    .curatedPendingConflictStatement(database, { id: row.id })
    .first<{ event_json: string }>();
  return event === null ? null : (JSON.parse(event.event_json) as PendingConflict);
}

function assertConflictBinding(conflict: PendingConflict | null, supplied: unknown): void {
  if (conflict === null) {
    if (supplied !== null) {
      throw new AdministrationProblem(
        409,
        "curated_revision_has_no_pending_conflict",
        "The Curated Revision has no pending source conflict.",
      );
    }
    return;
  }
  if (supplied !== conflict.conflict_digest) {
    throw new AdministrationProblem(
      409,
      "curated_revision_conflict_digest_mismatch",
      "The exact pending conflict digest is required.",
    );
  }
}

function mutationResult(
  operationId: string,
  row: RevisionRow,
  status: MutationResult["status"],
  eventVersion: number,
  currentRevisionId: string,
  code: string,
): MutationResult {
  return {
    operation_id: operationId,
    curated_revision_id: row.id,
    status,
    event_version: eventVersion,
    content_digest: row.content_digest,
    current_catalogue_revision_id: currentRevisionId,
    code,
  };
}

async function appendLifecycleMutation(
  database: CatalogueStore,
  mutation: ExistingMutation,
  result: MutationResult,
  event: {
    status: MutationResult["status"];
    kind: "reaffirmed" | "retired";
    version: number;
    details: Record<string, unknown>;
    observedAt: string;
  },
): Promise<void> {
  try {
    await database.batch(
      curatedLifecycleMutationStatements(database, {
        revisionId: mutation.row.id,
        expectedEventVersion: mutation.row.event_version,
        status: event.status,
        eventVersion: event.version,
        kind: event.kind,
        eventJson: canonicalJson(event.details),
        observedAt: event.observedAt,
        idempotencyKey: mutation.idempotencyKey,
        requestDigest: mutation.requestDigest,
        responseJson: canonicalJson(result),
      }),
    );
  } catch (error) {
    const replay = await idempotencyReplay(database, mutation.idempotencyKey, mutation.requestDigest);
    if (replay !== null) return;
    throw lifecycleWriteProblem(error);
  }
}

async function idempotencyReplay(
  database: CatalogueStore,
  key: string,
  requestDigest: string,
): Promise<{ created: boolean; document: MutationResult } | null> {
  const row = await replayByDigest({
    lookup: () =>
      curatedStatements
        .curatedIdempotencyReplayStatement(database, { key })
        .first<{ request_digest: string; response_json: string }>(),
    retainedDigest: (retained) => retained.request_digest,
    requestDigest,
    conflictDetail: "The idempotency key is already bound to another request.",
  });
  if (row === null) return null;
  return { created: false, document: JSON.parse(row.response_json) as MutationResult };
}

function lifecycleWriteProblem(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes("curated_revision_target_conflict")) {
    return new AdministrationProblem(
      409,
      "curated_revision_target_conflict",
      "An active Curated Revision already overlaps this target and interval.",
    );
  }
  if (detail.includes("curated_revision_operation_not_idle")) {
    return new AdministrationProblem(409, "operation_not_idle", "The production mutation boundary is not idle.");
  }
  if (detail.includes("curated_revision_release_not_idle")) {
    return new AdministrationProblem(
      409,
      "release_not_idle",
      "An active production release blocks Curated Revision mutation.",
    );
  }
  if (detail.includes("curated_revision_current_revision_mismatch")) {
    return new AdministrationProblem(
      409,
      "current_revision_mismatch",
      "The expected current Catalogue Revision changed concurrently.",
    );
  }
  if (detail.includes("UNIQUE constraint failed") || detail.includes("curated_revision_events")) {
    return new AdministrationProblem(
      409,
      "curated_revision_event_version_mismatch",
      "The lifecycle event version changed concurrently.",
    );
  }
  return error instanceof Error ? error : new Error(detail);
}

async function effectiveReviewedSourceDigest(
  database: CatalogueStore,
  revisionId: string,
  fallback: string,
): Promise<string> {
  const row = await curatedStatements
    .curatedReaffirmedSourceDigestStatement(database, { revisionId })
    .first<{ digest: string | null }>();
  return row?.digest ?? fallback;
}

async function validateSupersedingProposal(
  database: CatalogueStore,
  mutation: ExistingMutation,
  proposal: Proposal,
): Promise<void> {
  await assertRetainedCuratedEvidence(database, proposal.evidence);
  const target = await currentTarget(database, mutation.currentRevisionId, proposal);
  if (proposal.target.kind === "field") {
    const parts = pointerParts(proposal.target.path);
    if (protectedPath(parts) || identityRootsByType[proposal.target.entity_type]?.has(parts[0] ?? "")) {
      throw new AdministrationProblem(
        422,
        "curated_revision_identity_forbidden",
        `The protected field ${proposal.target.path} cannot be curated.`,
      );
    }
    const _source = valueAt(target, parts);
    const schema = curatedFieldSchema(proposal.target.entity_type, target, parts);
    if (
      schema === null ||
      !validCuratedFieldAssertion(
        proposal.target.entity_type,
        target,
        parts,
        (proposal.assertion as { kind: "field"; value: unknown }).value,
        schema,
      )
    ) {
      throw new AdministrationProblem(
        422,
        "curated_revision_assertion_type_invalid",
        "The assertion value does not match the pinned schema field type.",
      );
    }
  } else {
    assertRelationshipRepresentable(target as unknown as CatalogueCandidate, proposal);
  }
  const previous = structuralProposal(JSON.parse(mutation.row.proposal_json));
  const expectedDigest =
    targetKey(previous) === targetKey(proposal)
      ? (mutation.conflict?.observed_source_digest ??
        (await effectiveReviewedSourceDigest(database, mutation.row.id, mutation.row.reviewed_source_digest)))
      : await sourceDigestForProposal(target, proposal);
  if (proposal.reviewed_source_digest !== expectedDigest) {
    throw new AdministrationProblem(
      409,
      "curated_revision_reviewed_source_mismatch",
      "The replacement must bind the exact reviewed Official Source value.",
    );
  }
}

async function sourceDigestForProposal(target: Record<string, unknown>, proposal: Proposal): Promise<string> {
  if (proposal.target.kind === "field") {
    const source = valueAt(target, pointerParts(proposal.target.path));
    return sha256Text(canonicalJson(reviewedFieldSource(source)));
  }
  return sha256Text(
    canonicalJson(relationshipPresent(target as unknown as CatalogueCandidate, proposal) ? "present" : "absent"),
  );
}

async function revisionContent(database: CatalogueStore, row: RevisionRow): Promise<Record<string, unknown>> {
  const proposal = structuralProposal(JSON.parse(row.proposal_json));
  const events = await curatedStatements
    .curatedRevisionEventHistoryStatement(database, { id: row.id })
    .all<{ kind: string; event_version: number; event_json: string; created_at: string; author: string }>();
  const conflict = await pendingConflict(database, row);
  return {
    id: row.id,
    content: proposal,
    content_digest: row.content_digest,
    author: row.author,
    created_at: Date.parse(row.created_at),
    status: row.status,
    event_version: row.event_version,
    pending_conflict:
      conflict === null
        ? null
        : {
            id: conflict.conflict_id,
            digest: conflict.conflict_digest,
            run_id: conflict.run_id,
            previous_source_digest: conflict.previous_source_digest,
            observed_source_digest: conflict.observed_source_digest,
          },
    events: events.results.map((event) => ({
      id: `crevt_${row.id}_${event.event_version}`,
      revision_id: row.id,
      type: event.kind,
      event_version: event.event_version,
      at: Date.parse(event.created_at),
      details: JSON.parse(event.event_json),
    })),
  };
}

function withoutEvents(document: Record<string, unknown>): Record<string, unknown> {
  const { events: _events, contract: _contract, ...revision } = document;
  return revision;
}

async function operationIdentity(idempotencyKey: string): Promise<string> {
  return `curop_${(await sha256Text(idempotencyKey)).slice(0, 32)}`;
}

async function currentCatalogueRevisionId(database: CatalogueStore): Promise<string> {
  const row = await curatedStatements
    .curatedCurrentCatalogueRevisionStatement(database)
    .first<{ current_revision_id: string }>();
  if (row === null) throw new Error("Catalogue state is unavailable.");
  return row.current_revision_id;
}

async function currentTarget(
  database: CatalogueStore,
  revisionId: string,
  proposal: Proposal,
): Promise<Record<string, unknown>> {
  if (
    proposal.target.kind === "field" &&
    (proposal.target.entity_type === "card" || proposal.target.entity_type === "printing")
  ) {
    const row = await curatedStatements
      .curatedEntityDocumentStatement(database, {
        revisionId,
        entityType: proposal.target.entity_type,
        entityId: proposal.target.entity_id,
      })
      .first<{ document_json: string }>();
    if (row === null)
      throw new AdministrationProblem(
        422,
        "curated_revision_target_not_found",
        "The target entity does not exist in the expected Catalogue Revision.",
      );
    const document = JSON.parse(row.document_json) as Record<string, unknown>;
    const entity = record(document.data) ? document.data : document;
    if (proposal.target.entity_type === "card" && entity.game !== proposal.game) {
      throw new AdministrationProblem(
        422,
        "curated_revision_target_invalid",
        "The target does not belong to the proposed Supported Game.",
      );
    }
    if (proposal.target.entity_type === "printing") {
      const cardId = typeof entity.card_id === "string" ? entity.card_id : null;
      const owner =
        cardId === null
          ? null
          : await curatedStatements
              .curatedCardDocumentStatement(database, { revisionId, cardId })
              .first<{ document_json: string }>();
      const cardDocument = owner === null ? null : (JSON.parse(owner.document_json) as Record<string, unknown>);
      const cardEntity = cardDocument !== null && record(cardDocument.data) ? cardDocument.data : cardDocument;
      if (cardEntity === null || cardEntity.game !== proposal.game) {
        throw new AdministrationProblem(
          422,
          "curated_revision_target_invalid",
          "The target does not belong to the proposed Supported Game.",
        );
      }
    }
    return stripCuratedEntityEffects(entity);
  }
  const row = await curatedStatements
    .curatedCatalogueCandidateStatement(database, { revisionId })
    .first<{ ingestion_run_id: string; candidate_json: string }>();
  if (row === null) {
    throw new AdministrationProblem(
      422,
      "curated_revision_target_not_found",
      "The target entity is unavailable in the expected Catalogue Revision.",
    );
  }
  const candidate = stripCuratedRevisionEffects(
    JSON.parse(
      await retainedPayload(database, row.ingestion_run_id, "candidate", row.candidate_json),
    ) as CatalogueCandidate,
  );
  return candidateTarget(candidate, proposal);
}

async function catalogueCardsAtRevision(
  database: CatalogueStore,
  revisionId: string,
): Promise<CatalogueCandidate["cards"]> {
  const rows = await curatedStatements
    .curatedCatalogueCardDocumentsStatement(database, { revisionId })
    .all<{ document_json: string }>();
  return rows.results.map(({ document_json }) => {
    const document = JSON.parse(document_json) as Record<string, unknown>;
    return (record(document.data) ? document.data : document) as CatalogueCandidate["cards"][number];
  });
}

function stripCuratedEntityEffects(input: Record<string, unknown>): Record<string, unknown> {
  const entity = structuredClone(input);
  const provenance = Array.isArray(entity.curated_provenance) ? (entity.curated_provenance as CuratedProvenance[]) : [];
  for (const item of provenance) {
    if (item.target.kind === "field") {
      restoreReviewedField(entity, pointerParts(item.target.path), item.reviewed_source_value);
    }
  }
  delete entity.curated_provenance;
  return entity;
}

function candidateTarget(candidate: CatalogueCandidate, proposal: Proposal): Record<string, unknown> {
  if (proposal.target.kind === "relationship") return candidate as unknown as Record<string, unknown>;
  const type = proposal.target.entity_type;
  const id = proposal.target.entity_id;
  let found: unknown;
  if (type === "card") found = candidate.cards.find((item) => item.id === id && item.game === proposal.game);
  else if (type === "printing")
    found = candidate.printings.find(
      (item) =>
        item.id === id && candidate.cards.some((card) => card.id === item.card_id && card.game === proposal.game),
    );
  else if (type === "product")
    found = candidate.products?.find((item) => item.id === id && item.game === proposal.game);
  else if (type === "distribution_context")
    found = candidate.distribution_contexts?.find((item) => item.id === id && item.game === proposal.game);
  else if (type === "erratum") found = candidate.errata?.find((item) => item.id === id && item.game === proposal.game);
  else if (type === "release") {
    found = candidate.products
      ?.filter((product) => product.game === proposal.game)
      .flatMap((product) => product.releases)
      .find((item) => item.id === id);
  }
  if (found === undefined)
    throw new AdministrationProblem(422, "curated_revision_target_not_found", "The target entity does not exist.");
  return found as Record<string, unknown>;
}

function applyRelationship(
  candidate: CatalogueCandidate,
  proposal: Proposal,
  revision: { id: string; content_digest: string },
  reviewedPresence: string,
) {
  assertRelationshipRepresentable(candidate, proposal);
  const target = proposal.target as RelationshipTarget;
  const assertion = proposal.assertion as { kind: "relationship"; presence: "present" | "absent" };
  const relationships = [...(candidate.product_relationships ?? [])];
  const matchingIndexes = relationships.flatMap((item, index) =>
    item.from.type === target.from.type &&
    item.from.id === target.from.id &&
    item.to.type === target.to.type &&
    item.to.id === target.to.id &&
    item.kind === target.relationship_kind
      ? [index]
      : [],
  );
  const curatedProvenance = provenanceFor(proposal, revision, reviewedPresence);
  for (const index of matchingIndexes) {
    const existing = relationships[index]!;
    relationships[index] = {
      ...existing,
      observed: assertion.presence === "present",
      curated_provenance: [...(existing.curated_provenance ?? []), curatedProvenance],
    };
  }
  if (matchingIndexes.length === 0) {
    relationships.push({
      id: `relationship_${revision.id}`,
      game: proposal.game,
      kind: target.relationship_kind,
      from: target.from,
      to: target.to,
      evidence_category: "curated",
      resolution: "canonical",
      source_observation_ids: proposal.evidence.flatMap((evidence) =>
        evidence.kind === "source_observation" ? [evidence.id] : [],
      ),
      relationship_value: `${target.from.type}:${target.from.id}|${target.to.type}:${target.to.id}`,
      observed: assertion.presence === "present",
      curated_provenance: [curatedProvenance],
    } as ProductRelationship);
  }
  (candidate as { product_relationships?: typeof relationships }).product_relationships = relationships;
}

function provenanceFor(
  proposal: Proposal,
  revision: { id: string; content_digest: string },
  reviewedSourceValue: unknown,
): CuratedProvenance {
  return {
    curated_revision_id: revision.id,
    content_digest: revision.content_digest,
    target: proposal.target,
    rationale: proposal.rationale,
    evidence: proposal.evidence,
    author: "owner",
    reviewed_source_value: structuredClone(reviewedSourceValue),
  };
}

function relationshipPresent(candidate: CatalogueCandidate, proposal: Proposal): boolean {
  const target = proposal.target as RelationshipTarget;
  return (candidate.product_relationships ?? []).some(
    (item) =>
      item.observed &&
      item.from.type === target.from.type &&
      item.from.id === target.from.id &&
      item.to.type === target.to.type &&
      item.to.id === target.to.id &&
      item.kind === target.relationship_kind,
  );
}

function assertRelationshipRepresentable(candidate: CatalogueCandidate, proposal: Proposal): void {
  const target = proposal.target as RelationshipTarget;
  const allowed = new Set([
    "printing-product",
    "printing-distribution-context",
    "distribution-context-product",
    "product-card",
  ]);
  const endpointPair = `${target.from.type}->${target.to.type}`;
  if (
    !allowed.has(target.relationship_kind) ||
    relationshipEndpointPairs[target.relationship_kind] !== endpointPair ||
    !entityExists(candidate, target.from.type, target.from.id, proposal.game) ||
    !entityExists(candidate, target.to.type, target.to.id, proposal.game)
  ) {
    throw new AdministrationProblem(
      422,
      "curated_revision_relationship_not_in_schema",
      "The relationship or one of its endpoints is not representable by the V1 schema.",
    );
  }
}

function entityExists(candidate: CatalogueCandidate, type: string, id: string, game: SupportedGame): boolean {
  if (type === "card") return candidate.cards.some((item) => item.id === id && item.game === game);
  if (type === "printing")
    return candidate.printings.some(
      (item) => item.id === id && candidate.cards.some((card) => card.id === item.card_id && card.game === game),
    );
  if (type === "product") return candidate.products?.some((item) => item.id === id && item.game === game) ?? false;
  if (type === "distribution_context")
    return candidate.distribution_contexts?.some((item) => item.id === id && item.game === game) ?? false;
  return false;
}

function structuralProposal(input: unknown): Proposal {
  const value = decodeDocument<Record<string, unknown>>(
    "record",
    input,
    () => new AdministrationProblem(422, "curated_revision_schema_invalid", "Proposal is required."),
  );
  onlyFields(value, [
    "game",
    "target",
    "assertion",
    "rationale",
    "evidence",
    "effective_interval",
    "reviewed_source_digest",
    "supersedes_revision_id",
  ]);
  if (!Object.hasOwn(value, "effective_interval") || !Object.hasOwn(value, "supersedes_revision_id")) {
    invalid("effective_interval and supersedes_revision_id are required, including when null.");
  }
  if (!games.has(String(value.game)))
    throw new AdministrationProblem(422, "invalid_supported_game", "The Supported Game is invalid.");
  if (typeof value.rationale !== "string" || value.rationale.trim() === "")
    invalid("A non-empty rationale is required.");
  if (!sha256Digest(value.reviewed_source_digest)) invalid("reviewed_source_digest must be a lower-case SHA-256.");
  const evidence = decodeDocument<CuratedEvidence[]>(
    "proposalEvidence",
    value.evidence,
    () =>
      new AdministrationProblem(
        422,
        "curated_revision_schema_invalid",
        "At least one valid evidence reference is required.",
      ),
  );
  if (evidence.some((item) => item.kind === "owner_reference" && !absoluteUri(item.uri)))
    invalid("At least one valid evidence reference is required.");
  const interval = value.effective_interval;
  if (record(interval)) onlyFields(interval, ["from", "to"]);
  if (
    !record(interval) ||
    !onlyDate(interval.from) ||
    !onlyDate(interval.to) ||
    (typeof interval.from === "string" && typeof interval.to === "string" && interval.from >= interval.to)
  ) {
    throw new AdministrationProblem(
      422,
      "curated_revision_interval_invalid",
      "The interval is closed-open and from must precede to.",
    );
  }
  if (!record(value.target) || !record(value.assertion))
    throw new AdministrationProblem(422, "curated_revision_target_invalid", "The target and assertion are required.");
  if (value.target.kind === "field") {
    onlyFields(value.target, ["kind", "entity_type", "entity_id", "path"]);
    onlyFields(value.assertion, ["kind", "value"]);
    decodeDocument(
      "proposalFieldTarget",
      value.target,
      () => new AdministrationProblem(422, "curated_revision_target_invalid", "Field target is incomplete."),
    );
    if (value.assertion.kind !== "field" || !Object.hasOwn(value.assertion, "value"))
      invalid("A field target requires an explicit field assertion.");
  } else if (value.target.kind === "relationship") {
    onlyFields(value.target, ["kind", "relationship_kind", "from", "to"]);
    onlyFields(value.assertion, ["kind", "presence"]);
    if (!record(value.target.from) || !record(value.target.to))
      throw new AdministrationProblem(422, "curated_revision_target_invalid", "Relationship target is incomplete.");
    onlyFields(value.target.from, ["type", "id"]);
    onlyFields(value.target.to, ["type", "id"]);
    if (
      !opaque(value.target.from.id) ||
      !opaque(value.target.to.id) ||
      typeof value.target.from.type !== "string" ||
      typeof value.target.to.type !== "string" ||
      typeof value.target.relationship_kind !== "string"
    )
      throw new AdministrationProblem(422, "curated_revision_target_invalid", "Relationship target is incomplete.");
    if (
      value.assertion.kind !== "relationship" ||
      (value.assertion.presence !== "present" && value.assertion.presence !== "absent")
    )
      invalid("A relationship assertion must be present or absent.");
  } else
    throw new AdministrationProblem(
      422,
      "curated_revision_target_invalid",
      "Target kind must be field or relationship.",
    );
  if (value.supersedes_revision_id !== null && !opaque(value.supersedes_revision_id))
    invalid("supersedes_revision_id must be an opaque identity or null.");
  return value as unknown as Proposal;
}

async function assertRetainedCuratedEvidence(
  database: CatalogueStore,
  evidence: readonly CuratedEvidence[],
): Promise<void> {
  const sourceObservationIds = evidence.flatMap((item) => (item.kind === "source_observation" ? [item.id] : []));
  if (sourceObservationIds.length === 0) return;
  const retained = await curatedStatements
    .retainedCuratedObservationEvidenceStatement(database, {
      sourceObservationIdsJson: JSON.stringify(sourceObservationIds),
    })
    .all<{
      source_observation_id: string;
    }>();
  const retainedIds = new Set(retained.results.map(({ source_observation_id }) => source_observation_id));
  const missing = sourceObservationIds.find((id) => !retainedIds.has(id));
  if (missing !== undefined) {
    throw new AdministrationProblem(
      422,
      "curated_revision_evidence_not_retained",
      `Source Observation ${missing} is not retained immutable evidence.`,
    );
  }
}

function targetKey(proposal: Proposal): string {
  const target = proposal.target;
  return target.kind === "field"
    ? [proposal.game, "field", target.entity_type, target.entity_id, target.path].join("|")
    : [
        proposal.game,
        "relationship",
        target.relationship_kind,
        target.from.type,
        target.from.id,
        target.to.type,
        target.to.id,
      ].join("|");
}
function pointerParts(path: string): string[] {
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}
function valueAt(target: Record<string, unknown>, parts: string[]): { found: boolean; value: unknown } {
  let value: unknown = target;
  for (const part of parts) {
    if (!record(value) && !Array.isArray(value)) return { found: false, value: undefined };
    if (!Object.hasOwn(value, part)) return { found: false, value: undefined };
    value = (value as Record<string, unknown>)[part];
  }
  return { found: true, value };
}
function reviewedFieldSource(source: { found: boolean; value: unknown }): unknown {
  return source.found ? source.value : curatedSourceAbsence;
}
function isCuratedSourceAbsence(value: unknown): boolean {
  return record(value) && Object.keys(value).length === 1 && value.contract === curatedSourceAbsence.contract;
}
function restoreReviewedField(
  target: Record<string, unknown>,
  parts: readonly string[],
  reviewedSourceValue: unknown,
): void {
  if (isCuratedSourceAbsence(reviewedSourceValue)) {
    deleteAt(target, parts);
    return;
  }
  setAt(target, parts, reviewedSourceValue);
}
function setAt(target: Record<string, unknown>, parts: readonly string[], value: unknown) {
  let parent: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
  parent[parts.at(-1)!] = structuredClone(value);
}
function deleteAt(target: Record<string, unknown>, parts: readonly string[]): void {
  let parent: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const child = parent[part];
    if (!record(child) && !Array.isArray(child)) return;
    parent = child as Record<string, unknown>;
  }
  delete parent[parts.at(-1)!];
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function opaque(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function sha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function onlyDate(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
function protectedPath(parts: readonly string[]): boolean {
  return (
    forbiddenRoots.has(parts[0] ?? "") ||
    parts.join("/") === "game_data/profile" ||
    parts.some((part) => part === "id" || part.endsWith("_id"))
  );
}

type JsonSchema = Readonly<Record<string, unknown>>;

const nullableTextSchema = {
  oneOf: [{ type: "string" }, { type: "null" }],
} as const;
const nullableNonEmptyTextSchema = {
  oneOf: [{ type: "string", minLength: 1 }, { type: "null" }],
} as const;
const nullableDateSchema = {
  oneOf: [{ type: "string", format: "date" }, { type: "null" }],
} as const;
const sharedCuratableFieldSchemas: Readonly<Record<string, JsonSchema>> = {
  "card:/name": { type: "string", minLength: 1 },
  "card:/effective_rules_text": nullableTextSchema,
  "printing:/rarity": {
    type: "object",
    additionalProperties: false,
    required: ["normalized", "raw"],
    properties: { normalized: nullableTextSchema, raw: nullableTextSchema },
  },
  "printing:/rarity/normalized": nullableTextSchema,
  "printing:/rarity/raw": nullableTextSchema,
  "printing:/printed_rules_text": nullableTextSchema,
  "product:/official_code": nullableNonEmptyTextSchema,
  "product:/name": nullableNonEmptyTextSchema,
  "release:/date": {
    type: "object",
    additionalProperties: false,
    required: ["precision", "value"],
    properties: {
      precision: {
        enum: ["day", "month", "quarter", "season", "year", "unknown", null],
      },
      value: nullableNonEmptyTextSchema,
    },
  },
  "release:/date/precision": {
    enum: ["day", "month", "quarter", "season", "year", "unknown", null],
  },
  "release:/date/value": nullableNonEmptyTextSchema,
  "release:/status": { enum: ["announced", "released", null] },
  "distribution_context:/kind": { enum: ["product", "tournament_pack", "winner_prize", "promotion", "other"] },
  "distribution_context:/label": { type: "string", minLength: 1 },
  "erratum:/effective_from": nullableDateSchema,
  "erratum:/official_wording": { type: "string", minLength: 1 },
  "erratum:/corrected_value": nullableNonEmptyTextSchema,
};

function curatedFieldSchema(
  entityType: string,
  target: Record<string, unknown>,
  parts: readonly string[],
): JsonSchema | null {
  if ((entityType === "card" || entityType === "printing") && parts[0] === "game_data" && parts[1] === "attributes") {
    const gameData = record(target.game_data) ? target.game_data : null;
    const profile = typeof gameData?.profile === "string" ? gameData.profile : null;
    if (profile === null) return null;
    const exported = exportedGameProfileSchema(profile);
    const root =
      record(exported.properties) && record(exported.properties[entityType])
        ? (exported.properties[entityType] as JsonSchema)
        : null;
    return root === null ? null : schemaAt(root, parts.slice(2));
  }
  return sharedCuratableFieldSchemas[`${entityType}:/${parts.join("/")}`] ?? null;
}

function schemaAt(schema: JsonSchema, parts: readonly string[]): JsonSchema | null {
  let current: JsonSchema = schema;
  for (const part of parts) {
    const properties = record(current.properties) ? current.properties : null;
    if (properties === null || !record(properties[part])) return null;
    current = properties[part] as JsonSchema;
  }
  return current;
}

function validCuratedFieldAssertion(
  entityType: string,
  target: Record<string, unknown>,
  parts: readonly string[],
  assertion: unknown,
  schema: JsonSchema,
): boolean {
  if (!fieldAjv.compile(schema)(assertion)) return false;
  const modified = structuredClone(target);
  setAt(modified, parts, assertion);
  if (!validCompleteCuratedEntity(entityType, modified)) return false;
  return true;
}

function validProfileEntity(entityType: "card" | "printing", entity: Record<string, unknown>): boolean {
  if (
    entityType === "card" &&
    (typeof entity.name !== "string" ||
      entity.name.trim().length === 0 ||
      !(entity.effective_rules_text === null || typeof entity.effective_rules_text === "string"))
  )
    return false;
  if (entityType === "printing") {
    const rarity = record(entity.rarity) ? entity.rarity : null;
    if (
      rarity === null ||
      ![rarity.normalized, rarity.raw].every((value) => value === null || typeof value === "string") ||
      !(entity.printed_rules_text === null || typeof entity.printed_rules_text === "string")
    )
      return false;
    if (entity.game_data === null) return true;
  }
  const gameData = record(entity.game_data) ? entity.game_data : null;
  if (gameData === null || typeof gameData.profile !== "string" || !record(gameData.attributes)) return false;
  try {
    canonicalProfileAttributes("curated_revision_validation", gameData.profile, entityType, gameData.attributes, []);
    return true;
  } catch {
    return false;
  }
}

function validCompleteCuratedEntity(entityType: string, entity: Record<string, unknown>): boolean {
  if (entityType === "card" || entityType === "printing") {
    return validProfileEntity(entityType, entity);
  }
  if (entityType === "product") {
    const reference = record(entity.reference) ? entity.reference : null;
    const code = entity.official_code;
    const name = entity.name;
    if (
      reference === null ||
      typeof reference.value !== "string" ||
      reference.value.trim().length === 0 ||
      !(code === null || (typeof code === "string" && code.trim().length > 0)) ||
      !(name === null || (typeof name === "string" && name.trim().length > 0))
    ) {
      return false;
    }
    return reference.kind === "official_code"
      ? code === reference.value
      : reference.kind === "name" && code === null && name === reference.value;
  }
  if (entityType === "release") {
    const date = record(entity.date) ? entity.date : null;
    if (date === null) return false;
    const precision = date.precision === null ? "unknown" : date.precision;
    const value = date.value;
    const patterns: Readonly<Record<string, RegExp>> = {
      day: /^\d{4}-\d{2}-\d{2}$/,
      month: /^\d{4}-\d{2}$/,
      quarter: /^\d{4}-Q[1-4]$/,
      season: /^\d{4}-(?:spring|summer|autumn|winter)$/,
      year: /^\d{4}$/,
    };
    if (precision === "unknown") return value === null;
    if (
      typeof precision !== "string" ||
      patterns[precision] === undefined ||
      typeof value !== "string" ||
      !patterns[precision]!.test(value)
    )
      return false;
    if (precision === "day") return onlyDate(value);
    if (precision === "month") {
      const month = Number(value.slice(5, 7));
      return month >= 1 && month <= 12;
    }
    return true;
  }
  if (entityType === "distribution_context") {
    return (
      ["product", "tournament_pack", "winner_prize", "promotion", "other"].includes(String(entity.kind)) &&
      typeof entity.label === "string" &&
      entity.label.trim().length > 0
    );
  }
  if (entityType === "erratum") {
    return (
      (entity.effective_from === null ||
        (typeof entity.effective_from === "string" && onlyDate(entity.effective_from))) &&
      typeof entity.official_wording === "string" &&
      entity.official_wording.trim().length > 0 &&
      (entity.corrected_value === null ||
        (typeof entity.corrected_value === "string" && entity.corrected_value.trim().length > 0))
    );
  }
  return true;
}

function validComposedCuratedCandidate(candidate: CatalogueCandidate): boolean {
  if (
    !candidate.cards.every((entity) => validCompleteCuratedEntity("card", entity as unknown as Record<string, unknown>))
  )
    return false;
  if (
    !candidate.printings.every((entity) =>
      validCompleteCuratedEntity("printing", entity as unknown as Record<string, unknown>),
    )
  )
    return false;
  if (
    !(candidate.products ?? []).every(
      (entity) =>
        validCompleteCuratedEntity("product", entity as unknown as Record<string, unknown>) &&
        entity.releases.every((release) =>
          validCompleteCuratedEntity("release", release as unknown as Record<string, unknown>),
        ),
    )
  )
    return false;
  if (
    !(candidate.distribution_contexts ?? []).every((entity) =>
      validCompleteCuratedEntity("distribution_context", entity as unknown as Record<string, unknown>),
    )
  )
    return false;
  if (
    !(candidate.errata ?? []).every((entity) =>
      validCompleteCuratedEntity("erratum", entity as unknown as Record<string, unknown>),
    )
  )
    return false;
  return (candidate.product_relationships ?? []).every(
    (relationship) =>
      relationshipEndpointPairs[relationship.kind] === `${relationship.from.type}->${relationship.to.type}` &&
      entityExists(candidate, relationship.from.type, relationship.from.id, relationship.game) &&
      entityExists(candidate, relationship.to.type, relationship.to.id, relationship.game),
  );
}
function absoluteUri(value: string): boolean {
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${field} must be a non-empty string.`);
  return value as string;
}
function onlyFields(value: Record<string, unknown>, fields: readonly string[]) {
  const extra = Object.keys(value).find((key) => !fields.includes(key));
  if (extra) invalid(`${extra} is not accepted.`);
}
function requiredOwnField(value: Record<string, unknown>, field: string): void {
  if (!Object.hasOwn(value, field)) invalid(`${field} is required, including when null.`);
}
function invalid(detail: string): never {
  throw new AdministrationProblem(422, "curated_revision_schema_invalid", detail);
}
