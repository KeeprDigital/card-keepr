/** Resource names are closed, deterministic namespaces; production retains its identities. */
export function environmentNames(environment = "production") {
  if (!["production", "dev", "staging"].includes(environment)) throw new Error("invalid_environment");
  const suffix = environment === "production" ? "" : `-${environment}`;
  const name = (base) => `${base}${suffix}`;
  const host = environment === "production" ? "card.keepr.digital" : `${environment}.card.keepr.digital`;
  return {
    environment,
    host,
    workers: [name("card-keepr-api"), name("card-keepr-ingestion")],
    catalogue: name("card-keepr-catalogue"),
    disposable: name("card-keepr-disposable-verification"),
    buckets: [
      "card-keepr-evidence",
      "card-keepr-printing-images",
      "card-keepr-catalogue-exports",
      "card-keepr-backups",
    ].map(name),
    workflows: [
      "card-keepr-evidence-ingestion",
      "card-keepr-evidence-host",
      "card-keepr-reconciliation",
      "card-keepr-catalogue-backup",
    ].map(name),
  };
}
