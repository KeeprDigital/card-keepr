# Ingestion implementation

The cluster's public interface stays in `index.ts` and `ingestion.ts`.
Implementation modules separate responsibilities without changing Ingestion Run transitions:

- `run-lifecycle.ts` starts, retries, rejects, and reads runs.
- `publication-lifecycle.ts` approves candidates and reconciles abandoned publication reservations.
- `publication-commit.ts` builds publication statements and atomically publishes verified data.
- `publication-storage.ts` reserves, writes, verifies, and fences publication objects.
- `publication-cleanup.ts` records publication failure and owns claimed cleanup attempts.
- `administration-idempotency.ts` claims administration requests and validates correlated replay outcomes.
- `administration-inspection.ts` assembles status, candidate inspection, and release smoke targets.
- `run-storage.ts`, `run-freshness.ts`, and `run-types.ts` hold the shared persistence operations and row types.
- `run-document-codec.ts` and `candidate-codec.ts` decode retained documents; `run-values.ts` holds scalar checks.

The codecs use the shared `decodeDocument` helper. JSON shapes live in
`../shared/document-schemas.mjs`; domain relationships, canonical timestamps,
publication ownership, and run-state consistency remain explicit codec checks.
Schemas preserve the existing accepted documents and problem messages.

Run `npm run documents:generate` after changing a document schema and commit the
generated validator and declaration files. Ajv compiles these validators ahead
of time, so decoding needs neither runtime code generation nor Ajv imports.
`npm run documents:check` verifies that both generated files match their schemas.

Ingestion Run states, ordered progress stages, and allowed transitions live in
`../shared/ingestion-run-state.ts`. `assertIngestionRunTransition` validates
administration preconditions while retaining each action's existing problem.
`ingestionRunTransitionSql` validates a planned edge and produces its SQL source
predicate; every state-changing UPDATE uses it, including workflow and Curated
Revision failure paths. The UPDATE remains a compare-and-set, so a stale
Workflow replay cannot move a run backwards or overwrite a winning action.

A paused run may fail only when the same transaction records its explicit
termination and sets `ingestion_run_terminated`. The guard receives those planned
facts; the database trigger independently requires the actual retained record.
Action-specific checks still distinguish termination from ordinary failure,
capacity extension from resume, and retrying an evidence run from retrying a
fixture run. State comparisons in inspection and idempotency validate retained
outcomes rather than defining additional transitions.

`acceptance/ingestion-run-state.test.mjs` applies the migrations and exercises
the installed trigger against every state pair and termination fact combination.
A transition-table edit must update the trigger through a forward migration;
the parity test fails if either side disagrees. Unchanged-state SQL updates are
idempotent no-ops and are deliberately not edges in the transition table.
