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
