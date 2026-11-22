// Rewrite-audit logging: optimized/dry-run/clipped/no-span events carry
// orig + rewritten text, and logRewrites:false suppresses them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

// tmp statsDir via options.statsDir — never touch the real stats/ dir.
const dir = mkdtempSync(join(tmpdir(), "pom-audit-"));
const readFileSyncTolerant = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
const FILE = join(dir, new Date().toISOString().slice(0, 10) + ".ndjson");
// Scan for OUR event by a unique marker instead of racing on the last line.
const findMine = (needle, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const rows = readFileSyncTolerant(FILE).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const hit = rows.reverse().find((r) => JSON.stringify(r).includes(needle));
    if (hit) return hit;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error("stats line not found for: " + needle);
};
// needle-free structural finder (logRewrites=false drops the text fields).
const findStruct = (pred, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const rows = readFileSyncTolerant(FILE).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const hit = rows.reverse().find(pred);
    if (hit) return hit;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error("stats line not found (structural)");
};
const ctx = (url, opts) => ({ protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: url, statsDir: dir, ...opts } });
const singleUser = (text) => ({ tools: [{}], messages: [{ role: "user", content: text }] });

test("audit: optimized event records orig and rewritten verbatim", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: "一段足够长的、用于断言的优化后提示词替换文本" });
  try {
    await onRequest(singleUser("帮我把这个模糊的需求改写成具体提示词甲"), ctx(gw.url, { deciderGroup: "", dryRun: false }));
    const ev = findMine("提示词甲");
    assert.equal(ev.action, "optimize");
    assert.equal(ev.reason, "optimized");
    assert.equal(ev.orig, "帮我把这个模糊的需求改写成具体提示词甲");
    assert.equal(ev.rewritten, "一段足够长的、用于断言的优化后提示词替换文本");
  } finally { gw.close(); }
});

test("audit: dry-run event records both texts too", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: "另一段足够长的优化后提示词替换文本内容" });
  try {
    await onRequest(singleUser("帮我把这个模糊的需求改写成具体提示词乙"), ctx(gw.url, { deciderGroup: "", dryRun: true }));
    const ev = findMine("提示词乙");
    assert.equal(ev.reason, "dry-run");
    assert.ok(ev.orig && ev.rewritten);
  } finally { gw.close(); }
});

test("audit: long text is clipped to logRewriteChars with a marker", async () => {
  const long = "很".repeat(3000);
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: "字".repeat(1500) });
  try {
    // orig 3000 units (CJK) → out 1500 units: guard window [1200, 2000] → passes;
    // clipped at 600 chars with a …(+N chars) marker on both fields.
    await onRequest(singleUser(long), ctx(gw.url, { deciderGroup: "", dryRun: false }));
    const ev = findMine("很");
    assert.equal(ev.reason, "optimized");
    assert.ok(ev.orig.startsWith("很".repeat(600)));
    assert.ok(ev.orig.includes("… +"));
    assert.ok(ev.rewritten.startsWith("字".repeat(600)));
  } finally { gw.close(); }
});

test("audit: logRewrites=false drops text fields but keeps counters", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: "足够长的优化后提示词替换文本内容，超过原文长度" });
  try {
    await onRequest(singleUser("帮我把这个模糊的需求改写成具体提示词丙"), ctx(gw.url, { deciderGroup: "", dryRun: false, logRewrites: false }));
    // needle can't be the (dropped) text — find OUR line structurally:
    // optimized + inputChars 19 + no orig field (logRewrites=false).
    const ev = findStruct((r) => r.agent === "t" && r.reason === "optimized" && r.inputChars === 19 && !("orig" in r));
    assert.equal(ev.reason, "optimized");
    assert.ok(ev.outputChars > 0);
  } finally { gw.close(); }
});

test("audit: ready reports rewritten body bytes; dry-run reports skipped", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: "一段足够长的优化后提示词替换文本内容，超过原文长度" });
  try {
    const codes = [];
    await onRequest(singleUser("帮我把这个模糊的需求改写成具体提示词戊"), { ...ctx(gw.url, { deciderGroup: "", dryRun: false }), report: (c, b) => codes.push([c, b]) });
    assert.equal(codes.length, 1);
    assert.equal(codes[0][0], "ready");
    // bytes reflect the REWRITTEN body (rewritten text embedded), not the input
    assert.ok(codes[0][1] > JSON.stringify(singleUser("帮我把这个模糊的需求改写成具体提示词戊")).length);
  } finally { gw.close(); }
});

test("teardown", () => rmSync(dir, { recursive: true, force: true }));
