// Regression tests for the mac-review fixes (2026-11-21, /tmp/pom-review-mac.md):
//   高-1 non-Chinese input + non-professional decider tier → professional_en
//      template (English system prompt), never a Chinese basic/planning prompt;
//   中-1 decider failure → rules-only fallback (first turn optimized, thread
//      passes), reason decider-fail-rule, not a whole-request pass;
//   中-2 absolute output ceiling scales with orig length (max(6000, orig)):
//      a >2000-char orig may legally rewrite to >6000 chars.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { getTemplate } from "../templates/index.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

const dir = mkdtempSync(join(tmpdir(), "pom-macfix-"));
const ctx = (url, opts) => ({ protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: url, cacheFile: join(dir, "cache.json"), statsDir: dir, ...opts } });
const singleUser = (text) => ({ tools: [{}], messages: [{ role: "user", content: text }] });
const threadBody = (text) => ({ tools: [{}], messages: [
  { role: "user", content: "start the task" },
  { role: "assistant", content: "done" },
  { role: "user", content: text },
] });
const EN_OPTIMIZE = "This is the rewritten English prompt with enough body to clear the guardrails easily.";

test("macfix 高-1: basic tier + English input → English system prompt (professional_en)", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9, tpl: { choice: "basic", confidence: 0.9 } }, optimize: EN_OPTIMIZE });
  try {
    await onRequest(singleUser("please help me fix this vague bug report"), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: true }));
    const opt = gw.seen.find((r) => r.path === "/v1/chat/completions");
    assert.ok(opt, "optimizer called");
    assert.ok(opt.body.messages[0].content.startsWith(getTemplate("professional_en").system));
  } finally { gw.close(); }
});

test("macfix 高-1: planning tier + English input → professional_en too", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9, tpl: { choice: "planning", confidence: 0.9 } }, optimize: EN_OPTIMIZE });
  try {
    await onRequest(singleUser("please help me plan this vague migration"), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: true }));
    const opt = gw.seen.find((r) => r.path === "/v1/chat/completions");
    assert.ok(opt.body.messages[0].content.startsWith(getTemplate("professional_en").system));
  } finally { gw.close(); }
});

test("macfix 高-1: basic tier + Chinese input stays on the Chinese basic template", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9, tpl: { choice: "basic", confidence: 0.9 } }, optimize: "优化后的中文提示词内容，足够长以通过护栏长度检查要求，超过原文长度。" });
  try {
    await onRequest(singleUser("帮我把这个模糊需求改写成具体可执行的中文提示词描述"), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: true }));
    const opt = gw.seen.find((r) => r.path === "/v1/chat/completions");
    assert.ok(opt.body.messages[0].content.startsWith(getTemplate("basic").system));
  } finally { gw.close(); }
});

test("macfix 中-1: decider 500 on a first turn → still optimized (rules fallback)", async () => {
  const gw = await mockGateway({ deciderStatus: 500, optimize: "一段足够长的优化后提示词替换文本内容，超过原文长度。" });
  try {
    const out = await onRequest(singleUser("帮我把这个模糊的需求改写成具体提示词描述"), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    assert.ok(out, "rewrite applied despite decider failure");
    assert.equal(gw.seen.filter((r) => r.path === "/v1/chat/completions").length, 1, "optimizer called");
  } finally { gw.close(); }
});

test("macfix 中-1: decider garbage JSON on a thread → conservative pass, no optimizer call", async () => {
  const gw = await mockGateway({ deciderRaw: "not-json{", optimize: "一段足够长的优化后提示词替换文本内容，超过原文长度。" });
  try {
    const out = await onRequest(threadBody("and now continue with the next vague step"), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    assert.equal(out, undefined);
    assert.equal(gw.seen.filter((r) => r.path === "/v1/chat/completions").length, 0, "thread passes, optimizer not called");
  } finally { gw.close(); }
});

test("macfix 中-2: orig > 6000 chars gets a ceiling above the fixed 6000", async () => {
  const orig = "x".repeat(7000);
  const out6k5 = "y".repeat(6500); // ceiling = max(6000, 7000) = 7000 → 6500 passes
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: out6k5 });
  try {
    const out = await onRequest(singleUser(orig), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    assert.ok(out, "6500-char rewrite accepted for 7000-char orig (old fixed 6000 cap would drop it)");
  } finally { gw.close(); }
});

test("macfix 中-2: short orig still capped at 6000", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: "y".repeat(7000) });
  try {
    const out = await onRequest(singleUser("x".repeat(2500)), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    assert.equal(out, undefined, "2500-char orig keeps the 6000 ceiling → 7000-char rewrite dropped");
  } finally { gw.close(); }
});

test("teardown", () => rmSync(dir, { recursive: true, force: true }));
