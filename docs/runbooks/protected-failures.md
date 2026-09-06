# Diagnose unexpected HTTP failures

Both Workers return their existing generic `internal_error` problem with a
`request_id`. Find that ID in the protected Worker logs: `request.completed`
provides the route, runtime, status and database call counts;
`card-keepr-protected-failure@1` / `request.failed` provides the cause chain.
These events belong in operator logs, never consumer responses or exports.

`causes` follows outer error to inner cause, with at most four entries. Each entry
has a closed `classification` (`sql_failure`, `missing_object`,
`programming_fault`, or `unexpected_error`) and `stack_reference`. SQL prefixes
and explicit missing-object codes are classified without retaining their text.
Missing required Printing Image, export manifest and parsed Source Snapshot
objects carry the explicit marker; an ordinary requested resource's expected
404 remains its existing problem. Size/digest failures are not labelled missing.

A stack reference is a SHA-256 fingerprint of up to eight V8 frames from the
first 8,192 characters of the stack. Compare fingerprints to group recurring failure sites
within the same deployed revision, then reproduce against that exact revision
and inspect its source. The fingerprint cannot reconstruct a stack and may change
between builds. Missing/unreadable stacks have a null reference.
`cause_chain_truncated` indicates a cycle or the four-cause limit. Raw messages,
names, provider URLs, SQL, headers, request/response bodies and arbitrary error
properties are never emitted. Expected domain problems retain their existing
HTTP contract and do not produce this unexpected-failure event.

The runtime tests use injected binding faults and synthetic published fixtures.
They establish HTTP/log behaviour and redaction, not real-source coverage or a
successful production operation. Existing durable operation diagnostics retain
their run/workflow references; this event does not replace their retained history.
