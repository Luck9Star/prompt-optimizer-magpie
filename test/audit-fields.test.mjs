// 0.2.9 R3: additive ndjson audit fields. Every new field is only written
// when the caller supplies a value; strings are clamped to 200 chars in
// log(), deciderError/errorMsg to 120 at their call sites. Existing
// orig/rewritten clip(600) is untouched and record() is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { renderDetail, T } from "../lib/stats-page.mjs";
import { localDay } from "../lib/stats.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

const dir = mkdtempSync(join(tmpdir(), "pom-r3-"));
const dayFile = join(dir, localDay() + ".ndjson");
const events = () => { try { return readFileSync(dayFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action !== "summary"); } catch { return []; } };
const before = () => events().length;
const since = (n) => events().slice(n);

const singleUser = (text) => ({ model: "group/main", tools: [{}], messages: [{ role: "user", content: text }] });
const ctxWith = (url, opts) => ({ protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: url, cacheFile: join(dir, "cache.json"), statsDir: dir, ...opts } });
const PROMPT = "帮我继续完善这个限流方案的实现细节与测试覆盖";
const KEY = "sk-.../v1/systemone";

// ── decideVerdict / decideConfidence ────────────────────────────────────
test("R3: decide event records decideVerdict + decideConfidence", async () => {
  const gw = await mockGateway({ decider: { choice: "followup", confidence: 0.42 } });
  try {
    const n = before();
    const out = await onRequest(singleUser(PROMPT), ctxWith(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    assert.equal(out, undefined);
    const ev = since(n).find((e) => e.action === "decide" && e.reason === "followup");
    assert.ok(ev, "decide event recorded");
    assert.equal(ev.decideVerdict, "followup");
    assert.equal(ev.decideConfidence, 0.42);
  } finally { await gw.close(); }
});

test("R3: decideConfidence omitted when not finite", async () => {
  const gw = await mockGateway({ decider: { choice: "followup" } });
  try {
    const n = before();
    await onRequest(singleUser(PROMPT), ctxWith(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    const ev = since(n).find((e) => e.action === "decide" && e.reason === "followup");
    assert.ok(ev);
    assert.equal(ev.decideVerdict, "followup");
    assert.ok(!("decideConfidence" in ev), "must omit, never write 0");
  } finally { await gw.close(); }
});

test("R3: decideVerdict is the raw choice (unknown choice also logged)", async () => {
  const gw = await mockGateway({ decider: { choice: "something_else", confidence: 0.9 } });
  try {
    const n = before();
    await onRequest(singleUser(PROMPT), ctxWith(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    const ev = since(n).find((e) => e.action === "decide" && e.reason === "choice:something_else");
    assert.ok(ev);
    assert.equal(ev.decideVerdict, "something_else");
    assert.equal(ev.decideConfidence, 0.9);
  } finally { await gw.close(); }
});

test("R3: decider-fail records deciderError (redacted, <=120) + errorKind + status", async () => {
  // Invalid JSON whose SyntaxError message carries a key-like assignment.
  const gw = await mockGateway({ deciderRaw: `api_key=${KEY}` });
  try {
    const n = before();
    await onRequest(singleUser(PROMPT), ctxWith(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    const evs = since(n);
    const ev = evs.find((e) => e.reason?.startsWith("decider-fail"));
    assert.ok(ev, `decider-fail recorded: ${JSON.stringify(evs.map((e) => e.reason))}`);
    assert.ok(ev.deciderError, "deciderError present");
    assert.ok(!ev.deciderError.includes(KEY), "key-like string redacted");
    assert.ok(ev.deciderError.includes("[REDACTED]"), "redaction marker present");
    assert.ok(ev.deciderError.length <= 120, `clamped to 120: ${ev.deciderError.length}`);
    assert.equal(ev.errorKind, "SyntaxError");
  } finally { await gw.close(); }
});

test("R3: decider-fail with HTTP status records deciderHttpStatus", async () => {
  const gw = await mockGateway({ deciderStatus: 503 });
  try {
    const n = before();
    await onRequest(singleUser(PROMPT), ctxWith(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    const ev = since(n).find((e) => e.reason?.startsWith("decider-fail"));
    assert.ok(ev);
    assert.equal(ev.deciderHttpStatus, 503);
    assert.equal(ev.errorKind, "Error");
    assert.equal(ev.deciderError, "gateway 503");
  } finally { await gw.close(); }
});

// ── bypassPrefixHit ─────────────────────────────────────────────────────
test("R3: bypass-prefix records the actual matched prefix", async () => {
  const n = before();
  const out = await onRequest(singleUser("## 帮我重写这段提示词"), ctxWith("http://127.0.0.1:1", { bypassPrefix: ["!!", "##"] }));
  assert.equal(out, undefined);
  const ev = since(n).find((e) => e.reason === "bypass-prefix");
  assert.ok(ev, "bypass-prefix recorded");
  assert.equal(ev.bypassPrefixHit, "##");
});

test("R3: bypass-prefix on ctx.query path also records hit", async () => {
  const n = before();
  const out = await onRequest(singleUser("normal text"), { ...ctxWith("http://127.0.0.1:1", {}), query: "!! something" });
  assert.equal(out, undefined);
  const ev = since(n).find((e) => e.reason === "bypass-prefix");
  assert.equal(ev.bypassPrefixHit, "!!");
});

// ── errorKind on *fail / optimize-empty / error ─────────────────────────
test("R3: optimize-fail records errorKind + httpStatus", async () => {
  const gw = await mockGateway({ failOptimize: { status: 500, message: "boom" } });
  try {
    const n = before();
    await onRequest(singleUser(PROMPT), ctxWith(gw.url, { optimizerMode: "rule", deciderGroup: "", dryRun: false }));
    const evs = since(n);
    const ev = evs.find((e) => e.reason === "optimize-fail");
    assert.ok(ev, `optimize-fail recorded: ${JSON.stringify(evs.map((e) => e.reason))}`);
    assert.equal(ev.errorKind, "Error");
    assert.equal(ev.httpStatus, 500);
  } finally { await gw.close(); }
});

test("R3: optimize-empty carries no errorKind (an empty result is not an exception)", async () => {
  const gw = await mockGateway({ optimize: "" });
  try {
    const n = before();
    await onRequest(singleUser(PROMPT), ctxWith(gw.url, { optimizerMode: "rule", deciderGroup: "", dryRun: false }));
    const evs = since(n);
    const ev = evs.find((e) => e.reason === "optimize-empty");
    assert.ok(ev, `optimize-empty recorded: ${JSON.stringify(evs.map((e) => e.reason))}`);
    assert.ok(!("errorKind" in ev), "no fabricated errorKind");
  } finally { await gw.close(); }
});

test("R3: the summary carries the accepted decision's verdict and confidence", async () => {
  const gw = await mockGateway({ optimize: "一段足够长的、用于断言的优化后提示词替换文本" });
  try {
    const n = before();
    await onRequest(singleUser(PROMPT), ctxWith(gw.url, { deciderGroup: "group/route-decider", dryRun: false, logOptimizes: false, logSkips: false }));
    const all = readFileSync(dayFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const s = all.filter((e) => e.action === "summary").pop();
    assert.ok(s, "summary recorded");
    assert.equal(s.decideVerdict, "new_task");
    assert.equal(s.decideConfidence, 0.9, "mock default confidence");
    assert.ok(!all.slice(n).some((e) => e.action === "decide"), "accepted decisions emit no decide event");
  } finally { await gw.close(); }
});

test("R3: merged-fail records errorKind + httpStatus from error.status", async () => {
  const gw = await mockGateway({ failMerged: { status: 502, message: "bad merged" } });
  try {
    const n = before();
    await onRequest(singleUser(PROMPT), ctxWith(gw.url, { optimizerMode: "merged", dryRun: false }));
    const evs = since(n);
    const ev = evs.find((e) => e.reason === "merged-fail");
    assert.ok(ev, `merged-fail recorded: ${JSON.stringify(evs.map((e) => e.reason))}`);
    assert.equal(ev.errorKind, "Error");
    assert.equal(ev.httpStatus, 502);
  } finally { await gw.close(); }
});

test("R3: outer catch records errorKind + errorMsg (redacted, 120 chars, clamped 200)", async () => {
  const body = { model: "group/main", tools: [{}], messages: [{ role: "user", content: "x" }] };
  Object.defineProperty(body, "messages", {
    get() { throw new TypeError(`fatal api_key=${KEY} ${"Z".repeat(400)}`); },
  });
  const n = before();
  const out = await onRequest(body, ctxWith("http://127.0.0.1:1", {}));
  assert.equal(out, undefined, "fail-open");
  const ev = since(n).find((e) => e.reason === "error");
  assert.ok(ev, `error event recorded: ${JSON.stringify(since(n).map((e) => e.reason))}`);
  assert.equal(ev.errorKind, "TypeError");
  assert.ok(ev.errorMsg, "errorMsg present");
  assert.ok(!ev.errorMsg.includes(KEY), "key-like string redacted from errorMsg");
  assert.ok(ev.errorMsg.length <= 120, `errorMsg clamped to 120: ${ev.errorMsg.length}`);
  assert.ok(ev.errorMsg.length <= 200, "global 200 clamp");
});

test("R3: every new string field clamped to 200 chars", async () => {
  // A very long bypass prefix is the only caller-controlled new string field
  // that can exceed 200; it must be clamped in log(), not written whole.
  const long = "P".repeat(400);
  const n = before();
  await onRequest(singleUser(`${long} hello`), ctxWith("http://127.0.0.1:1", { bypassPrefix: [long] }));
  const ev = since(n).find((e) => e.reason === "bypass-prefix");
  assert.ok(ev);
  assert.equal(ev.bypassPrefixHit.length, 200);
});

// ── orig clip(600) regression ───────────────────────────────────────────
test("R3: existing orig/rewritten clip(600) behavior unchanged", async () => {
  const gw = await mockGateway();
  try {
    const n = before();
    await onRequest(singleUser("请帮我".repeat(300)), ctxWith(gw.url, { optimizerMode: "rule", deciderGroup: "", dryRun: false }));
    const ev = since(n).find((e) => e.orig);
    assert.ok(ev, "orig logged");
    assert.ok(ev.orig.length > 600 && ev.orig.length < 700, `clip uses 600 + suffix: ${ev.orig.length}`);
    assert.ok(ev.orig.includes("chars"), "suffix preserved");
  } finally { await gw.close(); }
});

test("R3: custom logRewriteChars still honored", async () => {
  const gw = await mockGateway();
  try {
    const n = before();
    await onRequest(singleUser("请帮我".repeat(100)), ctxWith(gw.url, { optimizerMode: "rule", deciderGroup: "", dryRun: false, logRewriteChars: 50 }));
    const ev = since(n).find((e) => e.orig);
    assert.ok(ev.orig.includes("+"), "custom clip suffix");
    assert.ok(ev.orig.length < 100, `custom clip: ${ev.orig.length}`);
  } finally { await gw.close(); }
});

// ── stats-page detail rendering ─────────────────────────────────────────
const NEW_FIELDS = ["decideVerdict", "decideConfidence", "deciderError", "errorKind", "errorMsg", "bypassPrefixHit", "httpStatus", "deciderHttpStatus"];

test("R3: new field bilingual labels exist", () => {
  for (const f of NEW_FIELDS) {
    assert.ok(T[`d_${f}`], `label for ${f}`);
    assert.equal(T[`d_${f}`].length, 2, `bilingual ${f}`);
  }
});

test("R3: renderDetail shows new fields with bilingual labels, HTML-escaped", () => {
  const ev = {
    ts: Date.now(), action: "pass", reason: "bypass-prefix",
    decideVerdict: "followup", decideConfidence: 0.9,
    deciderError: "boom <script>alert(1)</script>", errorKind: "TypeError",
    errorMsg: "fatal & <b>", bypassPrefixHit: "##", httpStatus: 503,
    deciderHttpStatus: 502,
  };
  const html = renderDetail(ev, { lang: "en" });
  for (const f of ["followup", "0.9", "TypeError", "##", "503", "502"]) {
    assert.ok(html.includes(f), `shows ${f}`);
  }
  for (const f of NEW_FIELDS.filter((f) => ev[f] !== undefined)) {
    assert.ok(html.includes(T[`d_${f}`][1]), `English label for ${f}`);
  }
  assert.ok(!html.includes("<script>"), "HTML escaped");
  assert.ok(html.includes("&#60;script&#62;"), "escaped to numeric entity");
});

test("R3: renderDetail omits absent new fields entirely", () => {
  const html = renderDetail({ ts: Date.now(), action: "pass", reason: "short-text" }, { lang: "en" });
  for (const f of NEW_FIELDS) {
    assert.ok(!html.includes(T[`d_${f}`][1]), `no label for absent ${f}`);
  }
});
