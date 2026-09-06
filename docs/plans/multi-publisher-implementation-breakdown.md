# Published implementation breakdown

Approved and published under [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216). The 24 implementation tickets carry their approved acceptance criteria, `ready-for-agent` labels, native sub-issue relationships and direct blocking dependencies. GitHub issues are the canonical execution records; the issue bodies below preserve the approved breakdown as a local planning record.

## Published tickets

1. [Card-content API and exports](https://github.com/KeeprDigital/card-keepr/issues/217)
2. [Eligibility processing removal](https://github.com/KeeprDigital/card-keepr/issues/218)
3. [Retained real-source evidence](https://github.com/KeeprDigital/card-keepr/issues/219)
4. [Shared Game Profiles](https://github.com/KeeprDigital/card-keepr/issues/220)
5. [Canonical source mappings](https://github.com/KeeprDigital/card-keepr/issues/221)
6. [Supplemental entity admission](https://github.com/KeeprDigital/card-keepr/issues/222)
7. [Identity and owner corrections](https://github.com/KeeprDigital/card-keepr/issues/223)
8. [Source-scoped refresh](https://github.com/KeeprDigital/card-keepr/issues/224)
9. [Bounded game candidates](https://github.com/KeeprDigital/card-keepr/issues/225)
10. [Complete candidate inspection](https://github.com/KeeprDigital/card-keepr/issues/226)
11. [Verified publication preparation](https://github.com/KeeprDigital/card-keepr/issues/227)
12. [Atomic game publication](https://github.com/KeeprDigital/card-keepr/issues/228)
13. [Composed catalogue recovery](https://github.com/KeeprDigital/card-keepr/issues/229)
14. [Reference-safe evidence cleanup](https://github.com/KeeprDigital/card-keepr/issues/230)
15. [One Piece two-source catalogue](https://github.com/KeeprDigital/card-keepr/issues/231)
16. [Riftbound catalogue](https://github.com/KeeprDigital/card-keepr/issues/232)
17. [Capacity and fault proof](https://github.com/KeeprDigital/card-keepr/issues/233)
18. [Protected failure diagnostics](https://github.com/KeeprDigital/card-keepr/issues/234)
19. [Exact-commit release gates](https://github.com/KeeprDigital/card-keepr/issues/235)
20. [Automatic isolated dev](https://github.com/KeeprDigital/card-keepr/issues/236)
21. [Manual staging release](https://github.com/KeeprDigital/card-keepr/issues/237)
22. [Automatic production promotion](https://github.com/KeeprDigital/card-keepr/issues/238)
23. [Fresh-baseline handoff](https://github.com/KeeprDigital/card-keepr/issues/239)
24. [Enabled-game launch rehearsal](https://github.com/KeeprDigital/card-keepr/issues/240)


The existing [Automated environment promotion: dev and staging environments, changelog generation, and hands-off production deployment](https://github.com/KeeprDigital/card-keepr/issues/151) remains the rollout completion index; the release slices below satisfy it rather than creating a duplicate rollout initiative. The existing [Go-Live freeze: fold migrations into the baseline and start version retention](https://github.com/KeeprDigital/card-keepr/issues/136) remains the final cutover issue and is already blocked by the replacement specification. It additionally depends on completed rollout, the enabled-game rehearsal and fresh-baseline handoff through native blocking relationships.

Dependencies below are prerequisites, not suggested scheduling order. Evidence capture, diagnostics, release safeguards and initial contract replacement can begin independently. No general codebase refactor is proposed: start from verified current main and preserve unrelated working-tree edits. Temporary internal compatibility for a wide prelaunch removal must have a named removal endpoint; do not maintain a second consumer contract. Atomic game publication and Composed catalogue recovery may share an integration branch if needed: green end-to-end publication/recovery is required at their joint checkpoint before merge, not claimed by an intermediate branch.

## Approved dependency index

| Slice | Direct blockers | Observable result |
| --- | --- | --- |
| 1. Card-content API and exports | None | Consumers receive in-scope card facts and explicit unknowns, with matching API/export contracts and no eligibility or administrative provenance surfaces. |
| 2. Eligibility processing removal | Card-content API and exports | A refresh and guarded release succeed without acquiring, reconciling or testing tournament eligibility. |
| 3. Retained real-source evidence | None | A dated, replayable evidence pack establishes the selected source shapes, matching examples and declared coverage. |
| 4. Shared Game Profiles | Eligibility processing removal | Sources with differing presentation publish small representative catalogues through the same game semantics and explicit authority policy. |
| 5. Canonical source mappings | Shared Game Profiles | The same real Printing observed through different source identifiers retains one stable consumer-facing identity. |
| 6. Supplemental entity admission | Canonical source mappings | The owner and permitted supplemental authorities can introduce real Cards and Printings through auditable Entity Proposals. |
| 7. Identity and owner corrections | Supplemental entity admission | Owners can repair identity and accepted facts while consumers can reconcile stable references and historical decisions remain intact. |
| 8. Source-scoped refresh | Shared Game Profiles | An owner refreshes declared source/subset coverage while unselected or unavailable optional sources retain truthful accepted facts. |
| 9. Bounded game candidates | Canonical source mappings, Source-scoped refresh | Reconciliation produces one sealed, partitioned candidate per game with inspectable durable progress and bounded resource use. |
| 10. Complete candidate inspection | Bounded game candidates, Identity and owner corrections | The owner can inspect every proposed fact, relationship, image and evidence decision consistently before approving a game candidate. |
| 11. Verified publication preparation | Bounded game candidates | Durable preparation produces verified immutable image, export and query/search artifacts without exposing partial data. |
| 12. Atomic game publication | Complete candidate inspection, Verified publication preparation | An exact approved game candidate advances the visible catalogue composition atomically through a promptly acknowledged durable operation. |
| 13. Composed catalogue recovery | Atomic game publication | Every published composition has verified restore evidence, and actual recovery safely fences all mutation and classifies pending work. |
| 14. Reference-safe evidence cleanup | Composed catalogue recovery | Unused terminal work can be reclaimed after 30 days without deleting published, decision, paused or recovery evidence. |
| 15. One Piece two-source catalogue | Retained real-source evidence, Supplemental entity admission, Source-scoped refresh, Composed catalogue recovery | Complete declared One Piece coverage from Bandai and Limitless publishes with verified matching, supplemental admission and recovery. |
| 16. Riftbound catalogue | Retained real-source evidence, Supplemental entity admission, Source-scoped refresh, Composed catalogue recovery | Actual Riftbound source data publishes through the same core with truthful publisher-specific fields, text and image semantics. |
| 17. Capacity and fault proof | One Piece two-source catalogue, Riftbound catalogue, Reference-safe evidence cleanup | Measured real and synthetic workloads demonstrate bounded operation, integrity and recovery under the accepted stress matrix. |
| 18. Protected failure diagnostics | None | Unexpected API and ingestion failures retain useful bounded cause information correlated to requests without leaking sensitive data. |
| 19. Exact-commit release gates | None | A release can proceed only on successful complete expected CI for the exact commit being deployed. |
| 20. Automatic isolated dev | Exact-commit release gates | Passing merges deploy to dev automatically with fully isolated resources and environment-scoped operational tooling. |
| 21. Manual staging release | Automatic isolated dev | The owner starts a release attempt for an exact commit and validates it in isolated staging. |
| 22. Automatic production promotion | Manual staging release | Successful staging validation automatically promotes the same selected commit through fresh production guards without another routine approval. |
| 23. Fresh-baseline handoff | Composed catalogue recovery, Exact-commit release gates | The pre-fold runtime can transfer authority safely to a fresh baseline through the supported guarded release path. |
| 24. Enabled-game launch rehearsal | Capacity and fault proof, Protected failure diagnostics, Automatic production promotion, Fresh-baseline handoff | Each game intended for consumers has recorded real-source journeys and the full deployment/recovery prerequisites have executable evidence. |

## Approved issue bodies

### 1. Card-content API and exports

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** Consumers receive in-scope card facts and explicit unknowns, with matching API/export contracts and no eligibility or administrative provenance surfaces.

**Blocked by:** None (can start immediately)

**Acceptance criteria**

- [ ] Remove eligibility endpoints/fields and consumer provenance, confidence, confirmation, source-health and admission filters; ordinary published records remain visible.
- [ ] Preserve printed and publisher-corrected text, images, Products, Releases, Distribution Contexts and meaningful identity/lifecycle relationships.
- [ ] Update current API/export schemas, serialization, CLI consumer behavior and acceptance cases in place; retain unrelated authentication, search, pagination, range/conditional and guarded export-deletion contracts.
- [ ] Mark conflicting historical prototype contracts as superseded. Temporary retained internal processing is removed by Eligibility processing removal; no permanent legacy consumer contract remains.

### 2. Eligibility processing removal

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** A refresh and guarded release succeed without acquiring, reconciling or testing tournament eligibility.

**Blocked by:** Card-content API and exports

**Acceptance criteria**

- [ ] Remove obsolete acquisition dependencies, entities/projections, parser obligations, admission/publication gates and administrative/CLI eligibility surfaces.
- [ ] Replace tests, production smoke targets and runbook/freeze obligations together; preserve in-scope publisher correction evidence even when hosted on mixed-content pages.
- [ ] Remove obsolete schema/seed and integration machinery through guarded prelaunch evolution; do not leave permanent unknown eligibility placeholders.
- [ ] Demonstrate source collection through publication and release smoke behavior with only the accepted card-content requirements.

### 3. Retained real-source evidence

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** A dated, replayable evidence pack establishes the selected source shapes, matching examples and declared coverage.

**Blocked by:** None (can start immediately)

**Acceptance criteria**

- [ ] Retain raw responses, headers/timestamps, digests and relevant images for Bandai/Limitless One Piece and actual Riftbound sources.
- [ ] Verify a cross-source same-Printing match and a genuine supplemental-only Printing within explicitly bounded official coverage; counts and distribution labels alone are insufficient.
- [ ] Record complete declared English coverage boundaries and census inputs; distinguish real findings from provider claims and synthetic examples.
- [ ] Include representative Riftbound identifiers, corrected content and face/treatment evidence. Label new-Card synthetic admission cases; report missing required real evidence as a failed gate.
- [ ] Provide replay inputs and expected source facts usable independently of production adapter implementation; no live network dependency in deterministic replay.

### 4. Shared Game Profiles

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** Sources with differing presentation publish small representative catalogues through the same game semantics and explicit authority policy.

**Blocked by:** Eligibility processing removal

**Acceptance criteria**

- [ ] Register Publisher, Source/Lineage and adapter-to-Game-Profile boundaries with applicable English locale and release-region scope.
- [ ] Expose owner administration for authority selection separately from source ownership, contribution and transport permission; no silent takeover/fallback.
- [ ] Demonstrate at least two source presentations through shared typed semantics at the CLI/API boundary; concrete full-source adapters follow separately.
- [ ] Preserve unknown optional source fields with actionable warnings and strict required structure failures; reproduce the Digimon optional-field regression.
- [ ] Keep prelaunch definitions in place and post-Go-Live attribution/version rules; fresh collection is the correction path and cross-version reparse is not promised.

### 5. Canonical source mappings

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** The same real Printing observed through different source identifiers retains one stable consumer-facing identity.

**Blocked by:** Shared Game Profiles

**Acceptance criteria**

- [ ] Allocate permanent opaque Card/Printing IDs independently of source lineage, publisher numbers and mutable compatibility fields; retain attributable mappings.
- [ ] Use game-specific exact-evidence matching with contradiction checks; owner administration can resolve ambiguity explicitly and inspect the evidence.
- [ ] Keep unknown/missing numbers truthful; URL changes and image re-encoding do not create variants.
- [ ] Replay Fusion World base/alternate records together and cross-source matching through candidate and consumer behavior; variants remain individually addressable.
- [ ] Persist mapping decisions in operational/recovery data; full composed-catalogue restoration is verified in Composed catalogue recovery.

### 6. Supplemental entity admission

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** The owner and permitted supplemental authorities can introduce real Cards and Printings through auditable Entity Proposals.

**Blocked by:** Canonical source mappings

**Acceptance criteria**

- [ ] Implement game/source admission rules, permitted automatic admission and explicit owner/manual admission without a universal corroboration count.
- [ ] Support proposal inspect/admit/link/reject/reconsider with retained history; automation cannot reverse an explicit owner rejection.
- [ ] Support attested exceptions while enforcing identified Card relationships and valid required structure; unresolved proposals stay unpublished.
- [ ] Disclose consistently isolated exclusions; contradictions in required identity/structure block when isolation cannot preserve consistency.
- [ ] Prove later unambiguous publisher confirmation attaches to the existing identity, confirms only evidenced facts and does not change authority.

### 7. Identity and owner corrections

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** Owners can repair identity and accepted facts while consumers can reconcile stable references and historical decisions remain intact.

**Blocked by:** Supplemental entity admission

**Acceptance criteria**

- [ ] Provide reviewed merge/split decisions with evidence, survivor redirects or replacement links; never choose a consumer-owned split variant automatically.
- [ ] Preserve prior published revisions/exports and mapping/admission history; publish corrections in a new revision.
- [ ] Integrate existing-entity Curated Revisions, explicit exceptions and material-change reaffirmation, replacement and retirement.
- [ ] Stricter policy prompts reassessment without automatic removal or ID churn; equal-authority conflicts remain explicit.
- [ ] Test changed-source and owner-reaffirmation flows, consumer correction links and internally consistent exclusions through the public boundaries.

### 8. Source-scoped refresh

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** An owner refreshes declared source/subset coverage while unselected or unavailable optional sources retain truthful accepted facts.

**Blocked by:** Shared Game Profiles

**Acceptance criteria**

- [ ] Fix required/optional participation and independently provable adapter scope before collection; no implicit authority reassignment.
- [ ] Test required outage and 99-of-100 capture blocking, explicit narrower retry and optional-source carry-forward.
- [ ] Expose successful check versus content/capture dates and no-change behavior in administration without consumer evidence leakage.
- [ ] Distinguish disappearance, source retirement, explicit withdrawal and reinstatement; preserve IDs and history.
- [ ] Classify semantic drift and preserve existing pacing, immutable request identity, capacity/retry/workflow pauses and collection recovery guarantees.

### 9. Bounded game candidates

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** Reconciliation produces one sealed, partitioned candidate per game with inspectable durable progress and bounded resource use.

**Blocked by:** Canonical source mappings, Source-scoped refresh

**Acceptance criteria**

- [ ] Pin exact selected evidence, policies/profiles, identity and admission decisions; permit concurrent collection while serializing the game candidate slot.
- [ ] Partition normalized records, relationships, evidence and candidate manifests; images are immutable references with integrity metadata.
- [ ] Return durable reconciliation identity/status; persist progress outside ephemeral workflow history, support exact idempotency and safe bounded retry/resume.
- [ ] Enforce byte/work budgets, subdivide high-degree content or give explicit capacity failure; never use a whole-game metadata/binary buffer.
- [ ] Seal before review and preserve the original seven-day creation deadline; fence superseded/abandoned workers and protect paused work.

### 10. Complete candidate inspection

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** The owner can inspect every proposed fact, relationship, image and evidence decision consistently before approving a game candidate.

**Blocked by:** Bounded game candidates, Identity and owner corrections

**Acceptance criteria**

- [ ] Expose full candidate and semantic before/after values against the exact Game Catalogue Revision through bounded pinned pages.
- [ ] Cover all in-scope entity/relationship classes, role-labelled images, identity/admission/correction decisions, exclusions, warnings, carry-forward and evidence-only changes.
- [ ] Summary counts reconcile with detail; images and supporting evidence are inspectable and no changed class is silently omitted.
- [ ] Missing/corrupt required artifacts prevent readiness; approval remains whole-candidate without mandatory per-item acknowledgement.
- [ ] Exercise product-only, release-only, image-only and evidence-only changes and stale/mixed page requests through administration.

### 11. Verified publication preparation

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** Durable preparation produces verified immutable image, export and query/search artifacts without exposing partial data.

**Blocked by:** Bounded game candidates

**Acceptance criteria**

- [ ] Stage and verify bounded image/object promotion, per-game export components and query/search projection batches with durable status.
- [ ] Reuse carry-forward and unrelated-game artifacts, including bounded hierarchical composition references.
- [ ] Exact retries reuse verified work; corruption, partial staging, lost requests and exhausted transient retry are distinguishable.
- [ ] Fence stale writers and check deadline/operation ownership; unfinished data is unavailable to consumers.
- [ ] Demonstrate bounded progress and recovery at each preparation stage without a whole-catalogue upload/transaction.

### 12. Atomic game publication

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** An exact approved game candidate advances the visible catalogue composition atomically through a promptly acknowledged durable operation.

**Blocked by:** Complete candidate inspection, Verified publication preparation

**Acceptance criteria**

- [ ] Persist exact approval before acknowledgement, bind the expected Game Catalogue Revision, and retain the original seven-day deadline through waits/resume.
- [ ] Use a small database-enforced all-or-nothing switch checking readiness, approval, predecessor, composition, writer generation, expiry and recovery health.
- [ ] Record result and reserve backup atomically; prevent later publication until its checkpoint is verified.
- [ ] Handle unrelated-game contention by refreshing bounded composition references without invalidating exact game approval; reject stale same-game predecessors.
- [ ] Prove complete composition-pinned API/pagination/export/image consistency, lost-response idempotency and no correction-date activation.

### 13. Composed catalogue recovery

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** Every published composition has verified restore evidence, and actual recovery safely fences all mutation and classifies pending work.

**Blocked by:** Atomic game publication

**Acceptance criteria**

- [ ] Bind backup to a consistent composition/database snapshot and verify it via Disposable Restore and representative API/invariant checks.
- [ ] Allow other games to prepare and receive approval during verification while blocking their final switches.
- [ ] Restore identity mappings, decisions, evidence references and consumer correction behavior; do not promise retention of operations newer than the snapshot.
- [ ] Globally fence actual Catalogue Recovery through validation and explicit acceptance; fence stale staged writers and classify restored operations.
- [ ] Exercise backup failure/retry, interruption, replacement targets and current-plus-two composition retention. Publication plus this slice form one integration checkpoint until the composed restore path passes.

### 14. Reference-safe evidence cleanup

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** Unused terminal work can be reclaimed after 30 days without deleting published, decision, paused or recovery evidence.

**Blocked by:** Composed catalogue recovery

**Acceptance criteria**

- [ ] Persist adjustable 30-day terminal-age eligibility, cleanup intent/progress/results and bounded resumable deletions.
- [ ] Retain evidence supporting published facts and owner decisions, plus live/paused/candidate/export/recovery references.
- [ ] Fence abandoned writers and recheck references immediately before deletion, including shared content and multipart constraints.
- [ ] Test exact age boundaries, interruption/retry, concurrently acquired references and protected historical data.
- [ ] Keep guarded Catalogue Export and operational backup retention distinct from unused-capture cleanup.

### 15. One Piece two-source catalogue

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** Complete declared One Piece coverage from Bandai and Limitless publishes with verified matching, supplemental admission and recovery.

**Blocked by:** Retained real-source evidence, Supplemental entity admission, Source-scoped refresh, Composed catalogue recovery

**Acceptance criteria**

- [ ] Implement the concrete source adapters/coverage contracts against the retained evidence and shared Game Profile.
- [ ] Carry the verified same-Printing and supplemental-only Printing through collection, proposal/mapping, candidate inspection, approval, ordinary API and export.
- [ ] Demonstrate official-only refresh, optional outage, missing identifiers and source conflict behavior without ID churn or fabricated freshness.
- [ ] Capture census/byte and amplification measurements for complete declared coverage and verify a restored result.
- [ ] Keep unproven physical matches/absence explicit; a failed real-evidence gate blocks completion.

### 16. Riftbound catalogue

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** Actual Riftbound source data publishes through the same core with truthful publisher-specific fields, text and image semantics.

**Blocked by:** Retained real-source evidence, Supplemental entity admission, Source-scoped refresh, Composed catalogue recovery

**Acceptance criteria**

- [ ] Implement the selected actual publisher adapter and English declared coverage using the shared registration/profile boundary.
- [ ] Preserve publisher/source aliases, printed/corrected text, Errata, release facts, treatment markers and face roles without Bandai-only coercion.
- [ ] Keep unknown or unavailable faces/numbers explicit; source announcements do not prove unobserved physical details.
- [ ] Demonstrate CLI collection through review/publication, authenticated consumer reads/images/export and restored identity/evidence.
- [ ] Record real census/byte measurements and representative boundary cases, distinct from synthetic stress data.

### 17. Capacity and fault proof

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** Measured real and synthetic workloads demonstrate bounded operation, integrity and recovery under the accepted stress matrix.

**Blocked by:** One Piece two-source catalogue, Riftbound catalogue, Reference-safe evidence cleanup

**Acceptance criteria**

- [ ] Exercise the reproduced 128 × 100 KiB image case through the pipeline and both accepted synthetic workload tiers.
- [ ] Record source/record/image/byte census, memory, CPU/wall time, calls, D1/index/write amplification, concurrent retained occupancy, billed dimensions and owner actions.
- [ ] Clearly distinguish successful usable capacity from correct guard rejection and synthetic cases from complete declared real-source workloads.
- [ ] Inject every durable-boundary interruption, duplicate/lost request, exhausted retry, corruption, expiry, late writer, composition contention, backup failure and cleanup race in the spec.
- [ ] Tune initial budgets transparently and derive cost/completion targets from measured evidence; report unresolved capacity as failure rather than weakening publication safeguards.

### 18. Protected failure diagnostics

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** Unexpected API and ingestion failures retain useful bounded cause information correlated to requests without leaking sensitive data.

**Blocked by:** None (can start immediately)

**Acceptance criteria**

- [ ] Preserve redacted internal classification and stack/cause reference for unexpected failures in both runtime problem mappings.
- [ ] Keep consumer errors stable and generic while administration/log correlation can distinguish missing objects, SQL failures and programming faults.
- [ ] Prove bearer keys, raw source payloads, bodies and sensitive provider details are excluded from diagnostic outputs.
- [ ] Exercise production-facing HTTP behavior and operational diagnostics rather than a source-text assertion.

### 19. Exact-commit release gates

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** A release can proceed only on successful complete expected CI for the exact commit being deployed.

**Blocked by:** None (can start immediately)

**Acceptance criteria**

- [ ] Remove the PR-head fallback; test green PR/red merge, missing/pending/failed shard and exact-SHA success.
- [ ] Verify runner availability and acquire fresh required checks; distinguish infrastructure allowance failures from failing application tests.
- [ ] Retain target/binding/schema/recovery guards, serialized release state and non-mutating CI behavior.
- [ ] Do not treat historical local merge checks as permission to bypass production CI or spend/change account billing automatically.

### 20. Automatic isolated dev

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** Passing merges deploy to dev automatically with fully isolated resources and environment-scoped operational tooling.

**Blocked by:** Exact-commit release gates

**Acceptance criteria**

- [ ] Parameterize target, route, secret and resource identity, including disposable-restore inventory and deletion; no cross-environment scratch collision.
- [ ] Verify current account capacity and replacement-recovery headroom before provisioning and retain concrete prerequisite evidence.
- [ ] Provision/configure the isolated dev path and environment-aware CLI operations through existing authorized deployment mechanisms.
- [ ] Prove passing exact-commit merges deploy only to dev; failure stops deployment and no staging trigger is introduced.
- [ ] Keep production credentials/data isolated and capture end-to-end dev deployment evidence.

### 21. Manual staging release

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** The owner starts a release attempt for an exact commit and validates it in isolated staging.

**Blocked by:** Automatic isolated dev

**Acceptance criteria**

- [ ] Provide one owner initiation that pins commit and release intent; later dev merges cannot replace it.
- [ ] Provision/configure isolated staging with environment-scoped recovery/cleanup and its own catalogue operations.
- [ ] Run the selected proportional validation scope and rehearse migrations from the production transition starting level.
- [ ] Persist staging outcome and stop on failure; no staging-on-merge and no staging data/interpretation copy into production.
- [ ] Preserve credential separation in the CLI/Actions authorization protocol and retain enough exact release evidence for guarded production continuation.

### 22. Automatic production promotion

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** Successful staging validation automatically promotes the same selected commit through fresh production guards without another routine approval.

**Blocked by:** Manual staging release

**Acceptance criteria**

- [ ] Implement exact release-intent/staging-result binding and fresh production target/schema/recovery/CI validation without forwarding an expired plan.
- [ ] Keep least-privilege credential separation; a changed credential boundary requires explicit architectural review instead of silently placing administration keys in Actions.
- [ ] Stop on stale production state, failed checks or competing release; prove commit substitution cannot succeed.
- [ ] Generate notes/changelog for the promoted commit, preserve guarded activation and post-deploy smoke behavior, and document failure/retry operations.
- [ ] Demonstrate the complete dev/manual-staging/automatic-production software flow while production Catalogue Candidate approval remains separate.

### 23. Fresh-baseline handoff

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** The pre-fold runtime can transfer authority safely to a fresh baseline through the supported guarded release path.

**Blocked by:** Composed catalogue recovery, Exact-commit release gates

**Acceptance criteria**

- [ ] Reuse and reconcile the existing reviewed handoff proposal with new schema, composition and recovery state.
- [ ] Implement and release the prerequisite protocol through the pre-fold runtime before attempting final folding.
- [ ] Prove restart, interruption and failure behavior without manual ledger copying or direct-deploy bypass.
- [ ] Preserve necessary evidence, identity and recovery authority; mark actual cutover readiness only after executable proof.
- [ ] Leave final fold and explicit Go-Live to the existing freeze issue.

### 24. Enabled-game launch rehearsal

**Parent:** [Implement the multi-publisher catalogue and staged release flow](https://github.com/KeeprDigital/card-keepr/issues/216)

**What to build:** Each game intended for consumers has recorded real-source journeys and the full deployment/recovery prerequisites have executable evidence.

**Blocked by:** Capacity and fault proof, Protected failure diagnostics, Automatic production promotion, Fresh-baseline handoff

**Acceptance criteria**

- [ ] Complete each enabled game journey twice with subsequent refresh, full inspection/approval, browse/search, images, export verification and recovery.
- [ ] Cover changed and no-change cases; retain One Piece two-source and actual Riftbound evidence and keep other games disabled unless their own gates pass.
- [ ] Record the exact staged/released software and schema, measured capacity limits and all release/diagnostic/recovery results.
- [ ] Confirm obsolete eligibility/provenance/version promises are absent from authoritative contracts, documentation, tests and release smokes.
- [ ] Refresh final-freeze inputs after all schema changes, but do not declare Go-Live or perform the final cutover as part of this rehearsal.

## Final existing issue

**Go-Live freeze: fold migrations into the baseline and start version retention** remains the existing final issue. After all implementation prerequisites, refresh and verify the final baseline fold, rehearse the final transition, preserve the chosen identifier suffixes and applicable retained-version rules, and obtain the owner's separate Go-Live declaration/date. Cross-version reparse and removed eligibility contracts are not reinstated. Completion of this draft, its specification or its decision map does not close the freeze.

## Handoff status

The owner approved this granularity and dependency structure. Ticket publication completes the planning handoff; implementation, real-source proof, environment rollout, measured capacity and Go-Live remain outstanding. The specification, rollout initiative and final freeze remain open.
