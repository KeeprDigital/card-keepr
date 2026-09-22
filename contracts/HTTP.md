# Generated HTTP contracts

The [catalogue OpenAPI](read-openapi.json) and [administration OpenAPI](admin-openapi.json)
cover every registered business operation, signed deployment operation, utility
and documentation route. Both Workers use executable Hono/Zod definitions for
routing and generation. [#325](https://github.com/KeeprDigital/card-keepr/issues/325)
completes the routing cutover under [#312](https://github.com/KeeprDigital/card-keepr/issues/312).
Persisted records, Catalogue Exports and domain transitions retain their independent contracts.

## Read or download documentation

Each Worker serves GET `/docs` (HTML) and GET `/openapi.json` (bundled OpenAPI 3.1)
beneath its configured `PUBLIC_BASE_URL`. Catalogue documentation is public;
catalogue data and readiness still require the consumer bearer key. Administration
documentation accepts the primary or replacement administration bearer key and
retains the administration rate limit. It remains readable during recovery or
unavailable catalogue storage. A consumer key does not grant owner access.

The HTML reference contains every operation, request/response schema, authentication
scheme and local schema link. Its styles and definitions are self-contained, with
no scripts, external assets, browser credential storage or subsequent spec fetch.
Download the protected page and open the resulting file in a browser:

```sh
pnpm --silent run keepr docs catalogue --target dev > catalogue.html
pnpm --silent run keepr docs administration --target staging > administration.html
pnpm --silent run keepr docs administration --target staging --json > administration-openapi.json
```

Explicit targets use `KEEPR_DEV_ADMINISTRATION_KEY`, `KEEPR_STAGING_ADMINISTRATION_KEY`
or `KEEPR_PRODUCTION_ADMINISTRATION_KEY`; they never inherit an unscoped key.
Without `--target`, the existing `KEEPR_API_URL`/`KEEPR_INGESTION_URL` and
`KEEPR_ADMINISTRATION_KEY` apply, defaulting to the local Worker addresses.
Public downloads send no credential. The specification link on a saved owner
page still requires the same Authorization header; `--json` downloads it directly.

Served specs and HTML advertise only the active configured origin and mount,
including root and trailing-slash configurations; the incoming Host cannot change
them. Checked-in specs list production from Worker configuration and isolated
bases from the same environment authority used by deployment and CLI selection.
All schema references are bundled. Public documents cache for five minutes;
owner documents are private/no-store. Both set nosniff, no-referrer and a restrictive
Content Security Policy. Only GET is exposed for documentation; image/liveness
HEAD and consumer OPTIONS retain their own explicitly declared behavior.

## Published discovery and reads

Authenticated GET `/v1/games` lists only games in the current published composition.
Each game carries its Game Profile identity, field types and explicit nullability,
accepted filter names, and absolute collection links pinned to that revision.
Unpublished source registrations do not appear. The shared Game Profile definitions
own both these descriptors and the generated Card/Printing wire schemas.
Pokémon Card ability and attack text represents accepted rules-level facts. The
selected Garchomp Erratum updates Sonic Slip in both `effective_rules_text` and
`game_data.attributes.abilities`; original physical wording stays on the Printing's
`printed_rules_text`, with the original Source Observation retained privately.

Within the Pokémon profile, Trainer `trainer_type` preserves the evidenced subtype;
null means the subtype remains unknown. Trainer and Energy `effect_text` describes
accepted Card wording when known, independently of original Printing text. Their
creature-only fields use the profile's explicit null or empty values. Trainer
`hp` can preserve an evidenced printed value, such as Mysterious Fossil's 10 HP,
without changing its Trainer category or inventing a subtype. Its rules for
counting as a Pokémon while in play remain in `effect_text`. Energy
`energy_kind` distinguishes Basic, Special and unknown. `provided_energy` contains
nonempty `units` only when unconditional provision is established (`state: fixed`);
otherwise `state: unknown` and an empty `units` array leave provision unresolved.
Conditional effects remain complete in `effect_text`. These profile semantics do
not establish physical issuance, Card equivalence or complete source coverage.

Card and Printing browsing includes gameplay, token and art categories by default.
Card relationships identify evidenced associated Cards; a Printing's `card_id`
identifies its parent. Collection cursors bind normalized filters to one exact
composition. An unavailable cursor returns 409 with an absolute restart link;
explicit unknown revisions return 404 instead of falling back to current data.
Current-model and query-readiness checks precede conditional responses.

The CLI accepts category and revision on Card search, for example:

```sh
keepr cards search --game riftbound --category art --revision REVISION --json
```

## Authoring and boundaries

Each registered operation uses `createRoute` from `@hono/zod-openapi` in its owning
catalogue cluster. That registration owns method, path, wire inputs, status/media
combinations, headers and security. `httpRoute` binds it to a typed Hono handler;
handlers consume `c.req.valid(...)`. JSON responses parse the declared response
schema before `c.json`, especially when presenters return stored or broadly typed
JSON. Hono does not automatically validate outgoing JSON.

Keep nullability at the use site with `z.union([namedSchema, z.null()])` when
sharing a named component. Applying `.nullable()` to the named schema can change
the generated component globally or leave a nullable reference non-null. Check
both required and intentionally nullable positions against actual responses.

For explicitly free-form retained JSON, validate without rebuilding the value.
Record parsers can strip literal keys such as `__proto__`, changing acknowledged
intent or inspection history. Verify actual commands, retained responses and
replay conflicts for key removal. This applies to free-form intake and unused
review fields; typed Card, Printing and admission fields retain their schemas.

The Card and Printing wire schemas project the Game Profile's declared primitives and
filter paths into Zod. Profile semantic checks, retained-document validators and
domain transitions remain independent of Zod. Card queries retain their existing
normalization, published-value checks, canonical ETags and revision-pinned cursors.
The bounded Card response is validated before returning JSON. Validation precedes
conditional 304 responses. Query errors use 400; malformed JSON uses 400,
unsupported JSON media uses 415, typed command errors use 422, and domain conflicts
use 409. Command bodies are capped at 16 KiB by actual streamed byte count, even
when Content-Length is absent or inaccurate.

Printing Image and Catalogue Export component responses use the checked
`streamingHttpRoute` boundary: declared status, media and required headers are
checked without materializing the body. Image HEAD uses
metadata only and ignores range/conditional headers. GET can return 200, 206,
304 or 416; the response contract names binary media and headers. Neither the
router nor response validation reads or buffers image bodies. Hono's implicit
HEAD-to-GET behavior is gated by the explicitly registered HEAD surface before
any GET handler work; handlers use the original request method for R2 metadata.

Worker middleware groups retain separate credentials, limits, CORS for consumers,
readiness and administration recovery/fresh-baseline guards. Mount rejection and
unauthenticated liveness stay ahead of these groups. Operational logging still
uses mount-free, redacted route segments. Dev deployment retains its separate
signed workflow identity and dev-only guard. Staging release authorization runs
on production before selected code executes; deployment preparation and outcomes
run only on staging. These platform endpoints authenticate the signed manual
workflow separately from owner-key administration. Automatic promotion
(`POST /v1/production-promotions`, production only) accepts the same run's
production-environment identity. Production forwards that identity to staging's
read-only `POST /v1/staging-deployments/{release}/promotion-outcome`; see the
[release procedure](../docs/runbooks/production-release.md#automatic-promotion-from-staging).

## Publication preparation and execution

[#319](https://github.com/KeeprDigital/card-keepr/issues/319) registers all 13
publication-family operations, including the pilot's two operations and every
script-only preparation, composition and export-advance operation. All remain
available; none are consolidated or retired. The maintained family inventory
accounts for their ownership and CLI callers.

Artifact start/resume returns 202 with an immutable
`card-keepr-publication-preparation-acceptance@1` receipt derived from the retained
action, an absolute `links.status`, `Location`, `Retry-After: 2` and no-store.
Replay preserves its original checkpoint and deadline even after the artifact
state changes or dispatch fails. GET preparation status observes that current
state. The unsuffixed preparation POST commits one bounded unit and returns 200.
Query/artifact reads and composition preparation preserve their bounded private
representations; they cannot select the published composition.

POST `/v1/publications/start` takes canonical JSON integer `generation`, retains
whole-candidate approval and dispatches its existing Workflow. It returns 202 with
`card-keepr-publication-acceptance@1`, the original immutable approval fields,
an absolute `links.status`, `Location` and `Retry-After`. Exact replay returns that
same acknowledgement even after status changes. GET `/v1/publications/{publication}`
returns the current `card-keepr-game-publication@1` state. Publication and Backup
Attempt verification remain separate outcomes. Approval without dispatch remains
available through POST `/v1/publications`.

The CLI requests ordinary JSON and derives text and exit status locally through
the shared pure presenter. Acceptance, pending and paused publication exit 10;
failed publication exits 8; published exits 0 and still requires separate backup
inspection. Target resolution, confirmation and canonical release dispatch bytes
remain server-owned. Each family retains its documented outcome semantics.
There is no server-negotiated CLI representation.

Preparation acceptance and pending/paused status also exit 10; failed preparation
exits 8 and verified artifacts exit 0. Generation and sequence are JSON integers;
the CLI converts decimal options once. Publication resume returns the immutable
202 acceptance for its next generation and the same original candidate deadline.
Approval-only POST retains its original approval without dispatch. Publication
advance returns its current status; export advance declares its waiting, terminal
and committed-checkpoint responses separately. Only committed export units bind
immutable replay; waiting replies observe current guards. Domain and retained
document validation stay independent of these wire schemas.

## Source and collection migration

[#317](https://github.com/KeeprDigital/card-keepr/issues/317) migrates all 16
source/collection operations, including the retained-record importer and content
reads without named CLI descriptors. The source-evidence module owns their
registrations. Authority/lifecycle generations are numeric on the wire and convert
to the existing retained decision input format before domain work.

Collection creation/retry returns an immutable initial receipt; the evidence read
returns current status. Resume is a dispatch acknowledgement with observed Workflow
status. The [administration contract](ADMINISTRATION.md#source-and-collection-http)
defines these distinctions and the unchanged owner guards. Retained content uses
the explicit streaming boundary: it checks status, media and required headers
without buffering bytes. Actual-response tests validate retained JSON against the
registered schema and compare snapshot bytes and digest/length headers.

## Game Candidate preparation and inspection

All 15 Game Candidate operations use generated administration contracts owned by
the reconciliation module. The [administration protocol](ADMINISTRATION.md#native-candidate-and-publication-commands)
defines immutable receipts, current status, CLI behavior, pinned inspection and
the separate whole-candidate approval requirement.

Typed responses describe Card categories, applicability, associations and
provenance. Recorded model context selects explicit current or retained historical
fact/input shapes without rewriting immutable evidence. Source-defined values
remain JSON. Candidate image inspection uses the shared streaming boundary to
check declared media and headers without buffering bytes.

## Identity review and admission

All 13 identity/admission operations are registered through the reconciliation
module. The [administration protocol](ADMINISTRATION.md#identity-review-and-entity-proposals)
defines wire inputs, retained decision replay, status-specific responses and
history pagination. Proposal evidence and preparation-scoped identity review are
available in the CLI as well as HTTP. Current profile checks and evidence-backed
admission stay in the domain; retained correction and identity evidence reuse
the shared historical schemas. Admission, correction and review resolution leave
whole-candidate approval and publication separate.

## Curated Revisions

All seven Curated Revision operations use generated schemas under
`/v1/curated-revisions`. The [administration protocol](ADMINISTRATION.md#curated-revision-http)
defines current validation, immutable mutation receipts, historical inspection,
physical evidence retention and CLI behavior. Current proposals remain strict;
explicit historical shapes preserve acknowledged empty-name extensions for exact
replay. Handlers validate retained values without rebuilding their property names.

## Maintenance and software release

[#322](https://github.com/KeeprDigital/card-keepr/issues/322) registers all 16
previous maintenance operations and one separate owner target-resolution operation.
Evidence cleanup, export deletion, status, search repair, Production Release and
owner staging/deployment inspection use their owning modules' generated contracts.
`POST /v1/administration-targets/resolve` accepts typed JSON choices; GET `/v1/status`
accepts no query parameters. The CLI and operational callers use the new resolution
route for exact server-owned confirmation. Both responses are private and no-store.

Cleanup object inspection returns `{objects, next_after}` so the ordinary CLI can
read and paginate it. Cleanup start returns current state after matching original scope/owner/retention;
export confirmation and retry return original attempt receipts while export status
observes current state. Search repair retains its completed result. Release receipts
preserve serialized plans and string-valued dispatch inputs after execution, with
separate cancellation/correction branches. Owner staging preserves its original
authorization and deadline, including exact historical singleton-array scope intent;
fresh scopes must be strings. The separately inventoried signed platform handlers
retain their workflow/environment credentials, expiry and exact-identity checks.
See the [administration protocol](ADMINISTRATION.md#maintenance-http).

## Backup and recovery

[#323](https://github.com/KeeprDigital/card-keepr/issues/323) registers all seven
backup and recovery operations. Their owning module defines the wire commands,
current status, verified success and structured failure responses. The
[administration protocol](ADMINISTRATION.md#backup-and-recovery-http) distinguishes
new dispatch from exact replay, and current recovery documents from their
immutable decision bindings. The [operator procedure](../docs/runbooks/backup-recovery.md)
retains actual restore, verification, replacement binding and explicit owner
acceptance as separate steps.

## Retained run administration

[#324](https://github.com/KeeprDigital/card-keepr/issues/324) registers all 16
retained run operations under explicit historical tags. The ingestion and
reconciliation modules own their schemas; the ordinary per-game preparation and
whole-candidate publication interfaces remain separate. The
[historical administration protocol](ADMINISTRATION.md#historical-run-operations)
defines retired approval, immutable receipt replay and current Workflow observations.

Inspection reuses the evidence-backed run schema or the historical `publicRun`
shape as appropriate. Historical candidate inspection verifies its retained digest
and header without imposing current Card and Printing definitions. Reconciliation
inputs and partitions share named record schemas with native preparation; status
preserves SQL flags, serialized definition pins and phase-owned JSON cursor keys.
The CLI sends numeric reconciliation generations, matching the numeric intent
already retained by historical actions.

## Add or change an operation

1. Start with [required operations](http-operations.json) and the
   [generated route/caller inventory](http-route-inventory.json). The required
   inventory is maintained independently of executable arrays, so deleting an
   operation from both routing and generated output fails coverage. Business
   routes without a CLI command remain required. Caller references are a census
   aid; they do not establish executed test coverage.
2. Define the operation in its owning cluster, bind its validated handler and
   include it in the shared composition consumed by the Worker and generator.
   Utility, documentation and signed platform families follow the same rule.
   There is no optional registration or legacy routing fallback.
3. Update affected CLI, operational and test callers together. Change the required
   inventory only for an intentional addition, consolidation or retirement,
   preserving historical inspection, immutable replay and recovery capabilities.
4. Regenerate with `pnpm generate:http`. Extend request validation and actual
   Worker response checks for the affected status, media and header variants,
   including historical outcomes. Future Game Profiles and game additions must
   regenerate and validate their affected contracts in their own slices.

`pnpm check` requires generated freshness, complete bidirectional operation
coverage, unique registrations/operation IDs, header schemas and resolved bundled
references. Generation emits the specs, caller inventory and compiled response/header
validators. JSON validators share named components with `inlineRefs: false` and
remain split per Worker to fit the test runtime's module transport. These choices
do not relax validation. Worker tests validate actual response bodies, status,
media and declared header values against those generated validators. HEAD, 204
and 304 prove body absence; opaque and binary streams retain byte/range/digest
checks without validation buffering their bodies. Generated request tests exercise
strict-object, safe-integer and supported-environment boundaries. Independent
historical snapshot/export validators remain in place; superseded HTTP
`CommandRequest` definitions have been removed.

Middleware order is part of the boundary:

| Surface                   | Guards before dispatch                                                               | Outcomes outside its success body                                                      |
| ------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Outside either mount      | Configured path check                                                                | 404; no authentication or rate-limit work                                              |
| Liveness GET/HEAD         | Independent liveness limit; no credential or request log                             | 429, sanitized 500; bodyless HEAD                                                      |
| Catalogue docs GET        | Mount and operational logging                                                        | Public HTML/JSON; consumer origin restrictions remain on data                          |
| Consumer preflight        | Allowed Origin/method/header policy                                                  | Bodyless 204, denied 403                                                               |
| Catalogue data/readiness  | Consumer CORS, rate limit and bearer key                                             | 401/403/429; domain/readiness failures and conditional variants declared per operation |
| Signed deployment POST    | Administration limit, environment, signed Workflow identity and exact release checks | Bounded decoding, signature/expiry/conflict errors; no owner bearer substitution       |
| Owner docs/readiness GET  | Administration limit and primary/replacement bearer key                              | 401/429 and sanitized failures; available before recovery guards                       |
| Owner business operations | Administration limit, bearer key, request clock, recovery/fresh-baseline guards      | Shared problem responses plus operation-specific history/receipt/status branches       |

The existing required CI paths run generated checks, actual Worker assertions and
CLI/release smoke tests. The release smoke probes public HTML/spec, the active
server and protected owner docs anonymously, with no owner credential in deployment
workflows. Follow [testing](../docs/testing.md) for the full gate. Local documentation
and contract validation do not establish live deployment, source-launch readiness
or Go-Live.
