// v0.1 milestone gap tests: decider template-tier routing (tpl question),
// retry cache (design §4.6), and bypassAgents (design step 0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onRequest } from "../hooks.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

const FILE = new URL("../stats.ndjson", import.meta.url);
// Tests run in parallel across files appending to one stats.ndjson — read back
// and scan for OUR line (matched by the unique prompt text) instead of the
// racy "last line" heuristic.
const findMine = (needle, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const rows = readFileSync(FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const hit = rows.reverse().find((r) => JSON.stringify(r).includes(needle));
    if (hit) return hit;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error("stats line not found for: " + needle);
};
const body1 = { tools: [{}], messages: [{ role: "user", content: "帮我设计一个限流方案，要求支持动态阈值乙" }] };
const ctx = (url, opts) => ({ protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: url, ...opts } });

const LONG = "优化后的提示词内容，足够长以通过护栏长度检查要求。";

test("tier: decider tpl=skip → pass, optimizer never called", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9, tpl: { choice: "skip", confidence: 0.9 } }, optimize: LONG });
  try {
    const out = await onRequest(body1, ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: true }));
    assert.equal(out, undefined);
    assert.equal(gw.seen.length, 1); // decider only
    const ev = findMine("限流方案");
    assert.equal(ev.reason, "tpl-skip");
    assert.ok(ev.orig.includes("限流方案"));
  } finally { gw.close(); }
});

test("tier: decider tpl=planning → optimizer gets the planning template system prompt", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9, tpl: { choice: "planning", confidence: 0.9 } }, optimize: LONG });
  try {
    await onRequest(body1, ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: true }));
    const opt = gw.seen.find((r) => r.path === "/v1/chat/completions");
    assert.ok(opt, "optimizer called");
    // planning template's system prompt differs from professional's
    assert.ok(opt.body.messages[0].content.includes("规划"));
  } finally { gw.close(); }
});

test("tier: invalid tpl choice falls back to professional", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9, tpl: { choice: "wat", confidence: 0.9 } }, optimize: LONG });
  try {
    const out = await onRequest(body1, ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: true }));
    assert.ok(out === undefined); // dry-run always returns undefined; check optimizer used
    const opt = gw.seen.find((r) => r.path === "/v1/chat/completions");
    assert.ok(opt.body.messages[0].content.length > 200); // professional system prompt
  } finally { gw.close(); }
});

test("cache: same prompt twice → second is cache-hit, one optimizer call", async () => {
  const cf = new URL("../tmp-cache-tier1.json", import.meta.url).pathname;
  const { rmSync } = await import("node:fs");
  rmSync(cf, { force: true });
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9, tpl: { choice: "basic", confidence: 0.9 } }, optimize: LONG });
  try {
    const b1 = { tools: [{}], messages: [{ role: "user", content: "帮我设计一个缓存策略方案，要支持失效穿透" }] };
    await onRequest(b1, ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: false, cacheFile: cf }));
    await onRequest(b1, ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: false, cacheFile: cf }));
    const opts = gw.seen.filter((r) => r.path === "/v1/chat/completions");
    assert.equal(opts.length, 1);
    assert.equal(findMine("失效穿透").reason, "cache-hit");
  } finally { gw.close(); rmSync(cf, { force: true }); }
});

test("cache: cacheTtlMs=0 disables the cache", async () => {
  const cf2 = new URL("../tmp-cache-tier2.json", import.meta.url).pathname;
  const { rmSync } = await import("node:fs");
  rmSync(cf2, { force: true });
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: LONG });
  try {
    const b1 = { tools: [{}], messages: [{ role: "user", content: "帮我设计一个零停机发布流程方案" }] };
    await onRequest(b1, ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: false, cacheTtlMs: 0, cacheFile: cf2 }));
    await onRequest(b1, ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: false, cacheTtlMs: 0, cacheFile: cf2 }));
    const opts = gw.seen.filter((r) => r.path === "/v1/chat/completions");
    assert.equal(opts.length, 2);
  } finally { gw.close(); rmSync(cf2, { force: true }); }
});

test("bypassAgents: listed agent passes before any gateway call", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: LONG });
  try {
    const b = { tools: [{}], messages: [{ role: "user", content: "给我规划一条欧洲自驾路线避开收费路段" }] };
    const out = await onRequest(b, ctx(gw.url, { bypassAgents: ["t"], dryRun: false }));
    assert.equal(out, undefined);
    assert.equal(gw.seen.length, 0);
    // bypass-agent carries no orig text (consistent with other bypass reasons)
    assert.equal(findMine("bypass-agent").reason, "bypass-agent");
  } finally { gw.close(); }
});

// debugDump probe: optional wire-layer dump for triage; off by default,
// writes a header + inspected body when set.
test("tier: debugDump writes a body dump when enabled", async () => {
  const dump = new URL("../tmp-debugdump-test.log", import.meta.url).pathname;
  const { rmSync, existsSync, readFileSync: rdf } = await import("node:fs");
  rmSync(dump, { force: true });
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9, tpl: { choice: "basic", confidence: 0.9 } }, optimize: LONG });
  try {
    await onRequest(body1, ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: true, debugDump: dump }));
    assert.ok(existsSync(dump), "dump file created");
    const txt = rdf(dump, "utf8");
    assert.ok(txt.includes("=== "), "header line present");
    assert.ok(txt.includes("role: 'user'"), "body inspected");
  } finally { gw.close(); rmSync(dump, { force: true }); }
});
