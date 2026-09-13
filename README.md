# Card Keepr

A private, single-owner catalogue of English-language Cards and Printings across
publishers. Consumers receive accepted card facts, printed text and publisher
Errata. Tournament eligibility, FAQs, rulings and personal collections are outside
scope. See [domain language](CONTEXT.md) and [architecture](docs/architecture.md).

The API Worker serves authenticated reads at `https://card.keepr.digital/api`;
the ingestion Worker owns administration at `https://card.keepr.digital/ingest`.
A game's presence in the source registry does not establish readiness for consumers.
Launch scope and remaining acceptance live in [GitHub issue #216](https://github.com/KeeprDigital/card-keepr/issues/216).

## Local development

Select the Node version in `.node-version` with your existing version manager.
Install Corepack if needed, then:

```sh
npm install --global corepack@0.36.0
corepack enable pnpm
pnpm install --frozen-lockfile
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/ingestion/.dev.vars.example apps/ingestion/.dev.vars
```

Replace the placeholder credentials in both secret files, then:

```sh
pnpm run db:migrate:local
pnpm run dev
```

The API listens on `http://127.0.0.1:8787`, ingestion on `http://127.0.0.1:8788`.
Wrangler emulates D1 and R2 locally. The copied secret files override
`PUBLIC_BASE_URL` with a local origin; without that override, each Worker expects
its production path prefix. A fresh database starts at `catrev_spine_000` until
its first approved publication.

## Find the right reference

| Task                                                        | Reference                                                                                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Work on the repository                                      | [Development](docs/development.md), [testing](docs/testing.md)                                                                     |
| Understand terminology and design                           | [Glossary](CONTEXT.md), [architecture](docs/architecture.md), [code map](src/catalogue/README.md)                                  |
| Integrate with the API or CLI                               | [Interface contracts](contracts/README.md)                                                                                         |
| Collect sources, resolve identity, admit or correct records | [Sources and owner decisions](docs/runbooks/sources.md)                                                                            |
| Inspect and publish a candidate                             | [Publication](docs/runbooks/publication.md)                                                                                        |
| Verify backups or restore the catalogue                     | [Backup and recovery](docs/runbooks/backup-recovery.md)                                                                            |
| Deploy software or change database bindings                 | [Production Release](docs/runbooks/production-release.md)                                                                          |
| Configure automatic dev deployment                          | [Isolated dev](docs/runbooks/isolated-dev.md)                                                                                      |
| Diagnose failures, repair search or reclaim unused objects  | [Maintenance](docs/runbooks/maintenance.md)                                                                                        |
| Check scheduled tests and source freshness                  | [Scheduled stress](docs/runbooks/scheduled-stress.md), [source monitoring](acceptance/fixtures/retained-official-source/README.md) |

## Quick checks

```sh
pnpm test
pnpm run check
```

`pnpm test` provides everyday feedback. Before code review, use the full routine
suite and validation described in [testing](docs/testing.md).
`pnpm run` lists scripts; the [administration contract](contracts/ADMINISTRATION.md) lists owner commands.
For machine-readable CLI output, use `pnpm --silent run keepr … --json`.

Set `KEEPR_API_KEY` and `KEEPR_ADMINISTRATION_KEY` in the environment for the CLI.
Use `KEEPR_API_URL` and `KEEPR_INGESTION_URL` to select bases including their mount
paths. `pnpm run keepr health --json` checks authenticated readiness on both
Workers. External liveness monitors use unauthenticated `/healthz` on each mount.
