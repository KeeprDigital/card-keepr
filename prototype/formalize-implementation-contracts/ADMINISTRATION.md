# Owner administration contract

Contract: `card-keepr-administration@1`

The repository CLI is the only initial owner interface. It talks to the
ingestion Worker for catalogue operations, to GitHub for a production release
dispatch, and to the owning secret stores for credential operations. The
ingestion Worker never receives GitHub or Cloudflare deployment credentials.

## Interaction rules

Read-only commands never prompt. Every production-changing command:

- requires `--environment production`;
- prints the resolved Cloudflare account, Worker, D1, and R2 identities before
  confirmation;
- names every target by opaque identity;
- checks an expected current Catalogue Revision;
- accepts secrets only from an interactive hidden prompt, keychain reference,
  or stdin descriptor, never an argument; and
- returns stable JSON with `--json` and the exit codes below.

`--yes` is accepted only with all applicable target identities, expected
revision, content or backup digest, and an idempotency key. A mismatch fails
closed.

Exit codes are `0` success, `2` usage, `3` confirmation declined, `4`
authentication, `5` authorization, `6` not found, `7` conflict or stale
precondition, `8` contract validation, `9` remote/platform failure, and `10`
operation accepted but not yet terminal.

## Commands

| CLI command | Mutation | Required preconditions or bindings |
| --- | --- | --- |
| `keepr status` | no | none |
| `keepr run start` | yes | exact Supported Games; no active run; recovery not blocked |
| `keepr run show` | no | run identity |
| `keepr candidate inspect` | no | run in `awaiting_approval` |
| `keepr run approve` | yes | run identity, candidate digest, expected current revision, unexpired candidate, verified current backup |
| `keepr run reject` | yes | run identity and candidate digest |
| `keepr run retry` | yes | terminal source run; creates a new linked run |
| `keepr backup status` | no | Catalogue Revision identity |
| `keepr backup retry` | yes | current revision; exact failed attempt and export/backup digest |
| `keepr recovery begin` | yes | target Catalogue Revision or bookmark; ingestion and release idle |
| `keepr recovery verify` | yes | recovery operation and restored target digest |
| `keepr recovery accept` | yes | verified recovery operation and expected restored revision |
| `keepr release production` | yes | manual dispatch; production target; expected current revision; ingestion idle; recovery healthy |
| `keepr credential rotate` | yes | credential class; replacement supplied out of band |
| `keepr credential verify` | yes | rotation identity and harmless class-specific probe |
| `keepr credential revoke-old` | yes | verified replacement and exact old credential fingerprint |

The ingestion Workflow owns automatic collection, parsing, reconciliation,
candidate finalization, publication, export verification, expiry, and backup
attempt progression. The CLI observes these automatic transitions; it cannot
skip or rewrite them.

## Ingestion Run states

The only legal non-terminal path is:

```text
planning → collecting → parsing → reconciling → awaiting_approval
          → publishing → published
```

`planning`, `collecting`, `parsing`, and `reconciling` may become `failed`.
`awaiting_approval` may become `publishing`, `rejected`, `expired`, or `failed`.
`publishing` may become `published` or `failed`. `published`, `rejected`,
`expired`, and `failed` are immutable terminal states.

Entering `awaiting_approval` fixes the candidate digest and a deadline exactly
seven 24-hour periods after `candidate_created_at`. At or after the deadline,
expiry wins over concurrent approval. Approval atomically rechecks run state,
deadline, candidate digest, expected current revision, active-run identity, and
recovery health.

## Backup and recovery states

Publishing creates an immutable backup attempt:

```text
pending → exporting → restoring_verification → verifying → verified
```

Any active backup state may become `failed`. A retry creates another immutable
attempt. Only a `verified` attempt whose manifest names the current Catalogue
Revision makes recovery `healthy`.

A recovery operation follows:

```text
preparing → restoring → validating → awaiting_acceptance → accepted
```

Any non-terminal state may become `failed`. Beginning recovery sets recovery
health to `blocked` and blocks ingestion and releases. Failure remains blocked;
the owner must resume with a new linked operation or explicitly restore and
verify another target. Acceptance makes recovery healthy and records the
restored current Catalogue Revision.

## Release and credential states

A production release follows:

```text
requested → preflight → migrating → deploying → smoke_testing → succeeded
```

Any non-terminal state may become `failed`. One release may be active. The
workflow rechecks the expected Catalogue Revision, idle ingestion, healthy
recovery, bindings, migration level, and recovery bookmark before mutation.
After a migration, failure is corrected by a compatible roll-forward unless a
schema-compatible Worker rollback is proven.

A credential rotation follows:

```text
replacement_installed → replacement_verified → old_revoked
```

The old credential remains usable until verification succeeds. The API traffic
gate may deliberately overlap both values during consumer cutover. The
administration key uses a harmless authenticated status probe. Cloudflare
operation tokens and the GitHub-held deployment token use class-specific
least-privilege probes in their owning boundary.

`administration.mjs` is the executable reference transition table. Any
production implementation must accept every transition it accepts, reject
every transition it rejects with the same stable code, and preserve the same
terminal-state and concurrency invariants.
