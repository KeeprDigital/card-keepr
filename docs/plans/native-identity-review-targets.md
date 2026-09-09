# Native identity review targets

Issue #274 must retain actual owner decisions when publication callers move to native per-game candidates. The two existing Card identity owner journeys reach a retained review with the exact previously published Printing, then the resolution route returns 409. At `5d55141231727ac1f400be8280c219575897d3e1`, a temporary diagnostic invoked the unchanged repository insert with that exact request and exposed `SQLITE_CONSTRAINT_FOREIGNKEY`: the schema17 decision table accepts only `reconciled_printings`, which native publication does not populate. The original route oracle remained failing; the diagnostic was removed exactly. The raw log and digest are retained in the caller-retirement evidence manifest.

The coordinator reserved migration0032. Migration0031 remains the no-change provider's responsibility; its populated upgrade must be corrected and proven first.

## Retained decision contract

Keep the existing six public decision fields, immutable request replay, changed-request rejection, owner authorization and operation-idle checks. Preserve every historical decision and its SQLite rowid: existing preparations pin `identity_decision_cutoff`, so merely copying the values in a new order would change their reviewed decision set.

Rebuild only the decision table to replace its exclusively legacy target reference with exactly one private target binding. A historical target continues to use the real `reconciled_printings` foreign key. A native target references both its immutable publication binding and the exact `publication_read_entities(candidate_id, 'printings', printing_id)` key. Foreign keys must continue preventing deletion of the referenced identity. Recreate all decision immutability, recovery and fresh-baseline handoff triggers.

Choose native targets through the review's retained preparation and immutable accepted-evidence predecessor, using an index beginning with review ID and one exact native Printing key. This preserves an old reviewed target after the current game head advances. A native predecessor with a missing target fails closed; a legacy predecessor retains the historical lookup. The database insert guard must also require the target in the review's retained candidate list and match its Source Snapshot game and Source Lineage. Do not allocate a new identity, manufacture a legacy Printing or read a mutable current head to redefine old evidence.

Keep the private binding fields out of the existing decision response. The complete backup already fingerprints the decision table, so the new columns are restored and verified with its other durable evidence; historical snapshots retain their recorded schema.

## Required proof

Prove the populated schema31-to32 upgrade preserves values, sparse rowids and creation-time cutoffs. Exercise missing, wrong-kind, cross-game, unpublished and changed-predecessor target failures; exact native and historical targets; referenced-target deletion; immutable decisions; recovery/handoff fencing; exact route replay and changed-key/request rejection. The two original native owner journeys must pass without weakening their identity or reviewed evidence assertions. Run the complete affected file after the focused proof and obtain independent Standards and Spec reviews before integration. This plan does not claim migration or native owner resolution complete.

## Implemented checkpoint awaiting native proof

The reviewed no-change provider `7a09fc673abf07149d6fd0252c650af0ae0b8776` is merged at `2dc4c495`. Two provider conflicts retain its accepted-head identity review and preparation-pinned Printing lookup. Migration0032 and the existing decision repository now implement the private native/historical target references above. The first retained review capture is selected by its immutable SQLite rowid through the review-ID index, so a later lexically earlier preparation cannot change that choice.

Nine focused real-SQLite tests pass in 2.39s, including populated historical rows at sparse rowids3/17, cutoff replay, later accepted-head/repeated-review capture, wrong game/kind, unpublished/missing native identity, missing pin, different predecessor, candidate-list membership, legacy fallback, referenced-target deletion and recovery/handoff fencing. The existing schema hygiene plus populated no-change upgrade family passes10/10 in3.765s. Typechecking and focused Biome checks pass. These relational fixtures do not represent an actual owner publication or restore; the two original native owner routes remain the next required runtime proof. Their existing exact replay now also checks changed intent/key rejection and absence of private reference fields in the response.


## Native owner proof and independent reviews

At exact `6e0339c32d132d7e5f5983a7255096289dd16b43`, both original native owner identity routes pass: 2/2 with21 other cases filtered,17.62s Vitest /18.825s harness. The source-local artwork review takes7.165s and the missing-number cross-source review7.923s. Both retain the original single Card/Printing identity and complete real native approval/publication evidence. The first also proves invalid target422, exact replay, changed intent/key409 and omission of private binding fields. The run finishes naturally under unchanged30s case bounds and a120s outer bound. Raw logs and digests retain background diagnostics.

Independent Standards and Spec reviews against fixed `2dc4c4951a9b7fa30bf3a8f7b36ecf602da06e9e` report zero actionable findings for all six changed files. This resolves the demonstrated owner-resolution FK failure. The five longitudinal Card identity migrations, Gundam canonical precedence, native Printing administration history and complete integration validation remain outstanding. Migration0032 becomes a prerequisite for final schema convergence under#239; no live migration has been executed.
