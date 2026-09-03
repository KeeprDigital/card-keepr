// The Spine Revision: the schema-valid Catalogue Revision pointer a fresh
// catalogue database starts at (migrations/0001_baseline.sql) until the first
// approved candidate is published. While it is current and no Catalogue
// Revision exists, the guarded Production Release runs in Bootstrap Mode
// (issue #141). Shared by the Workers, the CLI, and the release scripts.
export const SPINE_REVISION_ID = "catrev_spine_000";
