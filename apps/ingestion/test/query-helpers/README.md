# Catalogue test queries

These helpers own the SQL used to seed, inspect, and deliberately corrupt test
catalogues. Queries are grouped by aggregate, and identical statements are
shared across API and ingestion tests. Test-specific variants name the scenario
whose retained shape they exercise.

Each fixed-query factory returns a prepared statement. Bind values, assertions,
execution, and atomic batch composition remain at the test site so fixture data
and transaction boundaries stay visible. Add a named query to the appropriate
aggregate file when a test needs a new shape; do not add a helper accepting
arbitrary SQL.

`collection-query-plans.ts` inspects the real production collection builders.
`database-failures.ts` owns database failure injection and captured-schema
restoration. These seams deliberately retain their original behavior; they do
not substitute mocks for the real runtime database.

The SQLite domain tests use the corresponding helpers under
`test/domain/query-helpers` because Node's synchronous statement API differs
from the Workers D1 binding.
