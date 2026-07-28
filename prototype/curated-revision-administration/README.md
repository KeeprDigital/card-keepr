# PROTOTYPE — Curated Revision administration

This throwaway logic prototype asks:

> Does one append-only Curated Revision contract let the owner safely author,
> inspect, apply, reaffirm, supersede, and retire exceptional corrections
> without mutating source evidence or leaving concurrency behavior for the
> implementer to invent?

It uses synthetic identities, values, and Source Observation digests. It does
not mutate Cloudflare, persist state, or assert facts about real cards.

Run it from the repository root:

```sh
npm run prototype:curated-revisions
```

Choose a scenario, advance one event at a time, and inspect the complete
relevant state and every accepted or rejected transition.

The proposed contract is in [CONTRACT.md](./CONTRACT.md). The pure reference
state machine is in `curated-revisions.mjs`; the terminal shell is disposable.

This directory is a primary-source discussion artifact. It is not an
implementation starter and must not be merged into `main`.
