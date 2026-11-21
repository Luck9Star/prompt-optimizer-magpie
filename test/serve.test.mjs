// v0.2: spawn serve.mjs with PORT=0 + POM_DATA_DIR, assert endpoints + lifecycle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, createServer } from "node:http";

const ROOT = new URL("..", import.meta.url).pathname;

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
    env: { ...process.env, PORT: String(port), POM_DATA_DIR: dataDir, POM_RETAIN_DAYS: "0" },
    stdio: "ignore",
  });
  const serviceJson = join(dataDir, "service.json");
  const t0 = Date.now();
  while (!existsSync(serviceJson)) {
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
    assert.equal(info.version, "0.2.0");

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
    await new Promise((r) => (child.on("exit", r)));
    assert.ok(!existsSync(serviceJson), "service.json cleaned up on exit");
  }
});

test("serve: aggregation over known ndjson + corrupted line tolerance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pom-serve-"));
  const lines = [
    { ts: 1, agent: "claude", action: "pass", reason: "short-text", durationMs: 1, inputChars: 2, outputChars: 0, dryRun: true },
    { ts: 2, agent: "claude", action: "optimize", reason: "optimized", durationMs: 100, inputChars: 50, outputChars: 120, dryRun: true },
    { ts: 3, agent: "codex", action: "optimize", reason: "dry-run", durationMs: 200, inputChars: 60, outputChars: 150, dryRun: true },
    { ts: 4, agent: "codex", action: "optimize", reason: "dry-run", durationMs: 400, inputChars: 60, outputChars: 150, dryRun: true },
    { ts: 5, agent: "codex", action: "optimize", reason: "dry-run", durationMs: 800, inputChars: 60, outputChars: 150, dryRun: true },
    { ts: 6, agent: "hermes", action: "pass", reason: "bypass-prefix", durationMs: 3, inputChars: 10, outputChars: 0, dryRun: true },
  ];
  writeFileSync(join(dir, "stats.ndjson"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n{corrupted!!\n");

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
    await new Promise((r) => (child.on("exit", r)));
  }
});

// EADDRINUSE retry: an occupied fixed PORT falls back to candidate 3497,
// stays up, and reports the actual bound port in service.json.
test("serve: occupied fixed port retries then binds fallback 3497", async () => {
  const blocker = createServer(() => {});
  await new Promise((r) => blocker.listen(3500, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "pom-serve-"));
  const child = spawn(process.execPath, [join(ROOT, "serve.mjs")], {
    env: { ...process.env, PORT: "3500", POM_DATA_DIR: dir },
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
    assert.equal(info.port, 3497, `expected fallback 3497, got ${info.port}; out=${out}`);
    assert.ok(/retrying \(15 left\)/.test(out) && /port 3500 busy, trying 3497/.test(out), `retry+shift lines logged; out=${out}`);
    const res = await once(info.port, "/api/stats");
    assert.equal(res.status, 200, "fallback port serves requests");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
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
  writeFileSync(join(dir, "stats.ndjson"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const child = spawn(process.execPath, [join(ROOT, "serve.mjs")], {
    env: { ...process.env, PORT: "0", POM_DATA_DIR: dir }, // no POM_RETAIN_DAYS → default 7
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
