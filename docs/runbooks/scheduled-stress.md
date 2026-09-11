# Scheduled Stress Suite

`.github/workflows/stress.yml` runs `pnpm run test:stress` every Monday at
03:17 UTC and on `workflow_dispatch`. Nobody watches a scheduled run, so the
workflow reports its own failures and its liveness must be checked by hand.

The default is two bounded checks: per-host concurrency/pacing and a 60-request
throughput window. It runs one file at a time with a five-minute job cap. The
full ten-file capacity suite is manual only: choose `suite: full` in the
workflow or run `pnpm run test:stress:full` locally; its job cap is 45 minutes.
Manual and scheduled runs have separate cancellation groups.

The full selection contains these ingestion files:

| File                                            | Coverage                                                        |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `capacity-tier-admission.stress.spec.ts`        | Tier request admission; fetches no bodies                       |
| `game-reconciliation-scale.stress.spec.ts`      | Native 1,001-Product candidate callback and elapsed budgets     |
| `native-printing-images.stress.spec.ts`         | Native publication, serving and export of 128 images            |
| `reconciliation-evidence-volume.stress.spec.ts` | Retained evidence volume                                        |
| `reconciliation-scale.stress.spec.ts`           | Large Card/Product publication and restore, images and warnings |
| `runtime-capacity-resume.stress.spec.ts`        | Capacity pause and resume                                       |
| `runtime-collection-completion.stress.spec.ts`  | Collection completion at volume                                 |
| `runtime-collection-throughput.stress.spec.ts`  | Bounded collection throughput                                   |
| `runtime-discovery-scale.stress.spec.ts`        | Discovery at volume                                             |
| `runtime-host-pacing.stress.spec.ts`            | Independent-host concurrency and pacing                         |

Run volume measurements with exclusive host resources and record the exact
commit, runtime, complete selection and every failure. Keep the candidate's
15,000 ms performance assertion separate from test deadlines and from CPU or
billing measurements. A bounded pass does not replace the full selection; a
full pass does not certify the 5/50 GiB tiers, whose admission test fetches no
bodies. Issue #275 owns usable capacity and accounting; #276 owns uncovered
durable faults.

Each workflow retains a seven-day `stress-results-bounded` or
`stress-results-full` JSON artifact with the complete test selection, failures,
durations and native callback report. Archive relevant evidence before expiry.
If a job dies before the reporter finishes, its missing artifact is incomplete
evidence, not an empty successful selection.

Use the existing focused diagnostics workflow for an isolated stress file:

```sh
gh workflow run test-suite-diagnostics.yml --ref <branch> \
  -f worker=ingestion -f suite=stress -f storage=memory \
  -f files='apps/ingestion/test/game-reconciliation-scale.stress.spec.ts' \
  -f repeats=1
```

Hosted full stress and `storage=memory` stress diagnostics use a disposable
2 GiB tmpfs; bounded stress and routine CI use 512 MiB. Capacity fixtures exceed
the smaller volume. The wrapper prints occupied bytes before removing the volume.
Use `storage=disk` for a controlled storage comparison. Focused results do not
replace full stress or routine CI.

The API currently has no separate stress files; its functional checks run in
the normal API suite. Missing expected ingestion tests remain an error. Add
API performance coverage explicitly before extending the stress selection.

## Failure reporting

When the `stress` job fails, the `report-failure` job opens a GitHub issue
titled `stress: scheduled stress suite failed` with the label `bug`, or
comments on that issue while it is still open, with the run link, trigger,
and commit. Close the issue once its recorded acceptance is met, including
full-selection verification when required; a green bounded run alone does not
resolve a tracked full-suite failure. The next failure
opens a fresh one. The `stress` job itself keeps a read-only token; only
`report-failure` holds `issues: write`.

## Cron liveness

A quiet schedule is not a passing schedule. GitHub silently stops a cron
when:

- the repository has had no activity for 60 days (GitHub disables the
  schedule and emails the last actor who touched the workflow file);
- the last actor to modify `stress.yml` loses write access to the
  repository, or the workflow file is changed on a branch other than `main`
  (schedules run only from the default branch);
- the workflow was disabled by hand.

None of these fail a run, so `report-failure` never fires and no issue is
opened. Check at least monthly, and after any long quiet period:

```sh
gh workflow view stress.yml --repo KeeprDigital/card-keepr      # state must be active
gh run list --workflow stress.yml --limit 3 --repo KeeprDigital/card-keepr
```

The latest run must be no older than the schedule interval (seven days).
If the workflow is disabled, re-enable it and run it once:

```sh
gh workflow enable stress.yml --repo KeeprDigital/card-keepr
gh workflow run stress.yml --repo KeeprDigital/card-keepr
```

A commit to `main` also resets the 60-day inactivity clock.
