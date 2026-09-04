import {
  ingestionRunTransitionSql,
  byteBoundedJsonArrays,
  type CatalogueCandidate,
  guardedAtomicBatch,
  type SupportedGame,
} from "../shared";
import { publicationBackupReservation } from "../backup-recovery";
import { type BuiltCatalogueExport, distributionContextExportId } from "../export";
import { legalityPublicationStatements } from "../legality";
import { cardSearchChunks, cardSearchTerms, cardSearchText } from "../read";
import {
  type PublicationEvidenceResource,
  productReleasePublicationStatements,
  type ReconciliationPublicationPlan,
  reconciliationPublication,
  typedPrintingProjections,
} from "../reconciliation";
import { idempotencyCompletionStatements, replayAfterConflict } from "./administration-idempotency";
import { printingQueryProjectionStatements } from "./printing-query-materialization";
import { requiredCandidateCatalogueDigest } from "./publication-storage";
import { progressFor, publicRun } from "./run-document-codec";
import { freshnessStatementsForRun } from "./run-freshness";
import { releaseRunLockStatement, throwApprovalFailure } from "./run-storage";
import type { ApproveRunRequest, IdempotencyClaimOwner, RunRow } from "./run-types";
import { parseSelectedGames, requiredPublicationValue } from "./run-values";

export async function publishNoChange(
  database: D1Database,
  run: RunRow,
  request: ApproveRunRequest,
  requestJson: string,
  approval: Record<string, unknown>,
  now: string,
  claimOwner: IdempotencyClaimOwner,
  candidate: CatalogueCandidate,
): Promise<Record<string, unknown>> {
  const resultingRun = publicRun({
    ...run,
    state: "published",
    approval_json: JSON.stringify(approval),
    approval_idempotency_key: request.idempotency_key,
    approval_history_json: JSON.stringify([approval]),
    terminal_at: now,
    progress_json: JSON.stringify(progressFor("published")),
    publication_outcome: "no_change",
    resulting_revision_id: request.expected_current_revision_id,
    freshness_checked_at: now,
  });
  const reconciliation = await reconciliationPublication(database, run.id, request.expected_current_revision_id, now);
  const runFreshnessStatements = await freshnessStatementsForRun(
    database,
    parseSelectedGames(run.selected_games_json),
    run.id,
    candidate,
    now,
  );
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO ingestion_no_change_results (
            ingestion_run_id,
            catalogue_revision_id,
            candidate_digest,
            checked_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .bind(run.id, request.expected_current_revision_id, request.candidate_digest, now),
      database
        .prepare(
          `UPDATE ingestion_runs
          SET state = 'publishing',
              approval_json = ?,
              approval_idempotency_key = ?,
              approval_history_json = ?,
              progress_json = ?
          WHERE id = ? AND ${ingestionRunTransitionSql("awaiting_approval", "publishing")}`,
        )
        .bind(
          JSON.stringify(approval),
          request.idempotency_key,
          JSON.stringify([approval]),
          JSON.stringify(progressFor("publishing")),
          run.id,
        ),
      ...(reconciliation?.statements ?? []),
      ...runFreshnessStatements,
      database
        .prepare(
          `UPDATE ingestion_runs
          SET state = 'published',
              terminal_at = ?,
              progress_json = ?,
              publication_outcome = 'no_change',
              resulting_revision_id = ?,
              freshness_checked_at = ?
          WHERE id = ? AND ${ingestionRunTransitionSql("publishing", "published")}`,
        )
        .bind(now, JSON.stringify(progressFor("published")), request.expected_current_revision_id, now, run.id),
      releaseRunLockStatement(database, run.id),
      ...idempotencyCompletionStatements(database, {
        key: request.idempotency_key,
        operation: "approve_ingestion_run",
        requestJson,
        response: resultingRun,
        status: 200,
        createdAt: now,
        claimOwner,
      }),
    ]);
  } catch (error) {
    const concurrentReplay = await replayAfterConflict(
      database,
      request.idempotency_key,
      "approve_ingestion_run",
      requestJson,
      error,
    );
    if (concurrentReplay !== null) return concurrentReplay;
    await throwApprovalFailure(database, run, error, now);
  }
  return resultingRun;
}

function catalogueCard(
  card: CatalogueCandidate["cards"][number],
  printingIds: readonly string[],
  revisionId: string,
  reconciledLifecycle?: Record<string, unknown>,
  evidenceResources: readonly PublicationEvidenceResource[] = [],
  effectiveRulesEvidence: readonly PublicationEvidenceResource[] = [],
) {
  const data = {
    type: "card",
    ...card,
    printing_ids: printingIds,
    source_lineages: [...new Set(evidenceResources.map(({ source }) => source))].sort(),
    lifecycle: reconciledLifecycle ?? lifecycle(revisionId),
    links: {
      self: `/v1/cards/${card.id}`,
    },
  };
  const included = [
    ...new Map([...evidenceResources, ...effectiveRulesEvidence].map((resource) => [resource.id, resource])).values(),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const effectiveRulesObservationIds = [...new Set(effectiveRulesEvidence.map(({ id }) => id))].sort();
  return {
    data,
    included,
    provenance:
      effectiveRulesObservationIds.length === 0
        ? {}
        : {
            "/data/effective_rules_text": effectiveRulesObservationIds,
          },
    disagreements: [],
  };
}

async function cataloguePrinting(
  printing: CatalogueCandidate["printings"][number],
  game: SupportedGame,
  revisionId: string,
  reconciledLifecycle?: Record<string, unknown>,
  relationshipEvidence: readonly Record<string, unknown>[] = [],
  locatorEvidence: Record<string, unknown> = {
    current: [],
    historical: [],
  },
  declaredContexts: readonly NonNullable<CatalogueCandidate["distribution_contexts"]>[number][] = [],
  declaredProducts: readonly NonNullable<CatalogueCandidate["products"]>[number][] = [],
  declaredRelationships: readonly NonNullable<CatalogueCandidate["product_relationships"]>[number][] = [],
  evidenceResources: readonly {
    type: "source_observation";
    id: string;
    captured_at: string;
    source: string;
  }[] = [],
  printingImages: readonly NonNullable<CatalogueCandidate["printing_images"]>[number][] = [],
) {
  const canonicalRelationshipEvidence = relationshipEvidence.filter(
    (relationship) => relationship.relationship_kind !== "source_bucket",
  );
  const contexts = await Promise.all(
    canonicalRelationshipEvidence
      .filter(
        (relationship) => relationship.current === true && relationship.relationship_kind === "distribution_context",
      )
      .map(async (relationship) => {
        const declared = declaredContexts.find(
          (context) => context.game === game && context.key === String(relationship.relationship_value),
        );
        return (
          declared ?? {
            id: await distributionContextExportId(
              game,
              String(relationship.source_lineage),
              String(relationship.relationship_value),
            ),
            kind: "other" as const,
            label: String(relationship.relationship_value),
            product_id: null,
            evidence_category: "explicit" as const,
          }
        );
      }),
  );
  const typed = typedPrintingProjections(printing.id, declaredProducts, declaredContexts, declaredRelationships);
  const projectedContexts = [
    ...new Map([...contexts, ...typed.distribution_contexts].map((context) => [context.id, context])).values(),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const data = {
    type: "printing",
    ...printing,
    printing_images: printingImages.map(publicPrintingImage),
    products: typed.products,
    distribution_contexts: projectedContexts,
    relationship_evidence: canonicalRelationshipEvidence,
    locator_evidence: locatorEvidence,
    source_lineages: [...new Set(evidenceResources.map(({ source }) => source))].sort(),
    lifecycle: reconciledLifecycle ?? lifecycle(revisionId),
    links: {
      self: `/v1/printings/${printing.id}`,
    },
  };
  const included = [...new Map(evidenceResources.map((resource) => [resource.id, resource])).values()].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
  const observationIds = included.map(({ id }) => id);
  return {
    data,
    included,
    provenance:
      observationIds.length === 0
        ? {}
        : {
            "/data/rarity": observationIds,
            "/data/printed_rules_text": observationIds,
            "/data/game_data": observationIds,
          },
    disagreements: [],
  };
}

function publicPrintingImage(image: NonNullable<CatalogueCandidate["printing_images"]>[number]) {
  return {
    type: "printing_image",
    id: image.id,
    printing_id: image.printing_id,
    role: image.role,
    media_type: image.media_type,
    width: image.width,
    height: image.height,
    content_sha256: image.content_sha256,
    links: {
      self: `/v1/printing-images/${encodeURIComponent(image.id)}`,
      content: `/v1/printing-images/${encodeURIComponent(image.id)}/content`,
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

export async function commitVerifiedPublication(
  database: D1Database,
  input: {
    run: RunRow;
    candidate: CatalogueCandidate;
    catalogueExport: BuiltCatalogueExport;
    reconciliation: ReconciliationPublicationPlan | null;
    requestJson: string;
    completedAt: string;
    claimOwner?: IdempotencyClaimOwner;
  },
): Promise<Record<string, unknown>> {
  const revisionId = requiredPublicationValue(input.run.publication_revision_id, "revision ID");
  const publishedAt = requiredPublicationValue(input.run.publication_started_at, "start time");
  const idempotencyKey = requiredPublicationValue(input.run.approval_idempotency_key, "idempotency key");
  const manifestDigest = requiredPublicationValue(input.run.publication_manifest_digest, "manifest digest");
  const publicationBackup = await publicationBackupReservation(revisionId);
  if (
    input.catalogueExport.manifest.manifest_sha256 !== manifestDigest ||
    input.catalogueExport.manifestKey !== `catalogue-exports/${revisionId}/manifest.json`
  ) {
    throw new Error("Reserved Catalogue Export identity changed");
  }
  const resultingRun = publicRun({
    ...input.run,
    state: "published",
    published_revision_id: revisionId,
    export_manifest_digest: manifestDigest,
    terminal_at: input.completedAt,
    progress_json: JSON.stringify(progressFor("published")),
    publication_outcome: "revision",
    resulting_revision_id: revisionId,
    freshness_checked_at: input.completedAt,
  });
  const runFreshnessStatements = await freshnessStatementsForRun(
    database,
    parseSelectedGames(input.run.selected_games_json),
    input.run.id,
    input.candidate,
    input.completedAt,
  );
  const cardDocuments = input.candidate.cards.map((card) => {
    const document = catalogueCard(
      card,
      input.candidate.printings.filter((printing) => printing.card_id === card.id).map((printing) => printing.id),
      revisionId,
      input.reconciliation?.cardLifecycles[card.id],
      input.reconciliation?.cardEvidence[card.id] ?? [],
      input.reconciliation?.cardEffectiveRulesEvidence[card.id] ?? [],
    );
    return {
      card,
      document,
      summary: {
        type: document.data.type,
        id: document.data.id,
        game: document.data.game,
        official_identity: document.data.official_identity,
        name: document.data.name,
        game_data: document.data.game_data,
        lifecycle: document.data.lifecycle,
        links: document.data.links,
      },
      searchText: cardSearchText(document.data),
    };
  });
  const gamesByCardId = new Map(input.candidate.cards.map((card) => [card.id, card.game]));
  const printingDocuments = await Promise.all(
    input.candidate.printings.map(async (printing) => ({
      printing,
      document: await cataloguePrinting(
        printing,
        gamesByCardId.get(printing.card_id)!,
        revisionId,
        input.reconciliation?.printingLifecycles[printing.id],
        input.reconciliation?.relationshipEvidence[printing.id] ?? [],
        input.reconciliation?.locatorEvidence[printing.id] ?? {
          current: [],
          historical: [],
        },
        input.candidate.distribution_contexts ?? [],
        input.candidate.products ?? [],
        input.candidate.product_relationships ?? [],
        input.reconciliation?.printingEvidence[printing.id] ?? [],
        (input.candidate.printing_images ?? []).filter((image) => image.printing_id === printing.id),
      ),
    })),
  );
  const productReleaseStatements = productReleasePublicationStatements(database, input.candidate, revisionId, {
    products: input.reconciliation?.productLifecycles ?? {},
    releases:
      input.reconciliation?.releaseLifecycles ??
      Object.fromEntries(
        (input.candidate.products ?? []).flatMap((product) =>
          product.releases.map((release) => [
            release.id,
            {
              first_revision_id: revisionId,
              last_observed_revision_id: revisionId,
            },
          ]),
        ),
      ),
    relationships: input.reconciliation?.productRelationshipLifecycles ?? {},
  });
  const revisionCardStatements = byteBoundedJsonArrays(
    cardDocuments.map(({ card, document }) => ({
      card_id: card.id,
      document_json: JSON.stringify(document),
    })),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO revision_cards (
           catalogue_revision_id, card_id, document_json
         )
         SELECT ?, json_extract(value, '$.card_id'),
                json_extract(value, '$.document_json')
         FROM json_each(?)`,
      )
      .bind(revisionId, chunk),
  );
  const revisionCardQueryStatements = byteBoundedJsonArrays(
    cardDocuments.map(({ card, summary, searchText }) => ({
      card_id: card.id,
      summary_json: JSON.stringify(summary),
      search_text: searchText,
    })),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO revision_card_query_documents (
           catalogue_revision_id, card_id, summary_json, search_text
         )
         SELECT ?, json_extract(value, '$.card_id'),
                json_extract(value, '$.summary_json'),
                json_extract(value, '$.search_text')
         FROM json_each(?)`,
      )
      .bind(revisionId, chunk),
  );
  const revisionCardSearchStatements = byteBoundedJsonArrays(
    cardDocuments.flatMap(({ card, searchText }) =>
      cardSearchTerms(searchText).map((term) => ({
        card_id: card.id,
        term,
      })),
    ),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO revision_card_search_terms (
           catalogue_revision_id, card_id, term, sort_game,
           sort_identity_kind, sort_identity_value, sort_id
         )
         SELECT query.catalogue_revision_id, query.card_id,
                json_extract(term.value, '$.term'),
                query.sort_game, query.sort_identity_kind,
                query.sort_identity_value, query.sort_id
         FROM json_each(?) AS term
         JOIN revision_card_query_documents AS query
           ON query.catalogue_revision_id = ?
          AND query.card_id = json_extract(term.value, '$.card_id')`,
      )
      .bind(chunk, revisionId),
  );
  const revisionCardSearchChunkStatements = byteBoundedJsonArrays(
    cardDocuments.flatMap(({ card, searchText }) =>
      cardSearchChunks(searchText).map((chunk) => ({
        card_id: card.id,
        field_ordinal: chunk.field,
        chunk_ordinal: chunk.ordinal,
        search_text: chunk.text,
      })),
    ),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO revision_card_search_chunks (
           catalogue_revision_id, card_id, field_ordinal,
           chunk_ordinal, search_text
         )
         SELECT ?, json_extract(value, '$.card_id'),
                json_extract(value, '$.field_ordinal'),
                json_extract(value, '$.chunk_ordinal'),
                json_extract(value, '$.search_text')
         FROM json_each(?)`,
      )
      .bind(revisionId, chunk),
  );
  const revisionPrintingStatements = byteBoundedJsonArrays(
    printingDocuments.map(({ printing, document }) => ({
      printing_id: printing.id,
      card_id: printing.card_id,
      document_json: JSON.stringify(document),
    })),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO revision_printings (
           catalogue_revision_id, printing_id, card_id, document_json
         )
         SELECT ?, json_extract(value, '$.printing_id'),
                json_extract(value, '$.card_id'),
                json_extract(value, '$.document_json')
         FROM json_each(?)`,
      )
      .bind(revisionId, chunk),
  );
  const printingImageStatements = byteBoundedJsonArrays(
    (input.candidate.printing_images ?? []).map((image) => ({
      id: image.id,
      printing_id: image.printing_id,
      role: image.role,
      media_type: image.media_type,
      width: image.width,
      height: image.height,
      content_sha256: image.content_sha256,
      content_byte_length: image.content_byte_length,
      object_key: image.object_key,
    })),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO reconciled_printing_images (
           id, printing_id, role, media_type, width, height,
           content_sha256, content_byte_length, object_key
         )
         SELECT
           json_extract(value, '$.id'),
           json_extract(value, '$.printing_id'),
           json_extract(value, '$.role'),
           json_extract(value, '$.media_type'),
           json_extract(value, '$.width'),
           json_extract(value, '$.height'),
           json_extract(value, '$.content_sha256'),
           json_extract(value, '$.content_byte_length'),
           json_extract(value, '$.object_key')
         FROM json_each(?)
         WHERE true
         ON CONFLICT(id) DO UPDATE SET
           printing_id = excluded.printing_id,
           role = excluded.role,
           media_type = excluded.media_type,
           width = excluded.width,
           height = excluded.height,
           content_sha256 = excluded.content_sha256,
           content_byte_length = excluded.content_byte_length,
           object_key = excluded.object_key`,
      )
      .bind(chunk),
  );
  // The projection carries the content facts the api serves, so the read
  // cluster never joins reconciled_printing_images, the reconciliation
  // cluster's identity table (issue #98).
  const revisionPrintingImageStatements = byteBoundedJsonArrays(
    (input.candidate.printing_images ?? []).map((image) => ({
      image_id: image.id,
      printing_id: image.printing_id,
      media_type: image.media_type,
      content_sha256: image.content_sha256,
      content_byte_length: image.content_byte_length,
      object_key: image.object_key,
    })),
  ).map((chunk) =>
    database
      .prepare(
        `INSERT INTO revision_printing_images (
           catalogue_revision_id, image_id, printing_id,
           media_type, content_sha256, content_byte_length, object_key
         )
         SELECT ?,
           json_extract(value, '$.image_id'),
           json_extract(value, '$.printing_id'),
           json_extract(value, '$.media_type'),
           json_extract(value, '$.content_sha256'),
           json_extract(value, '$.content_byte_length'),
           json_extract(value, '$.object_key')
         FROM json_each(?)`,
      )
      .bind(revisionId, chunk),
  );
  const commitStatements = [
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
        input.run.id,
        publishedAt,
        requiredCandidateCatalogueDigest(input.run),
        input.run.expected_current_revision_id,
        input.run.candidate_digest,
      ),
    ...(input.reconciliation?.statements ?? []),
    ...legalityPublicationStatements(database, input.candidate, revisionId),
    ...revisionCardStatements,
    ...revisionCardQueryStatements,
    ...revisionCardSearchChunkStatements,
    ...revisionCardSearchStatements,
    database
      .prepare(
        `INSERT INTO catalogue_query_revisions (
           catalogue_revision_id, state, repaired_through_card_id
         ) VALUES (?, 'available', NULL)`,
      )
      .bind(revisionId),
    database
      .prepare(
        `WITH RECURSIVE retained(catalogue_revision_id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT revision.expected_previous_revision_id, retained.depth + 1
         FROM retained
         JOIN catalogue_revisions AS revision
           ON revision.id = retained.catalogue_revision_id
         WHERE retained.depth < 2
           AND revision.expected_previous_revision_id IS NOT NULL
       )
       UPDATE catalogue_query_revisions
       SET state = 'archived',
           repaired_through_card_id = NULL,
           repair_card_id = NULL,
           repair_search_offset = 0,
           repair_term_offset = 0
       WHERE catalogue_revision_id NOT IN (
         SELECT catalogue_revision_id
         FROM retained
       )`,
      )
      .bind(revisionId),
    database.prepare(
      `DELETE FROM revision_card_query_documents
       WHERE catalogue_revision_id IN (
         SELECT catalogue_revision_id
         FROM catalogue_query_revisions
         WHERE state = 'archived'
       )`,
    ),
    ...revisionPrintingStatements,
    ...printingImageStatements,
    ...revisionPrintingImageStatements,
    ...productReleaseStatements,
    ...printingQueryProjectionStatements(
      database,
      revisionId,
      printingDocuments.map(({ printing }) => ({
        printing_id: printing.id,
        card_id: printing.card_id,
        supported_game: gamesByCardId.get(printing.card_id)!,
        normalized_rarity: printing.rarity.normalized,
      })),
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
      .bind(revisionId, input.catalogueExport.manifestKey, manifestDigest),
    database
      .prepare(
        `UPDATE catalogue_state
        SET current_revision_id = ?, published_at = ?
        WHERE singleton = 1
          AND current_revision_id = ?`,
      )
      .bind(revisionId, publishedAt, input.run.expected_current_revision_id),
    ...runFreshnessStatements,
    database
      .prepare(
        `UPDATE ingestion_runs
        SET state = 'published',
            published_revision_id = ?,
            export_manifest_digest = ?,
            terminal_at = ?,
            progress_json = ?,
            publication_outcome = 'revision',
            resulting_revision_id = ?,
            freshness_checked_at = ?
        WHERE id = ? AND ${ingestionRunTransitionSql("publishing", "published")}`,
      )
      .bind(
        revisionId,
        manifestDigest,
        input.completedAt,
        JSON.stringify(progressFor("published")),
        revisionId,
        input.completedAt,
        input.run.id,
      ),
    database
      .prepare(
        `INSERT INTO catalogue_backup_attempts (
         idempotency_key, request_json, owner_token, catalogue_revision_id,
         state, object_key, started_at, publication_ingestion_run_id
       ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(
        publicationBackup.idempotencyKey,
        publicationBackup.requestJson,
        publicationBackup.ownerToken,
        revisionId,
        publicationBackup.objectKey,
        input.completedAt,
        input.run.id,
      ),
    database.prepare(
      `UPDATE operation_state SET recovery_health = 'degraded'
       WHERE singleton = 1 AND recovery_health = 'healthy'`,
    ),
    releaseRunLockStatement(database, input.run.id),
    ...idempotencyCompletionStatements(database, {
      key: idempotencyKey,
      operation: "approve_ingestion_run",
      requestJson: input.requestJson,
      response: resultingRun,
      status: 200,
      createdAt: input.completedAt,
      claimOwner: input.claimOwner ?? null,
    }),
  ];
  await database.batch(guardedAtomicBatch(commitStatements));
  return resultingRun;
}
