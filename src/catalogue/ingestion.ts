import { buildCatalogueExport } from "./export";
import {
  FixtureInputError,
  fixtureCandidate,
  type FixtureCandidate,
} from "./fixture";
import { canonicalJson, sha256 } from "./serialization";

const sevenDaysInMilliseconds = 7 * 24 * 60 * 60 * 1_000;

type RunRow = {
  id: string;
  state: string;
  selected_games_json: string;
  started_at: string;
  expected_current_revision_id: string;
  linked_run_id: string | null;
  idempotency_key: string;
  candidate_digest: string | null;
  candidate_created_at: string | null;
  approval_deadline: string | null;
  approval_json: string | null;
  published_revision_id: string | null;
  export_manifest_digest: string | null;
  terminal_at: string | null;
  candidate_json: string;
  approval_idempotency_key: string | null;
};

type CatalogueStateRow = {
  current_revision_id: string;
  published_at: string;
};

export type StartRunRequest = {
  fixture: string;
  selected_games: readonly string[];
  idempotency_key: string;
};

export type ApproveRunRequest = {
  candidate_digest: string;
  expected_current_revision_id: string;
  idempotency_key: string;
};

export async function startFixtureRun(
  database: D1Database,
  request: StartRunRequest,
): Promise<Record<string, unknown>> {
  assertOpaqueId(request.idempotency_key, "idempotency_key");
  const { candidate, digest } = await fixtureCandidate(
    request.fixture,
    request.selected_games,
  ).catch((error: unknown) => {
    if (error instanceof FixtureInputError) {
      throw new AdministrationProblem(422, error.code, error.message);
    }
    throw error;
  });

  const replay = await findRunByIdempotencyKey(
    database,
    request.idempotency_key,
  );
  if (replay !== null) {
    if (replay.candidate_json !== canonicalJson(candidate)) {
      throw new AdministrationProblem(
        409,
        "idempotency_key_reused",
        "The idempotency key was already used for a different ingestion request.",
      );
    }
    return publicRun(replay);
  }

  const catalogueState = await currentCatalogueState(database);
  const startedAt = new Date().toISOString();
  const approvalDeadline = new Date(
    Date.parse(startedAt) + sevenDaysInMilliseconds,
  ).toISOString();
  const runId = `run_${crypto.randomUUID()}`;
  const candidateJson = canonicalJson(candidate);

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO ingestion_runs (
            id,
            state,
            selected_games_json,
            started_at,
            expected_current_revision_id,
            linked_run_id,
            idempotency_key,
            candidate_digest,
            candidate_created_at,
            approval_deadline,
            approval_json,
            published_revision_id,
            export_manifest_digest,
            terminal_at,
            candidate_json,
            approval_idempotency_key
          ) VALUES (?, 'awaiting_approval', ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL)`,
        )
        .bind(
          runId,
          JSON.stringify(candidate.selected_games),
          startedAt,
          catalogueState.current_revision_id,
          request.idempotency_key,
          digest,
          startedAt,
          approvalDeadline,
          candidateJson,
        ),
      database
        .prepare(
          "UPDATE operation_state SET active_ingestion_run_id = ? WHERE singleton = 1",
        )
        .bind(runId),
    ]);
  } catch (error) {
    const concurrentReplay = await findRunByIdempotencyKey(
      database,
      request.idempotency_key,
    );
    if (
      concurrentReplay !== null &&
      concurrentReplay.candidate_json === candidateJson
    ) {
      return publicRun(concurrentReplay);
    }
    if (errorMessage(error).includes("active_ingestion_run")) {
      throw new AdministrationProblem(
        409,
        "active_ingestion_run",
        "Another Ingestion Run is already active.",
      );
    }
    throw error;
  }

  return publicRun(
    await requiredRun(database, runId),
  );
}

export async function showRun(
  database: D1Database,
  runId: string,
): Promise<Record<string, unknown>> {
  assertOpaqueId(runId, "run_id");
  return publicRun(await requiredRun(database, runId));
}

export async function inspectCandidate(
  database: D1Database,
  runId: string,
): Promise<Record<string, unknown>> {
  assertOpaqueId(runId, "run_id");
  const row = await requiredRun(database, runId);
  if (row.state !== "awaiting_approval") {
    throw new AdministrationProblem(
      409,
      "candidate_not_approvable",
      "The Ingestion Run does not have a candidate awaiting approval.",
    );
  }
  const candidate = parseCandidate(row);
  return {
    run_id: row.id,
    candidate_digest: row.candidate_digest,
    expected_current_revision_id: row.expected_current_revision_id,
    approval_deadline: row.approval_deadline,
    diff: {
      summary: {
        cards_added: candidate.cards.length,
        printings_added: candidate.printings.length,
        warnings: 0,
      },
      cards: {
        added: candidate.cards.map((card) => card.id),
        changed: [],
        missing_observations: [],
      },
      printings: {
        added: candidate.printings.map((printing) => printing.id),
        changed: [],
        identity_matches: [],
      },
      warnings: [],
    },
  };
}

export async function approveRun(
  database: D1Database,
  catalogueExports: R2Bucket,
  runId: string,
  request: ApproveRunRequest,
): Promise<Record<string, unknown>> {
  assertOpaqueId(runId, "run_id");
  assertSha256(request.candidate_digest, "candidate_digest");
  assertOpaqueId(
    request.expected_current_revision_id,
    "expected_current_revision_id",
  );
  assertOpaqueId(request.idempotency_key, "idempotency_key");

  const run = await requiredRun(database, runId);
  if (
    run.state === "published" &&
    run.approval_idempotency_key === request.idempotency_key
  ) {
    return publicRun(run);
  }
  if (
    run.approval_idempotency_key === request.idempotency_key ||
    (await approvalKeyExists(database, request.idempotency_key))
  ) {
    throw new AdministrationProblem(
      409,
      "idempotency_key_reused",
      "The idempotency key was already used for a different approval request.",
    );
  }
  if (run.state !== "awaiting_approval") {
    throw new AdministrationProblem(
      409,
      "run_not_approvable",
      "The Ingestion Run is not awaiting approval.",
    );
  }
  const now = new Date().toISOString();
  if (
    run.approval_deadline === null ||
    Date.parse(now) >= Date.parse(run.approval_deadline)
  ) {
    await expireRun(database, run.id, now);
    throw new AdministrationProblem(
      409,
      "candidate_expired",
      "The candidate approval deadline has passed.",
    );
  }
  if (run.candidate_digest !== request.candidate_digest) {
    throw new AdministrationProblem(
      409,
      "candidate_digest_mismatch",
      "The candidate digest no longer matches the requested approval.",
    );
  }
  if (
    run.expected_current_revision_id !==
    request.expected_current_revision_id
  ) {
    throw new AdministrationProblem(
      409,
      "current_revision_mismatch",
      "The current Catalogue Revision no longer matches the requested approval.",
    );
  }
  const state = await currentCatalogueState(database);
  if (state.current_revision_id !== request.expected_current_revision_id) {
    throw new AdministrationProblem(
      409,
      "current_revision_mismatch",
      "The current Catalogue Revision no longer matches the requested approval.",
    );
  }

  const candidate = parseCandidate(run);
  const revisionId = `catrev_${request.candidate_digest.slice(0, 32)}`;
  const catalogueExport = await buildCatalogueExport(
    candidate,
    request.candidate_digest,
    revisionId,
    now,
  );

  try {
    await storeAndVerifyExport(catalogueExports, catalogueExport.objects);
    const cardDocument = catalogueCard(candidate, revisionId);
    const printingDocument = cataloguePrinting(candidate, revisionId);
    const approval = {
      approved_at: now,
      candidate_digest: request.candidate_digest,
      expected_current_revision_id: request.expected_current_revision_id,
    };
    await database.batch([
      database
        .prepare(
          `INSERT INTO catalogue_revisions (
            id,
            ingestion_run_id,
            published_at,
            content_digest,
            expected_previous_revision_id,
            approved_candidate_digest
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          revisionId,
          run.id,
          now,
          request.candidate_digest,
          request.expected_current_revision_id,
          request.candidate_digest,
        ),
      database
        .prepare(
          `INSERT INTO revision_cards (
            catalogue_revision_id,
            card_id,
            document_json
          ) VALUES (?, ?, ?)`,
        )
        .bind(revisionId, candidate.cards[0].id, JSON.stringify(cardDocument)),
      database
        .prepare(
          `INSERT INTO revision_printings (
            catalogue_revision_id,
            printing_id,
            card_id,
            document_json
          ) VALUES (?, ?, ?, ?)`,
        )
        .bind(
          revisionId,
          candidate.printings[0].id,
          candidate.printings[0].card_id,
          JSON.stringify(printingDocument),
        ),
      database
        .prepare(
          `INSERT INTO catalogue_exports (
            catalogue_revision_id,
            manifest_key,
            manifest_digest,
            verified
          ) VALUES (?, ?, ?, 1)`,
        )
        .bind(
          revisionId,
          catalogueExport.manifestKey,
          catalogueExport.manifest.manifest_sha256,
        ),
      database
        .prepare(
          `UPDATE ingestion_runs
          SET state = 'publishing',
              approval_json = ?,
              approval_idempotency_key = ?
          WHERE id = ? AND state = 'awaiting_approval'`,
        )
        .bind(JSON.stringify(approval), request.idempotency_key, run.id),
      database
        .prepare(
          `UPDATE catalogue_state
          SET current_revision_id = ?, published_at = ?
          WHERE singleton = 1`,
        )
        .bind(revisionId, now),
      database
        .prepare(
          `UPDATE ingestion_runs
          SET state = 'published',
              published_revision_id = ?,
              export_manifest_digest = ?,
              terminal_at = ?
          WHERE id = ? AND state = 'publishing'`,
        )
        .bind(
          revisionId,
          catalogueExport.manifest.manifest_sha256,
          now,
          run.id,
        ),
      database
        .prepare(
          `UPDATE operation_state
          SET active_ingestion_run_id = NULL
          WHERE singleton = 1 AND active_ingestion_run_id = ?`,
        )
        .bind(run.id),
    ]);
  } catch (error) {
    if (errorMessage(error).includes("publication_guard_failed")) {
      throw new AdministrationProblem(
        409,
        "publication_precondition_failed",
        "The publication guards changed before the approval could commit.",
      );
    }
    await failRun(database, run.id, now);
    throw new AdministrationProblem(
      500,
      "export_verification_failed",
      "The Catalogue Export could not be verified, so no revision was published.",
    );
  }

  return publicRun(await requiredRun(database, run.id));
}

export class AdministrationProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function catalogueCard(candidate: FixtureCandidate, revisionId: string) {
  const card = candidate.cards[0];
  return {
    type: "card",
    ...card,
    printing_ids: candidate.printings.map((printing) => printing.id),
    lifecycle: lifecycle(revisionId),
    links: {
      self: `/v1/cards/${card.id}`,
    },
  };
}

function cataloguePrinting(
  candidate: FixtureCandidate,
  revisionId: string,
) {
  const printing = candidate.printings[0];
  return {
    type: "printing",
    ...printing,
    printing_images: [],
    distribution_contexts: [],
    lifecycle: lifecycle(revisionId),
    links: {
      self: `/v1/printings/${printing.id}`,
    },
  };
}

function lifecycle(revisionId: string) {
  return {
    first_revision_id: revisionId,
    last_observed_revision_id: revisionId,
    withdrawn: false,
  };
}

async function storeAndVerifyExport(
  bucket: R2Bucket,
  objects: readonly {
    key: string;
    bytes: Uint8Array;
    contentType: string;
    contentEncoding?: string;
  }[],
): Promise<void> {
  for (const object of objects) {
    const expectedDigest = await sha256(object.bytes);
    const existing = await bucket.get(object.key);
    if (existing !== null) {
      const existingDigest = await sha256(await existing.arrayBuffer());
      if (existingDigest !== expectedDigest) {
        throw new Error("Immutable Catalogue Export object changed");
      }
      continue;
    }
    await bucket.put(object.key, object.bytes, {
      httpMetadata: {
        contentType: object.contentType,
        ...(object.contentEncoding === undefined
          ? {}
          : { contentEncoding: object.contentEncoding }),
        cacheControl: "private, max-age=31536000, immutable",
      },
    });
    const stored = await bucket.get(object.key);
    if (
      stored === null ||
      stored.size !== object.bytes.byteLength ||
      (await sha256(await stored.arrayBuffer())) !== expectedDigest
    ) {
      throw new Error("Catalogue Export object verification failed");
    }
  }
}

async function currentCatalogueState(
  database: D1Database,
): Promise<CatalogueStateRow> {
  const state = await database
    .prepare(
      "SELECT current_revision_id, published_at FROM catalogue_state WHERE singleton = 1",
    )
    .first<CatalogueStateRow>();
  if (state === null) {
    throw new Error("Catalogue state is unavailable");
  }
  return state;
}

async function requiredRun(
  database: D1Database,
  runId: string,
): Promise<RunRow> {
  const run = await database
    .prepare("SELECT * FROM ingestion_runs WHERE id = ?")
    .bind(runId)
    .first<RunRow>();
  if (run === null) {
    throw new AdministrationProblem(
      404,
      "ingestion_run_not_found",
      "The requested Ingestion Run does not exist.",
    );
  }
  return run;
}

function findRunByIdempotencyKey(
  database: D1Database,
  key: string,
): Promise<RunRow | null> {
  return database
    .prepare("SELECT * FROM ingestion_runs WHERE idempotency_key = ?")
    .bind(key)
    .first<RunRow>();
}

async function approvalKeyExists(
  database: D1Database,
  key: string,
): Promise<boolean> {
  return (
    (await database
      .prepare(
        "SELECT id FROM ingestion_runs WHERE approval_idempotency_key = ?",
      )
      .bind(key)
      .first<{ id: string }>()) !== null
  );
}

async function expireRun(
  database: D1Database,
  runId: string,
  terminalAt: string,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `UPDATE ingestion_runs
        SET state = 'expired', terminal_at = ?
        WHERE id = ? AND state = 'awaiting_approval'`,
      )
      .bind(terminalAt, runId),
    database
      .prepare(
        `UPDATE operation_state
        SET active_ingestion_run_id = NULL
        WHERE singleton = 1 AND active_ingestion_run_id = ?`,
      )
      .bind(runId),
  ]);
}

async function failRun(
  database: D1Database,
  runId: string,
  terminalAt: string,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `UPDATE ingestion_runs
        SET state = 'failed', terminal_at = ?
        WHERE id = ? AND state IN ('awaiting_approval', 'publishing')`,
      )
      .bind(terminalAt, runId),
    database
      .prepare(
        `UPDATE operation_state
        SET active_ingestion_run_id = NULL
        WHERE singleton = 1 AND active_ingestion_run_id = ?`,
      )
      .bind(runId),
  ]);
}

function parseCandidate(row: RunRow): FixtureCandidate {
  return JSON.parse(row.candidate_json) as FixtureCandidate;
}

function publicRun(row: RunRow): Record<string, unknown> {
  return {
    id: row.id,
    state: row.state,
    selected_games: JSON.parse(row.selected_games_json),
    started_at: row.started_at,
    expected_current_revision_id: row.expected_current_revision_id,
    linked_run_id: row.linked_run_id,
    idempotency_key: row.idempotency_key,
    candidate_digest: row.candidate_digest,
    candidate_created_at: row.candidate_created_at,
    approval_deadline: row.approval_deadline,
    approval:
      row.approval_json === null ? null : JSON.parse(row.approval_json),
    published_revision_id: row.published_revision_id,
    ...(row.export_manifest_digest === null
      ? {}
      : { export_manifest_digest: row.export_manifest_digest }),
    terminal_at: row.terminal_at,
  };
}

function assertOpaqueId(value: string, field: string): void {
  if (
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      `${field} is not a valid opaque identity.`,
    );
  }
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      `${field} is not a lower-case SHA-256 digest.`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
