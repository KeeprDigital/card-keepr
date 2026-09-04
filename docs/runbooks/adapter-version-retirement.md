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

Generate the read-only query from the exact retiring identifiers. The generator
reuses the production repository's immutable-event authority predicate, including
the full current projection, latest event identity and birth selection. It treats
missing or inconsistent authority as a blocker even if a mutable row says terminal.
An unknown adapter identifier also produces a blocker instead of an empty result.

```sh
node scripts/adapter-retirement-sql.mjs EXACT_ADAPTER_ID > retirement-check.sql
./node_modules/.bin/wrangler d1 execute CATALOGUE_DB --remote --json \
  --config apps/ingestion/wrangler.jsonc \
  --command "$(cat retirement-check.sql)" > retirement-check.json
```

Replace `EXACT_ADAPTER_ID` with each exact retiring identifier (additional arguments
are supported). Use the selected environment's verified D1 target and retain the
query and result with the PR. Retirement requires an empty `results` array after
a successful query; an error is never equivalent to no blockers. Do not edit the
database to clear a pin or make a current projection appear terminal.

For a non-terminal collection run, inspect it with `source show`, follow the
[collection pause and termination runbook](collection-pause.md), and restart under
the active version once the original run is terminal. Runs in other stages need
the corresponding supported lifecycle action; collection termination is not a
universal state bypass. The same rule applies after restoring an older backup.

Reparsing a retained Source Snapshot uses an explicitly selected supported
contract. A retired contract remains available in git for forensic comparison
but is never made executable again under the retired identity.
