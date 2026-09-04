# Published catalogue reads

The collection endpoint kit owns shared HTTP mechanics: strict limits and single-value filters, UTF-8 cursor encoding, revision availability, bounded page lookahead, canonical ETags, conditional responses, and `ReadProblem`. All read failures carry their status, code, detail, headers, and extensions to the API worker's generic mapper.

Cards, Printings, and Products require an available query projection even when a cursor pins the current Catalogue Revision. Cards also require the FTS index to be ready. Exports and Legality Status pin published revisions independently of the Card query projection: exports verify their retained manifests, while legality reads its own published rule projections.

Each read model retains its domain query and cursor-position validation. Cards additionally bound each database read and total response bytes. Card cursors store the complete normalized filter object so adding a filter changes the filter parser and query, without extending the pagination infrastructure.

ETags describe canonical representations. Collection self links are built from normalized filter values in their defined order. The strict conditional-request parser handles all reads, including byte-range resources. Invalid or repeated filters fail before revision lookup; an unavailable first-page projection returns 503, while an unavailable pinned cursor returns 409 with an absolute collection restart link.
