// v0.2 standalone stats daemon (design §6). All HTTP logic lives in
// lib/stats-service.mjs, shared with index.mjs (magpie plugin host entry).
// This file adds: env overrides (PORT, POM_DATA_DIR), service.json discovery
// for systemd, EADDRINUSE retry+fallback, and the startup/daily prune.
import { writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prune } from "./lib/stats.mjs";
import { makeStatsServer } from "./lib/stats-service.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.POM_DATA_DIR || ROOT;
const STATS = join(DATA_DIR, "stats.ndjson");
const SERVICE = join(DATA_DIR, "service.json");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
// 日志保留：默认 7 天；0/负数 = 永久保留。70 上部署目录大小可控。
const RETAIN_DAYS = Number(process.env.POM_RETAIN_DAYS ?? 7) || 0;

const server = makeStatsServer({ statsFile: STATS });
// design §6: ephemeral (PORT=0) is the norm; a fixed PORT may hit EADDRINUSE —
// per candidate: same-port retry 16×100ms (a leaving process's socket often
// clears), then move to the next candidate (fixed fallback 3497 for the page's
// hello.service-down path). Retry budget is shared across candidates so
// systemd restarts never die on a lingering socket.
const port = Number(process.env.PORT ?? 0);
const FIXED_FALLBACK = [3497]; // hello.service-down fallback (design §6.2b)
const RETRIES_PER_CANDIDATE = 16;
const RETRY_DELAY_MS = 100;
const candidates = port === 0 ? [0] : [port, ...FIXED_FALLBACK.filter((p) => p !== port)];
let retriesLeft = RETRIES_PER_CANDIDATE;
// Register the listening handler ONCE: listen(port, host, cb) adds cb as
// another one-time 'listening' listener per retry attempt, so a bind that
// succeeds after N retries would fire N callbacks (N service.json writes).
server.on("listening", () => {
  const { port: bound } = server.address();
  writeFileSync(SERVICE, JSON.stringify({ port: bound, pid: process.pid, startedAt: Date.now(), version: VERSION }, null, 2));
  console.log(`serve: http://127.0.0.1:${bound}  (data: ${DATA_DIR})`);
});
const tryListen = () => server.listen(candidates[0], "127.0.0.1");
server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && retriesLeft > 0 && candidates.length > 0) {
    retriesLeft -= 1;
    if (retriesLeft % RETRIES_PER_CANDIDATE === 0 && candidates.length > 1) {
      console.error(`serve: ${err.message}, port ${candidates[0]} busy, trying ${candidates[1]}...`);
      candidates.shift(); // budget exhausted for this port → next candidate
    } else {
      console.error(`serve: ${err.message}, retrying (${Math.min(RETRIES_PER_CANDIDATE, retriesLeft)} left)...`);
    }
    setTimeout(tryListen, RETRY_DELAY_MS);
    return;
  }
  console.error(`serve: ${err.message}`);
  process.exit(1);
});
// prune at startup, then once a day (timer doesn't keep the loop alive —
// serve's listening socket does). Result logged once for ops visibility.
const pruned = prune(RETAIN_DAYS, Date.now(), STATS);
if (pruned > 0) console.log(`serve: pruned ${pruned} stats events older than ${RETAIN_DAYS}d`);
setInterval(() => {
  const n = prune(RETAIN_DAYS, Date.now(), STATS);
  if (n > 0) console.log(`serve: pruned ${n} stats events older than ${RETAIN_DAYS}d`);
}, 86400_000).unref?.();

tryListen();

const shutdown = () => {
  try {
    rmSync(SERVICE); // best-effort: only ours
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
