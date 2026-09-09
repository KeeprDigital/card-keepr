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

The serving write uses the retained R2 body directly, the existing conditional
immutable write, and the SHA-256 precondition. The stored serving object is
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

## Remaining evidence

Run the new native test and relevant existing image failure/integrity checks
under the exclusive runtime lease; record the exact commit, duration and any
failure. Complete the integrated full validation and independent Standards
and Spec reviews. The complete #274 acceptance also requires the caller
migration plus native export/cleanup/actual restore proof. Neither #274 nor
its launch parents can close on this checkpoint.
