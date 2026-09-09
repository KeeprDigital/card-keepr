# Private launch execution handoff

Use [#216](https://github.com/KeeprDigital/card-keepr/issues/216) as the current
specification and launch tracker. This handoff follows the 9 September 2026 audit
and cleanup. The owner confirmed a private first release; commercial access in
#269 is deferred and does not block launch.

## Start from the current state

Read the repository instructions, CONTEXT.md, relevant ADRs, and the full current
issue bodies/comments before implementation. Fetch main and recompute native
GitHub dependencies. Check whether the audit cleanup PR is merged before
reimplementing its #270 fix, #253 entrypoint fix or small parser cleanup.
If existing CI failures prevent integration, start the independent foundations
and diagnose #271 against the cleanup commit. Stack dependent reliability fixes
on that commit when necessary, then integrate the verified combined result and
update the issue dependencies. Keep the cleanup's implementation status distinct
from its pending merge and the wider validation result.

The ordinary checkout was fast-forwarded from 9cfc5dd to 51e1c83f after preserving
all 26 local edits. Git tag `codex-preserved-pre-audit-20260909` points to the stash
commit, including its untracked parent. The hash-verified original files and
six-file toolchain patch remain at
`/Users/marcus/Developer/card-keepr-worktrees/preserved-pre-audit-20260909`.
#272 owns reconciliation of that toolchain patch against current main.

## Ordered waves

The native dependency graph is authoritative. These groups are the initial
execution plan; refresh them when new evidence or merged work changes the graph.

| Wave or lane | Work | Completion boundary |
| --- | --- | --- |
| Cleanup integration | Review/integrate the audit cleanup PR for #270, small parser cleanup, README and #253's entrypoint. | Exact reviewed commit integrated; #253 stays open until the complete stress result is acceptable. |
| Wave 1: independent foundations | #267 active-source recapture; #272 compatible toolchain update; #273 realistic fixtures and source/storage census. | Each ticket has reviewed implementation and its required evidence. Capture the original #271 failure baseline before changing toolchain; final reliability validation follows #272. |
| Wave 2: reliability and publication | #271 final suite reliability after #270/#272, with #253 stress diagnosis in the same lane; #274 native publication/image migration in parallel. | Implementations integrated and validated on the selected runtime. Coordinate shared source files and run heavy suites serially. |
| Wave 3: proof | #275 usable capacity after #273/#274/#271; #276 durable fault and actual composed recovery after #274/#271; finish #253's full stress and scheduled/manual Actions proof once required fixes are integrated. | Evidence names exact tested commits, distinguishes usable capacity from rejection, and records remaining failures. Measurement has exclusive host resources. |
| Release lane | Resolve #236's human/account prerequisite; reconcile existing PR #246; then #237 manual staging and #238 automatic production. | Actual isolated environments and guarded exact-commit release evidence, with the accepted credential boundary. |
| Handoff lane | #239 after final relevant schema/publication changes and #271; reuse merged protocol from PR #264. | Prerequisite released through the pre-fold runtime and supported live handoff proven. |
| Final convergence | Close #268 only after all four children satisfy the original combined criteria; complete #240; refresh PR #204/#136 from the final schema. | Enabled-game journeys, capacity, recovery and rollout proven; separate explicit owner Go-Live declaration. Close #151/#216 only when their acceptance is complete. |

Source recapture #267 and the full stress outcome #253 remain explicit blockers
of the final rehearsal. #155 and PR #199 are closed as superseded; their useful
historical decisions remain linked from #216/#151. Existing completed structure
work stays closed.

## Implementation process

Use the owner's implement skill at
`/Users/marcus/.agents/skills/implement/SKILL.md`. It calls for TDD where possible,
regular typechecks and focused tests, a full suite at the end, code review, and
commits. Use established public API/CLI, adapter and existing runtime seams;
choose the lowest layer that proves the requested behavior. A new interface or
changed domain contract requires explicit discussion in its ticket.

Use one branch/worktree per ticket. Delegate only dependency-ready, independent
slices, with explicit file ownership. Keep one coordinator responsible for
integration, ticket status and evidence. Prefer three implementation agents at
most while the coordinator remains available. Each delegate should return its
commit, validation results, review findings, remaining constraints and any
shared-file conflict.

Run the Standards and Spec review axes independently against a fixed base. Merge
providers before dependants, update from main at each wave boundary, and repeat
only checks justified by integration changes or unresolved failures. The existing
release gate still requires all expected CI checks on the exact release SHA.
A green isolated rerun does not resolve a failing suite without a supported cause.

The runtime suites use significant local resources. Grant one heavy-test lease
per host; measure capacity with no competing test or profiler processes. Parallel
code/review work can continue while that lease is held. Prefer local scoped
verification while diagnosing; keep remote CI evidence distinct from local proof.

Keep moving on independent work while a human decision is pending. For live
provisioning, account/billing changes, deployment, destructive data operations or
Go-Live, first prepare the exact target, changes, validation and recovery plan for
the required operational authorization. A general backlog implementation request
does not supply those live approvals.

## Current verification caveat

Main 51e1c83f obtained Actions runners, but ingestion and acceptance checks failed
or were cancelled. The earlier runner/billing-only explanation is stale. #271
owns those failures; #268/#275/#276 own the remaining capacity/fault acceptance.
The cleanup does not certify launch readiness or erase historical failures.
