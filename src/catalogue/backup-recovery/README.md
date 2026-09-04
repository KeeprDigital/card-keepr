# Backup and recovery persistence

The domain modules own capability checks, Workflow orchestration, reads, writes,
and atomic batch composition. Repository functions only prepare and bind named
statements; they do not execute them. Backup Attempt persistence lives in
`backup-repository.ts`, recovery journals in `recovery-repository.ts`, Workflow
requests in `backup-workflow-repository.ts`, and FTS export leases in
`card-search-recovery-repository.ts`.

`backup-verification-repository.ts` defines the three bounded verification query
shapes used by both local D1 and the remote D1 API. The domain chooses the
verification request and evaluates its result; SQL and binding order stay in the
repository. FTS DDL is shared with remote restore through the existing
`card-search-recovery-statements.ts` schema definitions.

Owner tokens, state and phase predicates, retained evidence, and guard statement
ordering remain part of each repository statement's contract. Callers retain the
same batch boundaries and check affected-row counts where required.

## Durable dispatch

Publication reserves the immutable backup Workflow request and its pending dispatch in the same D1 transaction as the Catalogue Revision. Approval waits for up to three dispatch attempts, using one deterministic Workflow identity. A lost create response is reconciled through the shared Workflow driver. Failure leaves the published catalogue readable and its recovery health degraded; it never manufactures a failed Backup Attempt while a Workflow may already exist.

`GET /v1/status` lists pending or failed dispatches under `diagnostics.backup_dispatches`; the Backup Attempt inspection also includes `dispatch`. Each includes the exact `POST /v1/backups` retry body and the three-attempt bound per request. Replaying that body retries the retained dispatch, preserving its original timestamp and identity. An acknowledged dispatch is not downgraded by a concurrent failed observer. Backup execution failures continue to use the existing immutable failed-attempt retry chain.

The approval route accepts a completion waiter. The runtime request-clock harness configures a bounded test waiter; ordinary requests await only durable dispatch, while verification proceeds in the Workflow.
