import { cardSearchChunks, cardSearchText } from "../read";
import type { CatalogueStore } from "../shared";
import {
  advanceCardSearchOffsetStatement,
  advanceCardSearchChunkOffsetStatement,
  appendRepairedCardSearchTextStatement,
  beginCardRepairStatement,
  cardRepairSourceDocumentStatement,
  completeCardSearchRepairStatement,
  completeSearchProjectionStatement,
  createCardQuerySummaryStatement,
  createPendingSearchProjectionStatement,
  insertRepairedCardSearchChunkStatement,
  nextCardToRepairStatement,
  pendingSearchProjectionStatement,
  revisionWithoutSearchProjectionStatement,
  searchRepairProgressStatement,
} from "./card-search-repair-repository";

type SearchableCard = {
  official_identity: { value: string };
  name: string;
  effective_rules_text?: string | null;
};

type PendingRevision = {
  catalogue_revision_id: string;
  repaired_through_card_id: string | null;
  repair_card_id: string | null;
  repair_search_offset: number;
  repair_term_offset: number;
};

type RevisionCardRow = {
  document_json: string;
};

export type CardSearchRepairResult = {
  contract: "card-keepr-card-search-repair@1";
  complete: boolean;
  processed_cards: number;
  revisions_available: number;
  maximum_bound_parameter_bytes: number;
};

const defaultMaximumBoundParameterBytes = 64 * 1024;
const maximumCardsPerInvocation = 25;
const maximumMaterializationEntriesPerBatch = 500;
const maximumInvocationDurationMilliseconds = 20_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

export async function repairCardSearchMaterialization(
  database: CatalogueStore,
  options: {
    limit?: number;
    maximumBoundParameterBytes?: number;
    targetRevisionId?: string;
  } = {},
): Promise<CardSearchRepairResult> {
  const limit = options.limit ?? maximumCardsPerInvocation;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumCardsPerInvocation) {
    throw new Error("Card search repair limit must be from 1 to 25 Cards.");
  }
  const maximumBoundParameterBytes = options.maximumBoundParameterBytes ?? defaultMaximumBoundParameterBytes;
  if (
    !Number.isInteger(maximumBoundParameterBytes) ||
    maximumBoundParameterBytes !== defaultMaximumBoundParameterBytes
  ) {
    throw new Error("Card search repair parameter bytes must be exactly 65536.");
  }
  const startedAt = Date.now();
  let processedCards = 0;
  let maximumObservedBoundParameterBytes = 0;
  let result: CardSearchRepairResult;
  do {
    result = await repairCardSearchMaterializationStep(database, {
      maximumBoundParameterBytes,
      targetRevisionId: options.targetRevisionId,
    });
    processedCards += result.processed_cards;
    maximumObservedBoundParameterBytes = Math.max(
      maximumObservedBoundParameterBytes,
      result.maximum_bound_parameter_bytes,
    );
  } while (
    !result.complete &&
    processedCards < limit &&
    Date.now() - startedAt < maximumInvocationDurationMilliseconds
  );
  return {
    ...result,
    processed_cards: processedCards,
    maximum_bound_parameter_bytes: maximumObservedBoundParameterBytes,
  };
}

async function repairCardSearchMaterializationStep(
  database: CatalogueStore,
  options: {
    maximumBoundParameterBytes: number;
    targetRevisionId?: string;
  },
): Promise<CardSearchRepairResult> {
  const maximumBoundParameterBytes = options.maximumBoundParameterBytes;
  const targetRevisionId = options.targetRevisionId;
  const revision = await pendingRevision(database, targetRevisionId);
  if (revision === null) {
    const missing = await revisionWithoutSearchProjectionStatement(database, targetRevisionId ?? null).first<{
      catalogue_revision_id: string;
    }>();
    if (missing === null) {
      return repairResult(database, 0, 0, targetRevisionId);
    }
    await createPendingSearchProjectionStatement(database, missing.catalogue_revision_id).run();
    return repairResult(database, 0, boundBytes(missing.catalogue_revision_id), targetRevisionId);
  }

  if (revision.repair_card_id === null) {
    const next = await nextCardToRepairStatement(database, {
      revisionId: revision.catalogue_revision_id,
      afterCardId: revision.repaired_through_card_id,
    }).first<{ card_id: string }>();
    if (next === null) {
      await completeSearchProjectionStatement(database, revision.catalogue_revision_id).run();
      return repairResult(database, 0, boundBytes(revision.catalogue_revision_id), targetRevisionId);
    }
    const claimed = await database.batch([
      createCardQuerySummaryStatement(database, { revisionId: revision.catalogue_revision_id, cardId: next.card_id }),
      beginCardRepairStatement(database, { cardId: next.card_id, revisionId: revision.catalogue_revision_id }),
    ]);
    assertCasBatch(claimed, [0, 1]);
    return repairResult(
      database,
      0,
      Math.max(
        boundBytes(revision.catalogue_revision_id, next.card_id),
        boundBytes(next.card_id, revision.catalogue_revision_id),
      ),
      targetRevisionId,
    );
  }

  const row = await cardRepairSourceDocumentStatement(database, {
    revisionId: revision.catalogue_revision_id,
    cardId: revision.repair_card_id,
  }).first<RevisionCardRow>();
  if (row === null) {
    throw new Error("The Card search repair source Card is unavailable.");
  }
  const searchText = cardSearchText(searchableCard(row.document_json));
  const searchBytes = encoder.encode(searchText);
  if (revision.repair_search_offset < searchBytes.byteLength) {
    const fixedBytes = boundBytes(revision.catalogue_revision_id, revision.repair_card_id);
    const chunk = utf8Chunk(searchBytes, revision.repair_search_offset, maximumBoundParameterBytes - fixedBytes);
    const nextOffset = revision.repair_search_offset + encoder.encode(chunk).byteLength;
    const measured = Math.max(
      boundBytes(chunk, revision.catalogue_revision_id, revision.repair_card_id),
      boundBytes(nextOffset, revision.catalogue_revision_id, revision.repair_card_id),
    );
    if (measured > maximumBoundParameterBytes) {
      throw new Error("The Card search repair parameter bound was exceeded.");
    }
    const appended = await database.batch([
      appendRepairedCardSearchTextStatement(database, {
        chunk: chunk,
        revisionId: revision.catalogue_revision_id,
        cardId: revision.repair_card_id,
        expectedOffset: revision.repair_search_offset,
      }),
      advanceCardSearchOffsetStatement(database, {
        nextOffset: nextOffset,
        revisionId: revision.catalogue_revision_id,
        cardId: revision.repair_card_id,
        expectedOffset: revision.repair_search_offset,
      }),
    ]);
    assertCasPair(appended);
    return repairResult(database, 0, measured, targetRevisionId);
  }

  const entries = cardSearchChunks(searchText);
  if (revision.repair_term_offset < entries.length) {
    const selectedEntries = entries.slice(
      revision.repair_term_offset,
      revision.repair_term_offset + maximumMaterializationEntriesPerBatch,
    );
    const statements = selectedEntries.map((entry) => {
      const measured = boundBytes(entry.text, revision.catalogue_revision_id, revision.repair_card_id!);
      if (measured > maximumBoundParameterBytes) {
        throw new Error("The Card search repair parameter bound was exceeded.");
      }
      return insertRepairedCardSearchChunkStatement(database, {
        revisionId: revision.catalogue_revision_id,
        cardId: revision.repair_card_id,
        fieldOrdinal: entry.field,
        chunkOrdinal: entry.ordinal,
        searchText: entry.text,
      });
    });
    const nextOffset = revision.repair_term_offset + selectedEntries.length;
    statements.push(
      advanceCardSearchChunkOffsetStatement(database, {
        nextOffset: nextOffset,
        revisionId: revision.catalogue_revision_id,
        cardId: revision.repair_card_id,
        expectedOffset: revision.repair_term_offset,
      }),
    );
    const inserted = await database.batch(statements);
    const offsetResult = inserted.at(-1);
    if (offsetResult === undefined || (offsetResult.meta.changes !== 0 && offsetResult.meta.changes !== 1)) {
      throw new Error("The Card search repair chunk offset CAS is invalid.");
    }
    return repairResult(
      database,
      0,
      Math.max(
        ...selectedEntries.map((entry) =>
          boundBytes(entry.text, revision.catalogue_revision_id, revision.repair_card_id!),
        ),
        boundBytes(nextOffset, revision.catalogue_revision_id, revision.repair_card_id),
      ),
      targetRevisionId,
    );
  }

  const completedCard = await completeCardSearchRepairStatement(database, {
    revisionId: revision.catalogue_revision_id,
    cardId: revision.repair_card_id,
    expectedSearchBytes: searchBytes.byteLength,
    expectedChunkCount: entries.length,
  }).run();
  if (completedCard.meta.changes !== 0 && completedCard.meta.changes !== 1) {
    throw new Error("The Card search repair completion CAS is invalid.");
  }
  return repairResult(
    database,
    completedCard.meta.changes,
    boundBytes(revision.catalogue_revision_id, revision.repair_card_id),
    targetRevisionId,
  );
}

function searchableCard(documentJson: string): SearchableCard {
  const parsed: unknown = JSON.parse(documentJson);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The Card search repair source Card is invalid.");
  }
  const document = parsed as Record<string, unknown>;
  const data = document.data;
  return (data !== null && typeof data === "object" && !Array.isArray(data) ? data : document) as SearchableCard;
}

async function pendingRevision(database: CatalogueStore, targetRevisionId?: string): Promise<PendingRevision | null> {
  return pendingSearchProjectionStatement(database, targetRevisionId ?? null).first<PendingRevision>();
}

async function repairResult(
  database: CatalogueStore,
  processedCards: number,
  maximumBoundParameterBytes: number,
  targetRevisionId?: string,
): Promise<CardSearchRepairResult> {
  const counts = await searchRepairProgressStatement(database, targetRevisionId ?? null).first<{
    pending: number | null;
    available: number | null;
    missing: number;
  }>();
  return {
    contract: "card-keepr-card-search-repair@1",
    complete: (counts?.pending ?? 0) === 0 && (counts?.missing ?? 0) === 0,
    processed_cards: processedCards,
    revisions_available: counts?.available ?? 0,
    maximum_bound_parameter_bytes: maximumBoundParameterBytes,
  };
}

function boundBytes(...values: readonly (string | number)[]): number {
  return values.reduce<number>((total, value) => total + encoder.encode(String(value)).byteLength, 0);
}

function assertCasPair(results: readonly D1Result<unknown>[]): void {
  if (results.length !== 2) {
    throw new Error("The Card search repair CAS result is invalid.");
  }
  const changes = results.map((result) => result.meta.changes);
  if (
    (changes[0] !== 0 && changes[0] !== 1) ||
    (changes[1] !== 0 && changes[1] !== 1) ||
    (changes[0] === 1 && changes[1] === 0)
  ) {
    throw new Error("The Card search repair offset CAS was not atomic.");
  }
}

function assertCasBatch(results: readonly D1Result<unknown>[], allowedChanges: readonly number[]): void {
  if (results.some((result) => !allowedChanges.includes(result.meta.changes))) {
    throw new Error("The Card search repair claim CAS is invalid.");
  }
}

function utf8Chunk(bytes: Uint8Array, offset: number, maximumBytes: number): string {
  if (maximumBytes < 1) {
    throw new Error("The Card search repair parameter bound is too small.");
  }
  let end = Math.min(bytes.byteLength, offset + maximumBytes);
  while (end > offset) {
    try {
      return decoder.decode(bytes.slice(offset, end));
    } catch {
      end -= 1;
    }
  }
  throw new Error("The Card search repair could not make bounded progress.");
}
