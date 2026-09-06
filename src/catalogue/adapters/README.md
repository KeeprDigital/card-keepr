# Official Source adapters

Each Supported Game has one adapter module: `one-piece-adapter.ts`,
`fusion-world-adapter.ts`, `digimon-adapter.ts`, and `gundam-adapter.ts`.
Gundam applies the same parser to its two locale contracts. A game module
owns its active registration, field table, structured-surface normalization,
inline Card or Card detail HTML parser, Erratum grammar, and game-specific
Product and correction parsing. Its exported adapter exposes
`parse(surface, bytes)` and request discovery alongside registration facts.
`surface` binds the request URL, request identity, and retained media type;
parsing returns the `OfficialSourceObservation` union and performs no I/O.
The existing wire shapes distinguish Catalogue, Official Erratum,
and surface-evidence observations; canonical builders check those shapes without
adding new fields to retained output.

`source-adapters.ts` adapts that interface to the registered
`parseBytes(bytes, context)` interface and ships only Official Source registrations.
Synthetic registrations live in `test/support/source-adapters` and are installed
explicitly by the test Worker entrypoints through the registry seam.
`product-release-source-adapters.ts` only assembles the game adapters and reads
their discovery roots.

Shared mechanisms stay below the game modules:

- `adapter-normalization.ts` maps Products and Releases using each game's
  field table, validates canonical fields, and closes partition coverage.
- `adapter-html.ts` provides shared HTML extraction and observation assembly.
- `adapter-product-html.ts` parses common Product HTML using the game's
  title field configuration, heading validator, and Release precision.
- `bandai-adapter-runtime.ts` applies request/surface routing, discovery,
  completeness checks, and evidence attachment. It receives each game's
  normalization, Card, Product, Erratum, and policy parsing functions.
- `official-source-authority.ts` is the common exact URL authority used by
  both registration and parsing; it is not a second adapter registry.

`AdapterParseFailure` distinguishes `source-contract` failures from
`configuration` failures. Source-contract failures cover explicit grammar
failures, invalid source URLs, and native decoding failures; messages remain
unchanged. Ingestion translates only that category into the existing
`source_parse_failed`/`source_discovery_failed` problems. Registration capacity,
contract, and ownership invariants use the configuration category and propagate,
along with unexpected programming errors.

## Retained-byte equivalence

Before #109, observations and discovery results were captured from commit
`8e5cb5c` for all 69 retained JSON and HTML fixtures. Every fixture has a
successful parse in the captured request/surface matrix. The matrix includes
surface identities, dynamic listing/detail/product requests, and discovery
stages; it also preserves rejection messages for incompatible contexts.

`test/domain/adapter-retained-observations.json` retains the fixture-byte and
serialized-output SHA-256 goldens. The test hashes `JSON.stringify` output
without canonicalizing it, so property order is covered as well as values.
The full before/after output was also compared byte-for-byte with `cmp`:
both files had SHA-256
`c010baf80578cec667afc71b956c543fc9d78fe2110a3a57eefa2ac5695adfe6`.
Set `KEEPR_ADAPTER_OBSERVATIONS_PATH` when running the test to export its full
observation matrix for inspection. The golden has no automatic update path.
The existing retained-source contract tests and fixture locations are unchanged.
