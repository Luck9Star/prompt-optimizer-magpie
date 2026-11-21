// Rewrite-audit logging: optimized/dry-run/output-guard/no-span events carry
// orig + rewritten text (clipped), and logRewrites:false suppresses them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { onRequest } from "../hooks.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

const FILE = fileURLToPath(new URL("../stats.ndjson", import.meta.url));
// Parallel test files append to one stats.ndjson — scan for OUR event by a
// unique marker instead of racing on the last line.
const findMine = (needle, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const rows = readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const hit = rows.reverse().find((r) => JSON.stringify(r).includes(needle));
    if (hit) return hit;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error("stats line not found for: " + needle);
};
const ctx = (url, opts) => ({ protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: url, ...opts } });
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
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: "x".repeat(4000) });
  try {
    // output-guard path fires (4000 > max(3*3000,1500)? no — 4000 < 9000, but > no…
    // 4000 < 9000 so guard passes; absolute cap 6000 also passes → no-span path:
    // orig not found in body? it IS found. Use too-long output to force guard:
    await onRequest(singleUser(long), ctx(gw.url, { deciderGroup: "", dryRun: false }));
    const ev = findMine("很");
    // 4000 chars output vs orig 3000: 0.4*3000=1200 ok, max(9000,1500)=9000 ok, 6000 cap ok → optimized.
    assert.equal(ev.reason, "optimized");
    assert.ok(ev.orig.startsWith("很".repeat(600)));
    assert.ok(ev.orig.includes("…(+"));
    assert.ok(ev.rewritten.startsWith("x".repeat(600)));
  } finally { gw.close(); }
});

test("audit: logRewrites=false drops text fields but keeps counters", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: "足够长的优化后提示词替换文本内容，超过原文长度" });
  try {
    await onRequest(singleUser("帮我把这个模糊的需求改写成具体提示词丙"), ctx(gw.url, { deciderGroup: "", dryRun: false, logRewrites: false }));
    // needle can't be the (dropped) text — find OUR line structurally:
    // optimized + inputChars 19 + no orig field (logRewrites=false).
    const ev = (() => {
      for (let i = 0; i < 40; i++) {
        const rows = readFileSync(FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        const hit = rows.reverse().find((r) => r.agent === "t" && r.reason === "optimized" && r.inputChars === 19 && !("orig" in r));
        if (hit) return hit;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      throw new Error("stats line not found for logRewrites=false case");
    })();
    assert.equal(ev.reason, "optimized");
    assert.equal("orig" in ev, false);
    assert.equal("rewritten" in ev, false);
    assert.equal(ev.inputChars, 19); // 丙 version
  } finally { gw.close(); }
});
