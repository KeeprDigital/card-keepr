# Limitless One Piece bucket census

Retained source evidence for [#334](https://github.com/KeeprDigital/card-keepr/issues/334).
The [manifest](manifest.json) identifies every exact request, original entity body,
raw response header bytes, capture times, status, byte length and SHA-256. Bodies
are unchanged; the local `.gitattributes` preserves raw bytes across checkouts.
[census.json](census.json) is a static extraction from those bodies.

## Captured scope

The 141 remaining Products and Promos bucket pages of the Limitless English One
Piece index: 56 Products buckets (4,066 declared references) and 85 Promos
buckets (834), including **Prize Cards** and **Misc. Promos**. With the ST01 and
OP16 buckets retained in [the 15 September pack](../2026-09-15-limitless/README.md)
this completes the 143-bucket, 5,072-reference census of the index bodies
inspected on 15–16 September. No detail page, sibling variant page or image was
acquired; bucket pages only.

The owner authorised this single finite acquisition on 21 September 2026 after
the run-wide Acquisition Budget merged. The qualified collector made 141
sequential GETs, all HTTP 200 at the requested URL with `text/html`, no redirect,
retry, cookie, authentication or implicit child. Bounds: 1 MiB per body, 32 MiB
aggregate, 64 KiB header/framing metadata, 30 s per request, at least 2 s after
the prior completion, 1,200 s work, 10 s settlement, 8 GiB free reserve. Actual:
3,097,774 body bytes (13,845–89,715 per page), 346 metadata bytes at most,
completion gaps 2.002–2.019 s, 442.4 s elapsed, single worker reaped with its
process group absent and output closed. The equivalent budget file used
`max_dispatches: 141` and `max_source_bytes: 33554432`. Transfer-framing bytes
and the owner receipt remain in the ignored run directory.

## Census

| Measure                                   |  Count |
| ----------------------------------------- | -----: |
| Buckets (141 retained here + 2 reused)    |    143 |
| Declared table references (index bodies)  |  5,072 |
| Grid links observed                       |  5,070 |
| Unique detail-page URLs                   |  4,707 |
| … base pages / distinct card numbers      |  2,795 |
| … `?v=N` variant pages                    |  1,912 |
| Unique referenced front image URLs        |  4,707 |
| Envelope: 2 roots + 143 + 4,707 + 4,707   |  9,559 |

Grid links are `/cards/NUMBER` or `/cards/NUMBER?v=N` anchors; each has exactly
one CDN front image, so detail pages and images are 1:1. Reprints appear in
several buckets and are counted once. 141 buckets agree exactly with their
declared reference count. Two do not:

- `bucket-001` (OP17 The World's Strongest Warriors) lists 169 links against 168
  declared: the source grew after the index was captured.
- `bucket-058` (Premium Card Collection – Flame-Flame Fruit Coliseum Edition)
  serves an empty grid against 3 declared references. The gap is retained, not
  filled from another page.

Prize Cards lists 112 links, every one a `?v=N` variant of a numbered Card; Misc.
Promos lists 90, of which 58 are variants. Both are inside the counted envelope.

## What this establishes and what it does not

The envelope is the dated request capacity registered for `limitless-one-piece-en@1`
by migration `0043` and the runtime registration: a finite admission bound over
index roots, buckets, unique detail pages and unique fronts. It is not measured
throughput, publication or recovery capacity, and it is not a claim that all
4,707 pages or images are acquirable or unchanged.

Counts are source references, not unique Cards, Printings, issued physical
inventory or image roles. Whether DON!! cards, tokens or art Cards appear in
these buckets is not determined here; no bucket page carries the gameplay fields
the adapter parses, and every grid link is a numbered `/cards/NUMBER` page. The
complete `limitless-one-piece-en@1` scope now discovers these buckets from the
[retained index roots](../2026-09-15-limitless-index/README.md) and each bucket
into its detail requests; 20 grid entries reference a Japanese-print front
(`_JP.webp`), which the adapter retains as evidence without requesting an
English Printing Image. This pack supports acquisition bounds, inventory and the
discovery parser; normalization, admission and publication need the detail
pages themselves. The earlier five-page access findings remain bounded; nothing
here extends them.
