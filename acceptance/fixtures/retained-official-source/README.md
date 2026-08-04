# Retained Bandai Official Source bytes

These fixtures were captured from the public URLs recorded in each JSON file
through 2026-08-04 Australia/Melbourne time. `body_base64` is either the complete
unchanged HTTP response body (`range_start = 0` and
`range_end_exclusive = full_body_size`) or an unchanged byte range containing
the complete publisher `<header>`. Range fixtures record their offsets, the
full response size and digest, and the retained-range digest. Tests decode the
bytes, verify `body_sha256`, and pass those exact bytes to the production
adapter.

The current Fusion World URL registered by the earlier adapter contract now
returns 404. Its complete response is retained as explicit negative evidence;
the current publisher-linked Rules page is retained separately. These files
are evidence snapshots, not synthetic success envelopes and not rewritten
HTML examples.

`one-piece-en-card-list.json` retains the complete live one-result Card List
response for the publisher's `series=569001&freewords=ST01-001` query. It
preserves the literal `<select name="series" id="series">` vocabulary, the
inline Card detail, and its discoverable Printing image.

`digimon-en-card-list-popup-fragment.html` retains the two complete adjacent
`EX12-021` and `EX12-021_P1` publisher popup records captured on 2026-08-04
from the exact live leaf
`/cards/index.php?search=true&category=522037&cardcategory=Digimon&color=Blue`.
It is a focused publisher HTML fragment used to prove that the registered
adapter consumes both the base and alternate-art Printing markup; line endings
and trailing whitespace are normalized for the repository fixture.

The live policy expectations intentionally follow the published scope rather
than capture time or article recency:

- One Piece's current-list heading states an exact April 10, 2026 effective
  date, so its five bans and three banned-pair rules retain that date and their
  exact effects.
- Fusion World's current detail states only “from March 2026”. Its eight Card
  targets are retained with an unresolved effective interval; no day is
  invented from the March 13 article date.
- Digimon's current affected-card summary contains two pair groups, three
  banned Cards, and fifty restricted Cards, but does not associate every
  carried-forward entry with one effective date. All 55 explicit target groups
  therefore retain an unresolved effective interval.
- Both Gundam locale details contain one banned Card, one restricted Card, two
  explicit pairs, and one twenty-Card predicate group. The July 24 article date
  does not state the list's effective boundary, so all five target groups per
  locale retain an unresolved effective interval.
