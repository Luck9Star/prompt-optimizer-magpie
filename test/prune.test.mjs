import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prune, readEvents, localDay } from "../lib/stats.mjs";

const dir = mkdtempSync(join(tmpdir(), "pom-prune-"));
const NOW = Date.now();
const day = (offsetDays) => localDay(new Date(NOW - offsetDays * 86400_000));

test("prune: unlinks day files older than retainDays, keeps recent, returns count", () => {
  const s = join(dir, "stats");
  mkdirSync(s, { recursive: true });
  writeFileSync(join(s, `${day(8)}.ndjson`), JSON.stringify({ ts: NOW - 8 * 86400_000 }) + "\n");
  writeFileSync(join(s, `${day(9)}.ndjson`), "{broken json\n"); // old + malformed content: file still goes by NAME
  writeFileSync(join(s, `${day(1)}.ndjson`), JSON.stringify({ ts: NOW - 86400_000 }) + "\n");
  writeFileSync(join(s, "not-a-day.log"), "x"); // malformed filename → untouched
  const removed = prune(7, NOW, s);
  assert.equal(removed, 2);
  assert.deepEqual(readdirSync(s).sort(), [`${day(1)}.ndjson`, "not-a-day.log"]);
});

test("prune: no expired files → dir untouched (returns 0)", () => {
  const s = join(dir, "stats2");
  mkdirSync(s, { recursive: true });
  writeFileSync(join(s, `${day(1)}.ndjson`), "{}\n");
  assert.equal(prune(7, NOW, s), 0);
  assert.equal(readdirSync(s).length, 1);
});

test("prune: retainDays<=0 disables (returns 0)", () => {
  const s = join(dir, "stats3");
  mkdirSync(s, { recursive: true });
  writeFileSync(join(s, "2000-01-01.ndjson"), "ancient\n");
  assert.equal(prune(0, NOW, s), 0);
  assert.equal(prune(-3, NOW, s), 0);
  assert.equal(readdirSync(s).length, 1);
});

test("prune: missing dir → 0, no throw", () => {
  assert.equal(prune(7, NOW, join(dir, "nope")), 0);
});

const rowsFor = (agent) => readEvents(dir).filter((r) => r.agent === agent);

test("log levels: logSkips=false suppresses routine pass but keeps failures", async () => {
  const { onRequest } = await import("../hooks.mjs");
  // routine pass: no tools → no-tools gate, logSkips=false must suppress it
  await onRequest({ messages: [{ role: "user", content: "无工具的普通提问不应记录" }] },
    { protocol: "chat", agent: "lv-skip", kind: "", query: "", options: { statsDir: dir, cacheTtlMs: 0, logSkips: false } });
  assert.equal(rowsFor("lv-skip").length, 0, "routine pass suppressed when logSkips=false");
  // failure pass: dead gateway + valid new task → optimize-fail must survive
  await onRequest({ tools: [{}], messages: [{ role: "user", content: "触发优化失败但失败事件必须保留可排障的问题描述" }] },
    { protocol: "chat", agent: "lv-fail", kind: "", query: "", options: { statsDir: dir, cacheTtlMs: 0, logSkips: false, gatewayUrl: "http://127.0.0.1:1", deciderGroup: "" } });
  const failRows = rowsFor("lv-fail");
  assert.ok(failRows.some((r) => r.reason === "optimize-fail"), "failure-class pass still logged when logSkips=false");
});

test("log levels: logOptimizes=false suppresses success-path optimize/decide events", async () => {
  const { onRequest } = await import("../hooks.mjs");
  const { mockGateway } = await import("./helpers.gateway.mjs");
  const gw = await mockGateway(); // live gateway → full success path
  try {
    await onRequest({ tools: [{}], messages: [{ role: "user", content: "关闭优化日志后不应记录成功优化轨迹的事件内容" }] },
      { protocol: "chat", agent: "lv-opt-off", kind: "", query: "", options: { statsDir: dir, cacheTtlMs: 0, logOptimizes: false, gatewayUrl: gw.url, dryRun: false } });
    const rows = rowsFor("lv-opt-off");
    assert.equal(rows.filter((r) => r.action === "optimize" || r.action === "decide").length, 0,
      "success-path optimize/decide events suppressed when logOptimizes=false");
  } finally {
    gw.close();
  }
});

test("log levels: logOptimizes=false keeps decider-fail-rule (failure survives the switch)", async () => {
  const { onRequest } = await import("../hooks.mjs");
  // dead gateway + live deciderGroup → decide() throws → decider-fail-rule;
  // README promises failures ignore logOptimizes — regression for the
  // switch swallowing decide/decider-fail wholesale.
  await onRequest({ tools: [{}], messages: [{ role: "user", content: "决策器失败时事件必须保留不得被降噪开关吞掉" }] },
    { protocol: "chat", agent: "lv-dec-fail", kind: "", query: "", options: { statsDir: dir, cacheTtlMs: 0, logOptimizes: false, gatewayUrl: "http://127.0.0.1:1" } });
  const rows = rowsFor("lv-dec-fail");
  assert.ok(rows.some((r) => r.action === "decide" && r.reason === "decider-fail-rule"),
    "decider-fail-rule must survive logOptimizes=false");
});

test("log levels: report codes unaffected by logOptimizes (followup→skipped, optimized→ready)", async () => {
  const { onRequest } = await import("../hooks.mjs");
  const { mockGateway } = await import("./helpers.gateway.mjs");
  const gw = await mockGateway({ decider: { choice: "followup", confidence: 0.9 } });
  try {
    // suppressed decide/followup still reports "skipped" — the switch must
    // not redefine ctx.report semantics (regression: used to send unavailable)
    let codes = [];
    await onRequest({ tools: [{}], messages: [{ role: "user", content: "追问不应上报 unavailable 语义验证" }] },
      { protocol: "chat", agent: "lv-rep-code", kind: "", query: "", options: { statsDir: dir, cacheTtlMs: 0, logOptimizes: false, gatewayUrl: gw.url, dryRun: false }, report: (c) => codes.push(c) });
    assert.deepEqual(codes, ["skipped"], "suppressed followup reports skipped, not unavailable");
    // suppressed successful optimize still reports "ready"
    const gw2 = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: "足够长的成功优化输出文本用于验证 ready 上报不被开关改变语义" });
    try {
      codes = [];
      await onRequest({ tools: [{}], messages: [{ role: "user", content: "成功优化应上报 ready 的语义验证用例" }] },
        { protocol: "chat", agent: "lv-rep-ready", kind: "", query: "", options: { statsDir: dir, cacheTtlMs: 0, logOptimizes: false, gatewayUrl: gw2.url, dryRun: false, deciderGroup: "" }, report: (c, b) => codes.push([c, b]) });
      assert.equal(codes.length, 1);
      assert.equal(codes[0][0], "ready");
      assert.ok(codes[0][1] > 0);
    } finally { gw2.close(); }
  } finally {
    gw.close();
  }
});

test("teardown", () => rmSync(dir, { recursive: true, force: true }));
