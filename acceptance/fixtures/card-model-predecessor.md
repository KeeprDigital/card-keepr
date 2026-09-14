# Pre-expansion Card model fixtures

`card-model-predecessor.json.gz` is frozen synthetic migration input for
`card-model-migration.test.mjs`. It was captured on 2026-09-14 from the actual
application at `d0f6ccaec3ca248c2e117b193d6d0251a0cf23c7`, with database schema 32.
Its compressed SHA-256 is
`7b11368a8ae4e4da997d6f6d9e1b97a164cbdf92ad7ba451964d200e9518b4b8`.

The 969,280-byte bundle holds the 4,050,944-byte SQLite database and 79 R2 objects,
including retained source observations, candidate partitions, immutable exports,
and actual SQL backup bytes. The source input and captured administration receipts
are included. All source content is synthetic; the fixture makes no claim about
a publisher's inventory and contains no live credentials.

Capture used the existing native retained-evidence harness and synthetic adapters
at that commit. It designated Riftbound authority, collected and prepared one
One Piece Card, then two Riftbound Cards (gameplay and token), approved both whole
candidates, and waited for each real SQL export/import checkpoint to verify.
Every Card has one Printing. A third Riftbound candidate was prepared and left
sealed without approval. A current collection cursor and an explicit historical
Riftbound export component were read through the API before stopping both Workers,
checkpointing SQLite's committed journal pages, and copying the catalogue database
and bucket objects. The captured pending-candidate receipt is checked against the
database before applying the migration.

The migration test imports these bytes into disposable bindings, applies the
forward migration, checks immutable history, then exercises normal per-game
regeneration and actual SQL restore. Keep this predecessor frozen when updating
the current application; do not generate a lookalike using new model code or
rewrite its source, candidate, approval or export records to satisfy validation.

`retained-card-model-export.json` pins a separate, small retained aggregate export
from the same predecessor commit's unmodified `buildCatalogueExport` writer. A
real Workerd instance serialized its existing `first-catalogue` One Piece fixture
(one Card and one Printing) on 2026-09-14. The capture's SHA-256 is
`e49baa08088bbb4265731f214a2efd534d83271444b30b1690c63cf95719cd89`.
The full 18,789-byte temporary capture includes all eleven object bodies and the
4,803-byte manifest. The committed fixture keeps only the exact source input,
publication parameters and each object's key, byte length and SHA-256. The
regression streams every reconstructed object and compares its actual bytes to
those fixed digests, including the original Game Profile, Card, Printing and
manifest encodings. Expanded art or relationship content must be refused by this
historical reconstruction path.
