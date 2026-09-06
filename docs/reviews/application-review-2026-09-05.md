# Card Keepr — prelaunch application review

> Subsequent scope decision, 6 September 2026: [ADR 0014](../adr/0014-card-content-without-tournament-eligibility.md) excludes tournament eligibility, ban lists, FAQs and rulings while retaining printed and publisher-corrected card content. Legality observations and recommendations below remain historical review evidence, not requirements for the replacement design. Reproduced defects are unchanged.

Reviewed 5 September 2026. **Recommendation: do not launch the four-game service in its current form.** The strongest problems concern real-data correctness and the ability to publish realistic catalogues, despite substantial passing test coverage.

**Baseline and scope.** Reviewed GitHub main `60415d00da0ccbc843eb92d0c8f6545dd15271c4`, isolated at `/tmp/card-keepr-review-60415d0`. The user's working tree remains at `9cfc5dd` with existing dependency/test-configuration edits; it was not reset or updated. Latest main was selected after identifying substantial already-completed fixes and presenting that scope choice. Findings below concern latest main, not defects already fixed since the older checkout.

The review covered the private API, CLI administration, source adapters, reconciliation, candidate approval/publication, storage boundaries, recovery design, CI/release controls, and tests. This is a catalogue service, not a collection-management frontend; absence of a graphical application is not a defect under the PRD. Requirements came from GitHub #22, implementation issues, CONTEXT.md, and ADRs. No production ingestion, deployment, credential change, or remote mutation was performed.

**Read the scope update at the end:** the owner subsequently clarified imminent support for other publishers and supplemental sources. Its identity, authority and coverage recommendations extend this review and supersede the original single-game-only validation plan.

Severity: **P1** = resolve before launch; **P2** = significant correctness, operability, or integration problem. Design recommendations and future contract gaps are labelled separately.

## Standards

**S1 · P1 · Replace image-bearing candidates with immutable image references.**

The current pipeline reads every retained image concurrently, converts it to base64, and places those bytes in the complete Catalogue Candidate. Publication then serializes that candidate and rejects it above 16 MiB. This creates a hard catalogue capacity ceiling unrelated to D1/R2 storage capacity.

A targeted executable proof called the real publication budget guard with 128 images of 100 KiB each. The raw image total was 13,107,200 bytes; the candidate was 17,526,322 bytes; the guard returned `422 publication_aggregate_too_large`. Card metadata was unnecessary to exceed the limit. This is a deterministic guard reproduction, not a claim that a full live catalogue was ingested. Eager concurrent image loading also creates a separate memory pressure risk before the guard runs. The aggregate carries previous images forward, so smaller incremental refreshes are not a general escape.

Evidence: [image loading](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/reconciliation/reconciliation-evidence.ts#L236), [base64 retention](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/reconciliation/reconciliation-evidence.ts#L1140), [publication guard](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/ingestion/publication-storage.ts#L180), [16 MiB limit](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/ingestion/run-types.ts#L8).

**Change:** retain only image identities, immutable evidence object references, byte lengths, media types and digests in candidates. Stream and verify object promotion in bounded durable steps. Keep atomic publication through a final revision-pointer transaction. Do not simply increase the size cap. Cloudflare likewise recommends streaming large payloads rather than buffering them in Worker memory. [Cloudflare guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

**S2 · P1 · Candidate inspection is insufficient for informed approval.**

Inspection returns changes for Cards, Printings and Legality Rules, plus warnings and curated effects. Official Products, Releases, Distribution Contexts, relationships, Printing Images and Errata have no dedicated semantic diff. Card/Printing changes are ID lists rather than before/after values. The endpoint does not expose the candidate itself as an alternative review surface.

A release-date-only change can be omitted from the normal inspection output while still being published. An immutable approval digest prevents technical substitution; it cannot help an owner evaluate changes they cannot see. This undermines the PRD's explicit candidate-diff requirement.

Evidence: [returned diff](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/ingestion/candidate-inspection.ts#L104), [inspection response](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/ingestion/administration-inspection.ts#L215), [PRD #22, story 47](https://github.com/KeeprDigital/card-keepr/issues/22).

**Change:** derive before/after differences for every published entity and relationship from the actual candidate and expected revision. Include evidence, identity decisions, missing observations and explicit lifecycle changes. Paginate large diffs. A generated local HTML review with image comparisons would improve owner usability without requiring a permanent administration web application.

**S3 · P2 · Publication is synchronous behind a ten-second CLI deadline.**

Approval awaits export storage, serial image verification/writes, and publication commit. The shared CLI client aborts requests after ten seconds and maps transport failures to `runtime_unavailable`, exit 9. A slow valid operation can therefore leave the owner with a transport failure and an unresolved mutation outcome. This is a code-path finding; no live timeout was induced.

Evidence: [synchronous publication](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/ingestion/publication-lifecycle.ts#L480), [serial images](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/ingestion/publication-storage.ts#L110), [CLI deadline](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/cli/lib/json-client.mjs#L36).

**Change:** atomically retain approval and return a durable operation reference. Let the CLI poll status and distinguish pending work from failure and unknown transport outcomes. Reconciliation also remains one large Workflow step; partition downstream work by a real byte/work budget. Treat this and S1 as one architectural replacement, not two unrelated rewrites.

Standards findings: **3**. Most severe: S1, the deterministic publication capacity failure. These are substantive design/correctness problems, not formatting violations; existing boundary and cycle checks pass.

## Spec

**P1 · P1 severity · Real Fusion World alternate art collides during identity resolution.**

The live HTML adapter supplies `null` artwork identity. Parsing the checked-in official ST01-001 and ST01-001_p1 pages produces distinct locators but identical complete Printing compatibility and generated Printing IDs; both identities are marked implicit. When these observations meet, the reconciliation guard produces `printing_match_insufficient_evidence`, blocking publication.

The targeted proof exercised the actual parser, observation normalization, compatibility builder and ID generation on the existing retained official pages. It proves the collision; the subsequent blocking branch was inspected. Existing real-source tests parse variants separately, while the synthetic normalization path supplies variant identity, allowing synthetic end-to-end tests to pass.

Evidence: [HTML identity construction](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/adapters/fusion-world-adapter.ts#L499), [blocking reconciliation branch](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/reconciliation/card-printing-reconciliation.ts#L436), [separate fixture tests](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/test/domain/official-source-raw-contract-fusion-world.test.mjs#L374).

**Change:** define sufficient publisher appearance evidence and stable identity rules for real variants, with explicit owner resolution when evidence is insufficient. Reconcile base and alternate variants together in a retained-real-source test. Removing the ambiguity guard would risk conflating Printings and is not a valid fix.

**P2 · P2 severity · An unknown optional Digimon mechanic fails the whole refresh.**

The adapter throws on every label outside a hardcoded list. Issue #33 explicitly requires unknown labelled mechanics to be retained verbatim and produce schema-review warnings.

A targeted proof parsed the existing 24-card official BT01 leaf, then inserted one optional `Future Mechanic` label/value pair without removing required fields. The adapter threw `Official Digimon Card List contains unknown field Future Mechanic`. Harmless additive publisher changes therefore prevent a refresh.

Evidence: [hard failure](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/adapters/digimon-adapter.ts#L352), [required behavior in #33](https://github.com/KeeprDigital/card-keepr/issues/33).

**Change:** retain unknown optional facts in Source Observations and produce actionable warnings. Keep required-field, identity and structural validation strict.

**P3 · Go-Live gap · Reparse promises exceed the implemented workflow.**

ADRs and CONTEXT promise that a new adapter version can reparse retained snapshots from Go-Live. The parser rejects any version different from the snapshot's capturing version, including reparse requests. Reconciliation also selects only observation sets whose parse intent is `collection`; there is no evident reparse-to-candidate selection path.

Evidence: [exact-version guard](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/source-evidence/source-evidence-parsing.ts#L53), [collection-only selection](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/reconciliation/reconciliation-evidence-repository.ts#L50), [freeze checklist #136](https://github.com/KeeprDigital/card-keepr/issues/136).

This is **future contract debt**, not a violation of ADR 0008's present one-version policy. Before freeze, implement compatible-lineage version selection and an explicit interpretation-to-candidate path, or amend the promise and defer the capability. A documentation-only freeze is insufficient.

Spec findings: **2 current defects and 1 Go-Live gap**. Most severe: the real Fusion World identity collision.

**Additional runtime and release findings**

**R1 · P1 · Release approval can use CI from a different commit than the deployed code.** The production workflow substitutes a merged PR's head SHA for the requested release SHA when reading check runs, then checks out/deploys the requested SHA. CI now runs on main specifically to catch interactions between merges, but release validation retains the older PR-head fallback. A green PR checked against an earlier main can pass this gate even when the final merge's CI is failing or pending. Later smoke checks run after activation and do not prove tree equivalence or replace full CI.

[Faulty substitution](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/.github/workflows/production-release.yml#L146). Require successful expected CI checks on the exact deployed SHA and verify the expected shard set. Replace the existing source-text assertion that preserves the fallback with behavioral gate tests: green PR/red merge, missing shard, pending job and exact-SHA success.

**R2 · P2 · Unexpected request failures lose their diagnostic cause.** Both problem mappers turn unknown exceptions into generic 500 responses without recording the error. The outer operational logger records status, route, duration and statement counts, but not a cause. A missing object, failed SQL query and programming exception can look identical in application logs. Returning generic errors to consumers is appropriate; discarding protected diagnostic context is not.

[API mapper](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/apps/api/src/problem.ts#L3), [ingestion mapper](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/apps/ingestion/src/problem.ts#L3), [request logger](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/http/operational-log.ts#L55). Record a bounded, redacted internal error classification and stack/cause reference tied to the request ID. Test that useful diagnostics survive without leaking bearer keys, bodies or sensitive provider details.

**Operational blocker observed:** GitHub CI on the reviewed main commit failed before running jobs. The check annotation says recent account payments failed or the spending limit needs increasing; this is not evidence of failing application tests. The open backlog map also records an Actions allowance problem. Restore runner availability and obtain exact-release-SHA verification before launch. Do not treat removing the gate as the routine solution. [Observed CI run](https://github.com/KeeprDigital/card-keepr/actions/runs/33856863691)

**What I would change, replace, remove, or defer**

These are product/architecture judgments, not additional asserted bugs.

- **Replace the whole-catalogue binary processing model.** Keep D1 for identities/projections and R2 for bytes. Stage large artifacts independently and publish only the final verified pointer. Preserve the existing correctness rules while simplifying data movement.
- **Prioritize one real consumer and one full game as a pilot.** Demonstrate collect → inspect → approve → browse/search → images → offline export → repeat refresh → recovery with realistic data. This narrows the current four-game launch scope and requires an explicit product decision. It provides a useful success criterion that closing tickets does not.
- **Defer automated environment promotion/changelog work (#151)** until complete-source ingestion and publication are reliable. It cannot compensate for the failures above.
- **Replace “byte changed” as the sole drift alarm with semantic checks.** The recapture script declares failure whenever any full response digest changes. Legitimate new products, cosmetic HTML, or dynamic page content can trigger it. Retain byte evidence, but distinguish expected content additions, parser failure, coverage loss and identity changes. Run the actual adapter against recaptured responses; prioritize actionable changes over routine publisher updates. [Current detector](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/scripts/recapture-official-bytes.mjs#L70)
- **Defer or remove features whose contract cannot be completed before launch**, especially the promised reparse path. Record the scope change in the relevant ADR; do not keep a misleading capability merely because the endpoint exists.
- **Do not rewrite the entire stack.** Separate read/mutation Workers, private object storage, immutable evidence, Card/Printing separation, explicit uncertain legality, revision-pinned pagination and final atomic visibility are good foundations. Latest main already fixed many structural problems from the old checkout. Another broad folder/repository refactor is lower value than correcting the runtime data model.
- **Keep security proportional to a private owner-operated service.** Current shared bearer credentials and dual-key rotation match the documented consumer model. No demonstrated issue here justifies introducing a multi-tenant identity platform. This review is not a penetration test or a review of live account policies.

**Recommended prelaunch order**

1. Resolve S1 and S3 together: referenced image bytes and bounded durable publication. Validate realistic full-game bytes, not only entity counts.
2. Resolve real-source Printing identity and unknown optional field handling; replay related official variants together.
3. Make the approval diff complete and usable. Demonstrate that product-only, image-only and relationship-only changes are visible.
4. Correct exact-SHA release verification, restore CI availability and preserve useful failure diagnostics.
5. Exercise one full-game consumer journey twice, including refresh, interruption/recovery, and export verification; record durations, request volume, image bytes, peak aggregate size and operator actions.
6. Resolve the version/reparse contract, then execute the Go-Live freeze. Add other games after the same evidence exists for them, or consciously accept a narrower initial release.

**Verification and limits**

| Check on latest main | Result |
| --- | --- |
| TypeScript checks | Passed |
| Domain suite | 27 files, 212 tests passed |
| API Worker suite | 11 files, 98 tests passed |
| Ingestion Worker suite | 60 files, 538 tests passed |
| Acceptance smoke | All 5 passed: four games plus retained-evidence CLI |
| Targeted review proofs | All 3 passed, demonstrating identity collision, image-budget rejection and Digimon optional-field failure |
| Lint | Exit 0; 36 warnings and 14 informational diagnostics |
| Catalogue cycle and boundary checks | Passed |
| Full acceptance suite, stress suite, generated-type check, deployment dry run | Not run during this review |
| Live production behavior/performance | Not exercised |

The ingestion test runtime emitted Miniflare Workflow warnings while passing all tests. No production defect is inferred solely from those messages. Passing tests establish useful regression coverage but do not rebut the targeted findings; they cover different scenarios.

Proofs remain in the isolated checkout under `test/domain/review-identity-proof.test.mjs`, `review-image-budget-proof.spec.ts`, and `review-digimon-warning-proof.test.mjs`. Image-budget output is `/tmp/card-keepr-image-budget-proof.json`; review logs are `/tmp/card-keepr-latest-*.log`. No application fixes, issue creation, or production changes were made.

**Scope update: multiple publishers and multiple sources per game**

The owner clarified after the initial review that non-Bandai games are imminent, and that additional sources must contribute cards/Printings missing from official catalogues, including promotional material. This changes the recommended architecture before launch. The findings above remain valid, but the original “one game” pilot should be expanded to test two sources for one game and a representative second publisher before the shared model is frozen. The additions below are gaps against the newly clarified scope, not retrospective violations of the old Bandai-only PRD.

**N1 · Foundational change · Separate canonical identity from source identity.** Current Printing ID generation hashes source lineage into the compatibility tuple, and matching requires the same lineage except for a special-case equivalence between the two Gundam English sources. Consequently, the same appearance observed on a newly registered source is not generally treated as the same Printing. Existing Card IDs are derived from game and official identity, which also needs explicit handling when a newly discovered promo lacks a reliable publisher identifier.

[Printing identity and matching](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/reconciliation/reconciliation-model.ts#L42)

Use persistent canonical Card/Printing IDs, with source-record identifiers and aliases mapped to them through retained resolution decisions. Matching evidence can evolve without changing the canonical ID. Model locale/edition, artwork, treatment and printed content explicitly where they distinguish a Printing. Do not merge solely on a card number, matching name, identical downloaded bytes, or apparent visual similarity. Support auditable merge/split corrections and explicit ambiguity review. Merely removing lineage from the existing hash would create new false merges.

**N2 · Foundational change · Make authority a policy over claims.** A source's classification does not make every field it publishes authoritative. Register each source's game coverage, locale, entity/field coverage, collection policy and permitted contribution. Preserve all observations, then resolve claims through deterministic field-specific rules. For example, a community source could contribute promo appearance/distribution evidence while effective rules text and legality still require an appropriate authority. Distinguish publisher-confirmed facts, accepted supplemental facts and unresolved claims without disguising their origins. Avoid an unexplained numeric “trust score” as the resolution mechanism.

Keep Official Source as the publisher-owned subset; introduce a broader source concept instead of silently redefining Official Source to include third parties. The current source allowlists remain valuable transport controls, but network permission must be separate from authority to supply canonical facts.

**N3 · Foundational change · Admit new entities through supplemental evidence.** Current Curated Revisions target existing canonical entities; they are not an intake path for a promo absent from the catalogue. Add an explicit source-evidence intake and identity-resolution path that can propose a new Card or a new Printing, preserve incomplete facts, and require review where identity is uncertain. The owner must decide whether accepted supplemental records appear in ordinary queries by default or through an explicit inclusion policy. In either case consumers need provenance and verification status; absence from an official list must not become a fabricated withdrawal or proof of invalidity.

[Existing-entity requirement](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/curated/curated-revisions.ts#L1560)

**N4 · Architectural change · Separate game semantics from source parsing.** The current adapter contract couples discovery format to the four Bandai game names and fixes the same small regional vocabulary. A source should parse its own presentation into observations; a game module should own identity constraints, legal field shapes, face/role semantics and game-specific validation. Shared ingestion/reconciliation should orchestrate those modules without accumulating publisher branches.

[Coupled adapter contract](https://github.com/KeeprDigital/card-keepr/blob/60415d00da0ccbc843eb92d0c8f6545dd15271c4/src/catalogue/adapters/adapter-contract.ts#L1)

Use checked-in typed registrations initially. Supporting several sources does not require a dynamic plugin marketplace, arbitrary user scripts, microservices, or a schema with every field reduced to an untyped bag. Keep a small common envelope plus typed game-specific facts.

**N5 · Coverage change · Source completeness is not game completeness.** A successful official crawl proves coverage of that source's declared scope, not every promo ever printed. Record completeness and freshness by source, area and locale. Declare which sources are required for each ingestion scope; an optional supplemental outage should not automatically block an unrelated official refresh. Carry its earlier accepted facts forward with their actual freshness. Conversely, an official-only run must not mark supplemental records as missing because it did not consult their source.

**Replacement validation sequence.** First resolve the deterministic image/publication blockers. Then test one existing game with an official source plus one supplemental source: the same Printing on both, a genuinely new promo, contradictory facts, missing identifiers, changed artwork URLs, and one unavailable source. Exercise a second publisher's actual representative data, potentially Riftbound once the intended source is selected, to expose assumptions hidden by the Bandai games. Only then freeze shared identity and observation contracts. No specific external source was evaluated in this update.

This scope explicitly conflicts with the current Bandai-only and Official-Source-first contribution assumptions in CONTEXT and PRD #22, and with the existing-entity restriction if Curated Revisions are used as intake. It requires a domain/spec revision before implementation. The user's clarification authorizes revising the architectural recommendation; no canonical records, ADRs, or source integrations were changed in this review.
