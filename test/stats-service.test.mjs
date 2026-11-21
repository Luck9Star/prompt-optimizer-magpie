// v0.2: lib/stats-service.mjs — shared HTTP service + startStatsService
// lifecycle (bind / reuse-on-busy / retry-then-throw on foreign occupant).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStatsService, aggregate, readEvents } from "../lib/stats-service.mjs";

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
  writeFileSync(join(dir, "stats.ndjson"), JSON.stringify({ ts: 1, agent: "a", action: "pass", reason: "not-turn" }) + "\n");
  const svc = await startStatsService({ port: 0, statsFile: join(dir, "stats.ndjson") });
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
  const first = await startStatsService({ port: 0, statsFile: join(dir, "stats.ndjson") }); // ephemeral
  try {
    // bind the SAME server again on first.port via a second startStatsService
    const second = await startStatsService({ port: first.port, statsFile: join(dir, "stats.ndjson") });
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

test("stats-service: foreign occupant → retries then throws, never kills the occupant", async () => {
  const blocker = createServer((req, res) => res.end("i am not stats"));
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const port = blocker.address().port;
  try {
    await assert.rejects(
      () => startStatsService({ port, statsFile: "/nonexistent/x.ndjson" }),
      /busy and no stats service answers/,
    );
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
