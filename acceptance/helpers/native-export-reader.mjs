import { loadNativeExport } from "./native-catalogue-runtime.mjs";

// An immutable package is verified once per API boot/revision. Clear before
// restoration so the restored API must independently supply every byte again.
export function nativeExportReader(requestIntervalMs) {
  const snapshots = new Map();
  return {
    clear() {
      snapshots.clear();
    },
    async records(baseUrl, apiKey, revisionId, kind) {
      const key = `${baseUrl}:${apiKey}:${revisionId}`;
      if (!snapshots.has(key))
        snapshots.set(
          key,
          loadNativeExport(baseUrl, apiKey, revisionId, requestIntervalMs).catch((error) => {
            snapshots.delete(key);
            throw error;
          }),
        );
      return (await snapshots.get(key)).filter((entry) => entry.kind === kind).map((entry) => entry.value);
    },
  };
}
