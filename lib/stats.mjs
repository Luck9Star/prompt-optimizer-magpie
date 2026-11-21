// Append-only event log next to the plugin root (import.meta.url based,
// never cwd). Silent on failure: stats must never break a request.
// Retention: prune() drops events older than retainDays (serve.mjs startup
// and a daily timer call it) so stats.ndjson stops growing without bound.
import { appendFileSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "stats.ndjson");

export function record(ev) {
  try {
    appendFileSync(FILE, JSON.stringify({ ts: Date.now(), ...ev }) + "\n");
  } catch {
    // 写失败静默
  }
}

// Drop lines whose ts is older than retainDays. Atomic-ish: write a temp
// file then rename, so a crash mid-prune can never truncate the log.
// `file` lets serve.mjs target its POM_DATA_DIR copy, not the plugin root.
// Returns the number of removed lines (0 = untouched file).
export function prune(retainDays, now = Date.now(), file = FILE) {
  if (!Number.isFinite(retainDays) || retainDays <= 0) return 0;
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return 0; // nothing to prune
  }
  const lines = raw.split("\n").filter(Boolean);
  const cutoff = now - retainDays * 86400_000;
  const keep = [];
  let removed = 0;
  for (const line of lines) {
    let ts = 0;
    try { ts = JSON.parse(line).ts || 0; } catch { /* keep malformed: prune by ts=0 */ }
    if (ts && ts < cutoff) removed++;
    else keep.push(line);
  }
  if (!removed) return 0;
  try {
    writeFileSync(`${file}.tmp`, keep.length ? keep.join("\n") + "\n" : "");
    renameSync(`${file}.tmp`, file);
  } catch {
    // prune is best-effort; a failed rewrite leaves the original intact
    return 0;
  }
  return removed;
}
