# Reconciliation continuation

Reconciliation progress lives in D1. Workflow history contains bounded cursor or
terminal references; it is not the candidate store. Inspect the reconciliation
status and partition routes to see preparation independently of a Workflow's
status.

Each reconciliation Workflow instance executes at most ten preparation steps.
Each step has three retries. This reserves at most 4,000 service calls for
preparation at the 100-call work-unit target, leaving room within the 5,000-call
shard target for dispatch, failure handling and notification. Work-unit resource
enforcement is separate from this orchestration bound.

Before dispatching a successor, the current instance retains its exact parameters
and deterministic identity in the `workflow_dispatch:<generation>` checkpoint.
The identity binds the operation's retained run key, generation and shard ordinal.
Dispatch retries recover that same identity through the Workflow driver. An
instance that has dispatched its successor returns; it never polls the chain.

The root can be the collection parent or an explicitly requested reconciliation
Workflow. It waits once for the `reconciliation-terminal` event. The final shard
sends only the terminal reference to that root. The wait uses the operation's
original deadline. Restarting a root reads retained dispatch progress, while a
sealed operation immediately returns its retained digest reference. A Workflow
restart does not extend the candidate deadline or clear D1 checkpoints.

Owner pause, resume and abandon remain generation-fenced administration actions.
A resumed generation uses a new dispatch namespace. Do not restart an old
generation as a substitute for the owner resume action.

Follow-on preparation stages should return durable progress at each bounded work
unit and use this continuation protocol. They must not put an unbounded loop into
the collection parent, wait on every descendant, or send candidate records through
Workflow parameters or events. The current run-key adapter does not establish the
independent per-game operation lifecycle required by issue #225; that lifecycle
must supply the operation identity before downstream issues #226 and #227 proceed.
