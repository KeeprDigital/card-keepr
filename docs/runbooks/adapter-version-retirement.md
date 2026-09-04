# Runbook: retiring a Source Adapter Version

ADR 0004 retains parser implementations for the current Source Adapter Version
and its immediate predecessor on each Source Lineage. Registration identities
and their immutable facts remain attributable forever. The #136 baseline starts
with one current production registration per lineage and no predecessor or retired
version; the first subsequent version establishes the predecessor window.

## Before a version change

1. Register a new identifier and immutable facts in a guarded forward migration.
   Do not edit the baseline, an existing registration, or its Request Capacity.
2. Add the new implementation under `src/catalogue/adapters/`, retaining the
   immediate predecessor. Keep retained observations attributable to their exact
   registered version; a new implementation never impersonates an old contract.
3. When a third version would make the former predecessor retire, first prove that
   no non-terminal Ingestion Run pins it. Query both planned and retained evidence
   with the exact retiring adapter IDs; use `ingestion_run_current` for state.
4. Preserve its registration and parser-contract string, while removing its
   executable parser, discovery handlers and tests/fixtures used only by that
   retired implementation. Add explicit retired-version refusal to every capture,
   discovery and parse entry point before removing its implementation. Reconciliation
   reads must still resolve the immutable registration without invoking a parser.
5. Exercise current and predecessor parsing, retained observation reconciliation,
   and explicit retired-version refusal. Check restored in-flight run handling.

The first actual retirement must add and review the retired registration resolver
and typed refusal with these tests. The initial Go-Live tree has no retired
versions, so there is no retired registry or list to populate speculatively.

## Pre-merge check

Use this read-only SQL with a JSON array containing the exact identifiers being
retired. Replace the sample value before running it. Run through the selected
environment's verified D1 target and retain the JSON result with the PR.

```sql
WITH retiring(adapter_version) AS (
  SELECT value FROM json_each('["EXACT_RETIRED_ADAPTER_ID"]')
), pinned(ingestion_run_id, adapter_version) AS (
  SELECT ingestion_run_id, adapter_version FROM ingestion_evidence_plans
  UNION
  SELECT ingestion_run_id, adapter_version FROM source_snapshots
  UNION
  SELECT snapshot.ingestion_run_id, operation.adapter_version
  FROM source_parse_operations AS operation
  JOIN source_snapshots AS snapshot ON snapshot.id = operation.source_snapshot_id
  UNION
  SELECT snapshot.ingestion_run_id, observations.adapter_version
  FROM source_observation_sets AS observations
  JOIN source_snapshots AS snapshot ON snapshot.id = observations.source_snapshot_id
  UNION
  SELECT ingestion_run_id, adapter_version FROM reconciliation_evidence_partitions
)
SELECT DISTINCT pinned.ingestion_run_id, current.state, pinned.adapter_version
FROM pinned
JOIN retiring USING (adapter_version)
LEFT JOIN ingestion_run_current AS current USING (ingestion_run_id)
WHERE current.state IS NULL
   OR current.state NOT IN ('published', 'rejected', 'expired', 'failed');
```

Retirement requires an empty result. A missing current projection also blocks it;
inspect/rebuild verified run projections before deciding that evidence is safe.
Do not treat a missing row as terminal or edit the database to clear a pin.

For a non-terminal collection run, inspect it with `source show`, follow the
[collection pause and termination runbook](collection-pause.md), and restart under
the active version once the original run is terminal. Runs in other stages need
the corresponding supported lifecycle action; collection termination is not a
universal state bypass. The same rule applies after restoring an older backup.

Reparsing a retained Source Snapshot uses an explicitly selected supported
contract. A retired contract remains available in git for forensic comparison
but is never made executable again under the retired identity.
