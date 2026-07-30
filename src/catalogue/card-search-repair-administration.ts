import {
  repairCardSearchMaterialization,
  type CardSearchRepairResult,
} from "./card-search-materialization";
import { AdministrationProblem } from "./ingestion";
import { canonicalJson } from "./serialization";
import { assertIdentifier } from "./source-evidence-model";

type SearchRepairRequestRow = {
  idempotency_key: string;
  target_revision_id: string;
  expected_current_revision_id: string;
  request_json: string;
  result_json: string | null;
  claim_token: string | null;
  claim_expires_at: string | null;
};

export async function runGuardedCardSearchRepair(
  database: D1Database,
  input: {
    target_revision_id: string;
    expected_current_revision_id: string;
    idempotency_key: string;
  },
  observedAt = new Date().toISOString(),
): Promise<CardSearchRepairResult> {
  assertIdentifier(input.target_revision_id, "target_revision_id");
  assertIdentifier(
    input.expected_current_revision_id,
    "expected_current_revision_id",
  );
  assertIdentifier(input.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson(input);
  const replay = await searchRepairRequest(
    database,
    input.idempotency_key,
  );
  if (replay !== null) {
    assertExactRepairReplay(replay, requestJson);
    if (replay.result_json !== null) {
      return parseRepairResult(replay.result_json);
    }
  } else {
    const target = await database
      .prepare(
        `WITH RECURSIVE retained(revision_id, depth) AS (
           SELECT state.current_revision_id, 0
           FROM catalogue_state AS state
           WHERE state.singleton = 1
           UNION ALL
           SELECT revision.expected_previous_revision_id,
                  retained.depth + 1
           FROM retained
           JOIN catalogue_revisions AS revision
             ON revision.id = retained.revision_id
           WHERE retained.depth < 2
         )
         SELECT state.current_revision_id,
                EXISTS (
                  SELECT 1 FROM catalogue_revisions AS revision
                  WHERE revision.id = ?
                ) AS target_exists,
                EXISTS (
                  SELECT 1 FROM retained
                  WHERE revision_id = ?
                ) AS target_retained
         FROM catalogue_state AS state
         WHERE state.singleton = 1`,
      )
      .bind(input.target_revision_id, input.target_revision_id)
      .first<{
        current_revision_id: string;
        target_exists: number;
        target_retained: number;
      }>();
    if (
      target === null ||
      (
        target.target_exists !== 1 &&
        target.current_revision_id !== input.target_revision_id
      )
    ) {
      throw new AdministrationProblem(
        404,
        "catalogue_revision_not_found",
        "The target Catalogue Revision does not exist.",
      );
    }
    if (
      target.current_revision_id !== input.expected_current_revision_id
    ) {
      throw new AdministrationProblem(
        409,
        "current_revision_mismatch",
        "The expected current Catalogue Revision is stale.",
      );
    }
    if (target.target_retained !== 1) {
      throw new AdministrationProblem(
        409,
        "catalogue_revision_not_repairable",
        "Card search repair is limited to the current Catalogue Revision and its two immediate predecessors.",
      );
    }
    await database
      .prepare(
        `INSERT OR IGNORE INTO catalogue_search_repair_requests (
           idempotency_key, target_revision_id,
           expected_current_revision_id, request_json, result_json
         ) VALUES (?, ?, ?, ?, NULL)`,
      )
      .bind(
        input.idempotency_key,
        input.target_revision_id,
        input.expected_current_revision_id,
        requestJson,
      )
      .run();
    const stored = await searchRepairRequest(
      database,
      input.idempotency_key,
    );
    if (stored === null) {
      throw new Error("The Card search repair request was not retained.");
    }
    assertExactRepairReplay(stored, requestJson);
    if (stored.result_json !== null) {
      return parseRepairResult(stored.result_json);
    }
  }

  const claimToken = crypto.randomUUID();
  const claimExpiresAt = new Date(
    Date.parse(observedAt) + 2 * 60 * 1_000,
  ).toISOString();
  const claim = await database
    .prepare(
      `UPDATE catalogue_search_repair_requests
       SET claim_token = ?, claim_expires_at = ?
       WHERE idempotency_key = ? AND result_json IS NULL
         AND (
           claim_token IS NULL
           OR claim_expires_at <= ?
         )
         AND EXISTS (
           SELECT 1
           FROM catalogue_state AS state
           WHERE state.singleton = 1
             AND state.current_revision_id =
                   catalogue_search_repair_requests.expected_current_revision_id
         )`,
    )
    .bind(
      claimToken,
      claimExpiresAt,
      input.idempotency_key,
      observedAt,
    )
    .run();
  if (claim.meta.changes !== 1) {
    const observed = await searchRepairRequest(
      database,
      input.idempotency_key,
    );
    if (observed?.result_json !== null && observed !== null) {
      return parseRepairResult(observed.result_json);
    }
    const current = await database
      .prepare(
        `SELECT current_revision_id
         FROM catalogue_state
         WHERE singleton = 1`,
      )
      .first<{ current_revision_id: string }>();
    if (
      current?.current_revision_id !==
        input.expected_current_revision_id
    ) {
      throw new AdministrationProblem(
        409,
        "current_revision_mismatch",
        "The expected current Catalogue Revision is stale.",
      );
    }
    throw new AdministrationProblem(
      409,
      "search_repair_in_progress",
      "The exact Card search repair request is already in progress.",
    );
  }
  let result: CardSearchRepairResult;
  try {
    result = await repairCardSearchMaterialization(database, {
      targetRevisionId: input.target_revision_id,
    });
  } catch (error) {
    await database
      .prepare(
        `UPDATE catalogue_search_repair_requests
         SET claim_token = NULL, claim_expires_at = NULL
         WHERE idempotency_key = ? AND claim_token = ?
           AND result_json IS NULL`,
      )
      .bind(input.idempotency_key, claimToken)
      .run();
    throw error;
  }
  const resultJson = canonicalJson(result);
  const completedUpdate = await database
    .prepare(
      `UPDATE catalogue_search_repair_requests
       SET result_json = ?, claim_token = NULL, claim_expires_at = NULL
       WHERE idempotency_key = ? AND result_json IS NULL
         AND claim_token = ?`,
    )
    .bind(resultJson, input.idempotency_key, claimToken)
    .run();
  if (completedUpdate.meta.changes !== 1) {
    throw new Error("The Card search repair claim was lost.");
  }
  const completed = await searchRepairRequest(
    database,
    input.idempotency_key,
  );
  if (completed?.result_json === null || completed === null) {
    throw new Error("The Card search repair result was not retained.");
  }
  return parseRepairResult(completed.result_json);
}

async function searchRepairRequest(
  database: D1Database,
  idempotencyKey: string,
): Promise<SearchRepairRequestRow | null> {
  return database
    .prepare(
      `SELECT idempotency_key, target_revision_id,
              expected_current_revision_id, request_json, result_json,
              claim_token, claim_expires_at
       FROM catalogue_search_repair_requests
       WHERE idempotency_key = ?`,
    )
    .bind(idempotencyKey)
    .first<SearchRepairRequestRow>();
}

function assertExactRepairReplay(
  stored: SearchRepairRequestRow,
  requestJson: string,
): void {
  if (stored.request_json !== requestJson) {
    throw new AdministrationProblem(
      409,
      "idempotency_conflict",
      "The search repair idempotency key is already bound to another request.",
    );
  }
}

function parseRepairResult(json: string): CardSearchRepairResult {
  const value: unknown = JSON.parse(json);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("contract" in value) ||
    value.contract !== "card-keepr-card-search-repair@1"
  ) {
    throw new Error("The retained Card search repair result is invalid.");
  }
  return value as CardSearchRepairResult;
}
