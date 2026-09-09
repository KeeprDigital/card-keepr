# Temporary hosted identity diagnostic

This branch is diagnostic evidence only and must never be merged. Base:
`905dd2a02db898fad703659403cbc4a5b7462dec`. It repeats the existing identity
associations/application/lookup sequence five times under Node 22 on Ubuntu.
Assertions, per-test deadlines and storage isolation remain unchanged.

A mismatch-only temporary `[DEBUG-271-immutable]` probe retains expected and
actual object metadata, operation header and differing top-level field names.
It prints no raw publisher record payloads and preserves the original collision
failure. The extra read occurs only after the immutable guard finds a mismatch.
Remove all temporary instrumentation before any eventual fix is integrated.

The dedicated workflow runs only by manual dispatch, uses read-only repository
permissions and has a twelve-minute finite allocation for fifteen 30-second
cases, initialization and cleanup. It has no deployment credentials or live
provider calls. Its job set cannot satisfy the production release CI guard.
A pass is a non-reproduction and cannot replace full suite validation.
