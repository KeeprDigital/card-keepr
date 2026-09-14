# Generated HTTP contracts and migration

The Hono pilot in [#315](https://github.com/KeeprDigital/card-keepr/issues/315)
implements the HTTP direction approved in [#312](https://github.com/KeeprDigital/card-keepr/issues/312).
The generated [read](read-openapi.json) and [administration](admin-openapi.json)
OpenAPI 3.1 documents describe the migrated operations. They are deliberately
partial during migration; `x-unmigrated-operations` accounts for the remaining
operations. Public documentation hosting and final complete-contract cutover
belong to the later HTTP tickets.

## Authoring and boundaries

Each migrated operation uses `createRoute` from `@hono/zod-openapi` in its owning
catalogue cluster. That registration owns method, path, wire inputs, status/media
combinations, headers and security. `httpRoute` binds it to a typed Hono handler;
handlers consume `c.req.valid(...)`. JSON responses parse the declared response
schema before `c.json`, especially when presenters return stored or broadly typed
JSON. Hono does not automatically validate outgoing JSON.

The Card search wire schema projects the Game Profile's declared primitives and
filter paths into Zod. Profile semantic checks, retained-document validators and
domain transitions remain independent of Zod. Card queries retain their existing
normalization, published-value checks, canonical ETags and revision-pinned cursors.
The bounded Card response is validated before returning JSON. Validation precedes
conditional 304 responses. Query errors use 400; malformed JSON uses 400,
unsupported JSON media uses 415, typed command errors use 422, and domain conflicts
use 409. Command bodies are capped at 16 KiB by actual streamed byte count, even
when Content-Length is absent or inaccurate.

Printing Image GET and HEAD retain the existing R2 read functions. HEAD uses
metadata only and ignores range/conditional headers. GET can return 200, 206,
304 or 416; the response contract names binary media and headers. Neither the
router nor response validation reads or buffers image bodies. Hono's implicit
HEAD-to-GET behavior is gated by the explicitly registered HEAD surface before
any GET handler work; handlers use the original request method for R2 metadata.

Worker middleware groups retain separate credentials, limits, CORS for consumers,
readiness and administration recovery/fresh-baseline guards. Mount rejection and
unauthenticated liveness stay ahead of these groups. Operational logging still
uses mount-free, redacted route segments. Dev deployment retains its separate
signed workflow identity and dev-only guard.

## Asynchronous publication pilot

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

## Migrating a family

1. Find the operation and potential callers in [the generated inventory](http-route-inventory.json).
   [Family assignments](http-migration-families.json) partition all original 100
   administration operations, including the 20 without named CLI descriptors.
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
classifies health, CORS preflight and dev deployment outside ordinary route arrays;
there are currently no deployed documentation endpoints.

Follow the repository's [validation policy](../docs/testing.md). Generated response
checks exercise real Worker results and declared headers; image tests also compare
actual bytes and ranges. Successful pilot checks do not establish final HTTP
coverage, source-launch readiness, live deployment or Go-Live.
