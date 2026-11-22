// Token-normalized output guard (.omp-guard-brief.md): length bounds are
// countUnits-based (CJK char = 1, word run = 1), split reasons, tolerant
// token compare. Guard trips are always pass-through (fail-safe).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { reasonGroup } from "../lib/stats-page.mjs";
import { readEvents } from "../lib/stats.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

const dir = mkdtempSync(join(tmpdir(), "pom-guard-"));
const ctx = (url, opts) => ({ protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: url, deciderGroup: "", dryRun: false, statsDir: dir, ...opts } });
const singleUser = (text) => ({ tools: [{}], messages: [{ role: "user", content: text }] });

test("guard: 0.3x units → output-guard-short, original passes through", async () => {
  const orig = "词".repeat(100);
  const gw = await mockGateway({ optimize: "词".repeat(30) });
  try {
    assert.equal(await onRequest(singleUser(orig), ctx(gw.url)), undefined);
    const ev = readEvents(dir).filter((e) => e.reason === "output-guard-short").at(-1);
    assert.ok(ev, "guard event recorded");
    assert.equal(ev.reason, "output-guard-short");
  } finally { gw.close(); }
});

test("guard: 6x units on a long orig → output-guard-long", async () => {
  const orig = "词".repeat(400); // 400 units → ceiling clamp(2000, 60, 2000) = 2000
  const gw = await mockGateway({ optimize: "词".repeat(2400) });
  try {
    assert.equal(await onRequest(singleUser(orig), ctx(gw.url)), undefined);
    assert.equal(readEvents(dir).at(-1).reason, "output-guard-long");
  } finally { gw.close(); }
});

test("guard: 3x units inside the window → rewrite applied", async () => {
  const out = "词".repeat(300); // 100-unit orig, 300 units < clamp(500, 60, 2000)
  const gw = await mockGateway({ optimize: out });
  try {
    const res = await onRequest(singleUser("词".repeat(100)), ctx(gw.url));
    assert.equal(res.messages[0].content, out);
    assert.equal(readEvents(dir).at(-1).reason, "optimized");
  } finally { gw.close(); }
});

test("guard: token loss inside the length window → output-guard-tokens", async () => {
  const orig = "请保留字段 {{name}} 并详细说明它的用途"; // 20 units
  const out = "请保留占位符并详细说明它的用途，同时补充更多关于用法与边界的细节说明。"; // no {{name}}
  const gw = await mockGateway({ optimize: out });
  try {
    assert.equal(await onRequest(singleUser(orig), ctx(gw.url)), undefined);
    const ev = readEvents(dir).at(-1);
    assert.equal(ev.reason, "output-guard-tokens");
  } finally { gw.close(); }
});

test("guard: stats-page maps the three split reasons to red, legacy output-guard stays red", () => {
  for (const r of ["output-guard", "output-guard-short", "output-guard-long", "output-guard-tokens"]) {
    assert.equal(reasonGroup(r), "red", r);
  }
});

test("teardown", () => rmSync(dir, { recursive: true, force: true }));
