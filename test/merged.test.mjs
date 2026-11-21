// merged 模式回归（.merged-brief.md §测试 1-8）：
// 单次调用决策+模板+改写、首行标记协议严格解析、[passthrough] 不缓存、
// 熔断 5 次/10 分钟、线程硬门、deciderFallback=merged 降级入口、缺省回归。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTemplate } from "../templates/index.mjs";
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
    const out = await onRequest(singleUser(ORIG), ctx(gw.url, { optimizerMode: "merged", dryRun: false }));
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
    const out = await onRequest(singleUser(ORIG), ctx(gw.url, { cacheFile, optimizerMode: "merged", dryRun: false }));
    assert.equal(out, undefined);
    assert.ok(!existsSync(cacheFile + ".d"), "no cache entry written");
    const ev = lastReason("merged-passthrough");
    assert.ok(ev, "merged-passthrough recorded");
  } finally { gw.close(); }
});

test("merged 3: garbage without tag → pass, reason=merged-fail", async () => {
  const gw = await mockGateway({ optimize: "看起来像普通回答但没有任何首行标记的输出内容" });
  try {
    const out = await onRequest(singleUser(ORIG), ctx(gw.url, { optimizerMode: "merged", dryRun: false }));
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
    assert.ok(sys.startsWith(getTemplate("professional").system), "classic template prompt, not merged prompt");
  } finally { gw.close(); }
});

test("merged 9: successful rewrite is cached — same prompt replays without a second model call", async () => {
  const gw = await mockGateway({ optimize: `[tpl:professional]\n${REWRITE}` });
  try {
    const cacheFile = join(dir, "cache-m9.json");
    const c = ctx(gw.url, { cacheFile, optimizerMode: "merged", dryRun: false });
    const out1 = await onRequest(singleUser("缓存验证用的唯一模糊输入甲" + "字".repeat(8)), c);
    assert.ok(out1, "first call rewrites");
    assert.equal(gw.seen.length, 1, "one model call so far");
    const out2 = await onRequest(singleUser("缓存验证用的唯一模糊输入甲" + "字".repeat(8)), c);
    assert.ok(out2, "second call rewrites from cache");
    assert.equal(gw.seen.length, 1, "replay served from cache — no second model call");
    const ev = readEvents().filter((e) => e.reason === "cache-hit").pop();
    assert.ok(ev, "cache-hit event recorded");
  } finally { gw.close(); }
});

test("merged 6: five empty rewrites open the breaker only for that backend", async () => {
  const gw = await mockGateway({ optimize: "[tpl:basic]\n " });
  const other = await mockGateway({ optimize: `[tpl:basic]\n${REWRITE}` });
  try {
    const c = ctx(gw.url, { optimizerMode: "merged", dryRun: false });
    for (let i = 0; i < 5; i++) assert.equal(await onRequest(singleUser(ORIG), c), undefined);
    await onRequest(singleUser(ORIG), c);
    assert.equal(gw.seen.length, 6);
    assert.ok(gw.seen.at(-1).body.messages[0].content.startsWith(getTemplate("professional").system));
    assert.equal(readEvents().at(-2).reason, "merged-circuit-open");
    assert.ok(await onRequest(singleUser(ORIG), ctx(other.url, { optimizerMode: "merged", dryRun: false })));
  } finally { gw.close(); other.close(); }
});

test("merged 7: CRLF marker never leaks and multiline text is preserved", async () => {
  const rewrite = `${REWRITE}\r\n正文中可以提到 [tpl:basic]。`;
  const gw = await mockGateway({ optimize: `[tpl:basic]\r\n${rewrite}` });
  try {
    const out = await onRequest(singleUser(ORIG), ctx(gw.url, { optimizerMode: "merged", dryRun: false }));
    assert.equal(out.messages[0].content, rewrite);
  } finally { gw.close(); }
});

test("teardown", () => rmSync(dir, { recursive: true, force: true }));
