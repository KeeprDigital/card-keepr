# Riot public English gallery pagination capture

This is new retained evidence for #232. The September 6 evidence remains unchanged.
The original HTML identifies `content.publishing.riotgames.com` as its content host.
All six linked public English card pages and the set inventory were fetched through
`scripts/source-evidence/capture.py`; the manifest retains response bytes, received
headers, URLs, capture intervals and SHA-256 digests. Header serialization follows
that capture tool's documented behavior.

The pages return **1,189 unique records**, exactly the same source IDs as the older
embedded gallery: OGN 352, OGS 24, SFD 288, UNL 288 and VEN 237. Their individual
counts are 200, 198, 200, 198, 198 and 195. The publisher's metadata reports **1,197**
on every page. The meaning of that difference remains unresolved. Traversing every
link establishes the complete returned public English inventory; it does not
establish that 1,197 records were captured or explain eight unreturned records.
No extra physical Cards or Printings are inferred.

The seven responses contain **3,249,095 body bytes** and **5,973 retained header
bytes**. These are capture measurements, not ingestion throughput or capacity.
No image was fetched in this capture. Six representative original images and the
Origins correction/product articles remain in the September 6 pack. Other image
URLs are observed references, not retained image bytes.

`UNL-T04` (Buff) and `UNL-T08` (XP Tracker) explicitly have an empty base card-type
array and a `token` supertype. These records are real source data and must not be
dropped to satisfy a Bandai-shaped profile. Their actual publisher codes do not
validate the earlier unrelated placeholder “Buff XXX”. Landscape orientation does
not establish a reverse face. Missing finish or face information stays unknown.

The adapter and native CLI/publication/recovery acceptance work is separate from
this evidence pack. This capture alone does not claim those gates pass.
