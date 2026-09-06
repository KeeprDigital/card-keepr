# ADR 0004: Superseded Source Adapter Version parser code is retired

## Status

Accepted from Go-Live (ADR 0008). Before Go-Live there is no predecessor window and no retired registration: each Source Lineage has one Source Adapter Version, edited in place.

Amended by the [validation and reparse decision](https://github.com/KeeprDigital/card-keepr/issues/215#issuecomment-5558885829): cross-version reparse is deferred and is not a Go-Live requirement. Evidence retention is a separate decision.

## Context

Every Source Adapter Version is an immutable, registered parser contract.
Parsing happens exactly once, at capture, and produces an immutable Source
Observation Set pinned to that version. Reconciliation, publication, and
every read path consume observation sets; nothing reparses Source Snapshot
bytes on those paths. The former promise that a new version could reparse
retained snapshots is deferred; corrected parsers use freshly collected
evidence through ordinary reconciliation, inspection and approval.

Despite that, the codebase retained every historical parser body: dozens of
version-suffixed functions behind per-contract dispatch, per-version
registry branches, and per-version tests against retained fixtures. The
retained bodies made the adapter module the largest file in the repository
and a large share of the test mass, while serving no live path. The only
reachable uses were starting a new run against a superseded version, or
reprocessing a snapshot under its original contract to obtain the
observation set already stored.

## Decision

Registration is permanent; implementation is not. Every Source Adapter
Version keeps its registration row and identifier forever so retained
Source Observation Sets, Evidence Plans, and Ingestion Runs stay
attributable. Parser implementation is retained only for the current
version and its immediate predecessor on each Source Lineage. Older parser
bodies, their dispatch branches, their registry-side behaviour flags, and
their per-version tests are removed once no non-terminal Ingestion Run pins
them.

A retired version remains registered but cannot be used to capture or
parse; the runtime refuses with an explicit problem rather than silently
falling through to another contract. Registering a new version does not
enable cross-version reparse of retained Source Snapshots. A retired contract is recoverable from
version control history for forensic comparison, but is never re-registered
or made executable again.

## Consequences

Fresh collection after a parser correction may observe changed source content,
or fail if the source is unavailable. This limitation is accepted instead of
requiring a cross-version reparse workflow at Go-Live. This amendment does not
authorize evidence deletion or remove existing same-version operations.

The adapter module shrinks to the live contracts, and a version bump adds
one contract and retires one rather than accumulating. Retained real-source
fixtures are exercised against live contracts only. A backup restored with
an in-flight run pinned to a retired version cannot resume that run; the
one-prior retention window is the intended safety margin, and such a run
must be terminated and restarted under a live version. Registration data
that previously lived in code-side version lists, such as which versions
carry errata coverage, belongs with the registration rather than the parser
body.
