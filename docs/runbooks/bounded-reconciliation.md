# Inspect retained reconciliation preparation

Use the owner administration credentials for these commands. An Ingestion Run is
collection provenance; its `candidates` status field identifies the proposed
Catalogue Candidate for each selected Supported Game.

```sh
keepr reconciliation status --run-id RUN --json
keepr game-candidate show --candidate-id CANDIDATE --json
keepr game-candidate partitions --candidate-id CANDIDATE --json
keepr game-candidate partition --candidate-id CANDIDATE --ordinal 0 --json
```

Partition listings return at most 100 entries. Pass the returned `next_cursor` as
`--after` until it is null. A candidate's manifest and partition count become
available in the same transaction that seals preparation. Its original creation
time and seven-day deadline do not change on retries or pause/resume.

Each game manifest binds its candidate identity, collection provenance, Supported
Game, expected predecessor, deadline, preparation manifest and ordered partition
hashes. The preparation manifest binds the verified input and pinned definitions,
admission decisions and identity corrections. `expected_game_revision_id`
currently identifies the nearest ancestor of the run's pinned Catalogue Revision
that selected this game; final Game Catalogue Revision publication is the #228
integration boundary. Attributable warnings belong only to that game's `warnings`
partitions. Diagnostics without game attribution are explicitly retained as
`shared_warnings` in each selected game's manifest.

## Large text and partition integrity

Metadata partitions contain at most 500 records and 512 KiB. Inspection returns
`records` and a parallel `text_parts` array. An empty `text_parts` entry means the
record is complete. Otherwise each entry identifies a path within that record,
the complete text's SHA-256, byte length and number of chunks. The path's null is
a transport placeholder, not a source assertion that the field is unknown.

```sh
keepr reconciliation text --run-id RUN --digest SHA256 --ordinal 0 --json
```

Read ordinals zero through `chunks - 1`, concatenate their `content` in order,
and verify the complete text's UTF-8 byte length and SHA-256 before restoring the
path. Each raw text chunk is at most 128 KiB. Printing Images use immutable object
references rather than embedded binary content.

To verify a metadata partition hash, reconstruct its ordered array of envelopes:
`{contract: "card-keepr-partitioned-record@1", value: records[i], text_parts: text_parts[i]}`.
Hash canonical JSON using the catalogue's UTF-8 key ordering and NFC text rules.

## Progress and compatibility boundary

```sh
keepr reconciliation inputs --run-id RUN --json
keepr reconciliation input --run-id RUN --ordinal 0 --json
keepr reconciliation pause --run-id RUN --generation 0 --idempotency-key KEY --json
keepr reconciliation resume --run-id RUN --generation 1 --idempotency-key KEY --json
keepr reconciliation abandon --run-id RUN --generation 1 --idempotency-key KEY --json
```

Use the generation returned by status and a distinct idempotency key for each new
action. Exact replay returns the retained result. Pause fences the previous
writer; resume keeps the original identity and deadline. A candidate past its
original deadline cannot resume. Abandon releases its preparation reservation.

`completed_documents` counts source documents whose retained bytes and provenance
have passed verification. A later document outage preserves those artifacts for
retry/resume. This counter does not assert complete Source Coverage: the verified
input manifest remains unavailable until the request graph, required surfaces,
count closure and normalized observations have all passed their checks.

`completed_observations` counts immutable normalized observations. Their original
document and position are retained separately, so retries can reuse completed
observations without accepting a duplicate identity from another position or
document. Completed observations do not repeat Printing Image verification work.

`completed_reducer_records` counts retained versions of Cards, Printings,
Printing Image references, local facts, authority, compatibility, locator and
Gundam provenance indexes. Card identity searches return small references;
matching reads complete facts one at a time. Replay
reads only earlier observation versions and its own writes, so retained later
observations cannot change earlier identity decisions. This counter counts
individual effects, not completed work units or a resume cursor.

Independent game preparation uses `keepr game-candidate create`, `show`,
`pause`, `resume`, and `abandon`. Each preparation owns its durable progress and
game slot. The legacy run-level preparation and approval adapter remains for
compatibility. Both paths use bounded reducers and partitioned retained work;
see [Reconciliation continuation](reconciliation-workflows.md) for dispatch,
resource bounds, and the native publication integration boundary.

## Complete candidate inspection

Newly prepared candidates retain `inspection` partitions and one
`inspection_summary` partition in the same immutable game manifest. Inspect the
summary and use the manifest returned by `show` to pin subsequent pages:

```sh
keepr game-candidate inspect --candidate-id CANDIDATE --manifest SHA256 --json
keepr game-candidate partitions --candidate-id CANDIDATE --manifest SHA256 --json
keepr game-candidate partition --candidate-id CANDIDATE --ordinal 0 --manifest SHA256 --json
keepr game-candidate evidence --candidate-id CANDIDATE --kind identity --manifest SHA256 --json
```

Pass each returned opaque `next_cursor` unchanged as `--after`. Partition cursors
bind the manifest; evidence cursors also bind their class. The supported evidence
classes are `identity`, `admission`, `correction`, and `curated`. These pages expose
retained decisions and mapping evidence from this preparation, including the
original collection, Source Snapshot, and Source Observation Set references.
Download retained source bytes through the existing authenticated
`/v1/source-snapshots/:snapshot/content` and
`/v1/source-observation-sets/:observationSet/content` routes. The candidate's
`inputs` pages retain source coverage and verification metadata.

Every inspection detail names its entity class and exact expected Game Catalogue
Revision, and includes full before/after values. Products include their complete
Release values; relationships include both endpoints. Changes are `added`,
`removed`, `changed`, `evidence_only`, or `carry_forward`. Warnings, exclusions,
source checks and identity corrections remain inspectable alongside catalogue
entities. The summary's per-class counts reconcile with all inspection detail
records. Evidence counts reconcile separately with the evidence-class pages.

Large text uses the existing transport placeholders. Restore the detail's own
`text_parts` first, then use `before_text` and `after_text` to restore referenced
values from their respective preparations. Never interpret a transport null as a
source assertion. Printing Image records retain their face/role and exact digest.
Download and verify an image with authenticated
`GET /v1/game-candidates/:candidate/partitions/:ordinal/images/:record?manifest=SHA256`,
where `record` is its zero-based index in a `printing_images` partition. The route
verifies the image bytes before returning the stream and rejects missing or
corrupt objects.

Readiness binds the candidate manifest and exact game predecessor. An expired,
abandoned, or stale candidate is not ready. A candidate sealed by an older
runtime without inspection artifacts reports `inspection_not_prepared`; its
immutable manifest is never amended. Create a fresh candidate through the normal
owner operation when complete inspection is required. Corrupt partition bytes,
missing required partitions, and inconsistent counts fail inspection. Inspection
readiness describes retained review artifacts; publication preparation and its
final switch verify their own readiness independently.

Approval remains a decision about the whole candidate. Reading every page is
available to the owner and requires no per-item acknowledgement. These commands
do not approve or publish a candidate.
