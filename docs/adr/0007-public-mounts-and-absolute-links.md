# ADR 0007: One host, two path mounts, absolute links

## Status

Accepted

## Context

The two Workers had no public address of their own. Each `wrangler.jsonc`
declared bindings and vars but no route, the CLI and the production smoke
checks resolved route paths against whatever origin an operator exported,
and every link the API emitted was a root-relative path such as
`/v1/cards`. That works only while a Worker owns the root of a host.

The catalogue is served from the existing `keepr.digital` Cloudflare zone,
and one host, `card.keepr.digital`, should carry both Workers. Cloudflare
offers two ways to do that: a router Worker in front of both, or zone
routes that map path prefixes of the host to each Worker directly. A
router adds a third deployable and a hop on every request; zone routes
are declarative configuration on the Workers that already exist. Zone
routes match on path, so each Worker must know the prefix it is mounted
under, and a root-relative link would resolve against the host, outside
the mount.

Catalogue Exports embed the same route paths in their manifests and
records. Those packages are immutable and digest-verified, so the API
cannot rewrite them at read time without breaking their self-verification.

## Decision

The API is mounted at `https://card.keepr.digital/api` and the ingestion
Worker at `https://card.keepr.digital/ingest`, through zone routes on the
`keepr.digital` zone (`card.keepr.digital/api`, `card.keepr.digital/api/*`,
and the `/ingest` pair). There is no router Worker and no custom domain.

Each Worker owns one source of truth for its public address: the
`PUBLIC_BASE_URL` var in its `wrangler.jsonc`. The helper in
`src/http/public-base.ts` derives the mount path from that URL, strips it
from every inbound request before routing, and answers a request outside
the mount with a `404` problem before rate limiting or authentication.
Only the path takes part in routing: a request that reaches the Worker
through another origin (local `wrangler dev`, the Vitest pool) is routed
by path alone, so local development and tests override the var with a
path-free local origin and keep root mounting. Cursors, operational log
routes, and the diagnostic `path` fields consumed by the CLI stay
mount-free route paths.

Every link the API emits is an absolute URL built from `PUBLIC_BASE_URL`:
collection `self` links, the catalogue `links` block and `current_export`,
Catalogue Export `self` links, `links.collection` on cursor problems, and
the `links` of every stored Card, Printing, Printing Image, and Product
document, which the API rewrites at read time so storage stays
host-independent. The ingestion Worker's administration operation links
are absolute in the same way. `KEEPR_API_URL`, `KEEPR_INGESTION_URL`, and
the smoke check's `API_BASE_URL` are base URLs that carry the mount path;
the CLI and smoke script append route paths to them.

The guarded release deploys with `wrangler versions upload` and
`versions deploy`, which carry code, vars, and bindings but never apply
routes, so it runs `wrangler triggers deploy` for both Workers after
activation and before the smoke checks.

## Consequences

Zone routes do not create DNS, so a proxied placeholder record for
`card.keepr.digital` must exist before the first release. The GitHub
`production` environment's `API_BASE_URL` must be the public API base.

The API contract accepts absolute links (a link is an `http(s)` URL ending
in the route path, or the route path itself for older records). Catalogue
Export packages are not changed: their manifests and records keep the
root-relative API route paths they were built with, and the API serves a
manifest byte-for-byte as stored, so `manifest_sha256` keeps verifying.
Consumers resolve those fields against the API base until #124 replaces
them with identifiers and route templates.

Moving a Worker to another host or path is a change to one var and two
route patterns; nothing stored in D1 or R2 records the host.
