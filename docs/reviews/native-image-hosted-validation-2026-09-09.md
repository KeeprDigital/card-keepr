# Native image hosted validation

The 128 × 100 KiB image functional proof introduced for #274 completes locally in 18.15s, but its 30s Vitest timeout expires on the slower hosted runner. Integration `fbd090e4` CI run 34344025750 logged this test failing after 36.57s, with preparation only just finished, and then produced no further test output before the 36-minute job cancellation. The shard did not complete and is not green.

An isolated hosted diagnostic at `633132d3` used the same integration application, dependency lockfile, 128 images and every original stream, reference, dimension, hash, owner, replay and export assertion. Only this test's orchestration bound was 120s, matching the repository's existing multi-image completeness test. Run 34347824440 completed naturally: 1/1 pass, 78.11s test, 83.25s Vitest, with no interruption. Its temporary manual-only workflow is not a release check and must not merge.

This change adopts that measured 120s test bound. It changes no production deadline, resource/byte/callback allowance, workload size or correctness assertion. In particular, #253's 15,000ms Product callback budget remains unchanged and failing on hosted runners. Final integrated CI is still required.

Evidence: [original integration run](https://github.com/KeeprDigital/card-keepr/actions/runs/34344025750), [isolated natural completion](https://github.com/KeeprDigital/card-keepr/actions/runs/34347824440). Raw logs are retained in `/tmp/card-keepr-launch-20260909/integration-fbd-ingestion2-cancelled.log` and `image-hosted-duration-633132d3.log`.
