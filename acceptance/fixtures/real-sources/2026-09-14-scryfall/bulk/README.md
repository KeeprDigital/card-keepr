# Retained Scryfall bulk records

These 38 records are exact, newline-terminated JSONL records extracted from the
pinned `default_cards` archive for [#327](https://github.com/KeeprDigital/card-keepr/issues/327).
`manifest.json` records each source UUID, original line number, decoded byte
offset where measured, byte length and SHA-256. The source archive SHA-256 is
`ea81f17a3c15d64dff75f4b1d012657358c6505f254df8a0d032edb34cd27ca4`.
Do not format or rewrite the JSON files.

The selection exercises logical faces sharing a physical side, reversible
appearances, etched finish evidence, missing illustration/image/artist facts,
original printed wording, the excluded incidental `front_card` layout, and a
Manifest reminder whose source `token` layout does not establish a Card category.
It is a regression selection, not the complete declared source inventory.
`token-layout-gameplay.json` (Maddened Oread) is a token-layout gameplay piece
the owner ruling admits as a gameplay Card.

`category-cohort.jsonl.gz` is the retained 210-line exception cohort, gzip of
the exact archive lines (decompressed SHA-256
`8891c4c09fd1b32324cf13adc1aa4fed4a9ada7408b911f7f73eecd9cb5aeb5c`): all 198
token-layout records without the Token type prefix, the three incomplete
reversible Adventure designs and their nine same-Oracle comparators.
`category-cohort.json` records each line's review group and the ruling it must
produce: 45 gameplay, 8 `advertising`, 145 `non_card_insert`, 3
`logical_parts_unresolved` and 9 ordinary.

The [parent pack](../README.md) retains the original four-record pilot and its
six real JPEGs. Two Bloomvine physical-side images were inspected separately;
this bulk fixture directory retains the exact JSON record and its conflicting
source fields, without substituting image wording into the source JSON.

The full archived source contains 117,941 unique source records. The retained
census and archive are temporary coordinator evidence, not repository fixtures.
They distinguish source-filter counts from accepted Cards or Printings. The
incomplete reversible Adventure designs still await owner admission after
publication; these fixtures do not establish that full-scope publication,
refresh, image coverage or restore is complete.
