# Native no-change acceptance

The private-launch coordinator confirmed that identical consumer catalogue content must retain its existing consumer revision and export while preserving newly accepted administrative evidence. ADR 0015 replaces multi-game atomic refresh, global predecessor invalidation, synchronous publication and date-crossing invalidation; it does not remove no-change reuse. Issue #216 requires changed/no-change proof and preserves unrelated private consumer/export behavior. The retired `publication_outcome` response field is not a native contract requirement.

## Reproduced failure

The focused test in `reconciliation-provenance-locators.spec.ts` at `3e0247538860a26367dd64ad611e775429addf4a` collected the same retained synthetic source twice, prepared two independently reviewed native manifests and completed both native publications and actual SQL restore checkpoints. Distinct manifests, newer complete successful-check evidence, new snapshots and unchanged first-run snapshots passed. The same-revision assertion failed: a second consumer revision was minted. The run exited naturally in 7.993 seconds (5.602 seconds in the test); it was not interrupted. `/tmp/issue-274-native-nochange-3e024753.log` retains the raw output.

The strengthened oracle at `fba8905b64e2c7597707888d15855483319522e2` compared the integrity-verified `canonical_digest:catalogue` checkpoints. Equality failed before the second publication: `96f57f9dfd3274cc8c6b7aa97cc0a082766deb0d2fc6f0ad4fc5d59d91e5543b` versus `974804d7f7c7b13dfebb1366537a0618d10f516ae9f727e343e4d151b88addcc`. The selected test exited naturally in 6.331 seconds (3.662 seconds in the test); ten other cases were filtered out. `/tmp/issue-274-native-nochange-digest-fba8905b.log` retains the output.

Production changes remain on hold. The existing digest is not yet a valid equality receipt: native candidate records now include administrative evidence absent from the historical candidate shape. A bounded comparison of the tiny synthetic candidate records and the actual verified public export records must identify the difference before choosing a digest correction. The original same-revision oracle and both red logs remain preserved; no runtime success or no-change fix is claimed.

## Bounded acceptance model under review

- Retain the existing streamed catalogue digest at the independent game's seal transaction, where `persistReviewableCandidate` already receives it. Bind the receipt to the candidate and exact manifest; do not hash an assembled game or treat the approval manifest as a semantic digest.
- Keep immutable consumer composition members and existing public artifact identities unchanged on equal consumer content. Record the new exact publication approval and accepted administrative evidence separately.
- Pin the accepted evidence predecessor when a native game preparation is created. Subsequent reconciliation, identity lookup and candidate inspection must use that immutable pin, rather than resolving a mutable latest evidence head during continuation.
- Maintain a current accepted candidate per game, separate from its consumer revision. One game slot and the exact predecessor, approval, writer generation and original deadline remain enforced by the final database transaction.
- Permit multiple accepted candidate bindings to the same consumer revision for lifecycle references. The current `catalogue_candidate_publications.catalogue_revision_id UNIQUE` constraint cannot represent this without a deliberate migration.
- Reserve and actually verify a new backup for the accepted evidence mutation. The next final publication must await the latest accepted mutation's checkpoint. The existing predicate accepting any verified backup for the revision is insufficient after a same-revision acceptance.
- Keep all work bounded: use retained digest receipts, exact candidate identifiers and fixed-size game/composition metadata. Existing streamed preparation and immutable artifact reuse remain in place. No catalogue-sized final transaction, metadata aggregation, global content scan or synthetic checkpoint admission is permitted.

Migration `0031_native_no_change_acceptance.sql` is reserved for this lane. Changes to native prior/locator code wait for the independently reviewed ambiguity fix owned by the toolchain lane. Production edits require the digest-equality oracle and the coordinator's seam review.

## Required proof before integration

Exercise the native owner/API path for equal content with newer evidence, changed content following that accepted refresh, exact approval replay, stale generation/predecessor, expiry, unrelated-game contention, delayed or failed latest backup and actual SQL restore of the accepted evidence. Preserve current-plus-two distinct consumer revision queryability. Compare unchanged public export identities and bytes, and verify administrative evidence separately. Run appropriate focused and full validation and independent Standards/Spec reviews at fixed commits. No private-launch ticket or live gate is fulfilled by this plan alone.
