# Retained Scryfall bulk records

These 36 records are exact, newline-terminated JSONL records extracted from the
pinned `default_cards` archive for [#327](https://github.com/KeeprDigital/card-keepr/issues/327).
`manifest.json` records each source UUID, original line number, decoded byte
offset where measured, byte length and SHA-256. The source archive SHA-256 is
`ea81f17a3c15d64dff75f4b1d012657358c6505f254df8a0d032edb34cd27ca4`.
Do not format or rewrite the JSON files.

The selection exercises logical faces sharing a physical side, reversible
appearances, etched finish evidence, missing illustration/image/artist facts,
original printed wording, and the excluded incidental `front_card` layout.
It is a regression selection, not the complete declared source inventory.
The [parent pack](../README.md) retains the original four-record pilot and its
six real JPEGs. Two Bloomvine physical-side images were inspected separately;
this bulk fixture directory retains the exact JSON record and its conflicting
source fields, without substituting image wording into the source JSON.

The full archived source contains 117,941 unique source records. The retained
census and archive are temporary coordinator evidence, not repository fixtures.
They distinguish source-filter counts from accepted Cards or Printings. Token
layout records with uncertain Card categories and incomplete reversible Adventure
designs still need resolution; these fixtures do not establish that full-scope
parsing, publication, refresh, image coverage or restore is complete.
