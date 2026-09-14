export type ProductionCodeTransition = {
  head_sha: string;
  versions: Array<{ worker: string; version_id: string }>;
  paths: string[];
  comparison_sha256: string;
};
export function observeStagingTransition(input: {
  target: {
    cloudflare_account_id: string;
    worker_scripts: readonly string[];
    d1_databases: readonly { id: string }[];
    r2_buckets: readonly string[];
  };
  previousRelease: { release_id: string; head_sha: string } | null;
  selectedSha: string;
  token?: string;
}): Promise<ProductionCodeTransition | null>;
