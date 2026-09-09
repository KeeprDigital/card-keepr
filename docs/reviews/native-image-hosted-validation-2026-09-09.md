# Native image hosted validation

The128×100KiB image functional proof introduced for#274 completes locally in18.15s, but its30s Vitest timeout expires on the slower hosted runner. Integration fbd090e4 CI34344025750 logged this test failing after36.57s, with preparation only just finished, and then produced no further test output before the36-minute job cancellation. The shard did not complete and is not green.

An isolated hosted diagnostic at633132d3 used the same integration application, dependency lockfile,128images and every original stream/reference/dimension/hash/owner/replay/export assertion. Only this test's orchestration bound was120s, matching the repository's existing multi-image completeness test. Run34347824440 completed naturally:1/1pass,78.11s test,83.25s Vitest, with no interruption. Its temporary manual-only workflow is not a release check and must not merge.

This change adopts that measured120s test bound. It changes no production deadline, resource/byte/callback allowance, workload size or correctness assertion. In particular, #253's15,000ms Product callback budget remains unchanged and failing on hosted runners. Final integrated CI is still required.

Evidence: [original integration run](https://github.com/KeeprDigital/card-keepr/actions/runs/34344025750), [isolated natural completion](https://github.com/KeeprDigital/card-keepr/actions/runs/34347824440). Raw logs are retained in /tmp/card-keepr-launch-20260909/integration-fbd-ingestion2-cancelled.log and image-hosted-duration-633132d3.log.
