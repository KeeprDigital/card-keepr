import {
  NativeSourceHistory,
  type SourceHistoryPosition,
} from "../../../src/catalogue/reconciliation/native-source-history-state";
import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import { publicationCheckpointStatement } from "../../../src/catalogue/reconciliation/game-publication-repository";
import { verifyCompositionArtifacts } from "../../../src/catalogue/backup-recovery/composition-artifacts";
import type { CompositionSnapshotEvidence } from "../../../src/catalogue/backup-recovery/composition-verification";
import { reconciliationCheckpoint } from "../../../src/catalogue/reconciliation/reconciliation-checkpoint";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import {
  approveNoChangeWithoutDispatch,
  assertVerifiedBackup,
  verifyNativeBackup,
  readNativeCards,
} from "./native-no-change-helpers";
import {
  acceptedPrivateRoot,
  nativeBackupIdentity,
  nativeCandidatePredecessor,
  nativeNoChangeState,
  rejectedUnchangedPublication,
} from "./query-helpers/native-no-change";
import {
  collect,
  exportComponentRecords,
  exportManifest,
  get,
  installReconciliationSuite,
  post,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";

installReconciliationSuite();

async function prepared(path: string, key: string, revision: string) {
  const source = await collect(path, key);
  return prepareNativeCandidate(source.id, "one-piece", revision, `${key}-prepare`);
}

test("same-revision acceptance requires its exact restored backup, preserves approval guards and permits a fresh manual backup", async () => {
  const first = await prepared("/reconciliation/repeatable", "nochange-backup-first", "catrev_spine_000");
  const published = await approveNativeCandidate(first, "nochange-backup-publish");
  const revision = requiredString(published.document, "resulting_revision_id");
  const second = await prepared("/reconciliation/repeatable", "nochange-backup-second", revision);
  const { operation, intent } = await approveNoChangeWithoutDispatch(second, "nochange-backup-approval");
  const before = (await nativeNoChangeState(testEnv.CATALOGUE_DB))!;
  const transaction = {
    id: requiredString(operation, "id"),
    generation: 0,
    predecessor: revision,
    revision,
    composition: before.content_digest,
    backup: "backup_rejected_unchanged",
    at: new Date().toISOString(),
  };
  for (const [change, code] of [
    [{ generation: 9 }, "publication_writer_conflict"],
    [{ clockOffsetMs: 8 * 86400000 }, "publication_deadline_expired"],
    [{ predecessor: "catrev_missing" }, "publication_composition_conflict"],
  ] as const) {
    await expect(rejectedUnchangedPublication(testEnv.CATALOGUE_DB, { ...transaction, ...change })).rejects.toThrow(
      code,
    );
    expect(await nativeNoChangeState(testEnv.CATALOGUE_DB)).toEqual(before);
  }
  expect((await post("/v1/publications", { ...intent, manifest_digest: "0".repeat(64) })).response.status).toBe(409);
  const accepted = await post(`/v1/publications/${operation.id}/advance`, { generation: 0 });
  expect(accepted.document).toMatchObject({ state: "published", resulting_revision_id: revision });
  expect((await post(`/v1/publications/${operation.id}/advance`, { generation: 0 })).document).toEqual(
    accepted.document,
  );
  expect((await post("/v1/publications", intent)).document.id).toBe(operation.id);
  const after = (await nativeNoChangeState(testEnv.CATALOGUE_DB))!;
  expect(after).toMatchObject({ ...before, accepted_candidate: second.id, acceptance_operation: operation.id });
  const checkpoint = () =>
    publicationCheckpointStatement(catalogueStore(testEnv.CATALOGUE_DB), revision).first<{ ready: number }>();
  expect((await checkpoint())!.ready).toBe(0);
  const third = await prepareNativeCandidate(
    String(second.ingestion_run_id),
    "one-piece",
    revision,
    "nochange-backup-third",
  );
  expect(await nativeCandidatePredecessor(testEnv.CATALOGUE_DB, String(third.id))).toBe(second.id);
  const waiting = await approveNoChangeWithoutDispatch(third, "nochange-backup-waiting");
  expect((await post(`/v1/publications/${waiting.operation.id}/advance`, { generation: 0 })).document.state).toBe(
    "waiting_backup",
  );

  const root = await acceptedPrivateRoot(testEnv.CATALOGUE_DB, String(second.id));
  const missingAcceptedRoot = new Proxy(testEnv.CATALOGUE_EXPORTS, {
    get(target, property) {
      if (property === "get")
        return (...args: Parameters<R2Bucket["get"]>) =>
          args[0] === `publication-artifacts/${root}` ? Promise.resolve(null) : target.get(...args);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const reserved = requiredString(accepted.document, "backup_attempt_id");
  await expect(verifyNativeBackup(reserved, revision, missingAcceptedRoot)).rejects.toThrow(
    "Publication root is unavailable",
  );
  const failed = (await get(`/v1/backups/${reserved}`)).document;
  expect(failed.state).toBe("failed");
  expect((await checkpoint())!.ready, "an older verified backup cannot authorize the accepted refresh").toBe(0);
  expect((await post(`/v1/publications/${waiting.operation.id}/advance`, { generation: 0 })).document.state).toBe(
    "waiting_backup",
  );
  await verifyNativeBackup("nochange-exact-retry", revision, testEnv.CATALOGUE_EXPORTS, {
    id: reserved,
    digest: requiredString(failed, "attempt_digest"),
  });
  await assertVerifiedBackup("nochange-exact-retry");
  expect(await nativeBackupIdentity(testEnv.CATALOGUE_DB, "nochange-exact-retry")).toMatchObject({
    state: "verified",
    publication_operation_id: operation.id,
    linked_attempt_id: reserved,
    publication_reserved: 0,
  });
  expect((await checkpoint())!.ready).toBe(1);
  const final = await post(`/v1/publications/${waiting.operation.id}/advance`, { generation: 0 });
  expect(final.document).toMatchObject({ state: "published", resulting_revision_id: revision });
  await verifyNativeBackup(requiredString(final.document, "backup_attempt_id"), revision);
  await verifyNativeBackup("nochange-manual-fresh", revision);
  await assertVerifiedBackup("nochange-manual-fresh");
  expect(await nativeBackupIdentity(testEnv.CATALOGUE_DB, "nochange-manual-fresh")).toMatchObject({
    state: "verified",
    publication_operation_id: waiting.operation.id,
    linked_attempt_id: null,
    publication_reserved: 0,
  });
}, 120_000);

test("nonempty owner corrections remain semantic changes and their repeated accepted facts reuse the revision", async () => {
  const source = "/reconciliation/card-without-printing";
  const first = await prepared(source, "nochange-correction-first", "catrev_spine_000");
  const initial = await approveNativeCandidate(first, "nochange-correction-initial");
  let revision = requiredString(initial.document, "resulting_revision_id");
  const original = (await exportComponentRecords(revision, "cards"))[0]!;
  const proposal = await post("/v1/entity-proposals", {
    game: "one-piece",
    source_lineage: "owner",
    reference: "nochange-synthetic-duplicate",
    content: {
      card: {
        ...original,
        id: undefined,
        type: undefined,
        lifecycle: undefined,
        official_identity: { kind: "unknown", value: null },
      },
    },
    evidence: { attestation: "Synthetic duplicate inspected by the owner" },
    idempotency_key: "nochange-duplicate-proposal",
  });
  expect(proposal.response.status, JSON.stringify(proposal.document)).toBe(201);
  const admission = await post(`/v1/entity-proposals/${proposal.document.id}/decisions`, {
    action: "admit",
    expected_generation: "0",
    rationale: "Synthetic initially distinct identity",
    idempotency_key: "nochange-duplicate-admit",
  });
  expect(admission.response.status, JSON.stringify(admission.document)).toBe(200);
  const duplicate = (admission.document.history as { decision: { card: { id: string } } }[])[0]!.decision.card.id;
  const added = await prepared(source, "nochange-correction-added", revision);
  const withDuplicate = await approveNativeCandidate(added, "nochange-correction-duplicate");
  revision = requiredString(withDuplicate.document, "resulting_revision_id");
  const unchanged = await prepared(source, "nochange-correction-before", revision);
  expect(
    (await approveNativeCandidate(unchanged, "nochange-correction-before-publish")).document.resulting_revision_id,
  ).toBe(revision);
  const before = await reconciliationCheckpoint<{ digest: string }>(
    catalogueStore(testEnv.CATALOGUE_DB),
    String(unchanged.id),
    "canonical_digest:catalogue",
  );
  const correction = {
    game: "one-piece",
    entity_kind: "card",
    action: "merge",
    source_ids: [duplicate],
    replacement_ids: [original.id],
    printing_assignments: {},
    expected_current_revision_id: revision,
    rationale: "Owner establishes the same rules-level Card",
    evidence: { attestation: "Synthetic comparison of both retained identities" },
  };
  const validated = await post("/v1/identity-corrections/validate", correction);
  expect(validated.response.status, JSON.stringify(validated.document)).toBe(200);
  const decided = await post("/v1/identity-corrections", {
    ...correction,
    review_digest: validated.document.review_digest,
    idempotency_key: "nochange-owner-merge",
  });
  expect(decided.response.status, JSON.stringify(decided.document)).toBe(201);
  const corrected = await prepared(source, "nochange-correction-after", revision);
  const after = await reconciliationCheckpoint<{ digest: string }>(
    catalogueStore(testEnv.CATALOGUE_DB),
    String(corrected.id),
    "canonical_digest:catalogue",
  );
  expect(after!.value.digest).not.toBe(before!.value.digest);
  const changed = await approveNativeCandidate(corrected, "nochange-correction-after-publish");
  const current = requiredString(changed.document, "resulting_revision_id");
  expect(current).not.toBe(revision);
  expect(await exportComponentRecords(current, "identity-corrections")).toEqual([
    expect.objectContaining({ id: duplicate, action: "merge", replacement_ids: [original.id] }),
  ]);
  expect(await exportComponentRecords(current, "cards")).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: duplicate })]),
  );
  expect(await exportComponentRecords(revision, "cards")).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: duplicate })]),
  );
  const repeated = await prepared(source, "nochange-correction-repeat", current);
  expect(
    (await approveNativeCandidate(repeated, "nochange-correction-repeat-publish")).document.resulting_revision_id,
  ).toBe(current);
}, 120_000);

test("changed successors preserve current-plus-two queryability and historical recovery uses captured accepted roots", async () => {
  const first = await prepared("/reconciliation/semantic-evidence-base", "nochange-history-first", "catrev_spine_000");
  const firstPublication = await approveNativeCandidate(first, "nochange-history-publish");
  const initial = requiredString(firstPublication.document, "resulting_revision_id");
  const firstManifest = await exportManifest(initial);
  const firstPrintings = await exportComponentRecords(initial, "printings");
  const relocated = await prepared("/reconciliation/semantic-evidence-locator", "nochange-history-relocated", initial);
  const accepted = await approveNativeCandidate(relocated, "nochange-history-accept");
  expect(accepted.document.resulting_revision_id).toBe(initial);
  const backup = await assertVerifiedBackup(requiredString(accepted.document, "backup_attempt_id"));
  const object = await testEnv.BACKUPS.head(requiredString(backup, "object_key"));
  const retainedSnapshot = await testEnv.BACKUPS.get(object!.customMetadata!.snapshot_key!);
  const snapshot = await retainedSnapshot!.json<CompositionSnapshotEvidence>();
  expect(snapshot.accepted_evidence_roots).toEqual([expect.objectContaining({ candidate_id: relocated.id })]);
  expect(await exportManifest(initial)).toEqual(firstManifest);
  expect(await exportComponentRecords(initial, "printings")).toEqual(firstPrintings);
  const revisions = [initial];
  let revision = initial;
  for (const [index, path] of ["/reconciliation/base", "/reconciliation/repeatable"].entries()) {
    const candidate = await prepared(path, `nochange-history-changed-${index}`, revision);
    const changed = await approveNativeCandidate(candidate, `nochange-history-changed-publish-${index}`);
    const next = requiredString(changed.document, "resulting_revision_id");
    expect(next).not.toBe(revision);
    revisions.push(next);
    revision = next;
  }
  for (const retained of revisions) expect((await readNativeCards(retained)).status).toBe(200);
  const pending = await prepared("/reconciliation/repeatable", "nochange-history-pending", revision);
  const pendingApproval = await approveNoChangeWithoutDispatch(pending, "nochange-history-pending-approval");
  const beforeOtherGame = (await nativeNoChangeState(testEnv.CATALOGUE_DB))!;
  const source = await collect("/reconciliation/profile-fusion-world", "nochange-history-fusion", {
    game: "fusion-world",
    lineage: "fusion-world-en",
    adapter: "fixture-fusion-world-json@2",
  });
  const fusion = await prepareNativeCandidate(
    source.id,
    "fusion-world",
    "catrev_spine_000",
    "nochange-history-fusion-prepare",
  );
  const composed = await approveNativeCandidate(fusion, "nochange-history-fusion-publish");
  expect(composed.document.resulting_revision_id).not.toBe(revision);
  const afterOtherGame = (await nativeNoChangeState(testEnv.CATALOGUE_DB))!;
  await expect(
    rejectedUnchangedPublication(testEnv.CATALOGUE_DB, {
      id: String(pendingApproval.operation.id),
      generation: 0,
      predecessor: revision,
      revision,
      composition: beforeOtherGame.content_digest,
      backup: "backup_stale_composition",
      at: new Date().toISOString(),
    }),
  ).rejects.toThrow("publication_composition_conflict");
  expect(await nativeNoChangeState(testEnv.CATALOGUE_DB)).toEqual(afterOtherGame);
  const acceptedAfterContention = await post(`/v1/publications/${pendingApproval.operation.id}/advance`, {
    generation: 0,
  });
  expect(acceptedAfterContention.document).toMatchObject({
    state: "published",
    resulting_revision_id: composed.document.resulting_revision_id,
  });
  await verifyNativeBackup(
    requiredString(acceptedAfterContention.document, "backup_attempt_id"),
    String(composed.document.resulting_revision_id),
  );
  expect((await nativeNoChangeState(testEnv.CATALOGUE_DB))!.query_window).toBe(afterOtherGame.query_window);
  expect((await readNativeCards(initial)).status).toBe(503);
  for (const retained of revisions.slice(1)) expect((await readNativeCards(retained)).status).toBe(200);
  // This is the recovery artifact boundary: target backup evidence must not be replaced by current control heads.
  await verifyCompositionArtifacts(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.CATALOGUE_EXPORTS,
    testEnv.PRINTING_IMAGES,
    initial,
    snapshot,
  );
  await expect(
    verifyCompositionArtifacts(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.CATALOGUE_EXPORTS,
      testEnv.PRINTING_IMAGES,
      initial,
      { ...snapshot, accepted_evidence_roots: undefined },
    ),
  ).rejects.toThrow("Accepted private evidence snapshot is missing");
}, 120_000);

test("a game can prepare again after another game publishes and its own evidence is accepted unchanged", async () => {
  const first = await prepared("/reconciliation/repeatable", "cross-game-first", "catrev_spine_000");
  const firstPublished = await approveNativeCandidate(first, "cross-game-first-publish");
  const gameRevision = requiredString(firstPublished.document, "resulting_revision_id");
  const otherRun = await collect("/reconciliation/gundam-product-asia", "cross-game-other", {
    game: "gundam",
    lineage: "gundam-en-asia",
    adapter: "fixture-gundam-en-asia-json@2",
  });
  const other = await prepareNativeCandidate(otherRun.id, "gundam", "catrev_spine_000", "cross-game-other-prepare");
  const otherPublished = await approveNativeCandidate(other, "cross-game-other-publish");
  const composition = requiredString(otherPublished.document, "resulting_revision_id");
  expect(composition).not.toBe(gameRevision);
  const repeated = await prepared("/reconciliation/repeatable", "cross-game-repeated", gameRevision);
  const accepted = await approveNativeCandidate(repeated, "cross-game-repeated-publish");
  expect(accepted.document.resulting_revision_id).toBe(composition);
  const next = await prepared("/reconciliation/repeatable", "cross-game-next", gameRevision);
  expect(next.state).toBe("sealed");
  expect(await nativeCandidatePredecessor(testEnv.CATALOGUE_DB, String(next.id))).toBe(repeated.id);
  expect(
    (
      await post(`/v1/game-candidates/${next.id}/abandon`, {
        generation: next.generation,
        idempotency_key: "cross-game-next-abandon",
      })
    ).document.state,
  ).toBe("abandoned");
});

test("retained Printing history can cross the identity-match limit without losing observation evidence", async () => {
  const candidate = await prepared("/reconciliation/repeatable", "lifetime-history", "catrev_spine_000");
  const preparation = requiredString(candidate, "id");
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  const checkpoint = await reconciliationCheckpoint<{ sourceHistory: { history: SourceHistoryPosition } }>(
    database,
    preparation,
    "disappearance_warnings",
  );
  expect(checkpoint).not.toBeNull();
  const history = new NativeSourceHistory(database, preparation, checkpoint!.value.sourceHistory.history);
  for (let ordinal = 0; ordinal < 501; ordinal++)
    await history.retain({
      id: `lifetime-membership-${ordinal}`,
      kind: "membership",
      entityId: "lifetime-printing",
      cardId: "lifetime-card",
      sourceLineage: "one-piece-en",
      identity: { kind: "card_number", value: "LIFETIME-001" },
      relationshipKind: "product",
      relationshipValue: "lifetime-product",
      sourceObservationId: `observation-${ordinal}`,
      first: { candidate: preparation },
      last: { candidate: preparation },
      missing: null,
      current: true,
    });
  const retained = new NativeSourceHistory(database, preparation, history.cursor);
  const evidence = await retained.forEntity("printing", "lifetime-printing");
  expect(evidence).toHaveLength(501);
  expect(new Set(evidence.map((record) => record.sourceObservationId)).size).toBe(501);
  expect(await retained.forEntity("printing", "lifetime-printing", "locator")).toEqual([]);
});
