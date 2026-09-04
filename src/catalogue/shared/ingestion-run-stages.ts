/** Ordered stages shared by retained run-document schemas and progress construction. */
export const activeRunStages = [
  "planning",
  "collecting",
  "parsing",
  "reconciling",
  "awaiting_approval",
  "publishing",
] as const;

// A paused run holds the active-run reservation with collection incomplete;
// it is a non-terminal state and never a completed progress stage.
