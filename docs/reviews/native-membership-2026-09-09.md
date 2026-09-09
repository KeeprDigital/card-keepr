# Native membership publication — #274 / PR #294

Fixed implementation base: `cb42d860` (reviewed native no-change provider). The original completeness Product lifecycle assertion remains in the coordinator-owned test. This branch adds actual native publication proofs for membership-only observations.

## First Product slice

- `fa7e5cfab2bef849cf84e7de1a35c63bbfeea847`: the new native Product lifecycle test failed naturally because candidate Products were absent (1 failed, 4.001 s harness).
- `b0ce1d83b0a19728d9885bfb55a71461cc53f2f8`: first implementation failed naturally while retaining an unsupported checkpoint phase (1 failed, 6.059 s). The actual baseline SQLite constraint accepts `product_reduction:one-piece` and rejects `membership_preparation`; no schema relaxation was made.
- `a5b7755a7b0b9c01e19da981f8c0312d92a782c4`: the same test passed naturally (1/1; 8.967 s harness, 7.95 s Vitest, 5.70 s test). Membership preparation is a bounded substage of the existing Product checkpoint. Two native publications and faithful SQL export/restore verification preserve the inferred Product identity and aggregate first/latest observed lifecycle across related Printings. Four canceled-request warnings appeared during teardown and remain in the log; exit status was zero.

All three runs used Node 22.23.2, an exclusive runtime lease, the unchanged 30-second test deadline and a declared 180-second outer bound. None was interrupted. Full typecheck passed after the checkpoint correction; focused formatting/lint and diff checks passed, with pre-existing reducer lint warnings retained.

Raw log hashes, deterministic compressed logs, exact commands, clean commit identities, wall times and outcomes are in [the evidence manifest](evidence/native-membership-20260909/manifest.json).

## Remaining gates

This is an incomplete vertical slice. Native membership relationships and Distribution Contexts, explicit target precedence, checked/unchecked lineage history, replay/no-change, bounded continuation and large-text proofs remain. Independent fixed-base Standards/Spec reviews and final relevant validation have not yet been requested. PR #294 remains draft; this evidence does not establish #274 acceptance or a green full suite.
