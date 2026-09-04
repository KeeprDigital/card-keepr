import { errataTargetsGuardStatement } from "./errata-guard-repository";
import { byteBoundedJsonArrays, atomicRepositoryStatement, type CatalogueStore, repositoryStatements } from "../shared";
// Prepared statements only; callers own execution and atomic batch composition.

export function publicationContextStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT context.source_lineage, plan.adapter_version,
              run.candidate_created_at AS observed_at
       FROM reconciliation_contexts AS context
       JOIN ingestion_evidence_plans AS plan
         ON plan.ingestion_run_id = context.ingestion_run_id
       JOIN ingestion_runs AS run
         ON run.id = context.ingestion_run_id
       WHERE context.ingestion_run_id = ?`)
    .bind(runId);
}

export function publicationLineagesStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT DISTINCT source_lineage, adapter_version
       FROM reconciliation_evidence_partitions
       WHERE ingestion_run_id = ?
       ORDER BY source_lineage, adapter_version`)
    .bind(runId);
}

export function publicationEvidenceStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT plan.source_observation_id AS id,
              plan.source_lineage AS source,
              snapshot.retrieved_at AS captured_at
       FROM reconciliation_candidates AS plan
       JOIN source_snapshots AS snapshot
         ON snapshot.id = plan.source_snapshot_id
       WHERE plan.ingestion_run_id = ?
       ORDER BY plan.source_observation_id`)
    .bind(runId);
}

export function publicationEvidenceByIdsStatement(
  database: CatalogueStore,
  observationIdsJson: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT candidate.source_observation_id AS id,
                candidate.source_lineage AS source,
                snapshot.retrieved_at AS captured_at
         FROM reconciliation_candidates AS candidate
         JOIN source_snapshots AS snapshot
           ON snapshot.id = candidate.source_snapshot_id
         WHERE candidate.source_observation_id IN (
           SELECT value FROM json_each(?)
         )
         ORDER BY candidate.source_observation_id`)
    .bind(observationIdsJson);
}

export function publishReconciledErrataStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; observedRevisionId: string; payload: string }>,
): D1PreparedStatement {
  return atomicRepositoryStatement(database, {
    before: [errataTargetsGuardStatement(database, input.payload)],
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO reconciled_errata (
             id, game, target_type, target_id, effective_from,
             official_wording, corrected_value_json,
             first_revision_id, last_observed_revision_id
           )
           SELECT json_extract(value, '$.id'),
                  json_extract(value, '$.game'),
                  json_extract(value, '$.target_type'),
                  json_extract(value, '$.target_id'),
                  json_extract(value, '$.effective_from'),
                  json_extract(value, '$.official_wording'),
                  json_extract(value, '$.corrected_value_json'), ?, ?
           FROM json_each(?) WHERE true
           ON CONFLICT (id) DO UPDATE SET
             last_observed_revision_id = excluded.last_observed_revision_id`)
      .bind(input.revisionId, input.observedRevisionId, input.payload),
  });
}

export function publishErratumProvenanceStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; observedRevisionId: string; payload: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO erratum_provenance (
             erratum_id, source_lineage, source_observation_id,
             first_revision_id, last_observed_revision_id
           )
           SELECT json_extract(value, '$.erratum_id'),
                  json_extract(value, '$.source_lineage'),
                  json_extract(value, '$.source_observation_id'), ?, ?
           FROM json_each(?) WHERE true
           ON CONFLICT (erratum_id, source_lineage, source_observation_id)
           DO UPDATE SET
             last_observed_revision_id = excluded.last_observed_revision_id`)
    .bind(input.revisionId, input.observedRevisionId, input.payload);
}

export function publishRevisionErrataStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; payload: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT OR IGNORE INTO revision_errata (
             catalogue_revision_id, erratum_id
           )
           SELECT ?, json_extract(value, '$.erratum_id')
           FROM json_each(?)`)
    .bind(input.revisionId, input.payload);
}

export function erratumTargetLifecycleStatement(database: CatalogueStore, erratumIdsJson: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT provenance.erratum_id,
                provenance.source_lineage,
                provenance.first_revision_id,
                provenance.last_observed_revision_id,
                first_revision.published_at AS first_order,
                last_revision.published_at AS last_order
         FROM erratum_provenance AS provenance
         JOIN catalogue_revisions AS first_revision
           ON first_revision.id = provenance.first_revision_id
         JOIN catalogue_revisions AS last_revision
           ON last_revision.id = provenance.last_observed_revision_id
         WHERE EXISTS (
           SELECT 1 FROM json_each(?) AS requested
           WHERE requested.value = provenance.erratum_id
         )`)
    .bind(erratumIdsJson);
}

export function inferredProductRevisionTimeStatement(
  database: CatalogueStore,
  revisionId: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT published_at FROM catalogue_revisions WHERE id = ?")
    .bind(revisionId);
}

export function carriedRevisionStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT expected_current_revision_id FROM ingestion_runs WHERE id = ?")
    .bind(runId);
}

export function carriedCardLifecyclesStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT card_id AS id, document_json
         FROM revision_cards
         WHERE catalogue_revision_id = ?`)
    .bind(revisionId);
}

export function carriedPrintingLifecyclesStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT printing_id AS id, document_json
         FROM revision_printings
         WHERE catalogue_revision_id = ?`)
    .bind(revisionId);
}

export function printingRelationshipLifecycleStatement(
  database: CatalogueStore,
  printingIdsJson: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT membership.printing_id, source_lineage, source_observation_id,
              relationship_kind, relationship_value,
              membership.first_revision_id,
              membership.last_observed_revision_id,
              first_revision.published_at AS first_revision_order,
              last_revision.published_at AS last_observed_revision_order,
              current, last_missing_revision_id
       FROM reconciled_printing_memberships AS membership
       JOIN catalogue_revisions AS first_revision
         ON first_revision.id = membership.first_revision_id
       JOIN catalogue_revisions AS last_revision
         ON last_revision.id = membership.last_observed_revision_id
       WHERE membership.printing_id IN (SELECT value FROM json_each(?))
       ORDER BY membership.printing_id, source_lineage, relationship_kind,
                relationship_value, first_revision.published_at,
                membership.first_revision_id, last_revision.published_at,
                membership.last_observed_revision_id, source_observation_id`)
    .bind(printingIdsJson);
}

export function printingLocatorLifecycleStatement(
  database: CatalogueStore,
  printingIdsJson: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT printing_id, source_lineage, locator, variant_key,
              first_revision_id, last_observed_revision_id,
              current, last_missing_revision_id
       FROM reconciled_printing_locators
       WHERE printing_id IN (SELECT value FROM json_each(?))
       ORDER BY printing_id, source_lineage, locator,
                COALESCE(variant_key, '')`)
    .bind(printingIdsJson);
}

export function publishWithdrawalAssertionsStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; payload: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciled_withdrawal_assertions (
           entity_type, entity_id, source_lineage, source_snapshot_id,
           source_observation_set_id, source_observation_id, assertion,
           state, effective_at, evidence_json,
           published_catalogue_revision_id
         )
         SELECT json_extract(value, '$.entity_type'),
                json_extract(value, '$.entity_id'),
                json_extract(value, '$.source_lineage'),
                json_extract(value, '$.source_snapshot_id'),
                json_extract(value, '$.source_observation_set_id'),
                json_extract(value, '$.source_observation_id'),
                json_extract(value, '$.assertion'),
                json_extract(value, '$.state'),
                json_extract(value, '$.effective_at'),
                json_extract(value, '$.evidence_json'), ?
         FROM json_each(?) WHERE true
         ON CONFLICT (entity_type, entity_id, source_observation_id)
         DO NOTHING`)
    .bind(input.revisionId, input.payload);
}

export function publishReconciledCardsStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; payload: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciled_cards (
           id, supported_game, official_identity_kind,
           official_identity_value, first_revision_id,
           last_observed_revision_id, withdrawn, withdrawal_revision_id,
           withdrawal_evidence_json
         )
         SELECT json_extract(value, '$.id'),
                json_extract(value, '$.supported_game'),
                json_extract(value, '$.official_identity_kind'),
                json_extract(value, '$.official_identity_value'),
                json_extract(value, '$.first_revision_id'), ?,
                json_extract(value, '$.withdrawn'),
                json_extract(value, '$.withdrawal_revision_id'),
                json_extract(value, '$.withdrawal_evidence_json')
         FROM json_each(?) WHERE true
         ON CONFLICT (id) DO UPDATE SET
           last_observed_revision_id = excluded.last_observed_revision_id,
           withdrawn = CASE
             WHEN reconciled_cards.withdrawn = 0 AND excluded.withdrawn = 1
             THEN 1 ELSE reconciled_cards.withdrawn END,
           withdrawal_revision_id = CASE
             WHEN reconciled_cards.withdrawn = 0 AND excluded.withdrawn = 1
             THEN excluded.withdrawal_revision_id
             ELSE reconciled_cards.withdrawal_revision_id END,
           withdrawal_evidence_json = CASE
             WHEN reconciled_cards.withdrawn = 0 AND excluded.withdrawn = 1
             THEN excluded.withdrawal_evidence_json
             ELSE reconciled_cards.withdrawal_evidence_json END`)
    .bind(input.revisionId, input.payload);
}

export function publishCardObservationsStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; payload: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciled_card_observations (
           card_id, source_lineage, source_observation_id,
           catalogue_revision_id, canonical_facts_json, current,
           last_missing_revision_id
         )
         SELECT json_extract(value, '$.card_id'),
                json_extract(value, '$.source_lineage'),
                json_extract(value, '$.source_observation_id'), ?,
                json_extract(value, '$.canonical_facts_json'), 1, NULL
         FROM json_each(?)`)
    .bind(input.revisionId, input.payload);
}

export function publishReconciledPrintingsStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; payload: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciled_printings (
           id, card_id, source_lineage, artwork_fingerprint,
           printed_fields_digest, rarity_normalized, treatment,
           first_revision_id, last_observed_revision_id, withdrawn,
           withdrawal_revision_id, withdrawal_evidence_json
         )
         SELECT json_extract(value, '$.id'),
                json_extract(value, '$.card_id'),
                json_extract(value, '$.source_lineage'),
                json_extract(value, '$.artwork_fingerprint'),
                json_extract(value, '$.printed_fields_digest'),
                json_extract(value, '$.rarity_normalized'),
                json_extract(value, '$.treatment'),
                json_extract(value, '$.first_revision_id'), ?,
                json_extract(value, '$.withdrawn'),
                json_extract(value, '$.withdrawal_revision_id'),
                json_extract(value, '$.withdrawal_evidence_json')
         FROM json_each(?) WHERE true
         ON CONFLICT (id) DO UPDATE SET
           last_observed_revision_id = excluded.last_observed_revision_id,
           withdrawn = CASE
             WHEN reconciled_printings.withdrawn = 0
                  AND excluded.withdrawn = 1
             THEN 1 ELSE reconciled_printings.withdrawn END,
           withdrawal_revision_id = CASE
             WHEN reconciled_printings.withdrawn = 0
                  AND excluded.withdrawn = 1
             THEN excluded.withdrawal_revision_id
             ELSE reconciled_printings.withdrawal_revision_id END,
           withdrawal_evidence_json = CASE
             WHEN reconciled_printings.withdrawn = 0
                  AND excluded.withdrawn = 1
             THEN excluded.withdrawal_evidence_json
             ELSE reconciled_printings.withdrawal_evidence_json END`)
    .bind(input.revisionId, input.payload);
}

export function publishPrintingLocatorsStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; observedRevisionId: string; payload: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciled_printing_locators (
           printing_id, source_lineage, locator, variant_key,
           variant_identity,
           first_revision_id, last_observed_revision_id, current,
           last_missing_revision_id
         )
         SELECT json_extract(value, '$.printing_id'),
                json_extract(value, '$.source_lineage'),
                json_extract(value, '$.locator'),
                json_extract(value, '$.variant_key'),
                COALESCE(json_extract(value, '$.variant_key'), ''), ?, ?, 1, NULL
         FROM json_each(?) WHERE true
         ON CONFLICT (source_lineage, locator, variant_identity) DO UPDATE SET
           last_observed_revision_id = excluded.last_observed_revision_id,
           current = 1, last_missing_revision_id = NULL`)
    .bind(input.revisionId, input.observedRevisionId, input.payload);
}

export function publishPrintingMembershipsStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; observedRevisionId: string; payload: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciled_printing_memberships (
           printing_id, source_lineage, source_observation_id,
           relationship_kind, relationship_value, first_revision_id,
           last_observed_revision_id, current, last_missing_revision_id
         )
         SELECT json_extract(value, '$.printing_id'),
                json_extract(value, '$.source_lineage'),
                json_extract(value, '$.source_observation_id'),
                json_extract(value, '$.relationship_kind'),
                json_extract(value, '$.relationship_value'), ?, ?, 1, NULL
         FROM json_each(?) WHERE true
         ON CONFLICT (
           printing_id, source_lineage, source_observation_id,
           relationship_kind, relationship_value
         ) DO UPDATE SET
           last_observed_revision_id = excluded.last_observed_revision_id,
           current = 1, last_missing_revision_id = NULL`)
    .bind(input.revisionId, input.observedRevisionId, input.payload);
}

export function requiredPublicationCandidateStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT candidate_json FROM ingestion_runs WHERE id = ?").bind(runId);
}

export function publicationEntityLifecyclesStatement(
  database: CatalogueStore,
  kind: "card" | "printing",
  idsJson: string,
): D1PreparedStatement {
  const table = kind === "card" ? "reconciled_cards" : "reconciled_printings";
  return repositoryStatements(database)
    .prepare(`SELECT * FROM ${table}
       WHERE id IN (SELECT value FROM json_each(?))
       ORDER BY id`)
    .bind(idsJson);
}

export function deactivatePublicationEvidenceStatements(
  database: CatalogueStore,
  kind: "card-observation" | "printing-locator" | "printing-membership",
  rows: readonly Record<string, unknown>[],
  revisionId: string,
): D1PreparedStatement[] {
  const { table, idColumn } = {
    "card-observation": { table: "reconciled_card_observations", idColumn: "card_id" },
    "printing-locator": { table: "reconciled_printing_locators", idColumn: "printing_id" },
    "printing-membership": { table: "reconciled_printing_memberships", idColumn: "printing_id" },
  }[kind];
  return byteBoundedJsonArrays(rows).map((payload) =>
    repositoryStatements(database)
      .prepare(
        `UPDATE ${table}
         SET current = 0, last_missing_revision_id = ?
         WHERE current = 1
           AND (${idColumn}, source_lineage) IN (
             SELECT json_extract(planned.value, '$.${idColumn}'),
                    json_extract(planned.value, '$.source_lineage')
             FROM json_each(?) AS planned
           )`,
      )
      .bind(revisionId, payload),
  );
}
