# Dependency patches

## Cloudflare test-pool persistence path

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
execution, before broader suites. See the
[publication test contract](../docs/testing.md#publication-large-workload-acceptance).

## Wrangler SQL compound-statement boundaries

`wrangler@4.130.0.patch` corrects the paired `BEGIN`/`CASE` and `END` keyword
boundaries in the existing quote/comment-aware SQL splitter. Punctuation can
separate keywords: an expression index uses `CASE ... END,`, and a trigger can
contain `value=CASE ... END` or `(CASE ... END)`. Whitespace-only boundaries group
unrelated definitions or split a trigger body before its final `END`.

The native backup regression in [#323](https://github.com/KeeprDigital/card-keepr/issues/323)
found an index grouped with hundreds of recovery triggers. Moving that group
before retained data activated the original recovery fence during import.
The patch recognizes punctuation while excluding identifier characters and
parameter prefixes; it does not replace text in SQL literals. Native recovery
exports restore data before installing the original indexes and triggers.

Keep this patch, `pnpm-workspace.yaml` and the lockfile together. Remove the patch
when the pinned upstream splitter handles both opener and closer boundaries.
Validate the whole `native-recovery-export` acceptance file, which covers native
restore and retained fences, paired CASE syntax, quoted/comment text, long
records and virtual-table rejection, then the complete backup/recovery owner
journey before broader suites.
