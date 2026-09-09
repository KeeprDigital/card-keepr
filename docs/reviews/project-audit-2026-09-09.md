# Card Keepr project and backlog audit

Reviewed 9 September 2026. **Keep the first release private and prioritise correctness and reliable validation, then capacity and the release path. The project is substantially implemented but is not ready for Go-Live.** The owner confirmed during this audit that paid access should be deferred.

This audit records the state before the subsequent cleanup. Its findings are pinned to main `51e1c83f`; the updated tracker and [execution handoff](../plans/private-launch-waves.md) record what happened afterward. The statements below about unchanged issues/code describe the audit phase only.

## Which project state is current?

| Surface | Verified state | Meaning |
| --- | --- | --- |
| Original local checkout | `main` at `9cfc5dd57b62d2c6460872a14f11e79d4d2b280b`; 694 commits behind GitHub; 26 changed/untracked files | An old checkout containing work from different efforts. It is unsuitable as the baseline for new implementation. |
| GitHub `main` | `51e1c83f64fb69abe82b190dc15918637c94f8dd`, merged 8 September | Includes [PR #266](https://github.com/KeeprDigital/card-keepr/pull/266), the bounded source-intake work for #233. |
| Review checkout | `codex/project-audit-20260909`, created from that exact GitHub commit | Used for inspection and focused local verification, preserving the original checkout. |
| Implementation specification | [#216](https://github.com/KeeprDigital/card-keepr/issues/216) | Current multi-publisher, private catalogue and staged-release requirements. |
| Current schema | Forward migrations through `0030_source_record_auxiliary.sql` | Older release and baseline drafts need reconciliation with this schema. |

The 26 local files fall into two groups:

- **20 documentation files:** the multi-publisher plan, ADRs, research and earlier review are associated with accepted planning commit `b73ddef6` and #216. Sixteen files are byte-for-byte identical to current GitHub `main`; the local legality note matches the accepted planning commit. The remaining glossary, README and release-runbook copies contain planning edits on older versions of those files. Reapplying those complete files would overwrite subsequent changes.
- **Six toolchain files:** `package.json`, its lockfile, two Vitest configurations and two test TypeScript configurations. These migrate to `@cloudflare/vitest-plugin` and update several dependencies. No matching ticket or commit was found in the inspected tracker/history. The earlier 5 September review already identified these as existing unrelated edits. Preserve and assess them as a separate change against current `main`.

Recommended checkout cleanup: retain a recoverable copy of all original edits; separate the six toolchain files into a reviewable patch; reconcile the already-merged documentation; only then update the ordinary checkout. Do not commit the mixed old tree as a new implementation of #216.

## Every open ticket

There are **13 open issues**: seven concrete launch work items, two scheduled-failure reports, three tracking/specification issues and one future product proposal. The repository should track a defined launch scope, rather than requiring every future idea to be closed before launch.

| Ticket | Verdict | Proposed correction or next action |
| --- | --- | --- |
| [#268 — Post-intake memory, capacity and publication cleanup](https://github.com/KeeprDigital/card-keepr/issues/268) | Keep; major launch blocker | Correctly carries work transferred from #233. Break execution into bounded child tasks: realistic workload/storage census; image and old-publication migration; memory/capacity measurements; remaining durable-fault and restore proof. Keep the parent open until the combined acceptance criteria pass. |
| [#253 — Scheduled stress failure](https://github.com/KeeprDigital/card-keepr/issues/253) | Keep; cause identified | The command finds no API stress files and exits before ingestion stress tests run. Replace the generic failure description with this reproduction and require the intended stress coverage to execute. Add `ready-for-agent`; retain `bug`. Coordinate capacity evidence with #268. |
| [#267 — Official-source recapture failure](https://github.com/KeeprDigital/card-keepr/issues/267) | Keep; narrow the diagnosis | The downloaded report has 59 byte drifts and one unchanged capture, with no `fetch_failed` or `invalid_golden` results. Review active source changes and distinguish semantic changes from cosmetic changes. Audit obsolete policy-only captures. Add `needs-triage`; do not describe all drift as parser failure or blindly refresh goldens. |
| [#236 — Automatic isolated dev](https://github.com/KeeprDigital/card-keepr/issues/236) | Keep; partly implemented | Draft #246 is unmerged and conflicted. Reconcile with current main, resolve the recorded account/credential-isolation choice, recheck capacity and complete the actual dev installation/release evidence. Use `ready-for-human` while that decision is the blocker, then return implementation work to `ready-for-agent`. |
| [#237 — Manual staging release](https://github.com/KeeprDigital/card-keepr/issues/237) | Keep; needed and unfinished | Its dependency on #236 is accurate. Implement exact-commit owner initiation and isolated staging validation after the dev foundation. Replace stale claims that no Actions runners are available with current evidence. |
| [#238 — Automatic production promotion](https://github.com/KeeprDigital/card-keepr/issues/238) | Keep; needed and unfinished | Dependency on #237 is accurate. Preserve automatic promotion of the exact successful staging commit through fresh production guards. The private-first decision does not remove this accepted prelaunch requirement. |
| [#239 — Fresh-baseline handoff](https://github.com/KeeprDigital/card-keepr/issues/239) | Keep; code merged, live proof pending | [PR #264](https://github.com/KeeprDigital/card-keepr/pull/264) implemented the local protocol. Update checklist/status to distinguish completed implementation from the still-unreleased prerequisite and live proof. Revalidate against schema 30. The remaining operational step is `ready-for-human`; no need to rebuild the protocol. |
| [#240 — Enabled-game launch rehearsal](https://github.com/KeeprDigital/card-keepr/issues/240) | Keep; still blocked | Replace the obsolete body reference to #233 with #268 and remove the stale statement that intake is unmerged. The native dependency already correctly includes #268. Preserve #238/#239 blockers and twice-completed journeys for each enabled game. |
| [#136 — Go-Live freeze](https://github.com/KeeprDigital/card-keepr/issues/136) | Keep; final step | Refresh the old schema-13 draft only after prerequisite schema work settles. Update the obsolete claim that the handoff protocol is unimplemented. Keep actual release, retention/recovery proof and the owner's separate Go-Live declaration explicit. |
| [#216 — Multi-publisher implementation specification](https://github.com/KeeprDigital/card-keepr/issues/216) | Keep as the canonical implementation tracker | Nineteen of the original 24 slices are closed; five remain open, plus follow-up #268. Clearly state that #233 closed by scope transfer, not successful capacity certification. Add current validation failures and the private-first decision to the next checkpoint. |
| [#151 — Environment-promotion initiative](https://github.com/KeeprDigital/card-keepr/issues/151) | Keep as a rollout umbrella | Its accepted scope is still valid and its native blocker #238 is accurate. Execute through #236–#238 rather than creating a second implementation stream. Refresh stale CI notes and retire conflicting historical design text from active instructions. |
| [#155 — Close every open ticket before Go-Live](https://github.com/KeeprDigital/card-keepr/issues/155) | Superseded execution map | Its old phases are completed and #216 explicitly makes it historical context. Transfer any remaining checkpoint information to #216, then close #155 as superseded. Do not use it to force deferred paid-access work into the private launch. |
| [#269 — Per-consumer identity, keys and limits](https://github.com/KeeprDigital/card-keepr/issues/269) | Defer commercial scope | Apply `needs-triage` and state “post-private-launch; not a launch blocker.” Paid tiers, quotas and third-party access conflict with the current first-release scope. Independent credentials for owned apps could still be useful; assess that smaller need separately if an integration requires independent revocation. Deferral is not `wontfix`. |

Do not reopen completed restructuring tickets merely because older reports mention the original problem. Verify the current implementation and use a focused regression ticket where needed.

## The three open pull requests

| PR | Assessment |
| --- | --- |
| [#246 — Isolated dev](https://github.com/KeeprDigital/card-keepr/pull/246) | Retain and reconcile for #236. GitHub reports merge conflicts; current main contains 396 commits absent from its branch. Its local checks are historical, and its description explicitly leaves live installation and the credential architecture unresolved. |
| [#204 — Go-Live baseline](https://github.com/KeeprDigital/card-keepr/pull/204) | Retain as prior work for #136, but do not merge as-is. GitHub reports conflicts; it folds the older schema-13 state while main is at schema 30. Regenerate its baseline and proof near final freeze. |
| [#199 — Environment design](https://github.com/KeeprDigital/card-keepr/pull/199) | Extract useful resource-isolation and recovery notes into current rollout work, then close as superseded. It preserves an older confirmation design, while ADR 0016 and #151's accepted scope require manual staging followed by automatic production promotion. |

## Current verification and operational findings

**Release-blocking validation is red, and the cause is no longer simply runner availability.** In [the latest main CI run](https://github.com/KeeprDigital/card-keepr/actions/runs/34223371172), lint, domain tests and the combined checks job passed. That checks job includes types, import guards, deployment dry runs and API tests. Ingestion shards 1 and 2 failed; shard 3 was cancelled. Acceptance shards 1 and 3 failed; shard 2 was cancelled.

The completed ingestion shards recorded **12 failed tests and 485 passes**. Failures include timeouts, immutable-object collisions, incomplete reconciliation and a run remaining in parsing. At least five acceptance scenarios failed: composed recovery, Digimon, Fusion World, One Piece two-source recovery, and Gundam. A cancelled shard contributes no successful completion evidence. These symptoms need classification; this audit does not attribute all of them to one production defect or to flakiness.

Create a focused validation-reliability ticket, linked to #268 and blocking the final rehearsal, with this exact run and commit. Reproduce failing families in their suite context, separate runtime/harness interference from application failures, and require the full intended checks on the release commit. Local successes do not waive the existing release gate. The curated-lookup file passes 2/2 in isolation here despite its CI collision; that is evidence of a context-sensitive failure, not a resolution.

**P2: the scheduled stress command does not reach its existing ingestion suites.** [package.json line 22](https://github.com/KeeprDigital/card-keepr/blob/51e1c83f64fb69abe82b190dc15918637c94f8dd/package.json#L22) runs the API stress selection first using `&&`. There are no matching API stress files. The command reproduced locally with exit 1 and “No test files found,” matching [the #253 run](https://github.com/KeeprDigital/card-keepr/actions/runs/34100293889). Explicitly select the intended suites and preserve useful API performance coverage if it remains a requirement. Avoid a blanket “empty suites pass” setting that could conceal missing ingestion coverage.

**Recapture needs better signal.** [The #267 run](https://github.com/KeeprDigital/card-keepr/actions/runs/34207274268) detects raw-byte differences, not semantic parser failures. A sampled Fusion World page differs only in a page token and asset-version strings. One HTTP/URL change is the old One Piece restriction-policy URL, outside the accepted card-content scope. These observations do not prove all 59 changes are harmless. Preserve raw evidence, validate current adapters and classify structural/card-content changes separately from cosmetic drift; review references before retiring policy fixtures. The current directory-wide monitor still includes ten policy/legality-named captures.

**The README is materially stale.** It describes Bandai-only data, says eligibility removal is still planned, and says production Card adapters remain unavailable. Main includes Riftbound and merged card-content changes. Update [README](https://github.com/KeeprDigital/card-keepr/blob/51e1c83f64fb69abe82b190dc15918637c94f8dd/README.md) to the implemented scope and supported owner journey; finalise the publication instructions with #268 and the environment instructions with #236–#238. Historical reviews should remain explicitly historical.

**Dependency upkeep deserves a separate patch.** A fresh audit of the current lockfile reports nine flagged package entries in the development/tooling graph (seven high and two moderate), while `npm audit --omit=dev` reports zero. This does not establish exploitable production exposure. Reconcile the six local toolchain edits against current packages, including the pinned Miniflare used by acceptance tests, and validate the resulting combination. Do not apply the old lockfile wholesale or use an automatic forced downgrade as the remediation plan.

## Standards

The independent Standards review covered the production changes in `git diff 0bb3b7d...51e1c83f`, against the repository instructions, glossary and relevant ADRs. It found **no hard documented-standard breaches** and two low-priority maintainability findings:

1. **Possible duplicated code:** [bounded-page-extraction.ts line 173](https://github.com/KeeprDigital/card-keepr/blob/51e1c83f64fb69abe82b190dc15918637c94f8dd/src/catalogue/adapters/bounded-page-extraction.ts#L173) and [riftbound-source-adapter.ts line 406](https://github.com/KeeprDigital/card-keepr/blob/51e1c83f64fb69abe82b190dc15918637c94f8dd/src/catalogue/adapters/riftbound-source-adapter.ts#L406) wrap the same streamed-member parser and translate the same errors. Share the small adapter-level wrapper so error classification remains consistent.
2. **Possible speculative generality:** [reconciliation-source-observation.ts line 12](https://github.com/KeeprDigital/card-keepr/blob/51e1c83f64fb69abe82b190dc15918637c94f8dd/src/catalogue/reconciliation/reconciliation-source-observation.ts#L12) retains an unused `_runId` argument after records moved to the sealed Source Observation Set. Remove it and update internal callers together.

The broader cleanup priority is already in #268: inventory and intentionally migrate callers of the old run-approval publication path, then remove it. Both `run approve` and the native game publication operations remain exposed, and the old aggregate-size guard still exists. Do not delete the old route before its supported callers have a migration path. Avoid another broad restructuring campaign while correctness and capacity proof are unsettled.

Standards: **0 hard violations; 2 possible smells.** The higher-impact smell within this axis is duplicated parser-error classification.

## Spec

**P2 — A document response can bypass source validation when labelled as an image.** In [source-evidence-parsing.ts lines 110–119](https://github.com/KeeprDigital/card-keepr/blob/51e1c83f64fb69abe82b190dc15918637c94f8dd/src/catalogue/source-evidence/source-evidence-parsing.ts#L110), the image branch is chosen either by the planned request identifier or by the response media type alone. A non-image card-list request returning `image/png` therefore skips the adapter's document validation and produces an empty extraction.

The focused proof calls the real `parseSnapshot` boundary with a stored One Piece card-list snapshot. The registered Bandai parser rejects the same input, but the intake path accepts it and persists a sealed Source Observation Set with `observation_count = 0`. This is a parse-boundary proof, not a claim that a production catalogue was erased or that downstream coverage guards cannot stop publication.

The intake plan explicitly requires that “malformed structure and incomplete required surfaces never seal an authoritative empty set” ([bounded-source-intake.md](https://github.com/KeeprDigital/card-keepr/blob/51e1c83f64fb69abe82b190dc15918637c94f8dd/docs/plans/bounded-source-intake.md#L228)). This also contradicts #216 story 10: “I want required structure and identity failures to remain blocking,” and the bounded-intake design's fail-closed requirements. Classify image requests from their planned role, then validate that role's expected response. A document request with an image media type must fail as a source-contract error; a real image request must retain its existing tolerated-missing-image semantics. Add regressions for both directions. Track this as a focused defect in the merged #266 implementation, independent of #268's accepted capacity deferrals.

The review found no additional confirmed implementation defect in its inspected scope. Memory, full-tier capacity, image-path work and retirement of the old publication path are explicitly deferred to #268; they are not concealed completions of #233. The original targets remain unresolved until measured on the resulting implementation.

The [retained reproduction](project-audit-2026-09-09-evidence/media-type-reproduction.spec.ts.txt) and [test output](project-audit-2026-09-09-evidence/media-type-reproduction.log) make the finding reviewable. The historical [test configuration](project-audit-2026-09-09-evidence/media-type-reproduction.vitest.config.mts.txt) points to the audit checkout.

Spec: **1 confirmed correctness finding**, the media-type validation bypass. No end-to-end data-loss claim is made.

## Recommended order

1. **Establish the working baseline.** Preserve the mixed checkout, use current main for new work, and apply the factual backlog/status corrections above. Keep paid access outside private launch scope.
2. **Close immediate correctness and verification gaps.** Fix the source media-type bypass; fix #253's empty-suite command; classify the current main CI failures; review #267's active-source changes. Give the CI failures their own bounded work item so they do not disappear inside capacity research.
3. **Complete #268 through small, reviewable deliverables.** Use realistic paginated/image-URL fixtures, retire redundant publication/image buffering paths deliberately, measure supported workloads, then finish the durable-fault and actual restore proof. Distinguish useful capacity from safe guard rejection. Record exact tested commits and unresolved results.
4. **Complete the accepted release sequence.** Reconcile #246/#236 and its human prerequisite, then #237, then #238. Complete #239's live prerequisite through the supported guarded path and revalidate the schema transition. These operations need their own concrete deployment scope; this audit has performed none.
5. **Rehearse and freeze.** Run #240 for every game intended to be enabled, refresh #204/#136 from the final schema, prove recovery/retention and obtain the separate Go-Live declaration. Close the #151/#216 umbrellas only when their actual acceptance conditions are fulfilled.

The next implementation session should begin with the media-type regression and the stress-entrypoint fix, followed by a focused validation-reliability investigation. Per-consumer billing, new publishers and another general refactor are lower priority than proving the catalogue already built.

## Evidence and limits

- GitHub was queried for all 13 open issues, their comments/labels and blocking edges, the 25 children of #216, all three open PRs, the latest main CI job results and logs, and the scheduled recapture artifact. Nothing was posted to GitHub.
- Main was pinned to `51e1c83f`; the latest-merge code review used `0bb3b7d` as its fixed base. The original checkout and all 26 changed files were preserved.
- Local checks on the pinned main: 13/13 focused parser/serialization tests passed; curated-lookup runtime file 2/2 passed; the stress command reproduced exit 1; the isolated media-type proof 1/1 passed by asserting the erroneous acceptance. That last pass demonstrates the defect, not correct behavior.
- Dependency audit results are a dated snapshot. Production dependencies had no reported advisories; development-tooling advisories require reachability and compatibility assessment.
- The independent review initially lacked installed dependencies. Dependencies were subsequently installed in the audit checkout, and the focused checks above supersede that initial limitation.
- This was a risk-focused project audit and a deeper review of the latest intake change. It was not an exhaustive review of every source line, a full local-suite rerun, a live capacity certification, or an inspection of the deployed production state. Current CI failures remain unresolved.

The compact [audit snapshot](project-audit-2026-09-09-evidence/audit-snapshot.json) retains issue identities, CI job outcomes, recapture classifications and dependency-audit counts without the large raw runtime logs.
