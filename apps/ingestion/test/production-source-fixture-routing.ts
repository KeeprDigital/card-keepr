// Compatibility shim: the marker, role, and surface parsing and the
// production stage responses now live in the shared fake-publisher module so
// every test layer routes requests the same way.
export * from "../../../test/support/fake-publisher/production-source-fixture-routing.ts";
