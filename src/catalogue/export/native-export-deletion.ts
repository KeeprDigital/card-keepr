import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { nativeDeletionComposition, nativeDeletionPublicRoots } from "./native-export-deletion-repository";
import type { CatalogueExportRow } from "./export-repository";

export function isNativeExportPackage(key: string) {
  return key.startsWith("catalogue-public-manifests/");
}

/** The exact physical deletion set is the exclusive package manifest. Its
 * transitive public components are protected by a separately retained snapshot,
 * not by counting the package being deleted as its own live reference. */
export async function nativeExportDeletionScope(db: CatalogueStore, bucket: R2Bucket, row: CatalogueExportRow) {
  const revision = await nativeDeletionComposition(db, row.catalogue_revision_id).first<{
    content_digest: string;
    content: string;
    retained_backup: string | null;
  }>();
  if (!revision?.retained_backup) throw new Error("native_export_recovery_reference_unavailable");
  const key = `catalogue-public-manifests/${row.catalogue_revision_id}/${revision.content_digest}.json`;
  if (row.manifest_key !== key || row.manifest_digest !== revision.content_digest)
    throw new Error("native_export_manifest_binding_invalid");
  const manifest = await bucket.get(key);
  if (
    !manifest ||
    manifest.size > 16384 ||
    (await manifest.text()) !== revision.content ||
    (await sha256Text(revision.content)) !== revision.content_digest
  )
    throw new Error("native_export_manifest_unavailable");
  const document = JSON.parse(revision.content) as {
    contract: string;
    games: { supported_game: string; candidate_id: string; public_root_digest: string }[];
  };
  const roots = (
    await nativeDeletionPublicRoots(db, row.catalogue_revision_id).all<{
      supported_game: string;
      candidate_id: string;
      root_digest: string;
      root_object_key: string;
      root_bytes: number;
    }>()
  ).results;
  if (
    document.contract !== "card-keepr-prepared-publication-composition@1" ||
    roots.length !== document.games.length ||
    !roots.length
  )
    throw new Error("native_export_public_roots_invalid");
  for (const root of roots) {
    if (
      !document.games.some(
        (game) =>
          game.supported_game === root.supported_game &&
          game.candidate_id === root.candidate_id &&
          game.public_root_digest === root.root_digest,
      )
    )
      throw new Error("native_export_public_roots_invalid");
    const object = await bucket.get(root.root_object_key);
    if (
      !object ||
      object.size !== root.root_bytes ||
      object.size > 16384 ||
      (await sha256Text(await object.text())) !== root.root_digest
    )
      throw new Error("native_export_public_root_unavailable");
  }
  return {
    objectKeys: [key],
    componentNames: [] as string[],
    dependencies: [
      {
        code: "shared_components_retained_for_recovery",
        severity: "warning",
        detail: `Remove only the exclusive package manifest. Retain public component and tree bytes required by backup ${revision.retained_backup}; immutable public roots: ${canonicalJson(roots.map((root) => root.root_digest))}.`,
      },
    ],
  };
}
