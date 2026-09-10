import { importedWrite } from "./service.ts";
async function localWrite(): Promise<void> { await Promise.resolve(); }
export function discarded(db: D1Database, bucket: R2Bucket) {
  localWrite(); // probe:local
  importedWrite(); // probe:imported
  db.prepare("INSERT INTO diagnostic_only VALUES (1)").run(); // probe:d1
  bucket.put("diagnostic-only", "value"); // probe:r2-put
  bucket.delete("diagnostic-only"); // probe:r2-delete
  void bucket.put("diagnostic-only", "value"); // probe:bare-void
}
export function misused(bucket: R2Bucket, keys: string[]) {
  keys.forEach(async (key) => { await bucket.put(key, "value"); }); // probe:callback
  if (bucket.get("diagnostic-only")) return true; // probe:condition
  return false;
}
export async function invalidAwait() {
  await 42; // probe:await-number
}
export function label(state: "pending" | "approved" | "rejected") {
  switch (state) { // probe:union
    case "pending": return "Pending";
    case "approved": return "Approved";
  }
  return "Other";
}
export function unsafe(text: string): string {
  const parsed = JSON.parse(text); // probe:unsafe-assignment
  return parsed.title; // probe:unsafe-return
}
export function suspicious(value: string) {
  if (value != null) return value; // probe:unnecessary-condition
  return "missing";
}
export async function caught(bucket: R2Bucket) {
  try {
    return bucket.put("diagnostic-only", "value"); // probe:return-await
  } catch (error) { throw new Error("Storage failed", { cause: error }); }
}
