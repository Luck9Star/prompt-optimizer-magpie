// 0.2.8 T4: ctx.signal aborted (host cancelled the hook) is not a gateway
// failure: an aborted request passes through ("skipped"), reports no *-fail
// reason, never counts toward the breaker and never says "unavailable".
// Since 0.2.9 R5 an abort additionally checks the timeout budget: with the
// default 1500/15000 timeouts and gatewayTimeoutMs undeclared (host default
// 1 s) the reason is budget-short, so the abort tests below declare 25000.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { reasonGroup } from "../lib/stats-page.mjs";
import { localDay } from "../lib/stats.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

const dir = mkdtempSync(join(tmpdir(), "pom-abort-"));
const dayFile = join(dir, localDay() + ".ndjson");
const events = () => { try { return readFileSync(dayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action !== "summary"); } catch { return []; } };
const REWRITE = "这是按照专业模板改写后的完整中文提示词内容，长度足够通过护栏检查要求。";
const MERGED = `[tpl:professional]\n${REWRITE}`;
const singleUser = (text) => ({ tools: [{}], messages: [{ role: "user", content: text }] });
const ctxWith = (url, signal, opts) => ({ protocol: "chat", agent: "t", kind: "", query: "", signal, options: { gatewayTimeoutMs: 25000, gatewayUrl: url, cacheFile: join(dir, "cache.json"), statsDir: dir, ...opts } });

// Hang the gateway so the request is in flight when the host aborts.
async function abortDuring(gw, body, opts, afterMs = 30) {
  const ac = new AbortController();
  const reports = [];
  const p = onRequest(body, { ...ctxWith(gw.url, ac.signal, opts), report: (c) => reports.push(c) });
  setTimeout(() => ac.abort(), afterMs);
  const out = await p;
  return { out, reports };
}

test("T4: auto path — abort during the decider call → host-abort, skipped, no decider-fail-rule", async () => {
  const gw = await mockGateway({ hang: ["/v1/systemone"] });
  try {
    const { out, reports } = await abortDuring(gw, singleUser("帮我把这个模糊的需求优化成具体的提示词描述"), { deciderGroup: "group/route-decider", dryRun: false, gatewayTimeoutMs: 25000 });
    assert.equal(out, undefined);
    assert.equal(reasonGroup("host-abort"), "amber");
    const evs = events();
    assert.ok(evs.some((e) => e.reason === "host-abort"), "host-abort recorded");
    assert.ok(!evs.some((e) => /-fail|optimize-empty|^error$/.test(e.reason)), `no failure reasons: ${JSON.stringify(evs.map((e) => e.reason))}`);
    assert.deepEqual(reports, ["skipped"]);
  } finally { gw.close(); }
});

test("T4: auto path — abort during the optimizer call → host-abort, no optimize-fail", async () => {
  const gw = await mockGateway({ hang: ["/v1/chat/completions"] });
  try {
    const { out, reports } = await abortDuring(gw, singleUser("帮我把这个模糊的需求优化成具体的提示词描述"), { deciderGroup: "group/route-decider", dryRun: false, gatewayTimeoutMs: 25000 });
    assert.equal(out, undefined);
    const evs = events();
    assert.ok(evs.some((e) => e.reason === "host-abort"));
    assert.ok(!evs.some((e) => e.reason === "optimize-fail"));
    assert.deepEqual(reports, ["skipped"]);
  } finally { gw.close(); }
});

test("T4: already-aborted signal at entry → host-abort, zero gateway calls", async () => {
  const gw = await mockGateway({ optimize: REWRITE });
  try {
    const ac = new AbortController();
    ac.abort();
    const out = await onRequest(singleUser("帮我把这个模糊的需求优化成具体的提示词描述"), ctxWith(gw.url, ac.signal, { dryRun: false }));
    assert.equal(out, undefined);
    assert.equal(gw.seen.length, 0);
    assert.equal(events().at(-1)?.reason, "host-abort");
  } finally { gw.close(); }
});

test("T4: merged — 5 consecutive aborts do not trip the breaker; the 6th healthy request optimizes", async () => {
  const hanging = await mockGateway({ hang: ["/v1/chat/completions"] });
  try {
    for (let i = 0; i < 5; i++) {
      const { out, reports } = await abortDuring(hanging, singleUser("帮我把这个模糊的需求优化成具体的提示词描述"), { optimizerMode: "merged", dryRun: false });
      assert.equal(out, undefined);
      assert.deepEqual(reports, ["skipped"], `abort ${i + 1}`);
    }
  } finally { hanging.close(); }
  const ok = await mockGateway({ optimize: MERGED });
  try {
    const out = await onRequest(singleUser("帮我把这个模糊的需求优化成具体的提示词描述"), ctxWith(ok.url, undefined, { optimizerMode: "merged", dryRun: false }));
    assert.equal(out?.messages?.[0].content, REWRITE, "6th request is optimized, not merged-circuit-open");
    // the day file is shared with the two auto-path abort tests above (+3)
    const evs = events();
    assert.ok(evs.filter((e) => e.reason === "host-abort").length >= 5);
    assert.ok(!evs.some((e) => e.reason === "merged-fail" || e.reason === "merged-circuit-open"), evs.map((e) => e.reason).join(","));
  } finally { ok.close(); }
});

test("T4: a real network error is still merged-fail and still counts toward the breaker", async () => {
  // Nothing listens on this port: ECONNREFUSED, not an abort.
  const url = "http://127.0.0.1:1";
  const out = await onRequest(singleUser("帮我把这个模糊的需求优化成具体的提示词描述"), ctxWith(url, undefined, { optimizerMode: "merged", dryRun: false }));
  assert.equal(out, undefined);
  const ev = events().find((e) => e.reason === "merged-fail");
  assert.ok(ev, "merged-fail recorded for a genuine network failure");
});
