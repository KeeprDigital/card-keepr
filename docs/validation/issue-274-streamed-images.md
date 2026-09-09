# Streamed Printing Image checkpoint — issue #274

This is the image portion of #274, not completion of the publication migration.
The implementation base is `4d02a199b56faae3a6d4f4efa4c62ebf12fb2a79`:
reviewed cleanup plus the #273 fixture and selected #272 toolchain commits.
Neither provider is represented here as integrated on main. The separate
`357b1341` #273 documentation commit records its two clear independent reviews.

## Image path and retained contracts

`reconciliation-evidence.ts` previously read each retained source image into
an ArrayBuffer, encoded it as base64, passed that encoding through observation
validation, and decoded it again for the serving-bucket write. The normalizer
now verifies the retained stream's byte count and SHA-256 while recognizing
dimensions with fixed header windows. PNG, GIF, JPEG, WebP and AVIF retain their
existing dimension-recognition rules. JPEG segments can be skipped across
chunks; AVIF's `ispe` search carries only its 16-byte window.

Verified metadata is supplied to observation parsing through an in-process
map. A source document cannot grant itself a reference by declaring a storage
key. The parser copies only the image contract's metadata; raw evidence keys
and base64 are excluded. Source-semantic artwork fingerprints, role completeness,
positive dimensions, tolerated unavailable-image behavior and novelty rules
remain in force. Historical synthetic observations that explicitly carry
base64 retain their validated fallback.

The serving write transfers the retained R2 body through a `FixedLengthStream`
using its authenticated length, the existing conditional immutable write,
and the SHA-256 precondition. The stored serving object is
read back as a stream and verified. Image identities and object keys remain
unchanged, as do the `PRINTING_IMAGES` bucket and durable staging ownership.
This change makes no storage consolidation claim and changes no cleanup or
backup/restore contract. R2's supported stream bodies, conditional writes and
checksum fields are described in the
[Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

No record/page budgets or large-text representation changed. The existing
16 MiB aggregate guard is not raised. Retirement of the old approval route,
CLI and whole-candidate aggregate callers is a separately owned #274 change.

## Validation at this checkpoint

Host: macOS arm64, Node 26.3.0; selected dependency pair from #272:
Vitest 4.1.11, Workers plugin 1.1.6, Wrangler 4.130.0 and Miniflare
5.20260908.0-alpha. Shared installed dependencies were not modified.

- TDD: the trusted-reference parser test first failed because an observation
  without embedded bytes could not complete; it now passes while rejecting
  a source-supplied storage key. PNG, JPEG and the remaining format tests each
  failed before the corresponding streaming recognition was added.
- Focused domain tests: 17 passed, including split headers, a 65,535-byte JPEG
  segment, all supported format families, invalid dimensions and source-key
  exclusion. The final checkpoint domain selection passed 268 tests across
  46 files in 2.76 seconds; the earlier selection passed 265 in 2.91 seconds.
- Typechecking passes after the production changes and new runtime test.
  An intermediate runtime-test authoring syntax error was caught and corrected
  before this checkpoint. Targeted lint, format, catalogue boundary and
  import-cycle checks pass.
- `native-printing-images.spec.ts` is written but **not executed** at this
  checkpoint: the host runtime lease belongs to #272's full validation. It
  uses #273's bounded 128-image workload, forbids buffered retained-image reads,
  requires streaming serving writes, inspects all candidate image references,
  approves/replays the exact native whole candidate, prepares the export and
  compares every published image's bytes and digest. Its 30-second test deadline
  and 250-unit publication bounds follow existing native publication tests.
- No runtime, stress, capacity measurement, deployment or live operation has
  run for this image change. No check was interrupted.

## Independent review and subsequent hosted red

The fixed diff from `4d02a199b56faae3a6d4f4efa4c62ebf12fb2a79` to
`9736d445b98273209bb0c1d30a272a3e38e9ba7e` received separate Standards and
Spec reviews: zero hard violations, zero smells and no Spec findings. These
were static reviews, not execution proof. A separate offline comparison
authenticated all 22 retained images (9,104,686 bytes) against their manifests
and fed seven-byte chunks through the new dimension reader; all dimensions
matched the previous implementation exactly. This is compatibility evidence
for the retained bounded sample, not a whole-publisher census.

[CI run 34334457703](https://github.com/KeeprDigital/card-keepr/actions/runs/34334457703)
executed that exact head on Ubuntu/Node 22. Lint, domain and combined checks
passed, while all three ingestion and acceptance shards failed. Ingestion
reported 733 passing and 21 failing tests. The newly added native image test
failed after 26.574 seconds: the candidate was paused with
`Candidate image storage is temporarily unavailable.` instead of sealed.
The retained stack reaches the serving write in `retainCandidateImage`,
after retained-stream validation. Hosted logs do not expose the nested cause.
This new image regression cannot be dismissed as previously recorded suite
interference. Other native publisher/retained-source paths also paused at
the image-storage boundary.

Raw logs are retained under `/tmp/issue-274-ci-ingestion{1,2,3}.log` and
`/tmp/issue-274-ci-acceptance{1,2,3}.log`.

## Local diagnosis and corrected image checkpoint

After the provider acceptance run released the exclusive runtime lease, the
original native test reproduced the paused-candidate failure in 4.298 seconds
(5.99 seconds total). One temporary error trace exposed the actual cause:
`Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)`.
The callback resource wrapper replaces the native R2 body with a generic
ReadableStream to track resource usage. Retained-byte verification succeeded,
but the serving R2 write rejected that generic stream. This is an application
integration defect introduced by the image checkpoint, not fixture contention.

The one-image minimization first failed at `staging_writer_fenced` because
its artificial owner did not identify a real run. Removing that nonessential
wrapper reached the same known-length error in 0.328 seconds (1.99 seconds
total). The native test still exercises actual durable staging ownership.
The production fix bridges the resource-wrapped body through a
`FixedLengthStream` using the already authenticated byte length. Upload and
transfer settle together; a failed upload aborts the transfer before the
callback completes. No resource guard or error classification changed.

The smaller copy/replay regression passed in 0.341 seconds after the fix.
The original native test then sealed and approved correctly, but exposed an
insufficient test-authoring bound: 250 artifact units cannot cover image
verification alone plus all 128 Card/Printing/image export and projection
records and three Card search fields. That synthetic fixture now reserves
16 units per Printing plus 128 partition/tree units (2,176 total). The
30-second test deadline remains unchanged; no production budget changed.

Final local results on the corrected code, macOS arm64/Node 26.3.0 with the
same selected #272 toolchain:

- Native whole-candidate test: 1 passed, 18.15 seconds (19.87 seconds total).
  It seals all 128 references, approves and replays the exact candidate,
  prepares artifacts/export, publishes and replays, verifies all 128 serving
  images' bytes/digests, and reads the composition export without base64.
- Three focused files: 11 passed, 17.71 seconds total. Includes image
  copy/replay, early rejected-upload settlement, existing callback resource
  bounds and tolerated image failures. The deliberately malformed
  Content-Length fixtures emit their existing runtime errors; the complete
  selection exits zero. No failure is ignored by a new rule.
- Full domain selection: 268 passed across 46 files, 2.73 seconds.
- Full typechecking and targeted lint/format pass. The temporary diagnostic
  was removed; no check was interrupted. The runtime lease was handed to
  the caller-migration lane after all processes exited naturally.

Local raw records: `/tmp/issue-274-native-probe.log`,
`/tmp/issue-274-one-image-red.log`, `/tmp/issue-274-one-image-red-minimal.log`,
`/tmp/issue-274-one-image-green.log`, `/tmp/issue-274-native-green.log`
(the insufficient 250-unit bound), `/tmp/issue-274-native-green-bounded.log`,
`/tmp/issue-274-focused-image-green.log`, `/tmp/issue-274-typecheck-final.log`
and `/tmp/issue-274-domain-final.log`.

## Remaining evidence

Complete the integrated full validation and independently review the fix
against its fixed predecessor. Hosted results on `9736d445` remain red;
these focused local passes do not replace exact-release-SHA CI. The complete
#274 acceptance also requires the caller
migration plus native export/cleanup/actual restore proof. Neither #274 nor
its launch parents can close on this checkpoint.
