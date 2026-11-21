// v0.2 standalone stats daemon (design §6). All HTTP logic lives in
// lib/stats-service.mjs, shared with index.mjs (magpie plugin host entry).
// This file adds: env overrides (PORT, POM_DATA_DIR, POM_BIND), service.json
// discovery for systemd and EADDRINUSE retry+fallback.
import { writeFileSync, rmSync, readFileSync, symlinkSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { makeStatsServer } from "./lib/stats-service.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.POM_DATA_DIR || ROOT;
const STATS = join(DATA_DIR, "stats"); // daily day-files (lib/stats.mjs)
const SERVICE = join(DATA_DIR, "service.json");
const instanceRecord = join(DATA_DIR, `.service-${randomUUID()}.json`);
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
// POM_BIND: 默认 127.0.0.1；设为 0.0.0.0 / 本机网卡 IP = 开 LAN 访问
// （stats 日志里有截断后的提示词原文，对内网可见——见 README 隐私说明）。
const BIND = process.env.POM_BIND || "127.0.0.1";

const server = makeStatsServer({ statsDir: STATS, bind: BIND });
// design §6: ephemeral (PORT=0) is the norm; a fixed PORT may hit EADDRINUSE —
// per candidate: same-port retry 16×100ms (a leaving process's socket often
// clears), then move to the next candidate (fixed fallback 3497 for the page's
// hello.service-down path). Each candidate gets its own 16-retry budget so a
// fallback port also survives a lingering socket (systemd restarts included).
const port = Number(process.env.PORT ?? 0);
// hello.service-down fallback (design §6.2b). Overridable so tests can pick
// a free port — hardcoding 3497 made the suite hang wherever magpie's own
// plugin host holds it.
const FIXED_FALLBACK = [Number(process.env.POM_FALLBACK_PORT ?? 3497)];
const RETRIES_PER_CANDIDATE = 16;
const RETRY_DELAY_MS = 100;
const candidates = port === 0 ? [0] : [port, ...FIXED_FALLBACK.filter((p) => p !== port)];
let retriesLeft = RETRIES_PER_CANDIDATE;
let discovery;
// Register the listening handler ONCE: listen(port, host, cb) adds cb as
// another one-time 'listening' listener per retry attempt, so a bind that
// succeeds after N retries would fire N callbacks (N service.json writes).
server.on("listening", () => {
  const { port: bound } = server.address();
  discovery = JSON.stringify({ port: bound, pid: process.pid, startedAt: Date.now(), version: VERSION }, null, 2);
  writeFileSync(instanceRecord, discovery, { flag: "wx" });
  symlinkSync(basename(instanceRecord), instanceRecord + ".next");
  renameSync(instanceRecord + ".next", SERVICE);
  console.log(`serve: http://${BIND}:${bound}  (data: ${DATA_DIR})`);
});
const tryListen = () => server.listen(candidates[0], BIND);
server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && retriesLeft > 0 && candidates.length > 0) {
    retriesLeft -= 1;
    if (retriesLeft === 0 && candidates.length > 1) {
      console.error(`serve: ${err.message}, port ${candidates[0]} busy, trying ${candidates[1]}...`);
      candidates.shift(); // budget exhausted for this port → next candidate …
      retriesLeft = RETRIES_PER_CANDIDATE; // … with a FRESH budget
    } else {
      console.error(`serve: ${err.message}, retrying (${retriesLeft} left)...`);
    }
    setTimeout(tryListen, RETRY_DELAY_MS);
    return;
  }
  console.error(`serve: ${err.message}`);
  process.exit(1);
});
tryListen();

const shutdown = () => {
  try {
    // Removing only our target keeps a concurrent publication intact.
    if (discovery && readFileSync(instanceRecord, "utf8") === discovery) rmSync(instanceRecord);
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
