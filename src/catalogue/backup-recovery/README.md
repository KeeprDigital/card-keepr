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
