export type CatalogueExportRow = {
  catalogue_revision_id: string;
  manifest_key: string;
  manifest_digest: string;
  maintenance_state: "available" | "deleting" | "deleted";
};

export function catalogueExportStatement(database: D1Database, revisionId: string): D1PreparedStatement {
  return database
    .prepare(
      `SELECT catalogue_revision_id, manifest_key, manifest_digest,
            maintenance_state
     FROM catalogue_exports WHERE catalogue_revision_id = ?`,
    )
    .bind(revisionId);
}

export type CatalogueExportDeletionPlanInput = {
  id: string;
  catalogue_revision_id: string;
  manifest_digest: string;
  expected_current_revision_id: string;
  object_keys_json: string;
  component_names_json: string;
  object_set_digest: string;
  dependencies_json: string;
  plan_digest: string;
  created_at: string;
  expires_at: string;
};

export function catalogueExportDeletionPlanInsertStatement(
  database: D1Database,
  input: CatalogueExportDeletionPlanInput,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO catalogue_export_deletion_plans (
       id, catalogue_revision_id, manifest_digest,
       expected_current_revision_id, object_keys_json, component_names_json,
       object_set_digest,
       dependencies_json, plan_digest, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.catalogue_revision_id,
      input.manifest_digest,
      input.expected_current_revision_id,
      input.object_keys_json,
      input.component_names_json,
      input.object_set_digest,
      input.dependencies_json,
      input.plan_digest,
      input.created_at,
      input.expires_at,
    );
}
