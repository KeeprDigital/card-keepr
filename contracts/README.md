# Maintained interface contracts

These files define the maintained API, Catalogue Export and owner administration
interfaces. Production export validation and the existing contract tests consume
them directly. They are included in normal JSON lint and changed-file formatting.

| Contract               | Source                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated read API | [OpenAPI](openapi.json) and [response schemas](schemas/api.schema.json)                                                                                       |
| Catalogue Export       | [Manifest](schemas/catalogue-export-manifest-v5.schema.json), [records](schemas/catalogue-export-record-v5.schema.json) and [serialization](SERIALIZATION.md) |
| Owner administration   | [Administration contract](ADMINISTRATION.md) and [request schemas](schemas/administration.schema.json)                                                        |

Update the relevant schema alongside its implementation and existing behavioral
tests. Keep schema identities and relative references consistent. Before Go-Live,
definitions evolve in place under [definition policy](../docs/architecture.md#definition-changes-and-go-live).
Domain language and invariants live in [CONTEXT.md](../CONTEXT.md).

Administration request definitions live under `$defs`. The administration
schema's root retains historical snapshot decoding; it does not describe the
current status response or authorize run-owned publication. Native candidate,
artifact preparation, approval and resume inputs have separate named definitions.

Source Erratum evidence uses [official-errata.schema.json](schemas/official-errata.schema.json).
The [architecture guide](../docs/architecture.md) owns design rationale.
