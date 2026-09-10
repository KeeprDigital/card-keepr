# Native membership publication — #274 / PR #294

Fixed implementation base: `cb42d860` (reviewed native no-change provider). The original completeness Product lifecycle assertion remains in the coordinator-owned test. This branch adds actual native publication proofs for membership-only observations.

## First Product slice

- `fa7e5cfab2bef849cf84e7de1a35c63bbfeea847`: the new native Product lifecycle test failed naturally because candidate Products were absent (1 failed, 4.001 s harness).
- `b0ce1d83b0a19728d9885bfb55a71461cc53f2f8`: first implementation failed naturally while retaining an unsupported checkpoint phase (1 failed, 6.059 s). The actual baseline SQLite constraint accepts `product_reduction:one-piece` and rejects `membership_preparation`; no schema relaxation was made.
- `a5b7755a7b0b9c01e19da981f8c0312d92a782c4`: the same test passed naturally (1/1; 8.967 s harness, 7.95 s Vitest, 5.70 s test). Membership preparation is a bounded substage of the existing Product checkpoint. Two native publications and faithful SQL export/restore verification preserve the inferred Product identity and aggregate first/latest observed lifecycle across related Printings. Four canceled-request warnings appeared during teardown and remain in the log; exit status was zero.

All three runs used Node 22.23.2, an exclusive runtime lease, the unchanged 30-second test deadline and a declared 180-second outer bound. None was interrupted. Full typecheck passed after the checkpoint correction; focused formatting/lint and diff checks passed, with pre-existing reducer lint warnings retained.

Raw log hashes, deterministic compressed logs, exact commands, clean commit identities, wall times and outcomes are in [the evidence manifest](evidence/native-membership-20260909/manifest.json).

## Membership target slice

`a07a4e67b16cd14568da469a1d5f788a98a28d55` failed the selected target test naturally (1 failed, 1 filtered; 6.734 s harness): the Product was present but the candidate Distribution Context was absent. `69fab028e7f4a7622fb353c048a3657f68c102a0` passed the same selected journey naturally (1 passed, 1 filtered; 6.249 s harness, 5.18 s Vitest, 2.95 s test). The sealed candidate now retains the derived targets and actual source evidence; public Products, contexts, relationships and Printing target projections are correct and exclude source buckets and private evidence. Two canceled-request warnings appeared during teardown; exit status was zero. These runs also used the unchanged 30-second testcase and 180-second outer bound with an exclusive runtime lease.

The deterministic relationship/context identities are shared with the historical exporter without changing their canonical input. Membership units check their byte budget before effects and retain a nested Product cursor after at most four units. Full typechecking, import boundaries and cycle checks pass; existing unrelated lint warnings remain.

`5d8838cf` separately addresses the pre-existing native publication leak of an `observed:false` Distribution Context. Its original red oracle is the unchanged disappeared-context case on capacity branch `51ce4e05`; exact post-fix proof is pending in that lane. The private candidate and history remain retained.

## Remaining gates

This is an incomplete vertical slice. Explicit target precedence, checked/unchecked lineage history, replay/no-change, bounded continuation and large-text proofs remain. The two-lineage history test is committed and queued; no history fix or green claim is implied. Independent fixed-base Standards/Spec reviews and final relevant validation have not yet been requested. PR #294 remains draft; this evidence does not establish #274 acceptance or a green full suite.
