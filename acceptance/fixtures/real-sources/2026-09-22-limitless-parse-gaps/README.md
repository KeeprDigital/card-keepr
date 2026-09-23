# Limitless One Piece parser gaps

Retained source evidence for [#334](https://github.com/KeeprDigital/card-keepr/issues/334).
The [manifest](manifest.json) identifies every exact request, original entity body,
raw response header bytes, capture time, status, byte length and SHA-256. Bodies are
unchanged; the local `.gitattributes` preserves raw bytes across checkouts.

Three English card pages retained by the composed full-scope run on 2026-09-22
(`run_7cc57e47…`), each pinning one parser gap the owner ruled on:

- `limitless-op17-109.body` — the rules text contains an inline `[Trigger]`
  reference ("You may trash 1 card with a [Trigger] from your hand: Draw 3
  cards."). Limitless renders it with the same `<br><br>[Trigger]` markup it uses
  for a real Trigger section, so the parser split the sentence in half and
  invented a Trigger the Card does not have.
- `limitless-op17-105.body` — the same inline reference, and the source page is
  itself truncated mid-sentence after it. The Card's text cannot be completed
  from this source; Bandai remains the card-facts authority.
- `limitless-op13-079.body` — the Attribute tooltip publishes the unresolved
  translation key `card.attribute.?` instead of a value.

These are three dated pages, not Limitless coverage. The real-Trigger comparison
case is `limitless-op16-019.body` in the
[2026-09-15 pilot pack](../2026-09-15-limitless/README.md).
