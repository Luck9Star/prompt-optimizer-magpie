// 0.2.9 R1: machine-narration anchors. When the (noise-stripped) user text
// starts with any of bypassAnchors, bypass without a model call. Real user
// text mentioning anchors mid-body or at the end must NOT bypass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../hooks.mjs";
import { stripLeadingNoise, lastUserText } from "../lib/turn.mjs";
import { reasonGroup } from "../lib/stats-page.mjs";
import { T } from "../lib/stats-page.mjs";

function bodyWith(text) {
  return { model: "m", stream: false, messages: [{ role: "user", content: text }], tools: [{ type: "function", function: { name: "t" } }] };
}

// A realistic long-enough prompt that would otherwise go to the optimizer.
const LONG_TAIL = "\n\n现在请重新检查代码实现，特别是边界条件和错误处理。";

test("R1: all 13 default anchors bypass", async () => {
  const anchors = [
    "→ ", "// ", "Tool result", "Attached image(s) from tool result",
    "<advisory", "**agent**:", "_thinking:_",
    "Automated capture turn — not a user reply", "<chat>", "<conversation>",
    "The following is an aggregated review from other models",
    "Supervised process", "[Compressed conversation section]",
  ];
  for (const a of anchors) {
    const text = `${a}\n...machine transcript body...${LONG_TAIL}`;
    const body = bodyWith(text);
    const out = await onRequest(body, { agent: "t", query: text, protocol: "chat", options: { dryRun: false } });
    assert.equal(out, undefined, `anchor: ${JSON.stringify(a)}`);
  }
});

test("R1: ACP prefix + anchor bypasses", async () => {
  const text = `<acp tokens="1.2K" type="text" time="2026-11-23 10:00:00">m00001</acp>\n→ tool invocation transcript follows${LONG_TAIL}`;
  const body = bodyWith(text);
  const out = await onRequest(body, { agent: "t", query: text, protocol: "chat", options: { dryRun: false } });
  assert.equal(out, undefined);
});

test("R1: [Replying to] prefix + anchor bypasses", async () => {
  const text = `[Replying to: "previous message"]\n→ tool invocation transcript follows${LONG_TAIL}`;
  const body = bodyWith(text);
  const out = await onRequest(body, { agent: "t", query: text, protocol: "chat", options: { dryRun: false } });
  assert.equal(out, undefined);
});

test("R1: ACP + [Replying to] + anchor (mixed, multiple) bypasses", async () => {
  const text = `<acp tokens="100" type="text" time="2026-11-23 10:00:00">m00001</acp>
[Replying to: "prior turn"]
<acp tokens="200" type="text" time="2026-11-23 10:00:01">m00002</acp>
→ transcript begins${LONG_TAIL}`;
  const body = bodyWith(text);
  const out = await onRequest(body, { agent: "t", query: text, protocol: "chat", options: { dryRun: false } });
  assert.equal(out, undefined);
});

test("R1: anchor mid-body does NOT bypass", async () => {
  // Real user text that happens to mention "→ " in the middle: optimizer
  // must still see the request as user text (no bypass-anchor pass).
  const text = `帮我设计一个限流方案。请求 → 响应 流程需要支持动态阈值。`;
  const body = bodyWith(text);
  // Force the optimizer into the dry-run path (no real model call) and
  // confirm we did NOT short-circuit to bypass-anchor by checking reason.
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readFileSync } = await import("node:fs");
  const { localDay } = await import("../lib/stats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "pom-r1-"));
  await onRequest(body, { agent: "t", query: text, protocol: "chat", options: { dryRun: false, statsDir: dir, cacheFile: join(dir, "cache.json"), optimizerMode: "direct" } });
  const dayFile = join(dir, localDay() + ".ndjson");
  let events = [];
  try { events = readFileSync(dayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  assert.ok(!events.some((e) => e.reason === "bypass-anchor"), "must not bypass mid-body");
});

test("R1: anchor at end of text does NOT bypass", async () => {
  const text = `帮我设计一个限流方案，需要支持动态阈值并给出实现细节 → `;
  const body = bodyWith(text);
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { localDay } = await import("../lib/stats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "pom-r1-"));
  await onRequest(body, { agent: "t", query: text, protocol: "chat", options: { dryRun: false, statsDir: dir, cacheFile: join(dir, "cache.json"), optimizerMode: "direct" } });
  const dayFile = join(dir, localDay() + ".ndjson");
  let events = [];
  try { events = readFileSync(dayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  assert.ok(!events.some((e) => e.reason === "bypass-anchor"), "must not bypass on trailing anchor");
});

test("R1: custom bypassAnchors override DEFAULTS", async () => {
  const text = `CUSTOM_MACHINE_PREFIX something follows${LONG_TAIL}`;
  const body = bodyWith(text);
  const out = await onRequest(body, { agent: "t", query: text, protocol: "chat", options: { dryRun: false, bypassAnchors: ["CUSTOM_MACHINE_PREFIX"] } });
  assert.equal(out, undefined);
});
test("R1: optimizer sees turn.mjs-cleaned text, not stripLeadingNoise output", () => {
  // turn.mjs's clean() already strips ACP/Replying-to lines before the
  // optimizer sees lu.text. stripLeadingNoise (my R1 helper) is ONLY used
  // for the bypass-anchor JUDGMENT; it never replaces lu.text. So lu.text
  // here still contains the leading "→ " anchor that triggers the bypass.
  const text = `<acp tokens="100" type="text" time="t">m00001</acp>\n→ machine lead-in\nuser's real question here`;
  const lu = lastUserText(bodyWith(text), "chat");
  assert.ok(lu.text.startsWith("→ "), "anchor visible to optimizer-judgment path");
  assert.ok(!lu.text.includes("<acp"), "ACP already stripped by turn.mjs clean()");
});
test("R1: stripLeadingNoise is idempotent and handles empty/missing", () => {
  assert.equal(stripLeadingNoise(""), "");
  assert.equal(stripLeadingNoise(null), "");
  assert.equal(stripLeadingNoise(undefined), "");
  assert.equal(stripLeadingNoise("  \n  hello"), "hello");
  const mixed = `<acp tokens="1" type="text" time="t">m1</acp>\n[Replying to: "x"]\n<acp tokens="2" type="text" time="t">m2</acp>\n→ rest`;
  assert.equal(stripLeadingNoise(mixed), "→ rest");
  // Mid-text ACP must NOT be stripped.
  const midText = "hello\n<acp tokens=\"1\" type=\"text\" time=\"t\">m1</acp>\nworld";
  assert.equal(stripLeadingNoise(midText), midText);
});

test("R1: reason label + amber group wired", () => {
  assert.deepEqual(T["r_bypass-anchor"], ["机器叙述锚点旁路", "machine-narration anchor bypassed"]);
  assert.equal(reasonGroup("bypass-anchor"), "amber");
});
