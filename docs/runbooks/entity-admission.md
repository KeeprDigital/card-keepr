# Entity admission

Entity Proposals are administrative intake for real Cards and Printings. They do
not publish data. An admitted entity enters the next selected game's reconciliation;
the owner still inspects and approves that exact Catalogue Candidate.

## Owner intake and decisions

Use the existing administration credentials with these CLI commands:

```sh
keepr entity-proposal create --proposal proposal.json --yes --json
keepr entity-proposal list --game one-piece --json
keepr entity-proposal inspect --proposal-id PROPOSAL_ID --json
keepr entity-proposal admit --proposal-id PROPOSAL_ID --decision decision.json --yes --json
```

A proposal file contains `game`, `source_lineage` (`owner` for personal intake),
`reference` (stable within that source), `content`, `evidence`, and
`idempotency_key`. Each proposal is limited to 64 KiB. `content` contains the
Card and optional Printing using the current game's normalized `card` and
`printing` shapes, without canonical IDs. Incomplete content can be retained;
admission subsequently validates required structure against the Game Profile.
Unknown publisher numbers use `{ "kind": "unknown", "value": null }`.
Missing optional facts stay explicit unknowns.

For personal inspection, `evidence.attestation` records what the owner inspected.
Retained source intake references its captured snapshot and observation; it does
not claim that a synthetic fixture is real-source evidence. Inspect appended
source captures through `GET /v1/entity-proposals/PROPOSAL_ID/evidence?after=CURSOR`.

A decision file contains `expected_generation` (a decimal string), `rationale`,
and `idempotency_key`. The CLI supplies the operation as `action`. Use `admit`,
`link`, `reject`, or `reconsider` with the same command structure. Linking requires
`card_id` or `printing_id` from the current catalogue and never changes its facts.
A new Printing for an existing Card uses `admit` with that `card_id`. A Printing
always requires an identified Card in the same game. Known numbered Cards cannot
be duplicated by admission; link their evidence instead.

An explicit exception has this shape:

```json
{
  "expected_generation": "0",
  "rationale": "Explain the evidence and the decision",
  "idempotency_key": "a-unique-owner-intent",
  "exception": {
    "scope": ["source_evidence", "identity"],
    "attestation": "Record the owner's specific personal inspection"
  }
}
```

Use only the necessary exception scopes. Manual Printing identity requires a
specific identity attestation unless retained source evidence already establishes
its novel appearance. Exceptions cannot waive required game structure or an
identified Card relationship. They apply to the immutable proposal content;
an incoming contradiction of the attested identity blocks publication. Unrelated
optional source changes do not invalidate the attestation. Existing entity corrections remain Curated Revisions.

The initial intake and every decision are immutable. `reconsider` may append
new `content` and `evidence` objects in its decision file; admission binds to that
exact retained intake revision. Inspection preserves `initial_intake` and the
complete decision history. Reconsideration and re-admission of an established
entity preserve its canonical IDs; changing an established identity requires the
identity correction process, and changing its selected facts uses Curated Revisions.
Repeating a key with different content or
using a stale generation fails. Reconsidering an owner rejection requires an
explicit owner decision; automated refreshes retain the rejection. Owner mutations
require collection, recovery and release operations to be idle. Inspection pages
include a `next_history_cursor`, supplied as `--after-generation` on the next
inspection; proposal lists use `--after` and `next_cursor`.

## Source rules and reconciliation

Game Profile validation establishes required Card and Printing structure.
Registered supplemental sources may automatically admit under their source rule
when designated authority for the applicable Card and Printing areas, with an
unambiguous identity and retained structured real-card evidence. New Printings
also require explicit novel-appearance evidence. There is no universal
corroborating-source count or mandatory publisher number. Other source intake
requires an owner admission decision.

Reconciliation retains source proposals, capture references and automatic
decisions. Unresolved or rejected proposals produce explicit
`entity_proposal_excluded` warnings; they do not allocate speculative IDs. A
candidate can proceed when the exclusion leaves its remaining relationships
consistent. Required identity or structural contradictions that cannot be
isolated still block reconciliation.

`pinEntityAdmissions(database, runId, games)` records an immutable run marker,
including an empty decision selection, exact proposal generations and the
selected authority snapshot. Retries reuse that selection. Proposals originating
from that run's own retained source evidence are separate intake within the run;
owners cannot mutate their decisions during collection/reconciliation. Admission
policy digests bind the Game Profile and source requirements. Changed requirements
flag accepted records for reassessment and preserve their IDs and history.

Publisher evidence that matches an established identity retains its ID and adds
source mappings. `publisher_confirmation.fields` names only concrete matching
facts from that publisher observation. Missing facts remain unknown, and publisher
ownership does not replace the owner's Source Authority designation. Neither
admission evidence nor its history appears in consumer Card/Printing documents.

The executable admission scenarios use explicitly synthetic owner attestations
and source fixtures. They prove behavior, not a verified real supplemental-only
Card or complete real-source coverage. The existing retained real-source dossier
remains a separate evidence gate.
