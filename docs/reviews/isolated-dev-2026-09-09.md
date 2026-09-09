# Isolated dev integration and review — 2026-09-09

PR #246 remains an unexecuted operational change for #236. The coordinator
merged the reviewed cleanup and foundation providers through `6816397f`, with
current-toolchain type generation, typechecking and 42 focused tests passing.
No live resources, credentials, routes or deployments were changed.

Independent Standards and Spec reviews fixed at `b28d2afc` through
`6816397f9a4f0a4731d8e30e6dd0cb1b6ac9c8ab` identified two issues:

- Spec: the executor discarded uploaded version IDs and observed settings only
  after activation. An older compatible version could satisfy catalogue smoke
  without proving the reviewed version actually served traffic.
- Standards: four custom CLI confirmation errors still named production when
  the selected target was dev (zero hard documented-standard violations, one
  duplicated-guard heuristic finding).

The executor now preserves both verified uploaded IDs, uses the existing active
version/route observer before recording binding or smoke success, and retains
`activation.json` alongside release SQL/evidence. Old versions, split traffic,
wrong active bindings and mismatched routes fail the existing observer. The
operating-system command boundary accepts an injected runner for deterministic
acceptance testing; ordinary owner/workflow invocations retain the same runner.

The executor regression uses the real signed-identity preparation, generated
release SQL, SQLite state and provider observers. Only operating-system commands
and provider HTTP are simulated. Before the fix, all three negative cases
(older version, split traffic, foreign route) wrongly succeeded, and successful
execution made zero active-deployment observations. After the fix, the complete
8-test dev deployment file passes. Each negative case proves no binding/success
ledger or smoke request occurs and that failure handling is invoked. Its failure
shell is a recorded boundary, not a claim that simulated execution proves live
failure recovery. Existing release SQL/provider tests cover those contracts.

Shared target-specific confirmation text now covers both generic and custom CLI
handlers. All four custom-command regressions failed with the misleading
production message before the fix and pass naming dev without provider traffic.
The environment CLI file passes 8/8. The combined five-file focused validation
passes 53/53 in 7.361 seconds, with full typechecking and focused Biome checks
passing. No heavy Worker runtime suite ran beside the exclusive baseline.

Remaining acceptance is unchanged: owner account-isolation decision, refreshed
capacity/resource observations, concrete authorized initial installation,
passing exact-SHA CI and actual automatic dev deployment evidence. Separate
non-production-account isolation versus accepting account-wide deployment-token
authority must be resolved before provisioning. #237/#238 and private-launch
convergence cannot infer live dev success from these simulations.
