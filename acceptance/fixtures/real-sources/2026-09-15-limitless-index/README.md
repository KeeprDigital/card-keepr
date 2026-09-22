# Limitless One Piece index roots

Retained source evidence for [#334](https://github.com/KeeprDigital/card-keepr/issues/334).
The [manifest](manifest.json) identifies both exact requests, original entity
bodies, serialized response header sets, capture times, status, byte length and
SHA-256. Bodies are unchanged; the local `.gitattributes` preserves raw bytes.
Header fields were serialized with LF from the recorded response; they are not
original HTTP wire framing.

## Captured scope

The two English One Piece index roots of the Limitless database, captured during
the 15 September 2026 bounded read-only access assessment (five paced GETs: robots,
legal notice, Products, Promos, Advanced Search; all HTTP 200, no redirects):

| Root     | URL                                          | Bucket rows | Declared references |
| -------- | -------------------------------------------- | ----------: | ------------------: |
| Products | `https://onepiece.limitlesstcg.com/cards`    |          58 |               4,238 |
| Promos   | `https://onepiece.limitlesstcg.com/cards/promos` |      85 |                 834 |

Each root is one `sets-table` whose rows link `/cards/<slug>` bucket pages. The
Products root also links the Promos root; that anchor is a sibling root, not a
bucket. The 143 bucket pages themselves are retained in
[the 15 September pack](../2026-09-15-limitless/README.md) (ST01, OP16) and
[the 21 September bucket census](../2026-09-21-limitless-buckets/README.md)
(the remaining 141).

## What this establishes and what it does not

These bodies are the complete-scope discovery roots of `limitless-one-piece-en@1`:
the adapter's `products-index` and `promos-index` surfaces parse them into the
143 bucket listing requests and nothing else. The declared per-bucket counts are
source references, not Cards, Printings or images. The bodies are dated: the
source has since grown (OP17 lists 169 grid links against 168 declared here).
Nothing here establishes detail-page content, image availability, DON!!/token/art
coverage or publication.
