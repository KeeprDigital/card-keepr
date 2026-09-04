# Domain Docs

## Before exploring, read these

- `CONTEXT.md` at the repository root.
- `docs/adr/` entries relevant to the area being changed.

## File structure

This repository has one domain context shared by both Workers:

```text
CONTEXT.md             Domain vocabulary and invariants
docs/adr/              Architecture decisions
docs/runbooks/         Operator procedures
src/catalogue/         Shared domain clusters and repositories
apps/api/              Catalogue read Worker
apps/ingestion/        Administration and workflow Worker
cli/                   Operator command interface
migrations/            Baseline and guarded forward migrations
test/                  Domain tests and shared test support
acceptance/            End-to-end and contract tests
```

## Use the glossary's vocabulary

Use terms as defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids. If a required concept is missing, reconsider the terminology or note the gap for domain modeling.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it.
