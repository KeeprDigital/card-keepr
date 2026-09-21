// Named fixed SQL; migration tests own values, execution and transactions.
export function limitlessRegistration(database) {
  return database.prepare("SELECT * FROM source_adapter_versions WHERE adapter_version='limitless-one-piece-en@1'");
}
