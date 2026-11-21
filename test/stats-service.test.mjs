// v0.2: lib/stats-service.mjs — shared HTTP service + startStatsService
// lifecycle (bind / reuse-on-busy / retry-then-throw on foreign occupant).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStatsServer, startStatsService, aggregate } from "../lib/stats-service.mjs";
import { readEvents } from "../lib/stats.mjs";

const once = (port, path) =>
  new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });

test("stats-service: ephemeral bind serves / and /api/stats", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pom-svc-"));
  mkdirSync(join(dir, "stats"), { recursive: true });
  writeFileSync(join(dir, "stats", new Date().toISOString().slice(0, 10) + ".ndjson"), JSON.stringify({ ts: 1, agent: "a", action: "pass", reason: "not-turn" }) + "\n");
  const svc = await startStatsService({ port: 0, statsDir: join(dir, "stats") });
  try {
    assert.equal(svc.reused, false);
    assert.ok(svc.port > 0, "ephemeral port assigned");
    const j = JSON.parse((await once(svc.port, "/api/stats")).body);
    assert.equal(j.total, 1);
    const html = await once(svc.port, "/");
    assert.match(html.body, /prompt-optimizer-magpie · stats/);
  } finally {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stats-service: busy port with a live stats service → reused, original untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pom-svc-reuse-"));
  const first = await startStatsService({ port: 0, statsDir: join(dir, "stats") }); // ephemeral
  try {
    // bind the SAME server again on first.port via a second startStatsService
    const second = await startStatsService({ port: first.port, statsDir: join(dir, "stats") });
    assert.equal(second.reused, true, "detected existing stats service");
    assert.equal(second.port, first.port);
    await second.close(); // no-op by contract
    const res = await once(first.port, "/api/stats"); // first still alive
    assert.equal(res.status, 200);
  } finally {
    await first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stats-service: foreign occupant → retries then throws, never kills the occupant", async (t) => {
  const timers = t.mock.method(globalThis, "setInterval");
  const blocker = createServer((req, res) => res.end("i am not stats"));
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const port = blocker.address().port;
  try {
    await assert.rejects(
      () => startStatsService({ port, statsDir: "/nonexistent/x.ndjson" }),
      /busy and no stats service answers/,
    );
    assert.equal(timers.mock.callCount(), 0, "failed binds must not start retention");
    // blocker survived the retry storm
    const res = await once(port, "/");
    assert.equal(res.body, "i am not stats");
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test("stats-service: aggregate + readEvents shared helpers still correct", () => {
  const events = [
    { action: "optimize", durationMs: 100 },
    { action: "optimize", durationMs: 300 },
    { action: "pass" },
  ];
  const agg = aggregate(events);
  assert.equal(agg.total, 3);
  assert.equal(agg.optimizeDuration.p50, 100);
  assert.equal(agg.optimizeDuration.p95, 300);
  assert.deepEqual(readEvents("/nonexistent/none.ndjson"), []);
});

function request(server, host, url) {
  const res = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; },
  };
  server.emit("request", { method: "GET", headers: { host }, url }, res);
  return res;
}

test("stats-service: invalid URL returns 400 and malformed day-file events are skipped", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pom-events-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const valid = { ts: 1, action: "pass", reason: "short-text" };
  const rows = [null, {}, [valid], { ...valid, inputChars: "12" }, { ...valid, reason: {} }, valid];
  writeFileSync(join(dir, "2026-01-01.ndjson"), rows.map((e) => JSON.stringify(e)).join("\n"));
  const server = makeStatsServer({ statsDir: dir });
  assert.equal(request(server, "localhost", "http://").status, 400);
  assert.deepEqual(JSON.parse(request(server, "localhost", "/api/recent").body), [valid]);
  assert.equal(JSON.parse(request(server, "localhost", "/api/stats").body).total, 1);
});

test("stats-service: Host authority supports multiple LAN interfaces and equivalent IPv6 literals", (t) => {
  t.mock.method(os, "networkInterfaces", () => ({
    en0: [{ address: "192.0.2.1" }],
    en1: [{ address: "2001:db8::a" }],
  }));
  const lan = makeStatsServer({ bind: "0.0.0.0" });
  for (const host of ["192.0.2.1:8000", "[2001:0DB8:0:0:0:0:0:A]:123", "LOCALHOST"]) {
    assert.equal(request(lan, host, "/missing").status, 404, host);
  }
  for (const host of ["[::1]:bad", "[::1]x", "localhost:65536", "localhost/path", "192.0.2.2"]) {
    assert.equal(request(lan, host, "/missing").status, 403, host);
  }
  const local = makeStatsServer({ bind: "0:0:0:0:0:0:0:1" });
  assert.equal(request(local, "192.0.2.1", "/missing").status, 403);
});

test("stats-service: IPv6 bind is probed on the same address; only the listener owns a timer", async (t) => {
  const add = t.mock.method(globalThis, "setInterval");
  const clear = t.mock.method(globalThis, "clearInterval");
  const dir = mkdtempSync(join(tmpdir(), "pom-bind6-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await startStatsService({ port: 0, bind: "::1", statsDir: dir, retainDays: 7 });
  try {
    const second = await startStatsService({ port: first.port, bind: "::1", statsDir: dir, retainDays: 7 });
    assert.ok(second.reused);
    await second.close();
    assert.equal(add.mock.callCount(), 1);
    assert.equal(clear.mock.callCount(), 0);
  } finally {
    await first.close();
  }
  assert.deepEqual(clear.mock.calls.map((c) => c.arguments[0]), [add.mock.calls[0].result]);
});

test("stats-service: one denominator per experiment, version and arm; historical detail stays separate", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pom-summary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const detail = { ts: 4, action: "optimize", reason: "optimized", durationMs: 12 };
  const summary = {
    ts: 3, action: "summary", reason: "optimized", group: "baseline", experimentId: "", version: "",
    mode: "auto", fallbackFrom: "", turn: "first", finalAction: "apply", fromCache: false, modelCalls: 2, durationMs: 10,
  };
  const rows = [
    summary, detail, { ...summary, finalAction: "dry-run", durationMs: 20 },
    { ...summary, finalAction: "pass", reason: "output-guard", modelCalls: 1, durationMs: 30 },
    { ...summary, experimentId: "trial", version: "v1", group: "auto" },
    { ...summary, experimentId: "trial", version: "v2", group: "auto" },
    { ...summary, experimentId: "another", version: "v1", group: "auto" },
    { ...summary, experimentId: "trial", version: "v1", group: "control", modelCalls: 0 },
    { ...summary, finalAction: "unknown" }, { ...summary, modelCalls: null },
  ];
  writeFileSync(join(dir, "2026-01-01.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n"));
  const server = makeStatsServer({ statsDir: dir });
  const stats = JSON.parse(request(server, "localhost", "/api/stats").body);
  assert.equal(stats.total, 1);
  assert.deepEqual(stats.actionCounts, { optimize: 1 });
  assert.deepEqual(stats.reasonTop, { optimized: 1 });
  assert.deepEqual(stats.optimizeDuration, { count: 1, p50: 12, p95: 12 });
  assert.equal(stats.firstTs, detail.ts);
  assert.equal(stats.lastTs, detail.ts);
  assert.equal(stats.requestGroups.length, 5);
  assert.deepEqual(stats.requestGroups[0], { group: "baseline", experimentId: "", version: "",
    samples: 3, applied: 1, applyRate: 1/3, modelCalls: 5, p95Ms: 30, passReasons: { "output-guard": 1 } });
  const html = request(server, "localhost", "/").body;
  assert.match(html, /33\.3%/);
  assert.match(html, /output-guard \(1\)/);
  assert.match(html, /Recent 1 detailed events/);
  assert.deepEqual(aggregate([detail]).requestGroups, []);
});
