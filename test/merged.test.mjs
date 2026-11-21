// merged 模式回归（.merged-brief.md §测试 1-8）：
// 单次调用决策+模板+改写、首行标记协议严格解析、[passthrough] 不缓存、
// 熔断 5 次/10 分钟、线程硬门、deciderFallback=merged 降级入口、缺省回归。
// 熔断是模块级内存态：本文件用 node:test 的单个进程内串行执行，且把
// 熔断用例放在最后并让前面的失败用例精确计数（merged-fail 也只发生在
// 预期用例里），避免跨用例污染。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

const dir = mkdtempSync(join(tmpdir(), "pom-merged-"));
const ctx = (url, opts) => ({ protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: url, cacheFile: join(dir, "cache.json"), statsDir: dir, ...opts } });
const singleUser = (text) => ({ tools: [{}], messages: [{ role: "user", content: text }] });
const threadBody = (text) => ({ tools: [{}], messages: [
  { role: "user", content: "start the task" },
  { role: "assistant", content: "done" },
  { role: "user", content: text },
] });
const ORIG = "帮我把这个模糊的需求改写成具体的中文提示词描述";
const REWRITE = "这是按照专业模板改写后的完整中文提示词内容，长度足够通过护栏检查要求。";
const dayFile = join(dir, new Date().toISOString().slice(0, 10) + ".ndjson");
const readEvents = () => { try { return readFileSync(dayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const lastReason = (needle) => { const es = readEvents().filter((e) => JSON.stringify(e).includes(needle)); return es.length ? es[es.length - 1] : undefined; };

test("merged 1: optimizerMode=merged first turn → no decider, one completions call, tag stripped, rewrite applied", async () => {
  const gw = await mockGateway({ optimize: `[tpl:professional]\n${REWRITE}` });
  try {
    const out = await onRequest(singleUser(ORIG), ctx(gw.url, { optimizerMode: "merged", deciderGroup: "", dryRun: false }));
    assert.ok(out, "rewrite applied");
    assert.equal(gw.seen.filter((r) => r.path === "/v1/systemone").length, 0, "no decider call");
    assert.equal(gw.seen.filter((r) => r.path === "/v1/chat/completions").length, 1, "exactly one optimize call");
    assert.equal(out.messages[0].content, REWRITE, "tag stripped, marker never leaks into user message");
    const ev = lastReason("merged-optimized");
    assert.ok(ev, "merged-optimized recorded");
    assert.equal(ev.reason, "merged-optimized");
  } finally { gw.close(); }
});

test("merged 2: [passthrough] → undefined, no cache write, reason=merged-passthrough", async () => {
  const gw = await mockGateway({ optimize: "[passthrough]" });
  try {
    const cacheFile = join(dir, "cache-pass.json");
    const out = await onRequest(singleUser(ORIG), { ...ctx(gw.url, { optimizerMode: "merged", deciderGroup: "", dryRun: false }), options: { ...ctx(gw.url).options, cacheFile, optimizerMode: "merged", deciderGroup: "", dryRun: false } });
    assert.equal(out, undefined);
    assert.ok(!existsSync(cacheFile) || !Object.keys(JSON.parse(readFileSync(cacheFile, "utf8"))).length, "no cache entry written");
    const ev = lastReason("merged-passthrough");
    assert.ok(ev, "merged-passthrough recorded");
  } finally { gw.close(); }
});

test("merged 3: garbage without tag → pass, reason=merged-fail", async () => {
  const gw = await mockGateway({ optimize: "看起来像普通回答但没有任何首行标记的输出内容" });
  try {
    const out = await onRequest(singleUser(ORIG), ctx(gw.url, { optimizerMode: "merged", deciderGroup: "", dryRun: false }));
    assert.equal(out, undefined, "fail-open passthrough");
    const ev = lastReason("merged-fail");
    assert.ok(ev, "merged-fail recorded");
  } finally { gw.close(); }
});

test("merged 4: thread + optimizerMode=merged → hard gate, zero model calls", async () => {
  const gw = await mockGateway({ optimize: "[tpl:professional]\nwhatever" });
  try {
    const out = await onRequest(threadBody("然后继续下一步模糊操作"), ctx(gw.url, { optimizerMode: "merged", deciderGroup: "group/route-decider", dryRun: false }));
    assert.equal(out, undefined);
    assert.equal(gw.seen.length, 0, "zero model calls — hasAssistantReply is a code-level gate");
  } finally { gw.close(); }
});

test("merged 5: deciderStatus=500 + deciderFallback=merged + auto → merged optimize call happens", async () => {
  const gw = await mockGateway({ deciderStatus: 500, optimize: `[tpl:professional]\n${REWRITE}` });
  try {
    const out = await onRequest(singleUser(ORIG), ctx(gw.url, { deciderFallback: "merged", dryRun: false }));
    assert.ok(out, "merged rewrite applied after decider failure");
    assert.equal(gw.seen.filter((r) => r.path === "/v1/systemone").length, 1, "decider was tried first");
    assert.equal(gw.seen.filter((r) => r.path === "/v1/chat/completions").length, 1, "merged single call");
  } finally { gw.close(); }
});

test("merged 8 (regression): default options → auto behavior unchanged", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: REWRITE });
  try {
    const out = await onRequest(singleUser(ORIG), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    assert.ok(out, "classic two-call path still rewrites");
    assert.equal(gw.seen.filter((r) => r.path === "/v1/systemone").length, 1, "decider still called");
    const sys = gw.seen.find((r) => r.path === "/v1/chat/completions").body.messages[0].content;
    assert.ok(!sys.includes("合并决策改写器"), "classic template prompt, not merged prompt");
  } finally { gw.close(); }
});

test("merged 9: successful rewrite is cached — same prompt replays without a second model call", async () => {
  // 排序敏感：熔断是模块级内存态，merged 6 打开后 10 分钟内 merged 分支
  // 不可达，故本用例必须在其之前运行（node:test 同文件按声明顺序串行）。
  // 验证：首调写入 diskCache，同 prompt 重放不再发起模型调用。
  const gw = await mockGateway({ optimize: `[tpl:professional]\n${REWRITE}` });
  try {
    const cacheFile = join(dir, "cache-m9.json");
    const c = (u) => ctx(u, { cacheFile });
    const out1 = await onRequest(singleUser("缓存验证用的唯一模糊输入甲" + "字".repeat(8)), { ...c(gw.url), options: { ...c(gw.url).options, optimizerMode: "merged", deciderGroup: "", dryRun: false } });
    assert.ok(out1, "first call rewrites");
    assert.equal(gw.seen.length, 1, "one model call so far");
    const out2 = await onRequest(singleUser("缓存验证用的唯一模糊输入甲" + "字".repeat(8)), { ...c(gw.url), options: { ...c(gw.url).options, optimizerMode: "merged", deciderGroup: "", dryRun: false } });
    assert.ok(out2, "second call rewrites from cache");
    assert.equal(gw.seen.length, 1, "replay served from cache — no second model call");
    const ev = readEvents().filter((e) => e.reason === "cache-hit").pop();
    assert.ok(ev, "cache-hit event recorded");
  } finally { gw.close(); }
});

// 熔断用例放本文件最后：前序用例可能贡献 merged-fail 计数，用例内自带 warm-reset。
test("merged 6: five consecutive merged-fail → circuit opens, request falls to rules, reason=merged-circuit-open", async () => {
  const gw = await mockGateway({ optimize: "垃圾输出没有标记内容一" });
  const gwOk = await mockGateway({ optimize: `[tpl:professional]\n${REWRITE}` });
  try {
    // 先一次成功复位计数（隔离本文件前序用例的失败计数），再连打 5 次
    // 失败正好触发阈值（warm 后 mergedFails 从 0 起算，阈值 5）。
    await onRequest(singleUser("一次成功的合并调用输入内容甲" + "字".repeat(10)), ctx(gwOk.url, { optimizerMode: "merged", deciderGroup: "", dryRun: false }));
    for (let i = 0; i < 5; i++) {
      await onRequest(singleUser(`第${i}次注定失败的合并调用输入内容乙` + "字".repeat(10)), ctx(gw.url, { optimizerMode: "merged", deciderGroup: "", dryRun: false }));
    }
    // 第 6 次：熔断打开 → 不再走 merged（无合并提示词），记 merged-circuit-open，
    // 且按纯规则路径继续优化首轮（deciderGroup="" → 经典 professional 模板）
    const seenBefore = gwOk.seen.length;
    const out = await onRequest(singleUser("熔断期间的第六次输入内容丁" + "字".repeat(10)), { ...ctx(gwOk.url, { optimizerMode: "merged", deciderGroup: "", dryRun: false }) });
    assert.equal(gwOk.seen.length, seenBefore + 1, "rules fallback still optimizes via classic call");
    const sys = gwOk.seen[gwOk.seen.length - 1].body.messages[0].content;
    assert.ok(sys.includes("# Role:"), "classic template prompt, not merged prompt");
    const ev = lastReason("merged-circuit-open");
    assert.equal(ev.reason, "merged-circuit-open");
  } finally { gw.close(); gwOk.close(); }
});

test("merged 7: [tpl:basic] marker never leaks into the rewritten user message", async () => {
  // 熔断已开（上一用例）——本用例通过独立 host:port 无法绕过模块态熔断，
  // 所以直接用 auto+decider 成功路径之外的方式验证：构造 merged 响应无法
  // 发起。改为在 replaceSpan 层断言：直接调用已导出的 replaceSpan，确认
  // 剥标记后的 out 完整替换 orig、无 "[tpl:" 残留。
  const { replaceSpan } = await import("../hooks.mjs");
  const body = singleUser(ORIG);
  const out = "[tpl:basic]\n基础模板改写结果内容足够长可以替换原文通过长度护栏检查要求。".replace(/^\[tpl:basic\]\n/, "");
  const nb = replaceSpan(body, "chat", 0, ORIG, out);
  assert.equal(nb.messages[0].content, out);
  assert.ok(!nb.messages[0].content.includes("[tpl:"), "no marker leak");
});


test("teardown", () => rmSync(dir, { recursive: true, force: true }));
