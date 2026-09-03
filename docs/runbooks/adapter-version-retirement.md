# Runbook: retiring a Source Adapter Version

ADR 0004 (`docs/adr/0004-superseded-parser-code-is-retired.md`): registration
is permanent, implementation is not. Parser implementation is retained only
for the current Source Adapter Version and its immediate predecessor on each
Source Lineage. Every older version is retired.

## What retirement means

A retired version:

- stays registered forever: its `source_adapter_versions` row, its parser
  contract string, and its registration in
  `src/catalogue/retired-source-adapter-versions.ts` never change, so
  retained Source Observation Sets, Evidence Plans, and Ingestion Runs stay
  attributable and `requiredSourceAdapter()` still resolves it (with
  `retired: true`) for reconciliation reads and diagnostics;
- has no parser: `parseBytes`, `discoverRequests`, and the request-surface
  contract are gone, and its parser body, dispatch branches, registry flags,
  per-version tests, and retired-only fixtures are deleted from the tree;
- cannot capture or parse: plan creation, snapshot capture, request
  discovery, and snapshot reparse refuse it with the typed problem
  `adapter_version_retired` (HTTP 422). Nothing falls through to another
  contract.

Reparsing retained Source Snapshots is done by registering a new version. A
retired contract can be read from version control history for forensic
comparison but is never re-registered or made executable again.

## The two-per-lineage window

Each Source Lineage keeps exactly two parseable versions: the active
registration (the last entry for the lineage in
`src/catalogue/product-release-source-adapters.ts`) and its predecessor.
The predecessor is superseded for new collection (`adapter_not_supported`)
but may still reparse the Source Snapshots it captured. A version bump
therefore adds one live contract and retires the former predecessor:

1. Add the new version to its lineage's `versions` list (last position) and
   insert its `source_adapter_versions` seed row in a new guarded migration
   (ADR 0006).
2. Move the former predecessor's registration facts (adapter version,
   lineage, game, parser contract, reconciliation areas, header
   inheritance) into `retiredSourceAdapterVersions`, copying the parser
   contract string byte-for-byte from the seed row.
3. Delete its parser bodies, dispatch branches, tests, and any fixture only
   it could read.
4. Add the version to `scripts/retired-adapter-runs.sql`. The acceptance
   suite asserts that file names exactly the retired versions.
5. Run the pre-merge check below.

## Pre-merge check: no non-terminal run pins a retired version

A non-terminal Ingestion Run pinned to a retired version can no longer
capture or parse, so it must not exist when the retirement merges. The
query lives in `scripts/retired-adapter-runs.sql`:

```sql
SELECT run.id, run.state, plan.adapter_version
FROM ingestion_evidence_plans AS plan
JOIN ingestion_runs AS run ON run.id = plan.ingestion_run_id
WHERE run.state NOT IN ('published', 'rejected', 'expired', 'failed')
  AND plan.adapter_version IN (<retired list>);
```

Run it against production D1 with `--command`. (`--file` goes through the
D1 import API, which reports execution statistics rather than the selected
rows, so it cannot show matches.)

```sh
npx wrangler d1 execute CATALOGUE_DB --remote --json \
  --config apps/ingestion/wrangler.jsonc \
  --command "$(grep -v '^--' scripts/retired-adapter-runs.sql)"
```

The retirement may merge only when `results` is an empty array.

Check log:

| Date | Retired versions | Result |
| --- | --- | --- |
| 2026-09-03 | the 22 versions listed in `scripts/retired-adapter-runs.sql` (initial ADR 0004 retirement, #108) | `results: []` against production |

## If a non-terminal run pins a retired version

The run cannot resume, parse, reconcile, or publish. Terminate it and start
again under a live version:

1. Inspect it: `npm run keepr -- source show --run-id RUN_ID --json`.
2. Terminate it through the collection-termination route
   (`source terminate --run-id RUN_ID --idempotency-key KEY`; see
   `docs/runbooks/collection-pause.md`). Termination keeps every retained
   Source Snapshot and diagnostic, marks the run terminal, and releases the
   active-run reservation.
3. Start a new Ingestion Run under the lineage's active version.

The same applies to a backup restored with an in-flight run pinned to a
retired version: the one-prior retention window is the intended safety
margin, and such a run must be terminated and restarted under a live
version.
