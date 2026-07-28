# PROTOTYPE — v1 Game Profiles and source-adapter contracts

This throwaway prototype asks:

> Can the proposed v1 Game Profiles and source-adapter policies represent the
> four Supported Games without leaking Official Source presentation into
> Catalogue Data or allowing incomplete source coverage to publish?

The prototype uses synthetic observations shaped like the researched Official
Sources. It does not scrape Bandai and none of its sample names, card numbers,
or text assert facts about real cards.

The dependency-free Node runtime is an explicit prototype assumption based on
the accepted Cloudflare Workers architecture. The contract itself is
runtime-neutral.

Run it from the repository root:

```sh
npm run prototype:game-contracts
```

Choose scenarios to inspect the source observations, resulting canonical
candidate, diagnostics, and publication outcome. Press `a` to run every
scenario and `q` to quit.

The complete proposed contract is in [CONTRACT.md](./CONTRACT.md). The pure
evaluation logic is in `contract.mjs`; the terminal shell is disposable.

This directory is a primary-source discussion artifact. It is not an
implementation starter and must not be merged into `main`.
