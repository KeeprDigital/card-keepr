# ADR 0005: Dual-key rotation replaces attested credential rotation

## Status

Superseded: the rotation log, route, and runbook were removed in #154 and
credential rotation is deferred until after Go-Live (the two-slot bearer keys
remain).

## Context

Catalogue Consumers are the owner's own applications; there are no
third-party or anonymous clients. The credential rotation subsystem was
nevertheless built to prove, without trusting the owner's own machine, that
a rotation had landed everywhere: a reserved rotation plan in the database,
a boundary attestor subprocess holding provider secrets, independent
observation of Cloudflare and GitHub state from the worker, a signed
consumer proof exchanged between the two workers over a service binding,
and replacement-slot duplicates of every secret. That is roughly seven
thousand lines, three tables, nine secrets, five configuration variables,
seven administration routes, and four CLI commands defending against an
adversary the threat model does not contain.

## Decision

Remove the attested rotation subsystem. Each worker continues to accept a
primary and a replacement bearer key so a rotation never has a gap.
Rotating a key is an operator procedure: set the replacement, verify with a
health call, promote it, and clear the old value, following a runbook. One
administration route records each rotation as an append-only log entry so
the history stays queryable. Provider-side credentials such as the
Cloudflare API token and GitHub environment secrets are rotated by runbook
steps and are not observed or attested by the worker.

Attestation is not forbidden in future. If a second party ever consumes the
catalogue, an attestation layer can be added on top of the dual-key model
without reversing this decision.

## Consequences

There is no machine-verifiable proof that a rotation reached every
provider; the runbook's verification call is the check. The consumer-proof
service binding, the observation secrets, the replacement-slot secrets
beyond the two bearer keys, the rotation tables, and the boundary attestor
CLI are deleted. The ingestion worker's configuration drops to the bindings
its own behaviour needs.
