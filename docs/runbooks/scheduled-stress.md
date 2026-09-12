# Scheduled stress

[stress.yml](../../.github/workflows/stress.yml) runs two bounded pacing/throughput
checks every Monday at 03:17 UTC and on manual dispatch, with a five-minute job cap.
Full stress is manual (`suite: full`, 45-minute cap) or local
`pnpm run test:stress:full`. Manual and scheduled cancellation groups are separate.
[Test selection and interpretation](../testing.md#what-the-stress-commands-prove)
explain what a result establishes.

Results are retained for seven days as `stress-results-bounded` or
`stress-results-full`. Save relevant evidence outside the tracked documentation
before expiry. A missing report is incomplete evidence, never an empty pass.
Bounded hosted storage uses 512 MiB tmpfs; full stress uses 2 GiB.

For one failing file:

```sh
gh workflow run test-suite-diagnostics.yml --ref <branch> \
  -f worker=ingestion -f suite=stress -f storage=memory \
  -f files='apps/ingestion/test/game-reconciliation-scale.stress.spec.ts' \
  -f repeats=1
```

Use `storage=disk` for a controlled storage comparison. Focused results do not
replace full stress or routine CI. The failure-reporting job opens/comments on
`stress: scheduled stress suite failed`; only that job holds `issues: write`.
Close the issue when its actual acceptance is met. A green bounded selection
does not resolve a full-suite failure.

## Schedule liveness

GitHub can disable scheduled workflows after 60 days of inactivity; schedules
also depend on default-branch configuration and an enabled workflow. A quiet
schedule is not a pass and creates no failed-run issue. Check monthly and after
long quiet periods:

```sh
gh workflow view stress.yml --repo KeeprDigital/card-keepr
gh run list --workflow stress.yml --limit 3 --repo KeeprDigital/card-keepr
```

Require an active workflow and a scheduled run within seven days. If disabled:

```sh
gh workflow enable stress.yml --repo KeeprDigital/card-keepr
gh workflow run stress.yml --repo KeeprDigital/card-keepr
```

[Official-source monitoring](../../acceptance/fixtures/retained-official-source/README.md)
is independent of these offline stress tests.
