# PROTOTYPE — completed lifecycle, evidence, and export-deletion contracts

This throwaway prototype asks:

> Do lifecycle and evidence read sidecars plus guarded Catalogue Export
> deletion now behave as one revision-pinned, provenance-first, fail-closed
> contract, without leaving destructive-operation behavior for the implementer
> to invent?

It uses synthetic identities and state. It does not scrape Bandai, mutate
Cloudflare, call GitHub Actions, or assert facts about real cards.

Run it from the repository root:

```sh
node prototype/formalize-implementation-contracts/cli.mjs
```

Choose a scenario, advance it one event at a time, and inspect the complete
relevant state and rejected transitions. The terminal shell is disposable; the
pure state machine is in `administration.mjs`.

The maintained OpenAPI, API/export schemas, administration contract and
serialization rules now live in [contracts/](../../contracts/README.md).
The CLI reads those schemas from that directory for its syntax check; its
historical scenario behavior does not define the current consumer contract.

The original proposal remains in [CONTRACT.md](CONTRACT.md). This directory is
retained as discussion history and is excluded from normal lint and formatting.
