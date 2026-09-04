import { repairCardSearchMaterialization, type CardSearchRepairResult } from "./card-search-materialization";
import { repairableCatalogueRevisionTarget } from "./catalogue-revision-retention";
import { AdministrationProblem, replayByDigest, canonicalJson } from "../shared";
import { assertIdentifier } from "../source-evidence/index";

type SearchRepairRequestRow = {
  idempotency_key: string;
  target_revision_id: string;
  expected_current_revision_id: string;
  request_json: string;
  result_json: string | null;
  claim_token: string | null;
  claim_expires_at: string | null;
};

const maximumSearchRepairSourceBytes = 64 * 1024;

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
  assertIdentifier(input.expected_current_revision_id, "expected_current_revision_id");
  assertIdentifier(input.idempotency_key, "idempotency_key");
  const requestJson = canonicalJson(input);
  const replay = await searchRepairReplay(database, input.idempotency_key, requestJson);
  if (replay !== null) {
    if (replay.result_json !== null) {
      const result = parseRepairResult(replay.result_json);
      if (result.complete) return result;
    }
    await assertRepairSourceBound(database, input.target_revision_id);
  } else {
    const target = await repairableCatalogueRevisionTarget(database, input.target_revision_id);
    if (target === null || (target.target_exists !== 1 && target.current_revision_id !== input.target_revision_id)) {
      throw new AdministrationProblem(
        404,
        "catalogue_revision_not_found",
        "The target Catalogue Revision does not exist.",
      );
    }
    if (target.current_revision_id !== input.expected_current_revision_id) {
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
    await assertRepairSourceBound(database, input.target_revision_id);
    await database
      .prepare(
        `INSERT OR IGNORE INTO catalogue_search_repair_requests (
           idempotency_key, target_revision_id,
           expected_current_revision_id, request_json, result_json
         ) VALUES (?, ?, ?, ?, NULL)`,
      )
      .bind(input.idempotency_key, input.target_revision_id, input.expected_current_revision_id, requestJson)
      .run();
    const stored = await searchRepairReplay(database, input.idempotency_key, requestJson);
    if (stored === null) {
      throw new Error("The Card search repair request was not retained.");
    }
    if (stored.result_json !== null) {
      const result = parseRepairResult(stored.result_json);
      if (result.complete) return result;
    }
  }

  const claimToken = crypto.randomUUID();
  const claimExpiresAt = new Date(Date.parse(observedAt) + 2 * 60 * 1_000).toISOString();
  const claim = await database
    .prepare(
      `UPDATE catalogue_search_repair_requests
       SET claim_token = ?, claim_expires_at = ?
       WHERE idempotency_key = ?
         AND (
           result_json IS NULL
           OR json_extract(result_json, '$.complete') = 0
         )
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
    .bind(claimToken, claimExpiresAt, input.idempotency_key, observedAt)
    .run();
  if (claim.meta.changes !== 1) {
    const observed = await searchRepairRequest(database, input.idempotency_key);
    if (observed?.result_json !== null && observed !== null) {
      const result = parseRepairResult(observed.result_json);
      if (result.complete) return result;
    }
    const current = await database
      .prepare(
        `SELECT current_revision_id
         FROM catalogue_state
         WHERE singleton = 1`,
      )
      .first<{ current_revision_id: string }>();
    if (current?.current_revision_id !== input.expected_current_revision_id) {
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
           AND (
             result_json IS NULL
             OR json_extract(result_json, '$.complete') = 0
           )`,
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
       WHERE idempotency_key = ? AND claim_token = ?
         AND (
           result_json IS NULL
           OR json_extract(result_json, '$.complete') = 0
         )`,
    )
    .bind(resultJson, input.idempotency_key, claimToken)
    .run();
  if (completedUpdate.meta.changes !== 1) {
    throw new Error("The Card search repair claim was lost.");
  }
  const completed = await searchRepairRequest(database, input.idempotency_key);
  if (completed?.result_json === null || completed === null) {
    throw new Error("The Card search repair result was not retained.");
  }
  return parseRepairResult(completed.result_json);
}

async function assertRepairSourceBound(database: D1Database, targetRevisionId: string): Promise<void> {
  const oversized = await database
    .prepare(
      `SELECT card_id
       FROM revision_cards
       WHERE catalogue_revision_id = ?
         AND length(CAST(document_json AS BLOB)) > ?
       ORDER BY card_id
       LIMIT 1`,
    )
    .bind(targetRevisionId, maximumSearchRepairSourceBytes)
    .first<{ card_id: string }>();
  if (oversized !== null) {
    throw new AdministrationProblem(
      422,
      "catalogue_search_repair_source_too_large",
      "A retained Card exceeds the durable 65536-byte search repair source bound.",
    );
  }
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

// The retained fingerprint is the canonical request itself rather than a
// digest of it, so the comparison is exact-JSON equality.
function searchRepairReplay(
  database: D1Database,
  idempotencyKey: string,
  requestJson: string,
): Promise<SearchRepairRequestRow | null> {
  return replayByDigest({
    lookup: () => searchRepairRequest(database, idempotencyKey),
    retainedDigest: (retained) => retained.request_json,
    requestDigest: requestJson,
    conflictDetail: "The search repair idempotency key is already bound to another request.",
  });
}

function parseRepairResult(json: string): CardSearchRepairResult {
  const value: unknown = JSON.parse(json);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("contract" in value) ||
    value.contract !== "card-keepr-card-search-repair@1" ||
    !("complete" in value) ||
    typeof value.complete !== "boolean"
  ) {
    throw new Error("The retained Card search repair result is invalid.");
  }
  return value as CardSearchRepairResult;
}
