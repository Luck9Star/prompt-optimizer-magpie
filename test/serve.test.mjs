// v0.2: spawn serve.mjs with PORT=0 + POM_DATA_DIR, assert endpoints + lifecycle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, createServer } from "node:http";

const ROOT = new URL("..", import.meta.url).pathname;


// A free TCP port for tests — hardcoded 3497 hangs wherever magpie's plugin
// host holds it (omp review [高-1]).
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
// Resolve when the child exits; guard against attaching after exit —
// `on("exit")` on an already-dead process never fires (the old hang).
function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((r) => child.once("exit", r));
}

function once(port, path) {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on("error", reject);
  });
}

async function startServe(dataDir, port = 0) {
  const child = spawn(process.execPath, [join(ROOT, "serve.mjs")], {
    // POM_RETAIN_DAYS=0: startup prune off — fixture ts values are arbitrary;
    // pruning itself is covered by the dedicated retain test below.
    // POM_STATS_DIR serves fixtures from the tmp dir; POM_LEGACY_STATS_DIR
    // points migration at a nonexistent dir — the dev checkout HAS a real
    // package-internal stats/ that must never leak into a spawned serve.
    env: { ...process.env, PORT: String(port), POM_DATA_DIR: dataDir, POM_STATS_DIR: join(dataDir, "stats"), POM_LEGACY_STATS_DIR: join(dataDir, "no-legacy"), POM_RETAIN_DAYS: "0" },
    stdio: "ignore",
  });
  const serviceJson = join(dataDir, "service.json");
  const t0 = Date.now();
  while (true) {
    if (existsSync(serviceJson) && JSON.parse(readFileSync(serviceJson, "utf8")).pid === child.pid) break;
    if (Date.now() - t0 > 10000) throw new Error("service.json not written within 10s");
    await new Promise((r) => setTimeout(r, 50));
  }
  return { child, serviceJson };
}

test("serve: service.json lifecycle + empty stats endpoints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pom-serve-"));
  const { child, serviceJson } = await startServe(dir);
  try {
    const info = JSON.parse(readFileSync(serviceJson, "utf8"));
    assert.equal(info.pid, child.pid);
    assert.ok(info.port > 0, "ephemeral port assigned");
    assert.ok(info.startedAt > 0);
    assert.equal(info.version, (await import("../package.json", { with: { type: "json" } })).default.version);

    const stats = await once(info.port, "/api/stats");
    assert.equal(stats.status, 200);
    assert.match(stats.headers["content-type"], /json/);
    const j = JSON.parse(stats.body);
    assert.ok(j.total >= 0);
    assert.equal(typeof j.actionCounts, "object");

    const recent = await once(info.port, "/api/recent");
    assert.equal(recent.status, 200);
    assert.ok(Array.isArray(JSON.parse(recent.body)));

    const html = await once(info.port, "/");
    assert.equal(html.status, 200);
    assert.match(html.body, /<html/);
  } finally {
    child.kill("SIGTERM");
    await exited(child);
    assert.ok(!existsSync(serviceJson), "service.json cleaned up on exit");
  }
});

test("serve: aggregation over known ndjson + corrupted line tolerance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pom-serve-"));
  const lines = [
    { ts: 1, agent: "claude", action: "pass", reason: "short-text", durationMs: 1, inputChars: 2, outputChars: 0, dryRun: true },
    { ts: 2, agent: "claude", action: "optimize", reason: "optimized", durationMs: 100, optimizeMs: 100, inputChars: 50, outputChars: 120, dryRun: true },
    { ts: 3, agent: "codex", action: "optimize", reason: "dry-run", durationMs: 200, optimizeMs: 200, inputChars: 60, outputChars: 150, dryRun: true },
    { ts: 4, agent: "codex", action: "optimize", reason: "dry-run", durationMs: 400, optimizeMs: 400, inputChars: 60, outputChars: 150, dryRun: true },
    { ts: 5, agent: "codex", action: "optimize", reason: "dry-run", durationMs: 800, optimizeMs: 800, inputChars: 60, outputChars: 150, dryRun: true },
    { ts: 6, agent: "hermes", action: "pass", reason: "bypass-prefix", durationMs: 3, inputChars: 10, outputChars: 0, dryRun: true },
  ];
  mkdirSync(join(dir, "stats"), { recursive: true });
  writeFileSync(join(dir, "stats", new Date().toISOString().slice(0, 10) + ".ndjson"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n{corrupted!!\n");

  const { child, serviceJson } = await startServe(dir);
  try {
    const { port } = JSON.parse(readFileSync(serviceJson, "utf8"));
    const j = JSON.parse((await once(port, "/api/stats")).body);
    assert.equal(j.total, 6, "corrupted line skipped");
    assert.deepEqual(j.actionCounts, { pass: 2, optimize: 4 });
    assert.equal(j.optimizeDuration.count, 4);
    // nearest-rank p50 of [100,200,400,8] → 200; p95 → ceil(.95*4)=4th → 800
    assert.equal(j.optimizeDuration.p50, 200);
    assert.equal(j.optimizeDuration.p95, 800);

    const rec = JSON.parse((await once(port, `/api/recent?n=2`)).body);
    assert.equal(rec.length, 2);
    assert.equal(rec[0].ts, 5, "most recent n events, oldest first");
    assert.equal(rec[1].reason, "bypass-prefix");
  } finally {
    child.kill("SIGTERM");
    await exited(child);
  }
});

// EADDRINUSE retry: an occupied fixed PORT falls back to the fallback port,
// stays up, and reports the actual bound port in service.json. Both ports are
// picked dynamically (env-overridable POM_FALLBACK_PORT) — never 3497.
test("serve: occupied fixed port retries then binds fallback", async () => {
  const [mainPort, fallbackPort] = await Promise.all([freePort(), freePort()]);
  const blocker = createServer(() => {});
  await new Promise((r) => blocker.listen(mainPort, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "pom-serve-"));
  const child = spawn(process.execPath, [join(ROOT, "serve.mjs")], {
    env: { ...process.env, PORT: String(mainPort), POM_FALLBACK_PORT: String(fallbackPort), POM_DATA_DIR: dir, POM_STATS_DIR: join(dir, "stats"), POM_LEGACY_STATS_DIR: join(dir, "no-legacy"), POM_RETAIN_DAYS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  try {
    const serviceJson = join(dir, "service.json");
    const t0 = Date.now();
    while (!existsSync(serviceJson)) {
      if (Date.now() - t0 > 10000) throw new Error(`service.json not written; out=${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const info = JSON.parse(readFileSync(serviceJson, "utf8"));
    assert.equal(info.port, fallbackPort, `expected fallback ${fallbackPort}, got ${info.port}; out=${out}`);
    assert.ok(/retrying \(15 left\)/.test(out) && new RegExp(`port ${mainPort} busy, trying ${fallbackPort}`).test(out), `retry+shift lines logged; out=${out}`);
    const res = await once(info.port, "/api/stats");
    assert.equal(res.status, 200, "fallback port serves requests");
  } finally {
    child.kill("SIGTERM");
    await exited(child);
    await new Promise((r) => blocker.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve: startup prune honors POM_RETAIN_DAYS (7d default behavior)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pom-serve-prune-"));
  const NOW = Date.now();
  const lines = [
    { ts: NOW - 8 * 86400_000, agent: "a", action: "pass", reason: "not-turn", durationMs: 1, inputChars: 0, outputChars: 0, dryRun: true },
    { ts: NOW, agent: "a", action: "pass", reason: "not-turn", durationMs: 1, inputChars: 0, outputChars: 0, dryRun: true },
  ];
  mkdirSync(join(dir, "stats"), { recursive: true });
  // day-file layout: retention is by FILE date — the 8d-old event goes in an
  // 8-day-old file, the fresh one in today's file
  writeFileSync(join(dir, "stats", new Date(NOW - 8 * 86400_000).toISOString().slice(0, 10) + ".ndjson"), JSON.stringify(lines[0]) + "\n");
  writeFileSync(join(dir, "stats", new Date().toISOString().slice(0, 10) + ".ndjson"), JSON.stringify(lines[1]) + "\n");
  const child = spawn(process.execPath, [join(ROOT, "serve.mjs")], {
    env: { ...process.env, PORT: "0", POM_DATA_DIR: dir, POM_STATS_DIR: join(dir, "stats"), POM_LEGACY_STATS_DIR: join(dir, "no-legacy") }, // no POM_RETAIN_DAYS → default 7
    stdio: "ignore",
  });
  const serviceJson = join(dir, "service.json");
  const t0 = Date.now();
  while (!existsSync(serviceJson)) {
    if (Date.now() - t0 > 10000) throw new Error("service.json not written within 10s");
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    const { port } = JSON.parse(readFileSync(serviceJson, "utf8"));
    const j = JSON.parse((await once(port, "/api/stats")).body);
    assert.equal(j.total, 1, "8-day-old event pruned at startup, fresh kept");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve: exiting an older instance preserves the newer record; a restart republishes discovery", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pom-discovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const children = [];
  const start = async () => {
    const instance = await startServe(dir);
    children.push(instance.child);
    return instance;
  };
  const stop = async (child) => { child.kill("SIGTERM"); await exited(child); };
  try {
    const first = await start();
    const second = await start();
    await stop(first.child);
    assert.equal(JSON.parse(readFileSync(first.serviceJson, "utf8")).pid, second.child.pid);
    assert.equal(readdirSync(dir).filter((f) => f.startsWith(".service-")).length, 1);
    await stop(second.child);
    assert.ok(!existsSync(second.serviceJson));
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(".service-")), []);
    const next = await start();
    assert.equal(JSON.parse(readFileSync(next.serviceJson, "utf8")).pid, next.child.pid);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await stop(child);
  }
});
