# One Piece declared two-source coverage

Both source adapters target the shared `one-piece@1` Game Profile. Bandai's
existing complete discovery contract remains available. The named
`p-001-catalogue` contract is independently complete for the English P-001
catalogue search and linked Printing pages only. It is not all One Piece cards,
all official publications, Products, or Errata. Inspect named coverage contracts
through `keepr source registry --json`.

The [example plan](../examples/one-piece-two-source-plan.json) selects both
sources as required. Its Bandai entry uses `p-001-catalogue-and-corroboration`,
which adds the separate Store Championship Wave 1 page and Trophy Card image.
The catalogue absence claim still covers only the seven-modals search, never the
separate event publication. Collection pins participation and subset before any fetch.
Use it with the owner CLI:

```sh
keepr source collect --plan-file docs/examples/one-piece-two-source-plan.json \
  --idempotency-key OWNER_CAPTURE_INTENT --json
keepr source resume --run-id RUN --json
keepr source show --run-id RUN --json
keepr entity-proposal list --game one-piece --json
```

For an official-only refresh, copy the plan and retain just its Bandai entry.
For an optional Limitless attempt, explicitly change its participation to
`optional` before starting a fresh collection. Neither operation changes Source
Authority. An optional outage carries accepted facts and their actual evidence
forward; it is not a successful source check. A narrower scope never establishes
disappearance outside that scope.

The retained 2026-09-06 evidence has seven Bandai modals and eight Limitless
variant pages, with every one of their fifteen front images. Parsers verify
source identities, duplicate locators and the declared/parsed inventory rather
than hardcoding those observed counts as a success condition. Required missing
identifiers or malformed inventories fail collection. A source's record suffix
or image URL is not an explicit publisher artwork identity.

Unproven Printing identities remain Entity Proposals. Official ownership does
not waive admission evidence. Use the [existing admission commands](entity-admission.md)
to record an explicit identity exception or link to an accepted Printing; this
is distinct from the later exact candidate approval. A sealed intake candidate with exclusions retains the game's preparation slot.
Keep its inspection, then explicitly abandon it before preparing a new candidate
that includes subsequent owner decisions:

```sh
keepr game-candidate abandon --candidate-id CANDIDATE --generation GENERATION \
  --idempotency-key ABANDON_INTENT --yes --json
```

No parser creates owner
attestations or silently installs the research pack's visual findings as mappings.

The retained review establishes the Bandai P-001 / Limitless base pair's matching
artwork, crop, printed markings and text. Physical finish remains unestablished.
The Limitless `v=4` WINNER appearance is absent only from the bounded seven-image
Bandai catalogue capture. A separately retained Bandai Store Championship page
and Trophy Card image corroborate its real issued appearance. This is not global
official absence or evidence of an unobserved foil finish. See the immutable
[evidence pack](../../acceptance/fixtures/real-sources/2026-09-06/README.md).

The executable local replay uses original entity bytes and retained header
metadata, with network delivery and the Cloudflare control plane simulated.
Its request times are local replay times, not new live source checks. It never
connects to production. Run the evidence integrity gate independently:

```sh
node scripts/source-evidence/replay.mjs acceptance/fixtures/real-sources/2026-09-06
node --test --test-concurrency=1 acceptance/one-piece-two-source.test.mjs
```

Publication uses shipped Workflows, exact per-game inspection/approval and the
verified backup checkpoint described in [atomic game publication](atomic-game-publication.md).
Consumer API and exports contain accepted facts and explicit unknowns;
source labels, admission history and coverage health remain administrative.

The retained seven-pair mapping is:

| Bandai locator | Limitless page variant |
| --- | --- |
| `P-001` | base page |
| `P-001_p1` | `v=1` |
| `P-001_p2` | `v=2` |
| `P-001_p3` | `v=3` |
| `P-001_p4` | `v=5` |
| `P-001_p5` | `v=6` |
| `P-001_p6` | `v=7` |

The executable journey records explicit owner decisions for these pairs; this
table does not install mappings. Linked observations can contribute complementary
known facts to the same reviewed Printing. An unknown value does not contradict a
known one, and two different known values still block reconciliation. Rarity and
printed text remain unknown for the supplemental WINNER appearance where its
source does not establish them.

For measurements, set an output path outside the immutable source pack:

```sh
KEEPR_P001_METRICS_PATH=/tmp/one-piece-measurements.json \
  node --test --test-concurrency=1 acceptance/one-piece-two-source.test.mjs
```

The test writes this report only after consumer and restored API/export checks
pass. It counts original source/header bytes, actual table rows and allocated
SQLite table/index pages, instrumented D1 statement attempts, workflow elapsed
time, and verified compressed/uncompressed export bytes. It preserves the normal
30-per-minute administration limit by pacing owner requests and polling; overall
journey wall time includes this pacing and five publication/checkpoint cycles.
Retained row counts are a storage amplification measurement, not a count of all
SQL writes. Node-driver CPU/RSS excludes workerd and CLI processes. These local
measurements do not establish production isolate CPU or peak-memory capacity.

Backup verification imports actual exported SQLite into a disposable target.
After stopping the local runtimes, the test restores that imported database into
the disposable API binding and boots the API again using the retained R2 objects.
It compares the restored public Printing export and reads the WINNER Printing.
This verifies the imported result through the ordinary consumer boundary.
