// Append-only event log next to the plugin root (import.meta.url based,
// never cwd). Silent on failure: stats must never break a request.
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "stats.ndjson");

export function record(ev) {
  try {
    appendFileSync(FILE, JSON.stringify({ ts: Date.now(), ...ev }) + "\n");
  } catch {
    // 写失败静默
  }
}
