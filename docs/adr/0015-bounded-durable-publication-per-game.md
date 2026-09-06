# Publish independently per game through bounded durable preparation

Accepted through [Decide bounded durable reconciliation and publication](https://github.com/KeeprDigital/card-keepr/issues/214#issuecomment-5558801899), which holds the full policy, alternatives and adjustable engineering targets. Concurrent collection feeds independently reviewed per-game candidates; Workflows, R2 and D1 prepare partitioned immutable data before a small atomic composition switch, so large catalogues need neither whole-catalogue buffers nor a global active-run reservation.

Approval binds the exact candidate and its game's predecessor, preserves collected/reviewed facts without applicability-date activation, and expires at the original seven-day deadline even after approval. Other games can prepare and receive approval while a published composition's backup is verified, but the next publication waits for that verified checkpoint; shared-database recovery remains globally fenced.

This replaces multi-game atomic refresh, global predecessor invalidation, synchronous publication and date-crossing invalidation requirements. Queues and Durable Objects remain optional responses to demonstrated needs; no measured throughput or permanent numeric capacity is promised, and implementation plus validation remain for the specification handoff.
