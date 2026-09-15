# Generated HTTP contracts and migration

The catalogue-read interface is fully registered through Hono under
[#316](https://github.com/KeeprDigital/card-keepr/issues/316), following the
[#315](https://github.com/KeeprDigital/card-keepr/issues/315) pilot and
[#312](https://github.com/KeeprDigital/card-keepr/issues/312) direction. The generated
[read OpenAPI](read-openapi.json) covers all consumer routes, API health/liveness
and CORS preflight. The [administration OpenAPI](admin-openapi.json) remains
partial while its families migrate; `x-unmigrated-operations` inventories the
remaining operations. Documentation hosting belongs to the later HTTP tickets.

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
workflow separately from owner-key administration.

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
remain server-owned. Unmigrated families retain their documented outcome semantics.
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

## Migrating a family

1. Find the operation and potential callers in [the generated inventory](http-route-inventory.json).
   [Family assignments](http-migration-families.json) partition the
   administration operations, including those without named CLI descriptors.
   Named descriptors identify the CLI implementation; literal/template caller
   references are an inventory aid, not evidence that a test runs that route.
2. Replace its legacy `route` with a wire registration and validated handler in
   the owning cluster. Both Workers dispatch migrated and legacy operations
   through the Hono bridge. Their outer guards cover both. Administration's
   shared route composition is consumed directly by the Worker and generator.
3. Update all affected CLI, release and test callers together. Record any
   consolidation or retirement in the family assignments, preserving required
   retained-record inspection, immutable replay and recovery capabilities.
4. Regenerate contracts and use actual-response checks at the existing Worker or
   CLI seams. Extend the streaming behavioral tests for binary/header/no-body
   changes. Remove superseded legacy HTTP definitions as their callers migrate;
   retained/export validation contracts continue to have separate ownership.

`generate:http` emits both bundled specifications, the inventory and standalone
response validators used by Worker tests. `check:generated` rejects stale output,
unresolved or unbundled references, duplicate operation IDs/registrations and
migrated operations missing from the generated paths. Servers come from each
Worker's configured public base, including its mount. The inventory explicitly
classifies API health/liveness/preflight registrations and administration utility
surfaces, including dev deployment and signed staging release endpoints, outside
ordinary catalogue route arrays;
there are currently no deployed documentation endpoints.

Follow the repository's [validation policy](../docs/testing.md). Generated response
checks exercise real Worker results and declared headers; image tests also compare
actual bytes and ranges. Successful pilot checks do not establish final HTTP
coverage, source-launch readiness, live deployment or Go-Live.
