# Maintained interface contracts

These files define the maintained API, Catalogue Export and owner administration
interfaces. Production export validation and the existing contract tests consume
them directly. They are included in normal JSON lint and changed-file formatting.

| Contract             | Source                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generated HTTP       | [Read OpenAPI](read-openapi.json), [administration OpenAPI](admin-openapi.json), [migration bridge](HTTP.md) and [complete route/caller inventory](http-route-inventory.json) |
| Unmigrated read API  | [Legacy OpenAPI](openapi.json) and [response schemas](schemas/api.schema.json)                                                                                                |
| Catalogue Export     | [Manifest](schemas/catalogue-export-manifest-v5.schema.json), [records](schemas/catalogue-export-record-v5.schema.json) and [serialization](SERIALIZATION.md)                 |
| Owner administration | [Administration contract](ADMINISTRATION.md) and [request schemas](schemas/administration.schema.json)                                                                        |

Update the relevant schema alongside its implementation and existing behavioral
tests. Keep schema identities and relative references consistent. Before Go-Live,
definitions evolve in place under [definition policy](../docs/architecture.md#definition-changes-and-go-live).
Domain language and invariants live in [CONTEXT.md](../CONTEXT.md).

Card summaries, details and exports always include `category` (`gameplay`,
`token`, or `art`), `gameplay_applicability` and `related_cards`. Unfiltered
Card browsing includes every category; `category` selects one category and is
part of the revision-pinned pagination and conditional-response identity.

Gameplay and token Cards have applicable gameplay properties; a nullable value
records unknown evidence. Art Cards have inapplicable gameplay properties,
empty `game_data.attributes` and null `effective_rules_text`. Printings also
expose `gameplay_applicability`, so null `printed_rules_text` is independently
distinguishable as unknown or inapplicable. Printing attributes describing the
issued appearance remain applicable to art Printings.

A `related_cards` entry identifies an associated canonical Card with
`kind: shared_artwork`. It means retained evidence connects at least one issued
Printing of each Card; it does not describe every Printing. Administration keeps
the supporting Printing and Source Observation identities. Consumer reads and
exports expose the relationship without that administrative evidence.

Administration request definitions live under `$defs`. The administration
schema's root retains historical snapshot decoding; it does not describe the
current status response or authorize run-owned publication. Native candidate,
artifact preparation, approval and resume inputs have separate named definitions.

Source Erratum evidence uses [official-errata.schema.json](schemas/official-errata.schema.json).
The [architecture guide](../docs/architecture.md) owns design rationale.
