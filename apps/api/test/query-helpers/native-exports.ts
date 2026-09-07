import { canonicalJson, sha256Text } from "../../../../src/catalogue/shared";

/** Read-only route fixture. Publication and recovery ownership are exercised by
 * native ingestion/acceptance tests, not simulated as end-to-end proof here. */
export async function seedNativeExportReadFacts(
  db: D1Database,
  bucket: R2Bucket,
  input: {
    revisionId: string;
    runId: string;
    publishedAt: string;
    components?: { descriptor: Record<string, unknown>; objectKey: string }[];
  },
) {
  const candidate = `candidate_${input.revisionId}`,
    operation = `publication_${input.revisionId}`,
    preparation = `preparation_${input.revisionId}`;
  const root = "a".repeat(64),
    publicRoot = "c".repeat(64);
  const content = canonicalJson({
    contract: "card-keepr-prepared-publication-composition@1",
    games: [{ supported_game: "gundam", candidate_id: candidate, root_digest: root, public_root_digest: publicRoot }],
  });
  const digest = await sha256Text(content);
  const key = `catalogue-public-manifests/${input.revisionId}/${digest}.json`;
  await bucket.put(key, content);
  await db.batch([
    db
      .prepare(
        `INSERT INTO reconciliation_operations(id,ingestion_run_id,supported_game,expected_game_revision_id,state,created_at,deadline,definition_pins_json,observation_cutoff,identity_decision_cutoff,authority_decision_cutoff) VALUES (?,?,'gundam','catrev_spine_000','sealed',?,?,'{}',0,0,0)`,
      )
      .bind(preparation, input.runId, input.publishedAt, input.publishedAt),
    db
      .prepare(
        `INSERT INTO game_candidates(id,preparation_id,ingestion_run_id,supported_game,expected_game_revision_id,created_at,deadline,state,generation,manifest_digest) VALUES (?,?,?,'gundam','catrev_spine_000',?,?,'published',0,?)`,
      )
      .bind(candidate, preparation, input.runId, input.publishedAt, input.publishedAt, root),
    db
      .prepare(
        `INSERT INTO game_publication_operations(id,candidate_id,manifest_digest,expected_game_revision_id,candidate_generation,deadline,approved_at,inspection_receipt,idempotency_key,request_json,approval_json,state,resulting_revision_id,published_at) VALUES (?,?,?,'catrev_spine_000',0,?,?,?,?,'{}','{}','published',?,?)`,
      )
      .bind(
        operation,
        candidate,
        root,
        input.publishedAt,
        input.publishedAt,
        root,
        operation,
        input.revisionId,
        input.publishedAt,
      ),
    db
      .prepare("UPDATE catalogue_revisions SET publication_operation_id=?,content_digest=?,published_at=? WHERE id=?")
      .bind(operation, digest, input.publishedAt, input.revisionId),
    db
      .prepare("INSERT INTO catalogue_composition_games VALUES (?,'gundam',?,?,?)")
      .bind(input.revisionId, candidate, input.revisionId, root),
    db
      .prepare("INSERT INTO publication_export_preparations VALUES (?,?,?,'verified',1,'{}',?,?,?,1,NULL)")
      .bind(
        operation,
        candidate,
        input.revisionId,
        input.components?.length ?? 0,
        publicRoot,
        `publication-artifacts/${publicRoot}`,
      ),
    db
      .prepare(
        "INSERT INTO catalogue_exports(catalogue_revision_id,manifest_key,manifest_digest,verified) VALUES (?,?,?,1)",
      )
      .bind(input.revisionId, key, digest),
    ...(input.components ?? []).map(({ descriptor, objectKey }, ordinal) =>
      db
        .prepare("INSERT INTO publication_export_components VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(
          candidate,
          ordinal,
          descriptor.kind,
          `record_${ordinal}`,
          root,
          objectKey,
          descriptor.compressed_sha256,
          descriptor.compressed_bytes,
          canonicalJson(descriptor),
        ),
    ),
  ]);
  return { key, digest };
}
