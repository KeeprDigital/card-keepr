# Native source history and administration

Issue #274 preserves source currentness, historical locators, first/last/missing observations and canonical source authority when callers move to native per-game publication. The two native Erratum routes currently cannot inspect published Printings because `publicReconciledPrinting` reads only legacy tables. The recorded native Card identity run also shows Asia-first Gundam raw Printing facts being replaced by formatting-equivalent US facts. Native `locator_evidence` is a cumulative list, so displaying it as current history would invent information and would break the original disappearance/authority tests.

The coordinator approved a bounded source-history reduction and reconstruction through immutable per-game predecessor pins. The existing historical Gundam test is being moved to native preparation/publication without changing its current/historical locator, ceased authority, same identity, canonical fact, Product conflict or owner-abandonment oracles. Its first actual red must be recorded before production implementation.

## Bounded retained history

Use existing immutable reducer namespaces for Card/source and Printing/locator history, with an explicit completed prefix. Keep its cursor as a nested source-history stage of the existing `disappearance_warnings` checkpoint; preserve the warning stage and its ordinal progression. Do not add a phase enum or schema field.

For a predecessor that already has complete history, copy its exact checked prefix one record per durable unit. For an older native predecessor without that index, follow only its pinned per-game predecessor, retaining each traversal entry in the new preparation. Replay completed observation plans and declared coverage oldest-to-newest, again one bounded record per durable unit. A retained traversal detects cycles without a catalogue-sized in-memory set. No old candidate, approved byte or prior checkpoint is rewritten. Missing or inconsistent publication bindings, pins, completed plans or coverage fail closed. A genuine legacy predecessor uses its retained relational history at the boundary.

Actual observations advance their lineage and locator history. A successfully checked complete or explicit Card scope can mark a missing observation historical; an unchecked source or Errata-only observation cannot do so. Retain first-observed, last-observed and last-missing candidate references, resolving them only through real publication bindings, including same-revision accepted candidates. Preserve withdrawal as a separate fact; disappearance must never imply withdrawal.

Native administration selects the current accepted candidate, verifies its completed history prefix and returns the existing Printing inspection contract. Internal Gundam source-authority/conflict and disappearance lookups use the exact preparation's pinned predecessor history; they do not read a mutable current head during reconciliation. Keep all record/hash and per-entity byte/count bounds explicit. The consumer export shape is unchanged.

The Product/membership producer belongs to the toolchain lane. Reuse its actual retained relationship identities and source observations; coordinate the narrow main reducer calls and avoid duplicating Product/context inference. Source buckets remain administrative. Preserve original relationship currentness and retained source IDs.

## Proof gates

Retain the original native Erratum404, Gundam canonical precedence and historical disappearance/authority reds. Exercise both locale orders, complete and scoped disappearance, no-change acceptance and later corroboration, unchanged historical bytes, missing/corrupt prefix, and older native reconstruction. Recheck the actual authenticated administration response and current source-authority decisions. Independent fixed-base Standards and Spec reviews, focused/full affected tests and combined integration remain required. This plan is not a completed history provider or a capacity measurement.

## First original red

At exact clean `d66710e5bcccb83c3d54d963c80ae89d9fc971d1`, the historical Gundam test completed naturally: one failure, 22 unselected, 7.78s Vitest / 8.849s harness. Both actual native publications and verified backups completed. The first administration assertion returned `404 printing_not_found` instead of the retained Asia locator marked historical/current:false and lifecycle.withdrawn:false. The unchanged case limit was 45 seconds, with a 90-second outer bound. The raw log and SHA-256 are retained in the publication caller evidence manifest. No producer code preceded this red.
