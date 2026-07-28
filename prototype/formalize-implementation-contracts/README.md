# PROTOTYPE — formalized implementation contracts

This throwaway prototype asks:

> Do the machine-readable read API, Catalogue Export, and owner-administration
> contracts preserve all accepted Card Keepr decisions without leaving state
> transitions, regional legality, serialization, approval, recovery, or
> deployment behavior for the implementer to invent?

It uses synthetic identities and state. It does not scrape Bandai, mutate
Cloudflare, call GitHub Actions, or assert facts about real cards.

Run it from the repository root:

```sh
npm run prototype:implementation-contracts
```

Choose a scenario, advance it one event at a time, and inspect the complete
relevant state and rejected transitions. The terminal shell is disposable; the
pure state machine is in `administration.mjs`.

The proposed handoff artifacts are:

- `openapi.json` — OpenAPI 3.1 contract for the authenticated `/v1` read API;
- `schemas/api.schema.json` — exact JSON response resource shapes;
- `schemas/catalogue-export-manifest.schema.json` and
  `schemas/catalogue-export-record.schema.json` — Catalogue Export schemas;
- `SERIALIZATION.md` — deterministic NDJSON, ordering, digest, and gzip rules;
- `ADMINISTRATION.md` and `schemas/administration.schema.json` — administration
  API/CLI commands, guards, states, and transitions; and
- `CONTRACT.md` — the cross-artifact decisions and acceptance checklist.

The accepted v1 Game Profile and source-adapter definitions remain in
`../v1-game-profiles-source-adapters/`.

This directory is a primary-source discussion artifact. It is not an
implementation starter and must not be merged into `main`.
