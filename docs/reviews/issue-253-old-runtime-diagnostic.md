# Preserved old-runtime Product benchmark

This diagnostic branch starts from the reviewed cleanup commit
`a14a803434dcc7bb150802dad3476989d0f61355`. Its original package lock,
Workers pool, native Product test, production code, timeouts and callback
reporter are unchanged. Only the manual diagnostic workflow and this note are
added. This branch must never be merged: its manual job set cannot satisfy the
release's required CI checks.

The single-test Ubuntu/Node 22 job compares the preserved runtime with current
runtime measurement `4cc3d13a` (68,249ms, 1,360 callbacks, 34,839 binding entries)
and current local Node 22 `9e22a340` (11,714ms with identical callback and method
counts). All existing budget assertions remain. The artifact is retained even
on failure. This is diagnostic evidence, not a full stress selection or release
validation. No live provider calls or credentials are used.
