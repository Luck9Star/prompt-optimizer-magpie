import { localDay } from "../lib/stats.mjs";
// 阶段计时回归（.omp-timing-brief.md）：
// 真实 decide()/optimize()/merged completion() 调用记 decideMs/optimizeMs；
// cache-hit、pass、护栏失败不产生阶段字段，也不进 KPI 分位桶。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { mockGateway } from "./helpers.gateway.mjs";
import { aggregate } from "../lib/stats-service.mjs";

const dir = mkdtempSync(join(tmpdir(), "pom-timing-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const ctx = (url, opts) => ({ protocol: "chat", agent: "tt", kind: "", query: "", options: { gatewayUrl: url, cacheFile: opts?.cacheFile ?? join(dir, "c-" + (url || "x").replace(/[^a-z0-9]/gi, "").slice(-10) + ".json"), statsDir: dir, ...opts } });
const singleUser = (text) => ({ tools: [{}], messages: [{ role: "user", content: text }] });
const threadBody = (text) => ({ tools: [{}], messages: [
  { role: "assistant", content: "done" },
  { role: "user", content: text },
] });
const ORIG = "帮我把这个模糊的需求改写成具体的中文提示词描述并补全上下文";
const REWRITE = "这是按照专业模板改写后的完整中文提示词内容，长度足够通过护栏检查要求。";
const dayFile = join(dir, localDay() + ".ndjson");
const readEvents = () => { try { return readFileSync(dayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action !== "summary"); } catch { return []; } };
const lastOptimize = () => readEvents().filter((e) => e.action === "optimize").at(-1);

test("timing: decider-fail still records decideMs from the real attempt", async () => {
  const gw = await mockGateway({ deciderStatus: 500 });
  try {
    await onRequest(singleUser(ORIG), ctx(gw.url, { dryRun: false }));
    const ev = readEvents().find((e) => e.reason === "decider-fail-rule");
    assert.ok(ev, "decider-fail-rule logged");
    assert.equal(typeof ev.decideMs, "number");
    assert.ok(ev.decideMs >= 0);
  } finally { gw.close(); }
});

test("timing: optimize success records optimizeMs; cache-hit and pass carry no stage fields", async () => {
  const gw = await mockGateway({ optimize: REWRITE });
  try {
    await onRequest(singleUser(ORIG + "第一轮"), ctx(gw.url, { dryRun: false }));
    const ev = lastOptimize();
    assert.equal(ev.reason, "optimized");
    assert.equal(typeof ev.decideMs, "number", "auto mode: same request measured both stages");

    const gwThread = await mockGateway({ decider: { choice: "followup", confidence: 0.9 } });
    await onRequest(threadBody("继续刚才的任务下一步"), ctx(gwThread.url, { dryRun: false }));
    gwThread.close();
    const followup = readEvents().filter((e) => e.reason === "followup").at(-1);
    assert.ok(followup, "thread decide/followup event exists");
    assert.equal(followup.action, "decide");
    assert.equal(typeof followup.decideMs, "number", "decider ran for real on a thread");
    assert.equal(followup.optimizeMs, undefined, "no optimizer call");
    await onRequest(singleUser(ORIG + "第一轮"), ctx(gw.url, { dryRun: false })); // same prompt → cache
    const cached = lastOptimize();
    assert.equal(cached.reason, "cache-hit");
    assert.equal(cached.optimizeMs, undefined, "cache hit made no model call");
  } finally { gw.close(); }
});

test("timing: merged optimize records optimizeMs", async () => {
  const gw = await mockGateway({ optimize: `[tpl:professional]\n${REWRITE}` });
  try {
    await onRequest(singleUser(ORIG + "合并模式第一轮"), ctx(gw.url, { optimizerMode: "merged", deciderGroup: "", dryRun: false }));
    const ev = lastOptimize();
    assert.equal(ev.reason, "merged-optimized");
    assert.equal(typeof ev.optimizeMs, "number");
  } finally { gw.close(); }
});

test("timing: aggregate buckets use stage fields only; durationMs-only legacy rows excluded", () => {
  const legacy = { ts: 1, agent: "a", action: "optimize", reason: "optimized", durationMs: 999 };
  const modern = { ts: 2, agent: "a", action: "optimize", reason: "optimized", durationMs: 500, optimizeMs: 500 };
  const decide = { ts: 3, agent: "a", action: "decide", reason: "new-task", durationMs: 50, decideMs: 50 };
  const pass = { ts: 4, agent: "a", action: "pass", reason: "not-turn", durationMs: 1 };
  const agg = aggregate([legacy, modern, decide, pass]);
  assert.equal(agg.actionDuration.optimize.count, 1, "legacy row without optimizeMs excluded");
  assert.equal(agg.actionDuration.optimize.p95, 500);
  assert.equal(agg.actionDuration.decide.count, 1);
  assert.equal(agg.actionDuration.decide.p95, 50);
  assert.equal(agg.actionDuration.pass, undefined, "no pass bucket");
  // empty-bucket shape stays dash-renderable
  writeFileSync(join(dir, "shape.ndjson"), "");
  const empty = aggregate([{ ts: 5, agent: "a", action: "pass", reason: "not-turn" }]);
  assert.deepEqual(empty.actionDuration.optimize, { count: 0, p50: null, p95: null, p99: null, max: null });
});
