# Cloudflare test-pool persistence path

`@cloudflare__vitest-plugin@1.1.6.patch` preserves `miniflare.resourcePersistencePath`
when parsing Worker options, then passes it to Miniflare's shared runtime options.
Without both changes the plugin silently drops the configured path. The ingestion
test runtime needs its own known database location for a native SQLite snapshot
and streamed SQL backup/restore, avoiding Miniflare's whole-export JSON limit.

Keep the patch with `pnpm-workspace.yaml` and the lockfile. It applies only to the
pinned test dependency. Do not change production persistence or inspect another
test runtime's temporary files to compensate for a missing path.

Remove it once the upstream pool exposes an equivalent supported persistence path.
Validate `publication-backup-transport` acceptance and the ingestion
`publication-caller-retirement.spec.ts` file, including controlled and real binding
execution, before broader suites. The [implementation record](../docs/reviews/publication-253-implementation-20260912.md)
retains the failed partial patch and successful end-to-end proof.
