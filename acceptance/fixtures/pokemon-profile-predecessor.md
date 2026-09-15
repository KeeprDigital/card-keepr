# Pokémon profile predecessor

`pokemon-profile-predecessor.json.gz` contains actual application state captured
on 15 September 2026 from commit `ebbdd7abeccc241e0dac050f70c2977325b2223e`,
with database schema 37. Its compressed SHA-256 is
`75eb256770ca1f99e9eb28a3b99dc6409b0e209fd8d4a8d340de1201f65cb4fa`.

The 7,902,394-byte bundle holds two SQLite snapshots and 169 R2 objects totaling
8,471,168 logical bytes. The snapshots are 8,650,752 and 8,667,136 bytes. Both
retain the original preparation definition string with SHA-256
`beb291d56486d8f542d134a0b659c63e10c37bf5fbe0db942c543e2ae8197429`.
The fixture records four application source fingerprints, independently checked
against that Git commit. It contains no live account credentials.

## Capture

An isolated archive of that exact commit ran the existing Pokémon pilot against
the original offline [source captures](real-sources/2026-09-14-pokemon/README.md).
The unmodified application collected evidence, retained five owner and two
automatic admission decisions, published the original and corrected catalogues,
and verified each actual SQL export/import. The existing acceptance assertions
checked three Cards, seven Printings, original and corrected Garchomp rules,
three original image objects, consumer reads and exports through an independently
imported database. These captures describe the bounded pilot, not the complete
TCGdex inventory.

The capture helper saved the completed source database before the acceptance
restore helper replaced that disposable binding with its verification import.
It then restored that exact saved source database, collected the same retained
correction plan, and saved a sealed candidate. After ordinary owner abandonment,
the old application created a new preparing candidate. A test-only Workflow
scheduling wrapper held its dispatch; all operation, definition and owner writes
came from the old production functions.

Final extraction copied both actual database snapshots, all original bucket
objects, current and pinned exports, consumer records and owner history. Capture
instrumentation initially failed on the restored-database fence and then on a
receipt field typo; those runs remain recorded as failures. Read-only extraction
completed from the retained states without altering their definitions or receipts.

## Transition contract

The transition test imports these bytes into disposable bindings and applies
current forward migrations. It checks unfinished preparation against the exact
old definition, and checks sealed publication guard eligibility at the captured
clock. The latter does not authorize publishing expired work or claim a full
sealed-candidate publication test.

Normal owner pause and abandonment release the unfinished candidate. Fresh
preparation from its retained evidence uses current definitions, followed by
whole-candidate approval and actual SQL export/import verification. Historical
export component downloads must match the original compressed bytes. Current and
pinned Card/Printing identities, image content and retained owner decisions must
survive. This proves a definition transition using existing source evidence;
fresh full-scope collection and refresh have separate acceptance requirements.

Keep the predecessor frozen. Do not recreate it with current application code or
rewrite its evidence, definition pins, owner decisions, or export receipts to
make a transition pass.
