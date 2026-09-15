# Limitless English multi-record evidence

Retained source evidence for [#334](https://github.com/KeeprDigital/card-keepr/issues/334).
The [manifest](manifest.json) identifies every exact request, original entity body,
serialized response header set, capture time, status, byte length and SHA-256.
Bodies and images are unchanged. Header fields were serialized by Python with LF;
they are not original HTTP wire framing. The local `.gitattributes` preserves raw
asset bytes across checkouts.

## Captured scope

The two source buckets are **Straw Hat Crew (ST01)** and **The Time of Battle
(OP16)**. Their complete retained HTML responses contain 17 and 155 distinct grid
links respectively and explicitly select English, all prints and all results.
Those are source references, not deduplicated canonical Cards or Printings.
Only the following four Card-number inventories were followed; other bucket
entries have not been acquired or qualified by this pack.

| Source number | Retained detail pages | Retained fronts | Observed gameplay shape |
| --- | --- | --- | --- |
| ST01-001 | Base and `v=1` | 2 | Leader, Life 5, Power 5000, no Cost |
| OP16-002 | Base | 1 | Character, Cost 1, Power 2000, Counter 1000 |
| OP16-019 | Base | 1 | Event, Cost 9, separate Trigger, no Power/Attribute |
| OP16-021 | Base and `v=1` | 2 | Stage, Cost 1, two effect clauses, no Power/Attribute |

Both two-appearance inventories name their sibling in the Printing table. The
other two tables have one selected row each. The pages use literal `/cards/…`
links, whereas the pre-existing P-001 evidence uses `/cards/en/…`. Available
active language links identify English explicitly; the English-only serial
variant has no language switch. Original request URLs remain provenance.

The Limitless portion has eight HTML responses and six original 600 × 838 WebP
fronts: 181,329 HTML bytes and 802,894 image bytes. Four additional Bandai search
responses contain 227,930 HTML bytes; their five PNG fronts contain 1,088,989
bytes. The existing complete P-001 pack and
its seven cross-source matches and supplementary-only appearance remain in
[the 6 September evidence](../2026-09-06/README.md).

## Retained visual review

All six fronts were directly inspected. The coordinator independently inspected
the same bytes. Each has a **SAMPLE** watermark, which remains unchanged.

- **ST01-001 base:** red frame/background, Luffy lunging forward, white name,
  Leader label, Life 5, Power 5000 and ST01-001 markings. It is a different
  gameplay design from P-001 despite sharing the name Monkey.D.Luffy.
- **ST01-001 `v=1`:** Luffy holding his hat, blue/white geometric frame, gold text,
  visible `001/700` marking and `NOT FOR SALE`. These depict an appearance
  difference from the base. The displayed serial is source-image evidence, not
  an identity for an individual owned copy or a count of canonical Printings.
- **OP16-002:** Izo firing pistols, printed Counter +1000, Cost 1, Power 2000,
  Ranged attribute and matching number. The image supports the separately
  parsed Counter field.
- **OP16-019:** comic-panel Event artwork, Cost 9 and a visibly separate yellow
  Trigger area: “Your Leader gains +1000 power during this turn.”
- **OP16-021 base:** comic-panel ship artwork with a pale text area.
  **`v=1`:** a sailing ship in open water with text over the artwork and a printed
  alternate star marking. Both show Stage, Cost 1 and the same two effect clauses.
  Different illustrations of this Stage are Printings of a gameplay Card, not
  collectible art Cards.

The review does not establish foil/finish, reverse faces, physical authenticity,
or every issued treatment. Source `serial` and `aa` labels alone are not
qualification rules. Bandai remains the designated Source Authority; a shared
number, name, image encoding or downloaded digest alone does not establish a
cross-source identity. Supplementary-only admission still requires the owner's
explicit decision and approval still covers the entire Catalogue Candidate.
The five retained Bandai fronts were directly compared with Limitless:
ST01-001 base, OP16-002 base, OP16-019 base, and both OP16-021 appearances match
their corresponding artwork, crop, frame, printed markings and wording.
PNG/WebP encoding differences do not create a Printing. All five Bandai fronts
also carry unchanged SAMPLE watermarks. The serial Luffy remains a separately
reviewed supplementary-only appearance within these declared catalogue searches.

## Bandai search evidence

Four complete `freewords` searches returned one ST01-001 record, one OP16-002
record, one OP16-019 record, and two OP16-021 records (`OP16-021`, `OP16-021_p1`).
Each reported count agrees with its retained modal inventory. These searches
omit a series restriction. Their construction uses the existing successful
P-001 `freewords`-only GET and the retained Bandai `freewords` input/ALL series
control. They are documented constructed queries, not previously seen anchors.

The ST01 serial appearance is absent from this exact catalogue search. This does
not establish absence from every official publication. The ST01 base has an
`Errata Card` note; that note alone establishes neither the original printed
wording nor a dated publisher Erratum. Bandai preserves the `[Trigger]` marker
in OP16-019's Trigger text. Both Sources must map that text consistently into
the shared Game Profile without changing Bandai's authority.

## Acquisition and access findings

This was a finite, staged selection: two buckets, four base pages, two sibling
pages, exactly six named Limitless images, four Bandai searches and their five
named images. No request followed redirects, retried,
authenticated, reused cookies, or implicitly fetched a child. Each response was
bounded at 2 MiB; each stage had a finite aggregate byte and wall-clock limit.
All stages after the first two buckets used absolute 30-second request
deadlines and at least two seconds after the prior response completed.

The initial two-list stage used its originally proposed two-second interval
between starts. Its measured gap after the first response completed was
0.934367 seconds; the stronger completion-based instruction arrived later.
That deviation is retained in the manifest. The requests were not repeated and
are not presented as conforming to the later instruction.

The earlier five-page assessment inspected One Piece robots, Limitless's legal
notice, Products, Promos and Advanced Search. It found an empty robots Disallow
and no explicit automation prohibition in those inspected pages. The retained
pages attribute card text/images to the rightsholders. These bounded findings
and the successful public CDN responses do not establish unlimited acquisition,
wider/CDN-specific terms, or an image redistribution grant.

## Full-scope work still required

The intended launch scope remains the evidenced English physical inventory from
both Products and Promos, including Prize Cards and Misc. Promos, plus all
linked Printing variants and available image roles. The earlier index census
found 58 product buckets with 4,238 references and 85 promo buckets with 834:
**5,072 table references are not unique Cards, Printings or image requests**.

This pack does not establish the complete source graph, full-source capacity,
issued token or art Card coverage, or every real-world Printing. Unestablished
categories and unavailable portions remain unknown, not zero. Candidate
publication, authenticated reads, exports, refresh and isolated SQL restore
need their own runtime evidence. This pilot must not close #334.
