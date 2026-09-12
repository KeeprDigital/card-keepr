# Inspect and publish a game candidate

Use `pnpm run keepr` (shown as `keepr`) with owner credentials.
Collection, preparation, candidate, publication and backup IDs identify different
operations. A completed collection does not itself establish a ready candidate.

## Prepare and inspect

```sh
keepr game-candidate list --run-id RUN --json
keepr game-candidate prepare --run-id RUN --game GAME \
  --expected-game-revision-id GAME_REVISION --idempotency-key PREPARE_INTENT --yes --json
keepr game-candidate show --candidate-id CANDIDATE --json
keepr game-candidate inspect --candidate-id CANDIDATE --manifest SHA256 --json
keepr game-candidate partitions --candidate-id CANDIDATE --manifest SHA256 --json
keepr game-candidate partition --candidate-id CANDIDATE --ordinal 0 --manifest SHA256 --json
keepr game-candidate evidence --candidate-id CANDIDATE --kind identity --manifest SHA256 --json
```

Prepare explicitly only when another candidate has not already been dispatched for
that game. Read the IDs and generation from status. The sealed manifest pins the
source evidence, owner decision cutoffs, game predecessor and original seven-day
deadline. Follow each returned opaque `next_cursor` as `--after`; evidence cursors
also bind their class (`identity`, `admission`, `correction`, `curated`).

Inspection contains full before/after entities and relationships, Products with
Releases, images, warnings, exclusions and evidence-only/carry-forward changes.
The summary counts must close over all detail pages. Reading every page is
available without per-item acknowledgements; approval is for the whole candidate.
Expired, abandoned, stale or integrity-failed candidates are not ready. An older
candidate without inspection artifacts reports `inspection_not_prepared`; create
a fresh candidate rather than altering its immutable manifest.

Metadata partitions are bounded. `text_parts` describes transport placeholders,
not unknown source facts. Read the referenced text chunks in ordinal order,
verify their full UTF-8 byte length and SHA-256, then restore their paths. Inspection
before/after text may refer to different preparations. The
[administration contract](../../contracts/ADMINISTRATION.md) defines partition
hashing and text routes. Authenticated snapshot/observation content routes return
retained source bytes. Candidate image routes verify the exact retained image;
inspection images accept `side=before` or `side=after`.

Progress is durable in D1; Workflow platform status alone cannot establish it.
`completed_documents`/`completed_observations` count verified retained work, not
complete Source Coverage. A sealed input manifest requires the full planned
evidence and completeness checks.

## Pause, resume or abandon preparation

Native candidate pause/resume are authenticated POSTs to
`/v1/game-candidates/:candidate/pause` and `/resume`, with inspected `generation`
and a fresh `idempotency_key`; they have no matching CLI commands. For retained
run-level reconciliation, use `reconciliation status`, `pause`, `resume` and
`abandon` with its run ID and generation.

```sh
keepr game-candidate abandon --candidate-id CANDIDATE --generation GENERATION \
  --idempotency-key ABANDON_INTENT --yes --json
```

Pause and sealed candidates keep their game slot. Abandonment increments the
generation and releases only that slot; it preserves the original manifest and
evidence. A new intent may then prepare from the same collection. Resume never
renews the original deadline. Use owner actions, not restarts of old Workflow
generations. Shared-database recovery fences all mutation.

## Prepare publication artifacts

```sh
keepr publication-preparation start --candidate-id CANDIDATE \
  --manifest-digest SHA256 --generation GENERATION --sequence 0 \
  --idempotency-key ARTIFACT_INTENT --json
keepr publication-preparation status --candidate-id CANDIDATE --json
keepr publication-preparation artifacts --candidate-id CANDIDATE --json
```

The Workflow verifies image bytes, promotes fact/text components, prepares private
query/search projections and seals a bounded immutable root. This neither approves
the candidate nor makes it visible. Candidate inspection readiness and verified
publication artifacts are independent gates. The status pins the candidate,
originating preparation, real collection, predecessor, manifest and deadline.

An exact request replay returns its original response, so inspect status separately.
After retry exhaustion, resume using the current sequence and generation:

```sh
keepr publication-preparation resume --candidate-id CANDIDATE \
  --manifest-digest SHA256 --generation GENERATION --sequence SEQUENCE \
  --idempotency-key ARTIFACT_RESUME_INTENT --json
```

Transient storage/dispatch failures retain verified work and bounded retry state.
Missing/corrupt manifests, partitions, text or images fail distinctly; they are
not converted into transient retries. Every committing transaction rechecks slot,
generation, predecessor, manifest, deadline and recovery health. Immutable objects
may be verified and reused after an ambiguous PUT; conflicting bytes are never
silently overwritten. Candidate state is not advanced by artifact preparation.

## Approve and observe publication

```sh
keepr publication approve --candidate-id CANDIDATE \
  --manifest-digest SHA256 --expected-game-revision-id GAME_REVISION \
  --generation GENERATION --idempotency-key APPROVAL_INTENT --json
keepr publication status --operation-id PUBLICATION --json
```

Approval is durably recorded before 202. Exact replay returns the original
acknowledgement; changed intent under the same key conflicts. Publication waits
for its artifacts and the current composition's verified backup checkpoint.
Other games may prepare and approve while that checkpoint is pending. The original
deadline still applies, and applicability dates do not recalculate approved facts.

The final transaction verifies approval/readiness, same-game predecessor, deadline,
generation and global recovery state; atomically switches the game/composition,
retains query visibility and reserves the composition's backup. A stale same-game
approval fails. Unrelated-game contention can reuse the candidate with refreshed
composition references. The resulting catalogue and backup must be inspected
separately through the [backup procedure](backup-recovery.md).

```sh
keepr publication resume --operation-id PUBLICATION --generation GENERATION \
  --idempotency-key PUBLICATION_RESUME_INTENT --json
```

Resume preserves the candidate, manifest and deadline while fencing older writers.
A completed dispatch is not a verified backup. Reads and cursors pin immutable
published compositions. Public exports serve stored schema-validated gzip records;
private preparation roots are not consumer export packages.

## Legacy data

`keepr run approve` is retired with exit 2 and no request. New unreserved HTTP run
approvals return `410 run_approval_retired`; exact historical results/reservations
retain observation and recovery semantics only. They cannot start new publication.

`publication_legacy_composition_unprepared` means an old current catalogue lacks
verified native carry-forward roots. Start natively from the empty spine and
freshly sealed candidates, or follow the separately approved
[fresh-baseline handoff](production-release.md#fresh-baseline-handoff). Do not
fabricate collections, clear guards or reset the database to bypass this failure.
