// 0.2.9 R2: bypassWrappers matching is leading-only and understands open
// tags with attributes. DEFAULTS keeps the plain "<tag>" strings; the
// matcher converts them to ^<tag(?:\s[^>]*)?>. Non-tag literals keep
// startsWith. Closing tags, second-line tags and mid-body mentions must not
// match (a human quoting <job> is not a machine wrapper).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { localDay } from "../lib/stats.mjs";

function bodyWith(text) {
  return { model: "m", stream: false, messages: [{ role: "user", content: text }], tools: [{ type: "function", function: { name: "t" } }] };
}

// "control" → direct mode, returns immediately with experiment-control:
// no gateway call, so a "must NOT bypass" assertion can inspect reasons fast.
async function reasons(text, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pom-r2-"));
  await onRequest(bodyWith(text), {
    agent: "t", query: text, protocol: "chat",
    options: { dryRun: false, statsDir: dir, cacheFile: join(dir, "cache.json"), optimizerMode: "control", ...extra },
  });
  let events = [];
  try { events = readFileSync(join(dir, localDay() + ".ndjson"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action !== "summary"); } catch {}
  return events.map((e) => e.reason);
}

async function bypasses(text, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pom-r2-"));
  const out = await onRequest(bodyWith(text), {
    agent: "t", query: text, protocol: "chat",
    options: { dryRun: false, statsDir: dir, cacheFile: join(dir, "cache.json"), ...extra },
  });
  assert.equal(out, undefined);
  const evs = readFileSync(join(dir, localDay() + ".ndjson"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action !== "summary");
  assert.ok(evs.some((e) => e.reason === "bypass-wrapper"), `reason: ${JSON.stringify(evs.map((e) => e.reason))}`);
}

test("R2: open tag with attributes hits", async () => {
  await bypasses(`<system-notice id="prelude-guide" data-kind="oob">\nRe-read the tool guidance now.`);
});

test("R2: open tag with single attribute hits", async () => {
  await bypasses(`<job status="done">\nSession UI request, not from the user.`);
});

test("R2: bare open tag still hits", async () => {
  await bypasses(`<system-notice>\nUser interjection during work.`);
});

test("R2: all 5 default wrappers hit", async () => {
  for (const w of ["<system-notice>", "<title-request>", "<progress-check>", "<job>", "<recap>"]) {
    await bypasses(`${w}\nProtocol text the rewrite must not touch.`);
  }
});

test("R2: leading noise (ACP + Replying to) then wrapper hits", async () => {
  const text = `<acp tokens="1.2K" type="text" time="2026-11-23 10:00:00">m00001</acp>
[Replying to: "prior"]
<system-notice id="x">\nProtocol text.`;
  await bypasses(text);
});

test("R2: closing tag at start does NOT bypass", async () => {
  const rs = await reasons(`</job>\nNow summarize the session for me.`);
  assert.ok(!rs.includes("bypass-wrapper"), `reasons: ${rs}`);
});

test("R2: wrapper on second line does NOT bypass", async () => {
  const rs = await reasons(`Here is my real question about the code.\n<job>job done notification</job>`);
  assert.ok(!rs.includes("bypass-wrapper"), `reasons: ${rs}`);
});

test("R2: wrapper mentioned mid-body does NOT bypass", async () => {
  const rs = await reasons(`请检查 <job> 标签的处理逻辑，看看是否有边界问题。`);
  assert.ok(!rs.includes("bypass-wrapper"), `reasons: ${rs}`);
});

test("R2: wrapper as trailing text does NOT bypass", async () => {
  const rs = await reasons(`请检查标签处理逻辑是否有边界问题 <recap>`);
  assert.ok(!rs.includes("bypass-wrapper"), `reasons: ${rs}`);
});

test("R2: custom non-tag literal wrapper still hits", async () => {
  await bypasses(`MACHINE_PREFIX: session recap not from user.`, { bypassWrappers: ["MACHINE_PREFIX:"] });
});

test("R2: custom literal mid-body does NOT bypass", async () => {
  const rs = await reasons(`Please explain MACHINE_PREFIX: handling.`, { bypassWrappers: ["MACHINE_PREFIX:"] });
  assert.ok(!rs.includes("bypass-wrapper"), `reasons: ${rs}`);
});

test("R2: DEFAULTS bypassWrappers array unchanged (5 plain tags)", async () => {
  // An explicit plain-tag config must behave exactly like the default.
  await bypasses(`<recap>\nSession recap.`, { bypassWrappers: ["<system-notice>", "<title-request>", "<progress-check>", "<job>", "<recap>"] });
});
