import { type CatalogueStore, repositoryStatements } from "../shared";

export function nativePriorPrintingLocatorsStatement(
  db: CatalogueStore,
  preparation: string,
  group: string,
  through: number,
  lineage: string,
  locator: string,
) {
  return repositoryStatements(db)
    .prepare(`SELECT state.key_digest,state.observation_ordinal,length(CAST(state.content AS BLOB)) AS byte_length
    FROM reconciliation_reducer_state state
    WHERE state.preparation_id=?1 AND state.namespace='prior_printings' AND state.group_digest=?2
      AND state.observation_ordinal<=?3 AND NOT EXISTS (
        SELECT 1 FROM reconciliation_reducer_state later WHERE later.preparation_id=state.preparation_id
          AND later.namespace=state.namespace AND later.key_digest=state.key_digest
          AND later.observation_ordinal>state.observation_ordinal AND later.observation_ordinal<=?3)
      AND EXISTS (SELECT 1 FROM json_each(state.content,'$.value.locator_evidence') evidence
        WHERE json_extract(evidence.value,'$.source_lineage')=?4 AND json_extract(evidence.value,'$.locator')=?5)
    ORDER BY state.key_digest LIMIT 9`)
    .bind(preparation, group, through, lineage, locator);
}

export type NativePrintingMatchKind = "locator" | "compatible" | "appearance" | "cross_source";

export function nativePriorPrintingIdentityMatchesStatement(
  db: CatalogueStore,
  prior: { preparationId: string; through: number; group: string; namespace: string },
  compatibility: import("./reconciliation-model").PrintingCompatibility,
  locator: { locator: string; variantKey: string | null },
  kind: NativePrintingMatchKind,
) {
  return repositoryStatements(db)
    .prepare(`SELECT state.key_digest,state.observation_ordinal,length(CAST(state.content AS BLOB)) AS byte_length
    FROM reconciliation_reducer_state state
    WHERE state.preparation_id=?1 AND state.namespace=?12 AND state.group_digest=?2
      AND state.observation_ordinal<=?3 AND NOT EXISTS (
        SELECT 1 FROM reconciliation_reducer_state later WHERE later.preparation_id=state.preparation_id
          AND later.namespace=state.namespace AND later.key_digest=state.key_digest
          AND later.observation_ordinal>state.observation_ordinal AND later.observation_ordinal<=?3)
      AND (
        (?11='locator' AND EXISTS (SELECT 1 FROM json_each(state.content,'$.value.locators') evidence
          WHERE json_extract(evidence.value,'$.source_lineage')=?4
            AND json_extract(evidence.value,'$.locator')=?9
            AND json_extract(evidence.value,'$.variant_key') IS ?10))
        OR (?11='compatible' AND json_extract(state.content,'$.value.compatibility.artwork_fingerprint') IS ?5
          AND json_extract(state.content,'$.value.compatibility.printed_fields_digest') IS ?6
          AND json_extract(state.content,'$.value.compatibility.rarity_normalized') IS ?7
          AND json_extract(state.content,'$.value.compatibility.treatment') IS ?8)
        OR (?11='appearance' AND json_extract(state.content,'$.value.compatibility.artwork_fingerprint') IS ?5
          AND json_extract(state.content,'$.value.compatibility.treatment') IS ?8)
        OR (?11='cross_source' AND json_extract(state.content,'$.value.compatibility.source_lineage')<>?4
          AND json_extract(state.content,'$.value.compatibility.printed_fields_digest') IS ?6
          AND json_extract(state.content,'$.value.compatibility.rarity_normalized') IS ?7
          AND json_extract(state.content,'$.value.compatibility.treatment') IS ?8))
    ORDER BY state.key_digest LIMIT 9`)
    .bind(
      prior.preparationId,
      prior.group,
      prior.through,
      compatibility.source_lineage,
      compatibility.artwork_fingerprint,
      compatibility.printed_fields_digest,
      compatibility.rarity_normalized,
      compatibility.treatment,
      locator.locator,
      locator.variantKey,
      kind,
      prior.namespace,
    );
}
