// 0.2.9 R5: timeout-budget selfcheck. Only requests that already ended in
// host-abort check the arithmetic; no timeout behavior changes and pass()'s
// unavailable mapping is untouched (budget-short reports "skipped").
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { reasonGroup, T, renderDetail } from "../lib/stats-page.mjs";
import { localDay } from "../lib/stats.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

const dir = mkdtempSync(join(tmpdir(), "pom-r5-"));
const dayFile = join(dir, localDay() + ".ndjson");
const events = () => { try { return readFileSync(dayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action !== "summary"); } catch { return []; } };
const before = () => events().length;
const since = (n) => events().slice(n);

const singleUser = (text) => ({ model: "group/main", tools: [{}], messages: [{ role: "user", content: text }] });
const ctxWith = (url, signal, opts) => ({ protocol: "chat", agent: "t", kind: "", query: "", signal, options: { gatewayUrl: url, cacheFile: join(dir, "cache.json"), statsDir: dir, ...opts } });
const PROMPT = "帮我把这个模糊的需求优化成具体的提示词描述";
const REWRITE = "这是按照专业模板改写后的完整中文提示词内容，长度足够通过护栏检查要求。";

// Abort before entry: zero gateway calls, exercises passHostAbort directly.
async function aborted(opts, url = "http://127.0.0.1:1") {
  const ac = new AbortController();
  ac.abort();
  const reports = [];
  const out = await onRequest(singleUser(PROMPT), { ...ctxWith(url, ac.signal, opts), report: (c) => reports.push(c) });
  return { out, reports };
}

test("R5: budget short → budget-short with budgets arithmetic", async () => {
  const n = before();
  const { out, reports } = await aborted({ deciderTimeoutMs: 2500, optimizeTimeoutMs: 25000, dryRun: false });
  assert.equal(out, undefined, "fail-open");
  const ev = since(n).find((e) => e.reason === "budget-short");
  assert.ok(ev, `budget-short recorded: ${JSON.stringify(since(n).map((e) => e.reason))}`);
  assert.equal(ev.budgets, "2500+25000>25000");
  assert.ok(!since(n).some((e) => e.reason === "host-abort"), "no host-abort when budget is short");
  assert.deepEqual(reports, ["skipped"], "pass() mapping unchanged");
});

test("R5: explicit gatewayTimeoutMs override is used", async () => {
  const n = before();
  await aborted({ deciderTimeoutMs: 1500, optimizeTimeoutMs: 15000, gatewayTimeoutMs: 17000, dryRun: false });
  const ev = since(n).find((e) => e.reason === "budget-short");
  assert.ok(ev);
  assert.equal(ev.budgets, "1500+15000>17000");
});

test("R5: budget sufficient → still host-abort", async () => {
  const n = before();
  await aborted({ deciderTimeoutMs: 1500, optimizeTimeoutMs: 15000, gatewayTimeoutMs: 25000, dryRun: false });
  const ev = since(n).find((e) => e.reason === "host-abort");
  assert.ok(ev, `host-abort recorded: ${JSON.stringify(since(n).map((e) => e.reason))}`);
  assert.ok(!since(n).some((e) => e.reason === "budget-short"));
  assert.ok(!since(n).some((e) => "budgets" in e), "no budgets field");
});

test("R5: DEFAULTS (1500+15000+1000 <= package.json 25000) does not trigger", async () => {
  const n = before();
  await aborted({ dryRun: false });
  assert.equal(since(n).find((e) => e.action === "pass")?.reason, "host-abort");
  assert.ok(!since(n).some((e) => e.reason === "budget-short"), "default config safe");
});

test("R5: boundary — equality is NOT short", async () => {
  const n = before();
  await aborted({ deciderTimeoutMs: 1500, optimizeTimeoutMs: 15000, gatewayTimeoutMs: 17500, dryRun: false });
  assert.equal(since(n).find((e) => e.action === "pass")?.reason, "host-abort");
});

test("R5: abort in flight (hanging decider) also gets budget-short", async () => {
  const gw = await mockGateway({ hang: ["/v1/systemone"] });
  try {
    const n = before();
    const ac = new AbortController();
    const p = onRequest(singleUser(PROMPT), ctxWith(gw.url, ac.signal, { deciderGroup: "group/route-decider", deciderTimeoutMs: 2500, optimizeTimeoutMs: 25000, dryRun: false }));
    setTimeout(() => ac.abort(), 30);
    assert.equal(await p, undefined);
    const ev = since(n).find((e) => e.reason === "budget-short");
    assert.ok(ev, `budget-short recorded: ${JSON.stringify(since(n).map((e) => e.reason))}`);
    assert.equal(ev.budgets, "2500+25000>25000");
  } finally { gw.close(); }
});

test("R5: normal complete request is unaffected (no budgets field)", async () => {
  const gw = await mockGateway({ optimize: REWRITE });
  try {
    const n = before();
    const out = await onRequest(singleUser(PROMPT), ctxWith(gw.url, undefined, { optimizerMode: "rule", deciderGroup: "", deciderTimeoutMs: 2500, optimizeTimeoutMs: 25000, dryRun: false }));
    assert.ok(out, "request was optimized");
    assert.equal(out.messages[0].content, REWRITE);
    assert.ok(!since(n).some((e) => "budgets" in e), "no budgets field on a healthy request");
    assert.ok(!since(n).some((e) => e.reason === "budget-short"));
  } finally { gw.close(); }
});

test("R5: stats-page label, amber group and detail rendering", () => {
  assert.deepEqual(T["r_budget-short"], ["超时预算不足（宿主已取消）", "timeout budget short (host aborted)"]);
  assert.equal(reasonGroup("budget-short"), "amber");
  assert.equal(T.d_budgets.length, 2);
  const html = renderDetail({ ts: Date.now(), action: "pass", reason: "budget-short", budgets: "2500+25000>25000" }, { lang: "en" });
  assert.ok(html.includes("2500+25000&#62;25000"), "budgets value rendered (HTML-escaped by esc())");
  assert.ok(html.includes("timeout budget arithmetic"));
});
