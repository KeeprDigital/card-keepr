export function environmentNames(environment?: string): {
  environment: string;
  host: string;
  publicBases: { api: string; ingestion: string };
  workers: string[];
  catalogue: string;
  disposable: string;
  buckets: string[];
  workflows: string[];
};
