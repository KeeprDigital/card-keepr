# ADR 0006: One schema baseline replaces the 36-migration chain

## Status

Accepted. Before Go-Live, forward migrations are folded back into the baseline whenever the production database is recreated, and all of them are folded in before Go-Live (ADR 0008); the "never edit the baseline" rule applies from Go-Live.

## Context

The catalogue schema had grown through 36 forward migrations. The files
carried three rebuilds of `ingestion_runs`, tables created and later
dropped (the attested-rotation subsystem, ADR 0005), `ALTER`s on `ALTER`s,
and the 0017/0018 schema-level repair. 0028 rebuilt `ingestion_runs` by
dropping it and lost curated pin rows on a populated database (PR #126):
the chain was a hazard as well as a history.

The bootstrap catalogue database was deleted and recreated empty (PR #127).
Nothing was live, no backup existed, and no upgrade path had to be
preserved. Applying the 36 files to the empty database would have left
wrangler's `d1_migrations` ledger with 36 entries and forced any later
squash to fake the baseline as already applied.

## Decision

`migrations/0001_baseline.sql` is the only migration. It creates the
level-36 schema in one pass, in the order the chain created its objects
(the singleton state tables and `ingestion_runs` are hoisted to the top;
trigger order is unchanged because SQLite fires overlapping triggers in
creation order), and seeds every row the chain seeded: the 53
`source_adapter_versions` registrations, the `catrev_spine_000` Catalogue
Revision pointer in `catalogue_state`, `operation_state`,
`card_search_fts_state`, and `catalogue_schema_state` at level 1. Design
rationale from the old files is carried over as comments where it explains
a constraint or trigger. The 36 old files are deleted; they remain in git
history at commit `30751a2a46548530d48dc37a1dc507efbbd07c03`.

Every environment is built the same way: tests, local development, and
production all apply the baseline to an empty database and report schema
level 1.

### Level mapping

| Old chain level | Baseline level |
| --------------- | -------------- |
| 1 through 36    | 1              |

The baseline is level 1. The next migration is `0002_*.sql` and bumps the
level to 2; there is no relationship between a new level and any old one.
A backup stamped with an old level cannot be restored into a baseline
database, which is acceptable because no such backup exists.

### Every later migration opens with the level guard

Migration 0035 introduced a loud precondition: the first statement asserts
the recorded level and aborts the whole migration on mismatch, because
`json_extract` on a non-JSON string raises `malformed JSON`. The final
statement bumps the level without a `WHERE` clause. Every migration after
the baseline must follow that shape:

```sql
SELECT CASE
  WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 1
  THEN 1
  ELSE json_extract('schema_level_mismatch_expected_1', '$')
END;

-- schema changes

UPDATE catalogue_schema_state
SET migration_level = 2
WHERE singleton = 1;
```

`acceptance/schema-hygiene.test.mjs` walks every migration and proves the
level after each one, and proves that each guarded migration changes
nothing when the recorded level is wrong.

### Proof of equivalence

`acceptance/schema-baseline.test.mjs` applies the baseline and compares its
`sqlite_schema` rows (type, name, tbl_name, sql) and every seeded row with
those produced by replaying the 36-file chain from commit `30751a2a46548530d48dc37a1dc507efbbd07c03`. The
DDL text is compared at the token level (comments, identifier quotes, and
whitespace around punctuation removed) because `sqlite_schema` stores
`ALTER TABLE ADD COLUMN` text with the `ALTER` statement's spacing and a
renamed table with its quoted name. The comparison excludes only
`catalogue_schema_state.migration_level`, which is 36 on the chain and 1 on
the baseline by design.

The digests recorded in the test:

| Input                                        | SHA-256                                                            | Source                     |
| -------------------------------------------- | ------------------------------------------------------------------ | -------------------------- |
| normalized `sqlite_schema` rows              | `4e16338cc27afa79f3ac39bacee5c36ad4807bb09a41d8ea06fcf2fdc78c1bf4` | chain replay (unchanged)   |
| seed rows of every table                     | `f5523576e21a352acd13f70a41fe5cdb5fd067d6bd4e2abc78f1c7d0dbe5856e` | the baseline itself        |

The schema digest assertion always runs. When that commit is present in the
checkout the chain is also replayed and diffed object by object, so a
mismatch names the object; a shallow CI clone runs the digest check alone.

Under ADR 0008 the seed rows diverged from the chain: #135 removed the
retired and predecessor `source_adapter_versions` rows from the baseline,
the pinned-JSON-document production rows and the non-legality-aware
synthetic fixture rows were removed so each Source Lineage keeps one
production and one fixture registration, and
#134 raised `one-piece-en@6`'s `request_capacity` in place, so the chain's
seed digest (`6955a52bb80e757e765b5d6db9e1db025b1e16d0f849771719ae89e2ca00b1c0`)
no longer matches. Only the schema DDL is still proven equivalent to the
chain; the seed digest above is the baseline's own and is pinned so an
unintended seed change still fails the test.

## Consequences

The populated-database upgrade tests are deleted: the 0006, 0015, and 0028
tests, the ingestion worker's legacy-run upgrade through 0002, and the
0019/0021 upgrade halves of the release validator tests. There is no
populated database to upgrade. Contract tests that read specific old files
read the baseline instead. The acceptance suite's migrated template hash
changes once.

The baseline must not be edited after production has applied it. A change
to the schema is a new guarded migration; a mistake in the baseline
discovered before production applies it is corrected by replacing the file
and recomputing the digests in the proof test.

Production is rebuilt by applying the baseline to the empty database and
deploying the workers; `keepr status` then reports schema level 1. Issues
#123 and #124 add their migrations as `0002` and later on top of the
baseline.

## Final Go-Live baseline (#136)

The owner-approved cutover replaces the final pre-Go-Live chain through level 13
with one level-1 baseline. Its source is commit
`23b1b1128cf9bf5827034d15dcaebf1964ce7c76`. The proof test compares every logical
schema object, every seed row other than the deliberately reset schema level,
and trigger creation order against that chain. It excludes only the empty,
unused `sqlite_sequence` left after the chain dropped its last AUTOINCREMENT
table; the test proves that no sequence row or AUTOINCREMENT definition remains.

| Proof | SHA-256 |
| --- | --- |
| Normalized logical schema | `12c3e223cdcb1623e1a362307eea051b36797b4735a95a18d96dfb067f1b2a60` |
| Seed rows except schema level | `0a7b7d721a7e6d343ca38e607c4285ab46ea32856802a4f2b6a4d35733cc5483` |

The baseline includes 105 immutability triggers and six shipped production
Source Adapter Version registrations. Synthetic registrations belong exclusively
to test composition. Historical upgrade/backfill tests leave the active suite
with their deleted migrations; current constraint, projection, publication and
query behavior remains covered. The chain and its upgrade tests stay in git
history, not in a second executable migration path.

At the approved cutover, create a fresh database and apply this baseline. Never
apply it to the previous production database or edit/fake its migration ledger.
Retain the previous database identity until the new binding and release evidence
are accepted. From that cutover onward this baseline is immutable; subsequent
changes use guarded forward migrations beginning at level 2. The older level-36
proof above describes the first pre-Go-Live fold and is historical.

All definition identifiers keep their existing suffixes, including
`one-piece-en@6` and `card-keepr-catalogue-export-manifest@5`. These are contract
identities, not an application release counter. No `@1` renumbering is performed.
