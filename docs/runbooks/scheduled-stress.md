# Scheduled Stress Suite

`.github/workflows/stress.yml` runs `npm run test:stress` every Monday at
03:17 UTC and on `workflow_dispatch`. Nobody watches a scheduled run, so the
workflow reports its own failures and its liveness must be checked by hand.

The default is two bounded checks: per-host concurrency/pacing and a 60-request
throughput window. It runs one file at a time with a five-minute job cap. The
full nine-file capacity suite is manual only: choose `suite: full` in the
workflow or run `npm run test:stress:full` locally; its job cap is 45 minutes.
Manual and scheduled runs have separate cancellation groups.

The API currently has no separate stress files; its functional checks run in
the normal API suite. Missing expected ingestion tests remain an error. Add
API performance coverage explicitly before extending the stress selection.

## Failure reporting

When the `stress` job fails, the `report-failure` job opens a GitHub issue
titled `stress: scheduled stress suite failed` with the label `bug`, or
comments on that issue while it is still open, with the run link, trigger,
and commit. Close the issue once the run is green again; the next failure
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
