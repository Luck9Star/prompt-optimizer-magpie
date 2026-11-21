// Append-only daily event logs under stats/ next to the plugin root
// (import.meta.url based, never cwd). Silent on failure: stats must never
// break a request.
//
// Why daily files: record() runs in the magpie plugin-host process while
// prune() runs in serve.mjs (systemd) — two OS processes. A read→tmp→rename
// rewrite races with a concurrent append (the append lands in the unlinked
// old inode). With one file per UTC day, retention is an unlink of *old*
// files and writers only ever append to *today's* file: the two operations
// touch disjoint inodes, so the race cannot drop data. It also caps any
// single file's growth and makes prune O(files), not O(bytes).
import { appendFileSync, readFileSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "stats");

// statsDir lets serve.mjs target its POM_DATA_DIR, tests target a tmp dir.
const dayFile = (d = new Date(), statsDir = DIR) =>
  join(statsDir, d.toISOString().slice(0, 10) + ".ndjson");

export function record(ev, statsDir = DIR) {
  try {
    appendFileSync(dayFile(new Date(), statsDir), JSON.stringify({ ts: Date.now(), ...ev }) + "\n");
  } catch (e) {
    if (e?.code === "ENOENT") {
      // first write of the day / fresh deploy: create the dir and retry once
      try {
        mkdirSync(statsDir, { recursive: true });
        appendFileSync(dayFile(new Date(), statsDir), JSON.stringify({ ts: Date.now(), ...ev }) + "\n");
        return;
      } catch { /* fall through to silent */ }
    }
    // 写失败静默
  }
}

// All events across retained day files, oldest first. Corrupted lines are
// skipped (never a 500). Missing dir → empty, not an error.
export function readEvents(statsDir = DIR) {
  let names;
  try {
    names = readdirSync(statsDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(n)).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    let raw;
    try {
      raw = readFileSync(join(statsDir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch { /* corrupted line → skip */ }
    }
  }
  return out;
}

// Retention: unlink day files whose date is older than retainDays. No
// rewriting of live files, so it can never race a concurrent append (the
// old design's temp+rename could). Malformed filenames are left alone.
// Returns the number of removed files (0 = nothing done).
export function prune(retainDays, now = Date.now(), statsDir = DIR) {
  if (!Number.isFinite(retainDays) || retainDays <= 0) return 0;
  let names;
  try {
    names = readdirSync(statsDir);
  } catch {
    return 0;
  }
  // files strictly older than the cutoff date (UTC) are unlinked
  const cutoff = new Date(now - retainDays * 86400_000).toISOString().slice(0, 10);
  let removed = 0;
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)) continue;
    if (name.slice(0, 10) >= cutoff) continue; // still within retention
    try {
      unlinkSync(join(statsDir, name));
      removed++;
    } catch { /* best-effort */ }
  }
  return removed;
}
