# Acceptance tests

`npm test` runs two smoke files. `npm run test:full` and the three CI acceptance
shards run all routine acceptance, including the small publisher journeys and
mixed-game recovery. See [the testing guide](../docs/testing.md) for CI policy.

| Command | Scope |
| --- | --- |
| `npm run test:acceptance` | All routine acceptance; at most two files at once |
| `npm run test:acceptance:smoke` | External evidence CLI and two-record native publication/SQL restore |
| `npm run test:acceptance -- --shard=1/3` | One routine CI shard |
| `npm run test:acceptance:extended -- composed-recovery` | One explicit extended scenario |
| `npm run test:benchmark -- native-sqlite-export` | One explicit capacity/profiling regression |
| `npm run test:stress` | Bounded production-pacing Worker checks used by weekly CI |
| `npm run test:stress:full` | All Worker capacity experiments; explicit opt-in |

Append `-- --list` to an acceptance/benchmark command to inspect selection without
starting a Worker. Extended and benchmark commands require a scenario name
(with or without `.test.mjs`); `--all` explicitly selects every scenario in that
tier. Omitting a scenario fails before allocating resources.

## Routine coverage

Routine acceptance retains real SQL export/import, native publication and restore
of two Riftbound records with actual image bytes, publisher-specific data and
rejection cases, public HTTP and external CLI, migration constraints and provider
failures. Tests use retained or synthetic bytes and local services, never live
publisher pages or production credentials.

Publisher journeys for One Piece, Digimon, Fusion World and Gundam use small
fixtures and the same Miniflare HTTP bridge as other routine tests. Only the
external evidence CLI smoke starts Wrangler. That keeps a real Wrangler wiring
check without starting a Wrangler process for every publisher case. The
`helpers/smoke-tier.mjs` registry also verifies publisher lineage coverage.

`mixed-game-recovery.test.mjs` uses two games, then three further publications to
cross the current-plus-two retention boundary. It verifies unchanged sibling
components, retained revision reads, expiry of the older revision, and actual
SQL restore. It replaces the five-game version, removes its borrowed 6 GiB
preflight, and deletes temporary state on both success and failure.

Routine files time out after two minutes. That catches a stuck test; it is not a
target duration or a RAM/disk quota. Domain and Worker tests retain the lower
layer's parsing, transactions, concurrency, corruption and recovery coverage.

## Extended journeys and benchmarks

`helpers/test-tiers.mjs` defines three separately selected extended journeys:

- `composed-recovery`: the longer recovery/fresh-baseline fault and history scenarios;
- `one-piece-two-source`: the retained Bandai evidence replay;
- `riftbound-catalogue`: the retained Riot inventory/Errata/Product replay.

They retain their assertions and remain available for changes to those specific
paths. Their workload is excluded from the everyday and full routine commands.

Benchmarks are separate: `native-sqlite-export` deliberately crosses 64 MiB,
`native-isolate-metrics` calibrates large-heap profiling, and
`reconciliation-capacity-probe` measures the synthetic 1,001-Product fixture.
The latter requires a report destination and never silently skips:

```sh
KEEPR_CAPACITY_OUTPUT_PREFIX=/tmp/keepr-capacity npm run test:benchmark -- reconciliation-capacity-probe
```

The probe retains its temporary state on failure and reports the location for
inspection; remove that reported directory after investigating. Other optional
probe settings are documented in its source. Running `benchmark --all` also
requires the report prefix because it includes this probe.

The full Riftbound journey alone retains the 6 GiB free-space preflight. Its
historical run took about 21 minutes and sampled 3.94 GB of local logical
occupancy across source, staging, export and restore copies. It makes no complete
image or production-capacity claim. See [the measurement record](../docs/validation/issue-233-capacity.md).
The bounded routine restore is the normal correctness check.

## Historical measurements and source freshness

The [2026-09-04 measurements](timings/2026-09-04.json) describe an earlier suite
and dependency set; use the current testing guide for recent local measurements.
Hosted timings must be measured on the exact changed commit.

The independent weekly [recapture workflow](../.github/workflows/official-source-recapture.yml)
checks retained digests against current publisher responses and reports drift.
It preserves changed bytes for review and never automatically replaces goldens.
See the [retained-byte procedure](fixtures/retained-official-source/README.md).
