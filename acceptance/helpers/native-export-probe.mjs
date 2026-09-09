import { parentPort, workerData } from "node:worker_threads";
import { nativeRecoveryCloudflare } from "./native-recovery-cloudflare.mjs";
const provider = nativeRecoveryCloudflare({ databaseDirectory: workerData.directory, directory: workerData.directory });
try {
  await provider.fetch(
    new Request("https://api.cloudflare.com/client/v4/accounts/local/d1/database/local/export", { method: "POST" }),
  );
  parentPort.postMessage({ snapshot: provider.snapshots[0] });
} catch (error) {
  parentPort.postMessage({ error: error.message });
} finally {
  provider.close();
}
