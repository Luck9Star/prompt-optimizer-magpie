import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prune } from "../lib/stats.mjs";

const dir = mkdtempSync(join(tmpdir(), "pom-prune-"));
const f = join(dir, "stats.ndjson");
const NOW = Date.now();
const line = (ts, tag) => JSON.stringify({ ts, agent: "t", action: "pass", reason: "not-turn", tag });

test("prune: drops >7d lines, keeps fresh + malformed, returns count", () => {
  writeFileSync(f, [
    line(NOW - 8 * 86400_000, "old1"),
    line(NOW - 9 * 86400_000, "old2"),
    "{broken json",
    line(NOW - 1 * 86400_000, "new1"),
    line(NOW, "new2"),
  ].join("\n") + "\n");
  const removed = prune(7, NOW, f);
  assert.equal(removed, 2);
  const rows = readFileSync(f, "utf8").trim().split("\n");
  assert.equal(rows.length, 3); // malformed + 2 fresh kept
  assert.ok(rows.some((r) => r.includes("broken"))); // malformed never dropped
  assert.ok(rows.every((r) => !r.includes("old")));
});

test("prune: no expired lines → file untouched (returns 0)", () => {
  const before = readFileSync(f, "utf8");
  assert.equal(prune(7, NOW, f), 0);
  assert.equal(readFileSync(f, "utf8"), before);
});

test("prune: retainDays<=0 disables (returns 0)", () => {
  writeFileSync(f, line(NOW - 30 * 86400_000, "ancient") + "\n");
  assert.equal(prune(0, NOW, f), 0);
  assert.ok(readFileSync(f, "utf8").includes("ancient"));
});

test("prune: missing file → 0, no throw", () => {
  assert.equal(prune(7, NOW, join(dir, "nope.ndjson")), 0);
});

const FILE = fileURLToPath(new URL("../stats.ndjson", import.meta.url));
const rowsFor = (agent) => readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.agent === agent);
const waitAgent = async (agent, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (rowsFor(agent).length) return rowsFor(agent);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return rowsFor(agent);
};

test("log levels: logSkips=false suppresses routine pass but keeps failures", async () => {
  const { onRequest } = await import("../hooks.mjs");
  // routine pass: no tools → no-tools gate, logSkips=false must suppress it
  await onRequest({ messages: [{ role: "user", content: "无工具的普通提问不应记录" }] },
    { protocol: "chat", agent: "lv-skip", kind: "", query: "", options: { logSkips: false } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(rowsFor("lv-skip").length, 0, "routine pass suppressed when logSkips=false");
  // failure pass: dead gateway + valid new task → optimize-fail must survive
  await onRequest({ tools: [{}], messages: [{ role: "user", content: "触发优化失败但失败事件必须保留可排障的问题描述" }] },
    { protocol: "chat", agent: "lv-fail", kind: "", query: "", options: { logSkips: false, gatewayUrl: "http://127.0.0.1:1", deciderGroup: "" } });
  const failRows = await waitAgent("lv-fail");
  assert.ok(failRows.some((r) => r.reason === "optimize-fail"), "failure-class pass still logged when logSkips=false");
});

test("log levels: logOptimizes=false suppresses success-path optimize/decide events", async () => {
  const { onRequest } = await import("../hooks.mjs");
  const { mockGateway } = await import("./helpers.gateway.mjs");
  const gw = await mockGateway(); // live gateway → full success path
  try {
    await onRequest({ tools: [{}], messages: [{ role: "user", content: "关闭优化日志后不应记录成功优化轨迹的事件内容" }] },
      { protocol: "chat", agent: "lv-opt-off", kind: "", query: "", options: { logOptimizes: false, gatewayUrl: gw.url, dryRun: false } });
    await new Promise((r) => setTimeout(r, 400));
    const rows = rowsFor("lv-opt-off");
    assert.equal(rows.filter((r) => r.action === "optimize" || r.action === "decide").length, 0,
      "success-path optimize/decide events suppressed when logOptimizes=false");
  } finally {
    gw.close();
  }
});

test("log levels: logOptimizes=false keeps decider-fail (failure survives the switch)", async () => {
  const { onRequest } = await import("../hooks.mjs");
  // dead gateway + live deciderGroup → decide() throws → decider-fail;
  // README promises failures ignore logOptimizes — regression for the
  // switch swallowing decide/decider-fail wholesale.
  await onRequest({ tools: [{}], messages: [{ role: "user", content: "决策器失败时事件必须保留不得被降噪开关吞掉" }] },
    { protocol: "chat", agent: "lv-dec-fail", kind: "", query: "", options: { logOptimizes: false, gatewayUrl: "http://127.0.0.1:1" } });
  const rows = await waitAgent("lv-dec-fail");
  assert.ok(rows.some((r) => r.action === "decide" && r.reason === "decider-fail"),
    "decider-fail must survive logOptimizes=false");
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
      { protocol: "chat", agent: "lv-rep-code", kind: "", query: "", options: { logOptimizes: false, gatewayUrl: gw.url, dryRun: false }, report: (c) => codes.push(c) });
    assert.deepEqual(codes, ["skipped"], "suppressed followup reports skipped, not unavailable");
    // suppressed successful optimize still reports "ready"
    const gw2 = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: "足够长的成功优化输出文本用于验证 ready 上报不被开关改变语义" });
    try {
      codes = [];
      await onRequest({ tools: [{}], messages: [{ role: "user", content: "成功优化应上报 ready 的语义验证用例" }] },
        { protocol: "chat", agent: "lv-rep-ready", kind: "", query: "", options: { logOptimizes: false, gatewayUrl: gw2.url, dryRun: false, deciderGroup: "" }, report: (c, b) => codes.push([c, b]) });
      assert.equal(codes.length, 1);
      assert.equal(codes[0][0], "ready");
      assert.ok(codes[0][1] > 0);
    } finally { gw2.close(); }
  } finally {
    gw.close();
  }
});

test("teardown", () => rmSync(dir, { recursive: true, force: true }));
