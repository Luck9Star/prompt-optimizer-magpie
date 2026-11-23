// 0.2.8 T2: input too long for the guard window → skip before any model call.
// Ceiling = min(max(origUnits × guardRatioLimit, 60), 2000); floor = origUnits × 0.4.
// Empty window ⇔ floor > ceiling ⇔ origUnits > 5000 at the default ratio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../hooks.mjs";
import { reasonGroup } from "../lib/stats-page.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

const ctx = (url, opts) => ({ protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: url, deciderGroup: "", dryRun: false, maxChars: 100000, ...opts } });
const singleUser = (text) => ({ tools: [{}], messages: [{ role: "user", content: text }] });

test("T2: 6000 units → pass input-too-long, zero gateway calls", async () => {
  const gw = await mockGateway({ optimize: "答".repeat(2000) });
  try {
    const reports = [];
    const out = await onRequest(singleUser("词".repeat(6000)), { ...ctx(gw.url), report: (c) => reports.push(c) });
    assert.equal(out, undefined);
    assert.equal(gw.seen.length, 0, "no decider, no optimizer");
    assert.deepEqual(reports, ["skipped"]);
    assert.equal(reasonGroup("input-too-long"), "amber");
  } finally { gw.close(); }
});

test("T2: 200 units → optimizer runs and the rewrite is applied", async () => {
  const gw = await mockGateway({ optimize: "答".repeat(200) });
  try {
    // 200-unit orig → floor 80 units; the mock rewrite must clear it.
    const out = await onRequest(singleUser("词".repeat(200)), ctx(gw.url));
    assert.equal(out.messages[0].content, "答".repeat(200));
    assert.equal(gw.seen.length, 1, "one optimizer call");
  } finally { gw.close(); }
});

test("T2: boundary — 5000 units (floor 2000 = ceiling) still reaches the optimizer; 5001 is skipped", async () => {
  const gw = await mockGateway({ optimize: "答".repeat(2000) });
  try {
    await onRequest(singleUser("词".repeat(5000)), ctx(gw.url));
    assert.equal(gw.seen.length, 1, "floor == ceiling → window not empty → optimizer called");
    await onRequest(singleUser("词".repeat(5001)), ctx(gw.url));
    assert.equal(gw.seen.length, 1, "floor > ceiling → skipped, no extra call");
  } finally { gw.close(); }
});

test("T2: lower guardRatioLimit tightens the pre-check with the same formula", async () => {
  const gw = await mockGateway({ optimize: "答".repeat(2000) });
  try {
    // ratio 2 → ceiling 2000 for ≥1000 units; 6000 units floor 2400 > 2000 → skip
    // ratio 20 → same 2000 clamp, so the skip is identical (clamp dominates)
    await onRequest(singleUser("词".repeat(6000)), ctx(gw.url, { guardRatioLimit: 20 }));
    assert.equal(gw.seen.length, 0, "ceiling clamped at 2000 regardless of a larger ratio");
  } finally { gw.close(); }
});
