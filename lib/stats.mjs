// Append-only daily event logs, one ndjson file per day. Stats live OUTSIDE
// the package dir: `magpie plugin update` wipes node_modules reinstalls and
// took the whole stats/ dir with it twice on prod. New home (design:
// ~/.config/magpie/prompt-optimizer-magpie/stats). Silent on failure: stats
// must never break a request.
//
// Why daily files: record() runs in the magpie plugin-host process while
// prune() runs in serve.mjs (systemd) — two OS processes. A read→tmp→rename
// rewrite races with a concurrent append (the append lands in the unlinked
// old inode). With one file per UTC day, retention is an unlink of *old*
// files and writers only ever append to *today's* file: the two operations
// touch disjoint inodes, so no lock protocol is needed. It also bounds a
// single file's growth and makes prune O(files), not O(bytes).
import { appendFileSync, readFileSync, readdirSync, unlinkSync, mkdirSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_DIR = join(ROOT, "stats"); // pre-0.2.5 location, wiped by plugin updates

// One resolver for record/read/prune defaults and both entries (index.mjs,
// serve.mjs). POM_STATS_DIR explicitly overrides; no XDG dependency — Windows
// falls back to ~/.config/... too (documented in README).
export function resolveStatsDir() {
  if (process.env.POM_STATS_DIR) return process.env.POM_STATS_DIR;
  return join(homedir(), ".config", "magpie", "prompt-optimizer-magpie", "stats");
}

// One-shot legacy migration (called from both entries at startup): if the
// package-internal stats/ dir survived and the new dir would lose data, COPY
// day files over (never overwrite; the legacy dir is left in place) and drop
// a MIGRATED.txt marker so it never runs twice. Copy-once beats move: on 70
// the old dir has manually-restored history an update must not re-destroy.
// Silent-fail — stats can never block a request.
export function migrateLegacyStats(oldDir = process.env.POM_LEGACY_STATS_DIR || LEGACY_DIR, newDir = resolveStatsDir()) {
  try {
    if (!existsSync(oldDir)) return false;
    if (existsSync(join(oldDir, "MIGRATED.txt"))) return false;
    mkdirSync(newDir, { recursive: true });
    for (const name of readdirSync(oldDir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)) continue;
      const dest = join(newDir, name);
      if (existsSync(dest)) continue; // never overwrite newer data
      copyFileSync(join(oldDir, name), dest);
    }
    writeFileSync(join(oldDir, "MIGRATED.txt"), `migrated to ${newDir} at ${new Date().toISOString()}\n`);
    return true;
  } catch {
    return false;
  }
}

const DIR = resolveStatsDir();

// statsDir lets serve.mjs target its data dir, tests target a tmp dir.
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

export function validEvent(ev) {
  if (!ev || typeof ev !== "object" || !Number.isFinite(ev.ts)) return false;
  if (typeof ev.action !== "string" || !ev.action || typeof ev.reason !== "string" || !ev.reason) return false;
  if (ev.action === "summary") {
    return ["group", "experimentId", "version"].every((k) => typeof ev[k] === "string")
      && ev.group.length > 0 && ["first", "thread"].includes(ev.turn)
      && ["auto", "merged", "rule", "direct"].includes(ev.mode)
      && ["", "auto", "merged", "auto/merged"].includes(ev.fallbackFrom)
      && ["apply", "pass", "dry-run"].includes(ev.finalAction)
      && typeof ev.fromCache === "boolean" && Number.isSafeInteger(ev.modelCalls) && ev.modelCalls >= 0
      && Number.isFinite(ev.durationMs) && ev.durationMs >= 0;
  }
  return ["durationMs", "inputChars", "outputChars", "inputUnits", "outputUnits"].every((k) => ev[k] === undefined || Number.isFinite(ev[k]))
    && ["agent", "orig", "rewritten"].every((k) => ev[k] === undefined || typeof ev[k] === "string")
    && ["dryRun", "fromCache"].every((k) => ev[k] === undefined || typeof ev[k] === "boolean");
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
        const ev = JSON.parse(line);
        if (validEvent(ev)) out.push(ev);
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
  const date = new Date(now - retainDays * 86400_000);
  if (!Number.isFinite(date.getTime())) return 0;
  const cutoff = date.toISOString().slice(0, 10);
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
