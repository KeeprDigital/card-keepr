# Retained official-source fixtures and monitoring

Top-level JSON files retain actual Bandai response bytes, URLs, capture times,
status and digests. `body_base64` contains either the full response or an exact
range with offsets, full-body size/hash and range hash. Verify bytes before
passing them to the current production adapter. The metadata owns capture dates
and provenance; filenames distinguish the publisher and source shape.

Standalone HTML fragments are focused parser examples, sometimes with normalized
line endings; they are not recapturable HTTP goldens. A retained range cannot
establish whole-response equivalence unless a complete golden of the exact same
original digest supplies the missing bytes. Synthetic changes in tests must remain
separate from actual source evidence. Keep retained captures immutable.

The ten audited policy/legality-named captures remain historical regression
fixtures and are excluded from recapture under the
[card-content scope](../../../docs/architecture.md#catalogue-scope-and-source-authority).
Rules/DON!! hubs, news/errata and Errata Applied detail pages that carry current
card-content evidence remain monitored. The exclusion list lives in
`scripts/official-source-recapture-assessment.mjs`.

## Weekly recapture

[official-source-recapture.yml](../../../.github/workflows/official-source-recapture.yml)
runs Tuesdays at 04:23 UTC and on manual dispatch. It verifies the top-level
capture records, excludes the audited eligibility-only URLs, and fetches each
remaining distinct URL once, sequentially one second apart. Requests have a
30-second timeout, 16 MiB body bound and no redirects.

After `pnpm install --frozen-lockfile`, explicitly fetch into a new directory:

```sh
node scripts/recapture-official-bytes.mjs /tmp/official-source-recapture
```

Each capture retains a digest-checked complete `.body` and separately identifies
the original retained range. Current adapters compare complete observations,
sidecars and discovered requests. Output paths reject golden-directory aliases,
existing files and symlinks; no old evidence is overwritten.

Categories are `unchanged`, `cosmetic_drift`, `semantic_drift`, `structural_drift`,
`unresolved_drift`, `integrity_failure`, `transport_failure` and `out_of_scope`.
Actionable results fail the job; missing baseline bytes remain unresolved.
Cosmetic drift retains exact raw bytes. No image query strings or optional facts
are normalized away. These checks establish bounded source-interface behavior,
not complete game coverage.

Artifacts expire after 14 days. The failing workflow updates its GitHub issue and
lists findings in the run summary. Preserve needed evidence before expiry.
Reassess a downloaded artifact offline:

```sh
node scripts/assess-official-recapture.mjs /tmp/official-source-recapture /tmp/new-assessment.json
```

Review real changed bytes and rerun adapter contracts before replacing a golden.
Manual replay/recapture success does not establish that the default-branch schedule
ran. Check the workflow monthly and after a quiet period; require an active
workflow and a scheduled run no older than a week:

```sh
gh workflow view official-source-recapture.yml --repo KeeprDigital/card-keepr
gh run list --workflow official-source-recapture.yml --limit 3 --repo KeeprDigital/card-keepr
```

If disabled, use `gh workflow enable official-source-recapture.yml` and then
`gh workflow run official-source-recapture.yml`. GitHub schedules may stop after
60 days of inactivity and run only from the default branch.

## Reviewed monitoring baselines

[monitoring/baselines.json](monitoring/baselines.json) pins separately reviewed
complete captures by body digest and selection reason. The matching `.json.gz`
files retain exact body bytes and metadata. Recapture uses these by default after
checking URL, completeness and digests; historical parser fixtures remain unchanged.

`category`/`actionable` describe the monitoring comparison. `baseline_file` and
`baseline_full_body_sha256` identify it. Older `status`, `differences` and
`expected_full_body_sha256` still describe the original regression capture, so
`status: drift` with `category: unchanged` is valid.

Raw comparisons include all observations and requests. Two reviewed display-only
equivalences are separate: complete Fusion Product-item permutations within one
status section, and version tokens on three exact decorative Gundam thumbnail
paths. Other facts, statuses, URLs and tokens remain exact. The earlier partial
Gundam capture never established complete-response equivalence.

Offline replay uses historical baselines unless explicitly selected:

```sh
node scripts/assess-official-recapture.mjs /path/to/artifact /tmp/report.json --reviewed-baselines
```
