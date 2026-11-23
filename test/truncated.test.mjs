// 0.2.8 T1: finish_reason=length must never reach the request body, and
// gateway HTTP status must land on the fail events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { localDay } from "../lib/stats.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

const dir = mkdtempSync(join(tmpdir(), "pom-trunc-"));
const ctx = (url, opts) => ({ protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: url, cacheFile: join(dir, "cache.json"), statsDir: dir, ...opts } });
const body = () => ({ tools: [{}], messages: [{ role: "user", content: "帮我把这个模糊的需求优化成具体的提示词描述" }] });
const REWRITE = "这是按照专业模板改写后的完整中文提示词内容，长度足够通过护栏检查要求。";
const dayFile = join(dir, localDay() + ".ndjson");
const events = () => { try { return readFileSync(dayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

test("T1 truncated: auto path, finish_reason=length → pass optimize-truncated, body untouched, report skipped", async () => {
  const gw = await mockGateway({ optimize: REWRITE.slice(0, 8), finishReason: "length" });
  try {
    const reports = [];
    const out = await onRequest(body(), { ...ctx(gw.url, { dryRun: false }), report: (c, n) => reports.push([c, n]) });
    assert.equal(out, undefined, "half a rewrite is never applied");
    const ev = events().find((e) => e.reason === "optimize-truncated");
    assert.ok(ev, "optimize-truncated recorded");
    assert.equal(ev.action, "pass");
    assert.deepEqual(reports.at(-1), ["skipped", 0]);
  } finally { gw.close(); }
});

test("T1 truncated: merged path, finish_reason=length → pass merged-truncated, breaker untouched", async () => {
  const gw = await mockGateway({ optimize: "[tpl:professional]\n" + REWRITE.slice(0, 8), finishReason: "length" });
  try {
    const out = await onRequest(body(), ctx(gw.url, { optimizerMode: "merged", dryRun: false }));
    assert.equal(out, undefined);
    const ev = events().find((e) => e.reason === "merged-truncated");
    assert.ok(ev, "merged-truncated recorded");
    assert.equal(ev.action, "pass");
    assert.ok(!events().some((e) => e.reason === "merged-fail"), "truncation is not a merged-fail");
  } finally { gw.close(); }
});

test("T1 truncated: missing finish_reason → treated as normal (old gateways)", async () => {
  const gw = await mockGateway({ optimize: REWRITE });
  try {
    const out = await onRequest(body(), ctx(gw.url, { dryRun: false }));
    assert.equal(out.messages[0].content, REWRITE, "rewrite applied as before");
  } finally { gw.close(); }
});

test("T1 truncated: finish_reason=stop → applied", async () => {
  const gw = await mockGateway({ optimize: REWRITE, finishReason: "stop" });
  try {
    const out = await onRequest(body(), ctx(gw.url, { dryRun: false }));
    assert.equal(out.messages[0].content, REWRITE);
  } finally { gw.close(); }
});

test("T1 httpStatus: optimizer 500 → optimize-fail carries httpStatus=500", async () => {
  const gw = await mockGateway({ optimizeStatus: 500 });
  try {
    const reports = [];
    const out = await onRequest(body(), { ...ctx(gw.url, { dryRun: false }), report: (c, n) => reports.push([c, n]) });
    assert.equal(out, undefined);
    const ev = events().find((e) => e.reason === "optimize-fail" && e.httpStatus === 500);
    assert.ok(ev, "optimize-fail with httpStatus recorded");
    assert.deepEqual(reports.at(-1), ["unavailable", 0]);
  } finally { gw.close(); }
});

test("T1 httpStatus: decider 500 → decider-fail-rule carries deciderHttpStatus=500", async () => {
  const gw = await mockGateway({ deciderStatus: 500, optimize: REWRITE });
  try {
    const out = await onRequest(body(), ctx(gw.url, { dryRun: false }));
    assert.ok(out, "rules fallback still optimizes");
    const ev = events().find((e) => e.reason === "decider-fail-rule" && e.deciderHttpStatus === 500);
    assert.ok(ev, "decider-fail-rule with deciderHttpStatus recorded");
  } finally { gw.close(); }
});

test("teardown", () => rmSync(dir, { recursive: true, force: true }));
