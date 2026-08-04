import type { CatalogueCandidate, SupportedGame } from "./catalogue-candidate";
import { AdministrationProblem } from "./administration-problem.mjs";
import { canonicalJson, sha256Text } from "./serialization";
import { retainedPayload } from "./reconciliation-payload";
import type { CuratedProvenance } from "./curated-provenance";
import type { ProductRelationship } from "./product-release-catalogue";

const games = new Set(["one-piece", "fusion-world", "digimon", "gundam"]);
const fieldEntityTypes = new Set([
  "card", "printing", "product", "release", "distribution_context",
  "erratum", "legality_rule",
]);
const forbiddenRoots = new Set([
  "id", "game", "official_identity", "source_snapshots",
  "source_observations", "provenance", "curated_provenance", "evidence",
  "lifecycle", "links", "source_lineages", "printing_ids",
  "relationship_evidence", "locator_evidence", "included", "disagreements",
  "withdrawal", "observed", "resolution", "evidence_category",
  "source_lineage", "source_observation_id", "source_observation_ids",
  "source_observation_pointer", "source_field_pointers",
]);
const identityRootsByType: Readonly<Record<string, ReadonlySet<string>>> = {
  card: new Set(["official_identity"]),
  printing: new Set(["card_id"]),
  product: new Set(["reference", "official_code"]),
  release: new Set(["event_key", "product_id", "region"]),
  distribution_context: new Set(["key", "product_id"]),
  erratum: new Set(["target_type", "target_id"]),
  legality_rule: new Set(["official_id"]),
};

type FieldTarget = {
  kind: "field";
  entity_type: string;
  entity_id: string;
  path: string;
};
type RelationshipTarget = {
  kind: "relationship";
  relationship_kind: string;
  from: { type: string; id: string };
  to: { type: string; id: string };
};
type Proposal = {
  game: SupportedGame;
  target: FieldTarget | RelationshipTarget;
  assertion: { kind: "field"; value: unknown } | {
    kind: "relationship"; presence: "present" | "absent";
  };
  rationale: string;
  evidence: readonly ({ kind: "source_observation"; id: string } | {
    kind: "owner_reference"; uri: string; content_digest: string;
  })[];
  effective_interval?: { from: string | null; to: string | null };
  reviewed_source_digest: string;
  supersedes_revision_id?: string | null;
};

type RevisionRow = {
  id: string;
  game: SupportedGame;
  target_key: string;
  proposal_json: string;
  content_digest: string;
  schema_binding_json: string;
  author: string;
  created_at: string;
  status: string;
  event_version: number;
  reviewed_source_digest: string;
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
  database: D1Database,
  proposalValue: unknown,
  expectedCurrentRevisionId: string,
): Promise<Record<string, unknown>> {
  const proposal = structuralProposal(proposalValue);
  const currentRevisionId = await currentRevision(database);
  if (expectedCurrentRevisionId !== currentRevisionId) {
    throw new AdministrationProblem(409, "current_revision_mismatch", "The expected current Catalogue Revision is stale.");
  }
  const target = await currentTarget(database, currentRevisionId, proposal);
  const schemaBinding = {
    catalogue_revision_id: currentRevisionId,
    game_profile: `${proposal.game}@1`,
  };
  if (proposal.target.kind === "field") {
    const path = pointerParts(proposal.target.path);
    if (protectedPath(path) ||
      identityRootsByType[proposal.target.entity_type]?.has(path[0] ?? "")) {
      throw new AdministrationProblem(422, "curated_revision_identity_forbidden", `The protected field ${proposal.target.path} cannot be curated.`);
    }
    const sourceValue = valueAt(target, path);
    if (!sourceValue.found) {
      throw new AdministrationProblem(422, "curated_revision_field_not_in_schema", "A Curated Revision cannot invent a Game Profile field.");
    }
    const assertionValue = (proposal.assertion as { kind: "field"; value: unknown }).value;
    if (!compatibleFieldAssertion(proposal.target.entity_type, path, sourceValue.value, assertionValue)) {
      throw new AdministrationProblem(422, "curated_revision_assertion_type_invalid", "The assertion value does not match the shared schema field type.");
    }
    const digest = await sha256Text(canonicalJson(sourceValue.value));
    if (digest !== proposal.reviewed_source_digest) {
      throw new AdministrationProblem(409, "curated_revision_reviewed_source_mismatch", "The reviewed Official Source value does not match the current Catalogue Revision.");
    }
  } else {
    const candidate = target as unknown as CatalogueCandidate;
    assertRelationshipRepresentable(candidate, proposal);
    const digest = await sha256Text(canonicalJson(
      relationshipPresent(candidate, proposal) ? "present" : "absent",
    ));
    if (digest !== proposal.reviewed_source_digest) {
      throw new AdministrationProblem(409, "curated_revision_reviewed_source_mismatch", "The reviewed Official Source relationship does not match the current Catalogue Revision.");
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
  database: D1Database,
  input: Record<string, unknown>,
  observedAt: string,
): Promise<{ created: boolean; document: MutationResult }> {
  onlyFields(input, ["environment", "expected_current_revision_id", "proposal", "proposal_digest", "idempotency_key"]);
  const idempotencyKey = requiredString(input.idempotency_key, "idempotency_key");
  const requestDigest = await sha256Text(canonicalJson(input));
  const replay = await database.prepare(
    "SELECT request_digest, response_json FROM curated_revision_idempotency WHERE idempotency_key = ?",
  ).bind(idempotencyKey).first<{ request_digest: string; response_json: string }>();
  if (replay !== null) {
    if (replay.request_digest !== requestDigest) {
      throw new AdministrationProblem(409, "idempotency_conflict", "The idempotency key is already bound to another request.");
    }
    return { created: false, document: JSON.parse(replay.response_json) as MutationResult };
  }
  if (input.environment !== "production") {
    throw new AdministrationProblem(422, "production_target_required", "Curated Revision mutations require environment production.");
  }
  const expected = requiredString(input.expected_current_revision_id, "expected_current_revision_id");
  const validation = await validateCuratedRevision(database, input.proposal, expected);
  const suppliedDigest = requiredString(input.proposal_digest, "proposal_digest");
  if (suppliedDigest !== validation.proposal_digest) {
    throw new AdministrationProblem(409, "curated_revision_content_digest_mismatch", "The supplied proposal digest does not match the canonical proposal.");
  }
  const operation = await database.prepare(
    "SELECT active_ingestion_run_id, recovery_health FROM operation_state WHERE singleton = 1",
  ).first<{ active_ingestion_run_id: string | null; recovery_health: string }>();
  if (operation?.recovery_health === "blocked") {
    throw new AdministrationProblem(409, "recovery_in_progress", "Recovery blocks Curated Revision mutation.");
  }
  if (operation?.active_ingestion_run_id !== null) {
    throw new AdministrationProblem(409, "active_ingestion_run", "An active Ingestion Run blocks Curated Revision mutation.");
  }
  const proposal = structuralProposal(input.proposal);
  if (proposal.supersedes_revision_id) {
    throw new AdministrationProblem(422, "curated_revision_schema_invalid", "Use supersession for a proposal with supersedes_revision_id.");
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
      database.prepare(
        `INSERT INTO curated_revisions (
          id, game, target_key, target_kind, effective_from, effective_to,
          proposal_json, content_digest, reviewed_source_digest,
          schema_binding_json, author, created_at, status, event_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner', ?, 'active', 1)`,
      ).bind(id, proposal.game, targetKey(proposal), proposal.target.kind,
        interval.from, interval.to, canonicalJson(proposal), suppliedDigest,
        proposal.reviewed_source_digest, canonicalJson(schemaBinding), observedAt),
      database.prepare(
        `INSERT INTO curated_revision_events (
          revision_id, event_version, kind, event_json, created_at, author
        ) VALUES (?, 1, 'authored', ?, ?, 'owner')`,
      ).bind(id, canonicalJson({ reviewed_source_digest: proposal.reviewed_source_digest }), observedAt),
      database.prepare(
        `INSERT INTO curated_revision_idempotency (
          idempotency_key, request_digest, response_json, response_status, created_at
        ) VALUES (?, ?, ?, 201, ?)`,
      ).bind(idempotencyKey, requestDigest, canonicalJson(document), observedAt),
    ]);
  } catch (error) {
    const concurrentReplay = await database.prepare(
      "SELECT request_digest, response_json FROM curated_revision_idempotency WHERE idempotency_key = ?",
    ).bind(idempotencyKey).first<{ request_digest: string; response_json: string }>();
    if (concurrentReplay !== null) {
      if (concurrentReplay.request_digest !== requestDigest) {
        throw new AdministrationProblem(409, "idempotency_conflict", "The idempotency key is already bound to another request.");
      }
      return {
        created: false,
        document: JSON.parse(concurrentReplay.response_json) as MutationResult,
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("curated_revision_target_conflict")) {
      throw new AdministrationProblem(409, "curated_revision_target_conflict", "An active Curated Revision already overlaps this target and interval.");
    }
    if (detail.includes("curated_revision_operation_not_idle")) {
      throw new AdministrationProblem(409, "operation_not_idle", "The production mutation boundary is not idle.");
    }
    throw error;
  }
  return { created: true, document };
}

export async function reaffirmCuratedRevision(
  database: D1Database,
  revisionId: string,
  input: Record<string, unknown>,
  observedAt: string,
): Promise<{ created: boolean; document: MutationResult }> {
  onlyFields(input, ["environment", "expected_current_revision_id", "expected_event_version", "conflict_digest", "rationale", "idempotency_key"]);
  const mutation = await existingRevisionMutation(database, revisionId, input);
  if (mutation.replay !== null) return mutation.replay;
  if (mutation.row.status !== "reconfirmation_required" || mutation.conflict === null) {
    throw new AdministrationProblem(409, "curated_revision_state_conflict", "Only a Curated Revision requiring reconfirmation may be reaffirmed.");
  }
  const rationale = requiredString(input.rationale, "rationale");
  const conflictDigest = requiredString(input.conflict_digest, "conflict_digest");
  if (conflictDigest !== mutation.conflict.conflict_digest) {
    throw new AdministrationProblem(409, "curated_revision_conflict_digest_mismatch", "The exact pending conflict digest is required.");
  }
  const version = mutation.row.event_version + 1;
  const result = mutationResult(
    mutation.operationId, mutation.row, "active", version,
    mutation.currentRevisionId, "curated_revision_reaffirmed",
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
    },
    observedAt,
  });
  return { created: true, document: result };
}

export async function retireCuratedRevision(
  database: D1Database,
  revisionId: string,
  input: Record<string, unknown>,
  observedAt: string,
): Promise<{ created: boolean; document: MutationResult }> {
  onlyFields(input, ["environment", "expected_current_revision_id", "expected_event_version", "conflict_digest", "rationale", "idempotency_key"]);
  const mutation = await existingRevisionMutation(database, revisionId, input);
  if (mutation.replay !== null) return mutation.replay;
  assertConflictBinding(mutation.conflict, input.conflict_digest);
  const rationale = requiredString(input.rationale, "rationale");
  const version = mutation.row.event_version + 1;
  const result = mutationResult(
    mutation.operationId, mutation.row, "retired", version,
    mutation.currentRevisionId, "curated_revision_retired",
  );
  await appendLifecycleMutation(database, mutation, result, {
    status: "retired",
    kind: "retired",
    version,
    details: {
      conflict_id: mutation.conflict?.conflict_id ?? null,
      conflict_digest: mutation.conflict?.conflict_digest ?? null,
      rationale,
    },
    observedAt,
  });
  return { created: true, document: result };
}

export async function supersedeCuratedRevision(
  database: D1Database,
  revisionId: string,
  input: Record<string, unknown>,
  observedAt: string,
): Promise<{ created: boolean; document: MutationResult }> {
  onlyFields(input, ["environment", "expected_current_revision_id", "expected_event_version", "conflict_digest", "proposal", "proposal_digest", "rationale", "idempotency_key"]);
  const mutation = await existingRevisionMutation(database, revisionId, input);
  if (mutation.replay !== null) return mutation.replay;
  assertConflictBinding(mutation.conflict, input.conflict_digest);
  requiredString(input.rationale, "rationale");
  const proposal = structuralProposal(input.proposal);
  if (proposal.supersedes_revision_id !== revisionId) {
    throw new AdministrationProblem(409, "curated_revision_supersession_mismatch", "The proposal must bind the exact prior Curated Revision identity.");
  }
  const proposalDigest = await sha256Text(canonicalJson(proposal));
  if (requiredString(input.proposal_digest, "proposal_digest") !== proposalDigest) {
    throw new AdministrationProblem(409, "curated_revision_content_digest_mismatch", "The supplied proposal digest does not match the canonical proposal.");
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
      database.prepare(
        "UPDATE curated_revisions SET status = 'superseded', event_version = ? WHERE id = ? AND event_version = ? AND status IN ('active', 'reconfirmation_required')",
      ).bind(oldVersion, revisionId, mutation.row.event_version),
      database.prepare(
        `INSERT INTO curated_revision_events (revision_id, event_version, kind, event_json, created_at, author)
         VALUES (?, ?, 'superseded', ?, ?, 'owner')`,
      ).bind(revisionId, oldVersion, canonicalJson({
        superseded_by_revision_id: replacementId,
        rationale: input.rationale,
        conflict_digest: mutation.conflict?.conflict_digest ?? null,
      }), observedAt),
      database.prepare(
        `INSERT INTO curated_revisions (
          id, game, target_key, target_kind, effective_from, effective_to,
          proposal_json, content_digest, reviewed_source_digest,
          schema_binding_json, author, created_at, status, event_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner', ?, 'active', 1)`,
      ).bind(replacementId, proposal.game, targetKey(proposal), proposal.target.kind,
        interval.from, interval.to, canonicalJson(proposal), proposalDigest,
        proposal.reviewed_source_digest, canonicalJson(schemaBinding), observedAt),
      database.prepare(
        `INSERT INTO curated_revision_events (revision_id, event_version, kind, event_json, created_at, author)
         VALUES (?, 1, 'authored', ?, ?, 'owner')`,
      ).bind(replacementId, canonicalJson({
        reviewed_source_digest: proposal.reviewed_source_digest,
        supersedes_revision_id: revisionId,
      }), observedAt),
      database.prepare(
        `INSERT INTO curated_revision_idempotency (idempotency_key, request_digest, response_json, response_status, created_at)
         VALUES (?, ?, ?, 201, ?)`,
      ).bind(mutation.idempotencyKey, mutation.requestDigest, canonicalJson(result), observedAt),
    ]);
  } catch (error) {
    const replay = await idempotencyReplay(database, mutation.idempotencyKey, mutation.requestDigest);
    if (replay !== null) return replay;
    throw lifecycleWriteProblem(error);
  }
  return { created: true, document: result };
}

export async function listCuratedRevisions(
  database: D1Database,
  filters: { game?: string; target?: string; status?: string },
): Promise<Record<string, unknown>> {
  if (filters.game !== undefined && !games.has(filters.game)) {
    throw new AdministrationProblem(422, "invalid_supported_game", "The Supported Game filter is invalid.");
  }
  if (filters.status !== undefined && ![
    "active", "superseded", "retired", "reconfirmation_required",
  ].includes(filters.status)) {
    throw new AdministrationProblem(422, "invalid_parameter", "The Curated Revision status filter is invalid.");
  }
  const rows = await database.prepare(
    `SELECT * FROM curated_revisions
     WHERE (? IS NULL OR game = ?)
       AND (? IS NULL OR target_key = ?)
       AND (? IS NULL OR status = ?)
     ORDER BY created_at, id`,
  ).bind(filters.game ?? null, filters.game ?? null, filters.target ?? null,
    filters.target ?? null, filters.status ?? null, filters.status ?? null)
    .all<RevisionRow>();
  return {
    items: await Promise.all(rows.results.map(async (row) =>
      withoutEvents(await revisionContent(database, row))
    )),
    next_cursor: null,
  };
}

export async function showCuratedRevision(
  database: D1Database,
  id: string,
): Promise<Record<string, unknown>> {
  const row = await database.prepare("SELECT * FROM curated_revisions WHERE id = ?")
    .bind(id).first<RevisionRow>();
  if (row === null) throw new AdministrationProblem(404, "curated_revision_not_found", "The requested Curated Revision does not exist.");
  const revision = await revisionContent(database, row);
  return {
    revision: withoutEvents(revision),
    events: revision.events,
  };
}

export async function pinCuratedRevisionsForRun(
  database: D1Database,
  runId: string,
  observedAt: string,
): Promise<{ revision_ids: string[]; set_digest: string }> {
  if (!(await curatedRevisionSchemaAvailable(database))) {
    return { revision_ids: [], set_digest: await sha256Text(canonicalJson([])) };
  }
  const existing = await database.prepare(
    "SELECT revision_ids_json, set_digest FROM ingestion_run_curated_revision_sets WHERE ingestion_run_id = ?",
  ).bind(runId).first<{ revision_ids_json: string; set_digest: string }>();
  if (existing !== null) {
    const revisionIds = JSON.parse(existing.revision_ids_json) as string[];
    const digest = await sha256Text(canonicalJson(revisionIds));
    if (existing.set_digest !== digest) {
      await database.prepare(
        "UPDATE ingestion_run_curated_revision_sets SET set_digest = ? WHERE ingestion_run_id = ? AND set_digest = ?",
      ).bind(digest, runId, existing.set_digest).run();
    }
    return { revision_ids: revisionIds, set_digest: digest };
  }
  const run = await database.prepare("SELECT selected_games_json FROM ingestion_runs WHERE id = ?")
    .bind(runId).first<{ selected_games_json: string }>();
  if (run === null) throw new AdministrationProblem(404, "ingestion_run_not_found", "The requested Ingestion Run does not exist.");
  const selectedGames = JSON.parse(run.selected_games_json) as string[];
  const on = observedAt.slice(0, 10);
  const rows = await database.prepare(
    `SELECT revision.id, revision.content_digest,
            COALESCE((
              SELECT json_extract(event.event_json, '$.reviewed_source_digest')
              FROM curated_revision_events AS event
              WHERE event.revision_id = revision.id
                AND event.kind = 'reaffirmed'
              ORDER BY event.event_version DESC LIMIT 1
            ), revision.reviewed_source_digest) AS reviewed_source_digest
     FROM curated_revisions AS revision
     WHERE revision.status = 'active'
       AND revision.game IN (SELECT value FROM json_each(?))
       AND (revision.effective_from IS NULL OR revision.effective_from <= ?)
       AND (revision.effective_to IS NULL OR ? < revision.effective_to)
     ORDER BY revision.id`,
  ).bind(canonicalJson(selectedGames), on, on).all<{
    id: string; content_digest: string; reviewed_source_digest: string;
  }>();
  const ids = rows.results.map(({ id }) => id);
  const setDigest = await sha256Text(canonicalJson(ids));
  await database.batch([
    ...rows.results.map((row, ordinal) => database.prepare(
      `INSERT INTO ingestion_run_curated_revisions (
        ingestion_run_id, ordinal, revision_id, content_digest, reviewed_source_digest
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(runId, ordinal, row.id, row.content_digest, row.reviewed_source_digest)),
    database.prepare(
      `INSERT INTO ingestion_run_curated_revision_sets (
        ingestion_run_id, revision_ids_json, set_digest, pinned_at
      ) VALUES (?, ?, ?, ?)`,
    ).bind(runId, canonicalJson(ids), setDigest, observedAt),
  ]);
  return { revision_ids: ids, set_digest: setDigest };
}

export async function curatedRevisionPinStatementsForNewRun(
  database: D1Database,
  runId: string,
  selectedGames: readonly string[],
  observedAt: string,
): Promise<D1PreparedStatement[]> {
  if (!(await curatedRevisionSchemaAvailable(database))) return [];
  const gamesJson = canonicalJson([...new Set(selectedGames)].sort());
  const on = observedAt.slice(0, 10);
  return [
    database.prepare(
      `INSERT INTO ingestion_run_curated_revisions (
         ingestion_run_id, ordinal, revision_id, content_digest,
         reviewed_source_digest
       )
       SELECT ?, ROW_NUMBER() OVER (ORDER BY revision.id) - 1,
              revision.id, revision.content_digest,
              COALESCE((
                SELECT json_extract(event.event_json, '$.reviewed_source_digest')
                FROM curated_revision_events AS event
                WHERE event.revision_id = revision.id
                  AND event.kind = 'reaffirmed'
                ORDER BY event.event_version DESC LIMIT 1
              ), revision.reviewed_source_digest)
       FROM curated_revisions AS revision
       WHERE revision.status = 'active'
         AND revision.game IN (SELECT value FROM json_each(?))
         AND (revision.effective_from IS NULL OR revision.effective_from <= ?)
         AND (revision.effective_to IS NULL OR ? < revision.effective_to)
       ORDER BY revision.id`,
    ).bind(runId, gamesJson, on, on),
    database.prepare(
      `INSERT INTO ingestion_run_curated_revision_sets (
         ingestion_run_id, revision_ids_json, set_digest, pinned_at
       ) VALUES (?, COALESCE((
         SELECT json_group_array(id) FROM (
           SELECT id FROM curated_revisions
           WHERE status = 'active'
             AND game IN (SELECT value FROM json_each(?))
             AND (effective_from IS NULL OR effective_from <= ?)
             AND (effective_to IS NULL OR ? < effective_to)
           ORDER BY id
         )
       ), '[]'), ?, ?)`,
    ).bind(runId, gamesJson, on, on, "0".repeat(64), observedAt),
  ];
}

export async function assertCuratedGamesUnblocked(
  database: D1Database,
  selectedGames: readonly string[],
): Promise<void> {
  if (!(await curatedRevisionSchemaAvailable(database))) return;
  const conflict = await database.prepare(
    `SELECT id, game FROM curated_revisions
     WHERE status = 'reconfirmation_required'
       AND game IN (SELECT value FROM json_each(?))
     ORDER BY id LIMIT 1`,
  ).bind(canonicalJson(selectedGames)).first<{ id: string; game: string }>();
  if (conflict !== null) {
    throw new AdministrationProblem(
      409,
      "curated_revision_reconfirmation_required",
      `Curated Revision ${conflict.id} requires reconfirmation for ${conflict.game}.`,
    );
  }
}

export async function applyPinnedCuratedRevisions(
  database: D1Database,
  runId: string,
  candidate: CatalogueCandidate,
  observedAt: string,
): Promise<CatalogueCandidate> {
  if (!(await curatedRevisionSchemaAvailable(database))) return candidate;
  const rows = await database.prepare(
    `SELECT revision.id, revision.proposal_json, revision.content_digest,
            pin.reviewed_source_digest
     FROM ingestion_run_curated_revisions AS pin
     JOIN curated_revisions AS revision ON revision.id = pin.revision_id
     WHERE pin.ingestion_run_id = ? ORDER BY pin.ordinal`,
  ).bind(runId).all<{
    id: string; proposal_json: string; content_digest: string; reviewed_source_digest: string;
  }>();
  const result = structuredClone(candidate) as CatalogueCandidate;
  for (const row of rows.results) {
    const proposal = structuralProposal(JSON.parse(row.proposal_json));
    const target = candidateTarget(result, proposal);
    if (proposal.target.kind === "field") {
      const parts = pointerParts(proposal.target.path);
      const source = valueAt(target, parts);
      if (!source.found || await sha256Text(canonicalJson(source.value)) !== row.reviewed_source_digest) {
        await recordSourceChange(database, row.id, runId, source.found ? source.value : null, row.reviewed_source_digest, observedAt);
        throw new Error("curated_revision_reconfirmation_required");
      }
      setAt(target, parts, (proposal.assertion as { kind: "field"; value: unknown }).value);
      const entity = target as Record<string, unknown> & { curated_provenance?: readonly CuratedProvenance[] };
      const provenance = Array.isArray(entity.curated_provenance) ? entity.curated_provenance : [];
      entity.curated_provenance = [...provenance, provenanceFor(proposal, row, source.value)];
    } else {
      const sourcePresence = relationshipPresent(result, proposal)
        ? "present"
        : "absent";
      if (await sha256Text(canonicalJson(sourcePresence)) !== row.reviewed_source_digest) {
        await recordSourceChange(database, row.id, runId, sourcePresence, row.reviewed_source_digest, observedAt);
        throw new Error("curated_revision_reconfirmation_required");
      }
      applyRelationship(result, proposal, row, sourcePresence);
    }
  }
  return result;
}

export async function curatedRevisionSetForRun(
  database: D1Database,
  runId: string,
): Promise<{ revision_ids: string[]; set_digest: string } | null> {
  if (!(await curatedRevisionSchemaAvailable(database))) return null;
  const row = await database.prepare(
    `SELECT revision_ids_json, set_digest
     FROM ingestion_run_curated_revision_sets
     WHERE ingestion_run_id = ?`,
  ).bind(runId).first<{ revision_ids_json: string; set_digest: string }>();
  return row === null
    ? null
    : { revision_ids: JSON.parse(row.revision_ids_json), set_digest: row.set_digest };
}

export async function curatedPublicationStatements(
  database: D1Database,
  runId: string,
  revisionId: string,
): Promise<D1PreparedStatement[]> {
  if (!(await curatedRevisionSchemaAvailable(database))) return [];
  return [database.prepare(
    `INSERT OR IGNORE INTO catalogue_curated_provenance (
       catalogue_revision_id, curated_revision_id, target_key,
       content_digest, provenance_json
     )
     SELECT ?, revision.id, revision.target_key,
            revision.content_digest,
            json_object(
              'author', revision.author,
              'created_at', revision.created_at,
              'evidence', json_extract(revision.proposal_json, '$.evidence'),
              'rationale', json_extract(revision.proposal_json, '$.rationale')
            )
     FROM ingestion_run_curated_revisions AS pin
     JOIN curated_revisions AS revision ON revision.id = pin.revision_id
     WHERE pin.ingestion_run_id = ?
     ORDER BY pin.ordinal`,
  ).bind(revisionId, runId)];
}

export function stripCuratedRevisionEffects(
  input: CatalogueCandidate,
): CatalogueCandidate {
  const candidate = structuredClone(input) as CatalogueCandidate;
  const entities: Record<string, unknown>[] = [
    ...candidate.cards,
    ...candidate.printings,
    ...(candidate.products ?? []),
    ...(candidate.products ?? []).flatMap((product) => product.releases),
    ...(candidate.distribution_contexts ?? []),
    ...(candidate.errata ?? []),
    ...(candidate.legality_rules ?? []),
  ] as Record<string, unknown>[];
  for (const entity of entities) {
    const provenance = Array.isArray(entity.curated_provenance)
      ? entity.curated_provenance as CuratedProvenance[]
      : [];
    for (const item of provenance) {
      const target = item.target;
      if (target.kind === "field" && typeof target.path === "string") {
        setAt(entity, pointerParts(target.path), item.reviewed_source_value);
      }
    }
    delete entity.curated_provenance;
  }
  if (candidate.product_relationships !== undefined) {
    candidate.product_relationships = candidate.product_relationships
      .filter((relationship) => relationship.evidence_category !== "curated")
      .map((relationship) => {
        const { curated_provenance: _provenance, ...official } = relationship;
        return official;
      });
  }
  return candidate;
}

async function curatedRevisionSchemaAvailable(database: D1Database): Promise<boolean> {
  const row = await database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'curated_revisions'",
  ).first<{ present: number }>();
  return row?.present === 1;
}

async function recordSourceChange(database: D1Database, revisionId: string, runId: string, value: unknown, previous: string, at: string) {
  const observed = await sha256Text(canonicalJson(value));
  const revision = await database.prepare("SELECT status, event_version FROM curated_revisions WHERE id = ?")
    .bind(revisionId).first<{ status: string; event_version: number }>();
  if (revision?.status === "reconfirmation_required") return;
  const version = (revision?.event_version ?? 0) + 1;
  const conflictId = `crconf_${crypto.randomUUID()}`;
  const conflictDigest = await sha256Text(canonicalJson({
    conflict_id: conflictId,
    run_id: runId,
    revision_id: revisionId,
    previous_source_digest: previous,
    observed_source_digest: observed,
  }));
  const details = {
    conflict_id: conflictId,
    conflict_digest: conflictDigest,
    run_id: runId,
    previous_source_digest: previous,
    observed_source_digest: observed,
  };
  await database.batch([
    database.prepare("UPDATE curated_revisions SET status = 'reconfirmation_required', event_version = ? WHERE id = ? AND status = 'active'")
      .bind(version, revisionId),
    database.prepare(
      `INSERT INTO curated_revision_events (revision_id, event_version, kind, event_json, created_at, author)
       VALUES (?, ?, 'source_change_detected', ?, ?, 'system')`,
    ).bind(revisionId, version, canonicalJson(details), at),
  ]);
}

type PendingConflict = {
  conflict_id: string;
  conflict_digest: string;
  run_id: string;
  previous_source_digest: string;
  observed_source_digest: string;
};

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
  database: D1Database,
  revisionId: string,
  input: Record<string, unknown>,
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
    throw new AdministrationProblem(422, "production_target_required", "Curated Revision mutations require environment production.");
  }
  const currentRevisionId = await currentRevision(database);
  if (requiredString(input.expected_current_revision_id, "expected_current_revision_id") !== currentRevisionId) {
    throw new AdministrationProblem(409, "current_revision_mismatch", "The expected current Catalogue Revision is stale.");
  }
  const operation = await database.prepare(
    "SELECT active_ingestion_run_id, recovery_health FROM operation_state WHERE singleton = 1",
  ).first<{ active_ingestion_run_id: string | null; recovery_health: string }>();
  if (operation?.recovery_health === "blocked") {
    throw new AdministrationProblem(409, "recovery_in_progress", "Recovery blocks Curated Revision mutation.");
  }
  if (operation?.active_ingestion_run_id !== null) {
    throw new AdministrationProblem(409, "active_ingestion_run", "An active Ingestion Run blocks Curated Revision mutation.");
  }
  const row = await database.prepare("SELECT * FROM curated_revisions WHERE id = ?")
    .bind(revisionId).first<RevisionRow>();
  if (row === null) throw new AdministrationProblem(404, "curated_revision_not_found", "The requested Curated Revision does not exist.");
  if (row.status !== "active" && row.status !== "reconfirmation_required") {
    throw new AdministrationProblem(409, "curated_revision_state_conflict", "The Curated Revision is no longer applicable.");
  }
  if (!Number.isInteger(input.expected_event_version) || input.expected_event_version !== row.event_version) {
    throw new AdministrationProblem(409, "curated_revision_event_version_mismatch", "The expected lifecycle event version is stale.");
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

async function pendingConflict(
  database: D1Database,
  row: RevisionRow,
): Promise<PendingConflict | null> {
  if (row.status !== "reconfirmation_required") return null;
  const event = await database.prepare(
    `SELECT event_json FROM curated_revision_events
     WHERE revision_id = ? AND kind = 'source_change_detected'
     ORDER BY event_version DESC LIMIT 1`,
  ).bind(row.id).first<{ event_json: string }>();
  return event === null ? null : JSON.parse(event.event_json) as PendingConflict;
}

function assertConflictBinding(conflict: PendingConflict | null, supplied: unknown): void {
  if (conflict === null) {
    if (supplied !== null && supplied !== undefined) {
      throw new AdministrationProblem(409, "curated_revision_has_no_pending_conflict", "The Curated Revision has no pending source conflict.");
    }
    return;
  }
  if (supplied !== conflict.conflict_digest) {
    throw new AdministrationProblem(409, "curated_revision_conflict_digest_mismatch", "The exact pending conflict digest is required.");
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
  database: D1Database,
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
    await database.batch([
      database.prepare(
        "UPDATE curated_revisions SET status = ?, event_version = ? WHERE id = ? AND event_version = ? AND status IN ('active', 'reconfirmation_required')",
      ).bind(event.status, event.version, mutation.row.id, mutation.row.event_version),
      database.prepare(
        `INSERT INTO curated_revision_events (revision_id, event_version, kind, event_json, created_at, author)
         VALUES (?, ?, ?, ?, ?, 'owner')`,
      ).bind(mutation.row.id, event.version, event.kind, canonicalJson(event.details), event.observedAt),
      database.prepare(
        `INSERT INTO curated_revision_idempotency (idempotency_key, request_digest, response_json, response_status, created_at)
         VALUES (?, ?, ?, 200, ?)`,
      ).bind(mutation.idempotencyKey, mutation.requestDigest, canonicalJson(result), event.observedAt),
    ]);
  } catch (error) {
    const replay = await idempotencyReplay(database, mutation.idempotencyKey, mutation.requestDigest);
    if (replay !== null) return;
    throw lifecycleWriteProblem(error);
  }
}

async function idempotencyReplay(
  database: D1Database,
  key: string,
  requestDigest: string,
): Promise<{ created: boolean; document: MutationResult } | null> {
  const row = await database.prepare(
    "SELECT request_digest, response_json FROM curated_revision_idempotency WHERE idempotency_key = ?",
  ).bind(key).first<{ request_digest: string; response_json: string }>();
  if (row === null) return null;
  if (row.request_digest !== requestDigest) {
    throw new AdministrationProblem(409, "idempotency_conflict", "The idempotency key is already bound to another request.");
  }
  return { created: false, document: JSON.parse(row.response_json) as MutationResult };
}

function lifecycleWriteProblem(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes("curated_revision_target_conflict")) {
    return new AdministrationProblem(409, "curated_revision_target_conflict", "An active Curated Revision already overlaps this target and interval.");
  }
  if (detail.includes("curated_revision_operation_not_idle")) {
    return new AdministrationProblem(409, "operation_not_idle", "The production mutation boundary is not idle.");
  }
  if (detail.includes("UNIQUE constraint failed") || detail.includes("curated_revision_events")) {
    return new AdministrationProblem(409, "curated_revision_event_version_mismatch", "The lifecycle event version changed concurrently.");
  }
  return error instanceof Error ? error : new Error(detail);
}

async function effectiveReviewedSourceDigest(
  database: D1Database,
  revisionId: string,
  fallback: string,
): Promise<string> {
  const row = await database.prepare(
    `SELECT json_extract(event_json, '$.reviewed_source_digest') AS digest
     FROM curated_revision_events
     WHERE revision_id = ? AND kind = 'reaffirmed'
     ORDER BY event_version DESC LIMIT 1`,
  ).bind(revisionId).first<{ digest: string | null }>();
  return row?.digest ?? fallback;
}

async function validateSupersedingProposal(
  database: D1Database,
  mutation: ExistingMutation,
  proposal: Proposal,
): Promise<void> {
  const target = await currentTarget(database, mutation.currentRevisionId, proposal);
  if (proposal.target.kind === "field") {
    const parts = pointerParts(proposal.target.path);
    if (protectedPath(parts) || identityRootsByType[proposal.target.entity_type]?.has(parts[0] ?? "")) {
      throw new AdministrationProblem(422, "curated_revision_identity_forbidden", `The protected field ${proposal.target.path} cannot be curated.`);
    }
    const source = valueAt(target, parts);
    if (!source.found || !compatibleFieldAssertion(proposal.target.entity_type, parts, source.value, (proposal.assertion as { kind: "field"; value: unknown }).value)) {
      throw new AdministrationProblem(422, "curated_revision_assertion_type_invalid", "The assertion value does not match the pinned schema field type.");
    }
  } else {
    assertRelationshipRepresentable(target as unknown as CatalogueCandidate, proposal);
  }
  const previous = structuralProposal(JSON.parse(mutation.row.proposal_json));
  const expectedDigest = mutation.conflict?.observed_source_digest ??
    (targetKey(previous) === targetKey(proposal)
      ? await effectiveReviewedSourceDigest(database, mutation.row.id, mutation.row.reviewed_source_digest)
      : await sourceDigestForProposal(target, proposal));
  if (proposal.reviewed_source_digest !== expectedDigest) {
    throw new AdministrationProblem(409, "curated_revision_reviewed_source_mismatch", "The replacement must bind the exact reviewed Official Source value.");
  }
}

async function sourceDigestForProposal(target: Record<string, unknown>, proposal: Proposal): Promise<string> {
  if (proposal.target.kind === "field") {
    const source = valueAt(target, pointerParts(proposal.target.path));
    return sha256Text(canonicalJson(source.found ? source.value : null));
  }
  return sha256Text(canonicalJson(relationshipPresent(target as unknown as CatalogueCandidate, proposal) ? "present" : "absent"));
}

async function revisionContent(database: D1Database, row: RevisionRow): Promise<Record<string, unknown>> {
  const proposal = structuralProposal(JSON.parse(row.proposal_json));
  const events = await database.prepare(
    "SELECT kind, event_version, event_json, created_at, author FROM curated_revision_events WHERE revision_id = ? ORDER BY event_version",
  ).bind(row.id).all<{ kind: string; event_version: number; event_json: string; created_at: string; author: string }>();
  const conflict = await pendingConflict(database, row);
  return {
    id: row.id,
    content: proposal,
    content_digest: row.content_digest,
    author: row.author,
    created_at: Date.parse(row.created_at),
    status: row.status,
    event_version: row.event_version,
    pending_conflict: conflict === null ? null : {
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

async function currentRevision(database: D1Database): Promise<string> {
  const row = await database.prepare("SELECT current_revision_id FROM catalogue_state WHERE singleton = 1")
    .first<{ current_revision_id: string }>();
  if (row === null) throw new Error("Catalogue state is unavailable.");
  return row.current_revision_id;
}

async function currentTarget(database: D1Database, revisionId: string, proposal: Proposal): Promise<Record<string, unknown>> {
  if (proposal.target.kind === "field" && (proposal.target.entity_type === "card" || proposal.target.entity_type === "printing")) {
    const table = proposal.target.entity_type === "card" ? "revision_cards" : "revision_printings";
    const idColumn = proposal.target.entity_type === "card" ? "card_id" : "printing_id";
    const row = await database.prepare(`SELECT document_json FROM ${table} WHERE catalogue_revision_id = ? AND ${idColumn} = ?`)
      .bind(revisionId, proposal.target.entity_id).first<{ document_json: string }>();
    if (row === null) throw new AdministrationProblem(422, "curated_revision_target_not_found", "The target entity does not exist in the expected Catalogue Revision.");
    const document = JSON.parse(row.document_json) as Record<string, unknown>;
    const entity = record(document.data) ? document.data : document;
    if (proposal.target.entity_type === "card" && entity.game !== proposal.game) {
      throw new AdministrationProblem(422, "curated_revision_target_invalid", "The target does not belong to the proposed Supported Game.");
    }
    if (proposal.target.entity_type === "printing") {
      const cardId = typeof entity.card_id === "string" ? entity.card_id : null;
      const owner = cardId === null ? null : await database.prepare(
        "SELECT document_json FROM revision_cards WHERE catalogue_revision_id = ? AND card_id = ?",
      ).bind(revisionId, cardId).first<{ document_json: string }>();
      const cardDocument = owner === null ? null : JSON.parse(owner.document_json) as Record<string, unknown>;
      const cardEntity = cardDocument !== null && record(cardDocument.data) ? cardDocument.data : cardDocument;
      if (cardEntity === null || cardEntity.game !== proposal.game) {
        throw new AdministrationProblem(422, "curated_revision_target_invalid", "The target does not belong to the proposed Supported Game.");
      }
    }
    return entity;
  }
  const row = await database.prepare(
    `SELECT run.id AS ingestion_run_id, run.candidate_json FROM catalogue_revisions AS revision
     JOIN ingestion_runs AS run ON run.id = revision.ingestion_run_id
     WHERE revision.id = ?`,
  ).bind(revisionId).first<{ ingestion_run_id: string; candidate_json: string }>();
  if (row === null) {
    throw new AdministrationProblem(422, "curated_revision_target_not_found", "The target entity is unavailable in the expected Catalogue Revision.");
  }
  const candidate = JSON.parse(await retainedPayload(
    database,
    row.ingestion_run_id,
    "candidate",
    row.candidate_json,
  )) as CatalogueCandidate;
  return candidateTarget(candidate, proposal);
}

function candidateTarget(candidate: CatalogueCandidate, proposal: Proposal): Record<string, unknown> {
  if (proposal.target.kind === "relationship") return candidate as unknown as Record<string, unknown>;
  const type = proposal.target.entity_type;
  const id = proposal.target.entity_id;
  let found: unknown;
  if (type === "card") found = candidate.cards.find((item) => item.id === id && item.game === proposal.game);
  else if (type === "printing") found = candidate.printings.find((item) =>
    item.id === id && candidate.cards.some((card) => card.id === item.card_id && card.game === proposal.game)
  );
  else if (type === "product") found = candidate.products?.find((item) => item.id === id && item.game === proposal.game);
  else if (type === "distribution_context") found = candidate.distribution_contexts?.find((item) => item.id === id && item.game === proposal.game);
  else if (type === "erratum") found = candidate.errata?.find((item) => item.id === id && item.game === proposal.game);
  else if (type === "legality_rule") found = candidate.legality_rules?.find((item) => item.id === id && item.game === proposal.game);
  else if (type === "release") {
    found = candidate.products?.filter((product) => product.game === proposal.game)
      .flatMap((product) => product.releases).find((item) => item.id === id);
  }
  if (found === undefined) throw new AdministrationProblem(422, "curated_revision_target_not_found", "The target entity does not exist.");
  return found as Record<string, unknown>;
}

function applyRelationship(candidate: CatalogueCandidate, proposal: Proposal, revision: { id: string; content_digest: string }, reviewedPresence: string) {
  assertRelationshipRepresentable(candidate, proposal);
  const target = proposal.target as RelationshipTarget;
  const assertion = proposal.assertion as { kind: "relationship"; presence: "present" | "absent" };
  const relationships = [...(candidate.product_relationships ?? [])];
  const index = relationships.findIndex((item) =>
    item.from.type === target.from.type && item.from.id === target.from.id &&
    item.to.type === target.to.type && item.to.id === target.to.id &&
    item.kind === target.relationship_kind
  );
  const curatedProvenance = provenanceFor(proposal, revision, reviewedPresence);
  if (assertion.presence === "present" && index >= 0) {
    const existing = relationships[index]!;
    relationships[index] = {
      ...existing,
      curated_provenance: [
        ...(existing.curated_provenance ?? []),
        curatedProvenance,
      ],
    };
  }
  if (index < 0 || assertion.presence === "absent") {
    relationships.push({
      id: `relationship_${revision.id}`,
      game: proposal.game,
      kind: target.relationship_kind,
      from: target.from,
      to: target.to,
      evidence_category: "curated",
      resolution: "canonical",
      source_observation_ids: proposal.evidence.flatMap((evidence) =>
        evidence.kind === "source_observation" ? [evidence.id] : []
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
  return (candidate.product_relationships ?? []).some((item) =>
    item.from.type === target.from.type && item.from.id === target.from.id &&
    item.to.type === target.to.type && item.to.id === target.to.id &&
    item.kind === target.relationship_kind
  );
}

function assertRelationshipRepresentable(candidate: CatalogueCandidate, proposal: Proposal): void {
  const target = proposal.target as RelationshipTarget;
  const allowed = new Set([
    "printing-product", "printing-distribution-context",
    "distribution-context-product", "product-card",
  ]);
  const endpointPair = `${target.from.type}->${target.to.type}`;
  const pairs: Readonly<Record<string, string>> = {
    "printing-product": "printing->product",
    "printing-distribution-context": "printing->distribution_context",
    "distribution-context-product": "distribution_context->product",
    "product-card": "product->card",
  };
  if (!allowed.has(target.relationship_kind) || pairs[target.relationship_kind] !== endpointPair ||
    !entityExists(candidate, target.from.type, target.from.id, proposal.game) ||
    !entityExists(candidate, target.to.type, target.to.id, proposal.game)) {
    throw new AdministrationProblem(422, "curated_revision_relationship_not_in_schema", "The relationship or one of its endpoints is not representable by the V1 schema.");
  }
}

function entityExists(candidate: CatalogueCandidate, type: string, id: string, game: SupportedGame): boolean {
  if (type === "card") return candidate.cards.some((item) => item.id === id && item.game === game);
  if (type === "printing") return candidate.printings.some((item) =>
    item.id === id && candidate.cards.some((card) => card.id === item.card_id && card.game === game)
  );
  if (type === "product") return candidate.products?.some((item) => item.id === id && item.game === game) ?? false;
  if (type === "distribution_context") return candidate.distribution_contexts?.some((item) => item.id === id && item.game === game) ?? false;
  return false;
}

function structuralProposal(value: unknown): Proposal {
  if (!record(value)) invalid("Proposal is required.");
  onlyFields(value, ["game", "target", "assertion", "rationale", "evidence", "effective_interval", "reviewed_source_digest", "supersedes_revision_id"]);
  if (!games.has(String(value.game))) throw new AdministrationProblem(422, "invalid_supported_game", "The Supported Game is invalid.");
  if (typeof value.rationale !== "string" || value.rationale.trim() === "") invalid("A non-empty rationale is required.");
  if (!sha256Digest(value.reviewed_source_digest)) invalid("reviewed_source_digest must be a lower-case SHA-256.");
  if (!Array.isArray(value.evidence) || value.evidence.length === 0 || !value.evidence.every(validEvidence)) invalid("At least one valid evidence reference is required.");
  const interval = value.effective_interval ?? { from: null, to: null };
  if (!record(interval) || !onlyDate(interval.from) || !onlyDate(interval.to) || (typeof interval.from === "string" && typeof interval.to === "string" && interval.from >= interval.to)) {
    throw new AdministrationProblem(422, "curated_revision_interval_invalid", "The optional interval is closed-open and from must precede to.");
  }
  if (!record(value.target) || !record(value.assertion)) throw new AdministrationProblem(422, "curated_revision_target_invalid", "The target and assertion are required.");
  if (value.target.kind === "field") {
    onlyFields(value.target, ["kind", "entity_type", "entity_id", "path"]);
    onlyFields(value.assertion, ["kind", "value"]);
    if (!fieldEntityTypes.has(String(value.target.entity_type)) || !opaque(value.target.entity_id) || typeof value.target.path !== "string" || !value.target.path.startsWith("/")) throw new AdministrationProblem(422, "curated_revision_target_invalid", "Field target is incomplete.");
    if (value.assertion.kind !== "field" || !Object.hasOwn(value.assertion, "value")) invalid("A field target requires an explicit field assertion.");
  } else if (value.target.kind === "relationship") {
    onlyFields(value.target, ["kind", "relationship_kind", "from", "to"]);
    onlyFields(value.assertion, ["kind", "presence"]);
    if (!record(value.target.from) || !record(value.target.to) || !opaque(value.target.from.id) || !opaque(value.target.to.id) || typeof value.target.from.type !== "string" || typeof value.target.to.type !== "string" || typeof value.target.relationship_kind !== "string") throw new AdministrationProblem(422, "curated_revision_target_invalid", "Relationship target is incomplete.");
    if (value.assertion.kind !== "relationship" || (value.assertion.presence !== "present" && value.assertion.presence !== "absent")) invalid("A relationship assertion must be present or absent.");
  } else throw new AdministrationProblem(422, "curated_revision_target_invalid", "Target kind must be field or relationship.");
  if (value.supersedes_revision_id !== null && value.supersedes_revision_id !== undefined && !opaque(value.supersedes_revision_id)) invalid("supersedes_revision_id must be an opaque identity or null.");
  return value as unknown as Proposal;
}

function targetKey(proposal: Proposal): string {
  const target = proposal.target;
  return target.kind === "field"
    ? [proposal.game, "field", target.entity_type, target.entity_id, target.path].join("|")
    : [proposal.game, "relationship", target.relationship_kind, target.from.type, target.from.id, target.to.type, target.to.id].join("|");
}
function pointerParts(path: string): string[] { return path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")); }
function valueAt(target: Record<string, unknown>, parts: string[]): { found: boolean; value: unknown } {
  let value: unknown = target;
  for (const part of parts) {
    if (!record(value) && !Array.isArray(value)) return { found: false, value: undefined };
    if (!Object.hasOwn(value, part)) return { found: false, value: undefined };
    value = (value as Record<string, unknown>)[part];
  }
  return { found: true, value };
}
function setAt(target: Record<string, unknown>, parts: string[], value: unknown) {
  let parent: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
  parent[parts.at(-1)!] = structuredClone(value);
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function opaque(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value); }
function sha256Digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function onlyDate(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value;
}
function protectedPath(parts: readonly string[]): boolean {
  return forbiddenRoots.has(parts[0] ?? "") ||
    parts.join("/") === "game_data/profile" ||
    parts.some((part) => part === "id" || part.endsWith("_id"));
}

function compatibleFieldAssertion(
  entityType: string,
  parts: readonly string[],
  source: unknown,
  assertion: unknown,
): boolean {
  const path = `/${parts.join("/")}`;
  const nullable = new Set([
    "card:/effective_rules_text",
    "printing:/rarity/normalized", "printing:/rarity/raw",
    "printing:/printed_rules_text", "printing:/game_data",
    "product:/official_code", "product:/name",
    "release:/date/precision", "release:/date/value", "release:/status",
    "distribution_context:/product_id",
    "erratum:/effective_from", "erratum:/corrected_value",
    "legality_rule:/event_tier", "legality_rule:/effective_from",
    "legality_rule:/effective_until", "legality_rule:/unresolved_scope",
  ]).has(`${entityType}:${path}`);
  if (assertion === null) return nullable;
  if (source === null) {
    if (!nullable) return false;
    if (path === "/game_data" || path === "/unresolved_scope") return record(assertion);
    if (path === "/date/precision") return typeof assertion === "string" && ["day", "month", "quarter", "year", "unknown"].includes(assertion);
    if (path === "/status") return assertion === "announced" || assertion === "released";
    return typeof assertion === "string";
  }
  if (path === "/region") return typeof assertion === "string" && ["EN-OCEANIA", "EN-ASIA", "EN-US", "unknown"].includes(assertion);
  if (path === "/date/precision") return typeof assertion === "string" && ["day", "month", "quarter", "year", "unknown"].includes(assertion);
  if (path === "/status") return assertion === "announced" || assertion === "released";
  if (["/effective_from", "/effective_until"].includes(path)) return typeof assertion === "string" && onlyDate(assertion);
  if (path === "/kind" && entityType === "distribution_context") return typeof assertion === "string" && ["product", "tournament_pack", "winner_prize", "promotion", "other"].includes(assertion);
  if (Array.isArray(source)) {
    return Array.isArray(assertion) &&
      assertion.length === source.length &&
      source.every((value, index) => compatibleFieldAssertion(entityType, [...parts, String(index)], value, assertion[index]));
  }
  if (record(source)) {
    if (!record(assertion)) return false;
    const sourceKeys = Object.keys(source).sort();
    const assertionKeys = Object.keys(assertion).sort();
    return sourceKeys.length === assertionKeys.length &&
      sourceKeys.every((key, index) => key === assertionKeys[index] && compatibleFieldAssertion(entityType, [...parts, key], source[key], assertion[key]));
  }
  return typeof source === typeof assertion;
}
function validEvidence(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.kind === "source_observation") return Object.keys(value).length === 2 && opaque(value.id);
  return value.kind === "owner_reference" && Object.keys(value).length === 3 && typeof value.uri === "string" && value.uri.length > 0 && sha256Digest(value.content_digest);
}
function requiredString(value: unknown, field: string): string { if (typeof value !== "string" || value.length === 0) invalid(`${field} must be a non-empty string.`); return value as string; }
function onlyFields(value: Record<string, unknown>, fields: readonly string[]) { const extra = Object.keys(value).find((key) => !fields.includes(key)); if (extra) invalid(`${extra} is not accepted.`); }
function invalid(detail: string): never { throw new AdministrationProblem(422, "curated_revision_schema_invalid", detail); }
