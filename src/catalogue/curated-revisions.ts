import type { CatalogueCandidate, SupportedGame } from "./catalogue-candidate";
import { AdministrationProblem } from "./administration-problem.mjs";
import { canonicalJson, sha256Text } from "./serialization";
import { retainedPayload } from "./reconciliation-payload";

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
    if (forbiddenRoots.has(path[0] ?? "") ||
      identityRootsByType[proposal.target.entity_type]?.has(path[0] ?? "")) {
      throw new AdministrationProblem(422, "curated_revision_identity_forbidden", `The protected field ${proposal.target.path} cannot be curated.`);
    }
    const sourceValue = valueAt(target, path);
    if (!sourceValue.found) {
      throw new AdministrationProblem(422, "curated_revision_field_not_in_schema", "A Curated Revision cannot invent a Game Profile field.");
    }
    const assertionValue = (proposal.assertion as { kind: "field"; value: unknown }).value;
    if (!compatibleJsonType(sourceValue.value, assertionValue)) {
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
): Promise<{ created: boolean; document: Record<string, unknown> }> {
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
    return { created: false, document: JSON.parse(replay.response_json) as Record<string, unknown> };
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
  const document = {
    contract: "card-keepr-curated-revision@1",
    id,
    game: proposal.game,
    target: proposal.target,
    assertion: proposal.assertion,
    rationale: proposal.rationale,
    evidence: proposal.evidence,
    effective_interval: interval,
    reviewed_source_digest: proposal.reviewed_source_digest,
    supersedes_revision_id: proposal.supersedes_revision_id ?? null,
    content_digest: suppliedDigest,
    schema_binding: schemaBinding,
    author: "owner",
    created_at: observedAt,
    status: "active",
    event_version: 1,
    events: [{
      type: "authored",
      event_version: 1,
      at: observedAt,
      author: "owner",
      details: { reviewed_source_digest: proposal.reviewed_source_digest },
    }],
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
        document: JSON.parse(concurrentReplay.response_json) as Record<string, unknown>,
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
    contract: "card-keepr-curated-revision-list@1",
    revisions: await Promise.all(rows.results.map((row) => publicRevision(database, row))),
  };
}

export async function showCuratedRevision(
  database: D1Database,
  id: string,
): Promise<Record<string, unknown>> {
  const row = await database.prepare("SELECT * FROM curated_revisions WHERE id = ?")
    .bind(id).first<RevisionRow>();
  if (row === null) throw new AdministrationProblem(404, "curated_revision_not_found", "The requested Curated Revision does not exist.");
  return publicRevision(database, row);
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
  if (existing !== null) return { revision_ids: JSON.parse(existing.revision_ids_json), set_digest: existing.set_digest };
  const run = await database.prepare("SELECT selected_games_json FROM ingestion_runs WHERE id = ?")
    .bind(runId).first<{ selected_games_json: string }>();
  if (run === null) throw new AdministrationProblem(404, "ingestion_run_not_found", "The requested Ingestion Run does not exist.");
  const selectedGames = JSON.parse(run.selected_games_json) as string[];
  const on = observedAt.slice(0, 10);
  const rows = await database.prepare(
    `SELECT id, content_digest, reviewed_source_digest
     FROM curated_revisions
     WHERE status = 'active'
       AND game IN (SELECT value FROM json_each(?))
       AND (effective_from IS NULL OR effective_from <= ?)
       AND (effective_to IS NULL OR ? < effective_to)
     ORDER BY id`,
  ).bind(canonicalJson(selectedGames), on, on).all<{
    id: string; content_digest: string; reviewed_source_digest: string;
  }>();
  const ids = rows.results.map(({ id }) => id);
  const setDigest = await sha256Text(canonicalJson(ids));
  if (rows.results.length === 0) {
    return { revision_ids: ids, set_digest: setDigest };
  }
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
      const entity = target as Record<string, unknown>;
      const provenance = Array.isArray(entity.curated_provenance) ? entity.curated_provenance : [];
      entity.curated_provenance = [...provenance, {
        curated_revision_id: row.id,
        content_digest: row.content_digest,
        target: proposal.target,
        rationale: proposal.rationale,
        evidence: proposal.evidence,
        author: "owner",
      }];
    } else {
      const sourcePresence = relationshipPresent(result, proposal)
        ? "present"
        : "absent";
      if (await sha256Text(canonicalJson(sourcePresence)) !== row.reviewed_source_digest) {
        await recordSourceChange(database, row.id, runId, sourcePresence, row.reviewed_source_digest, observedAt);
        throw new Error("curated_revision_reconfirmation_required");
      }
      applyRelationship(result, proposal, row);
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

async function curatedRevisionSchemaAvailable(database: D1Database): Promise<boolean> {
  const row = await database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'curated_revisions'",
  ).first<{ present: number }>();
  return row?.present === 1;
}

async function recordSourceChange(database: D1Database, revisionId: string, runId: string, value: unknown, previous: string, at: string) {
  const observed = await sha256Text(canonicalJson(value));
  const revision = await database.prepare("SELECT event_version FROM curated_revisions WHERE id = ?")
    .bind(revisionId).first<{ event_version: number }>();
  const version = (revision?.event_version ?? 0) + 1;
  const details = { run_id: runId, previous_source_digest: previous, observed_source_digest: observed };
  await database.batch([
    database.prepare("UPDATE curated_revisions SET status = 'reconfirmation_required', event_version = ? WHERE id = ? AND status = 'active'")
      .bind(version, revisionId),
    database.prepare(
      `INSERT INTO curated_revision_events (revision_id, event_version, kind, event_json, created_at, author)
       VALUES (?, ?, 'source_change_detected', ?, ?, 'system')`,
    ).bind(revisionId, version, canonicalJson(details), at),
  ]);
}

async function publicRevision(database: D1Database, row: RevisionRow): Promise<Record<string, unknown>> {
  const proposal = structuralProposal(JSON.parse(row.proposal_json));
  const events = await database.prepare(
    "SELECT kind, event_version, event_json, created_at, author FROM curated_revision_events WHERE revision_id = ? ORDER BY event_version",
  ).bind(row.id).all<{ kind: string; event_version: number; event_json: string; created_at: string; author: string }>();
  return {
    contract: "card-keepr-curated-revision@1", id: row.id, game: row.game,
    target: proposal.target, assertion: proposal.assertion,
    rationale: proposal.rationale, evidence: proposal.evidence,
    effective_interval: proposal.effective_interval ?? { from: null, to: null },
    reviewed_source_digest: proposal.reviewed_source_digest,
    supersedes_revision_id: proposal.supersedes_revision_id ?? null,
    content_digest: row.content_digest,
    schema_binding: JSON.parse(row.schema_binding_json), author: row.author,
    created_at: row.created_at, status: row.status, event_version: row.event_version,
    events: events.results.map((event) => ({ type: event.kind, event_version: event.event_version,
      at: event.created_at, author: event.author, details: JSON.parse(event.event_json) })),
  };
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
  else if (type === "printing") found = candidate.printings.find((item) => item.id === id);
  else if (type === "product") found = candidate.products?.find((item) => item.id === id && item.game === proposal.game);
  else if (type === "distribution_context") found = candidate.distribution_contexts?.find((item) => item.id === id);
  else if (type === "erratum") found = candidate.errata?.find((item) => item.id === id && item.game === proposal.game);
  else if (type === "legality_rule") found = candidate.legality_rules?.find((item) => item.id === id && item.game === proposal.game);
  else if (type === "release") {
    found = candidate.products?.flatMap((product) => product.releases)
      .find((item) => item.id === id);
  }
  if (found === undefined) throw new AdministrationProblem(422, "curated_revision_target_not_found", "The target entity does not exist.");
  return found as Record<string, unknown>;
}

function applyRelationship(candidate: CatalogueCandidate, proposal: Proposal, revision: { id: string; content_digest: string }) {
  assertRelationshipRepresentable(candidate, proposal);
  const target = proposal.target as RelationshipTarget;
  const assertion = proposal.assertion as { kind: "relationship"; presence: "present" | "absent" };
  const relationships = [...(candidate.product_relationships ?? [])];
  const index = relationships.findIndex((item) =>
    item.from.type === target.from.type && item.from.id === target.from.id &&
    item.to.type === target.to.type && item.to.id === target.to.id &&
    item.kind === target.relationship_kind
  );
  if (assertion.presence === "absent" && index >= 0) relationships.splice(index, 1);
  if (assertion.presence === "present" && index < 0) {
    relationships.push({
      id: `relationship_${revision.id}`,
      game: proposal.game,
      kind: target.relationship_kind,
      from: target.from,
      to: target.to,
      evidence_category: "curated",
      resolution: "canonical",
      source_lineage: "curated-revision",
      source_observation_ids: proposal.evidence.flatMap((evidence) =>
        evidence.kind === "source_observation" ? [evidence.id] : []
      ),
      relationship_value: `${target.from.type}:${target.from.id}|${target.to.type}:${target.to.id}`,
      observed: false,
    } as never);
  }
  (candidate as { product_relationships?: typeof relationships }).product_relationships = relationships;
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
  if (!allowed.has(target.relationship_kind) ||
    !entityExists(candidate, target.from.type, target.from.id, proposal.game) ||
    !entityExists(candidate, target.to.type, target.to.id, proposal.game)) {
    throw new AdministrationProblem(422, "curated_revision_relationship_not_in_schema", "The relationship or one of its endpoints is not representable by the V1 schema.");
  }
}

function entityExists(candidate: CatalogueCandidate, type: string, id: string, game: SupportedGame): boolean {
  if (type === "card") return candidate.cards.some((item) => item.id === id && item.game === game);
  if (type === "printing") return candidate.printings.some((item) => item.id === id);
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
function compatibleJsonType(source: unknown, assertion: unknown): boolean {
  if (source === null || assertion === null) return true;
  if (Array.isArray(source)) return Array.isArray(assertion);
  if (record(source)) return record(assertion);
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
