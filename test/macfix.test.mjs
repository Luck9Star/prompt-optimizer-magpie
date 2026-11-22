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

test("macfix 中-2: long orig gets a ceiling that scales with orig units", async () => {
  const orig = "词".repeat(700);   // 700 units → ceiling clamp(3500, 60, 2000) = 2000
  const out1800 = "答".repeat(1800); // 1800 units, 2.6× orig → legal expansion
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: out1800 });
  try {
    const out = await onRequest(singleUser(orig), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    assert.ok(out, "1800-unit rewrite accepted for 700-unit orig (a fixed 60-unit cap would drop it)");
  } finally { gw.close(); }
});

test("macfix 中-2: short orig is capped at 5× its units", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: "答".repeat(700) });
  try {
    const out = await onRequest(singleUser("词".repeat(100)), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    assert.equal(out, undefined, "100-unit orig → ceiling 500 units → 700-unit rewrite dropped");
  } finally { gw.close(); }
});

test("teardown", () => rmSync(dir, { recursive: true, force: true }));
