export function validatedProductionTarget(value: unknown): null | {
  cloudflare_account_id: string;
  worker_scripts: string[];
  d1_databases: { name: string; id: string }[];
  r2_buckets: string[];
};
