export function validatedProductionTarget(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !sameKeys(value, [
      "cloudflare_account_id",
      "worker_scripts",
      "d1_databases",
      "r2_buckets",
    ]) ||
    !/^[0-9a-f]{32}$/.test(value.cloudflare_account_id ?? "") ||
    !sameStringArray(
      value.worker_scripts,
      ["card-keepr-api", "card-keepr-ingestion"],
    ) ||
    !sameStringArray(
      value.r2_buckets,
      [
        "card-keepr-evidence",
        "card-keepr-printing-images",
        "card-keepr-catalogue-exports",
        "card-keepr-backups",
      ],
    ) ||
    !Array.isArray(value.d1_databases) ||
    value.d1_databases.length !== 2
  ) {
    return null;
  }
  const expectedDatabaseNames = [
    "card-keepr-catalogue",
    "card-keepr-disposable-verification",
  ];
  for (const [index, database] of value.d1_databases.entries()) {
    if (
      database === null ||
      typeof database !== "object" ||
      Array.isArray(database) ||
      !sameKeys(database, ["name", "id"]) ||
      database.name !== expectedDatabaseNames[index] ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        database.id ?? "",
      )
    ) {
      return null;
    }
  }
  return value;
}

function sameKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    expected.slice().sort().every((key, index) => key === keys[index]);
}

function sameStringArray(value, expected) {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}
