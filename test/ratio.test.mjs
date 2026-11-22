// guardRatioLimit (default x10, configurable) + inputUnits/outputUnits in
// recorded events (.omp-ratio-brief.md). Old output-guard tests asserted
// the x5 ceiling; those expectations move here under the new default and
// an explicit override.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { readEvents } from "../lib/stats.mjs";
import { countUnits } from "../lib/rewrite-guard.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

const dir = mkdtempSync(join(tmpdir(), "pom-ratio-"));
const ctx = (url, opts) => ({ protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: url, deciderGroup: "", dryRun: false, statsDir: dir, ...opts } });
const singleUser = (text) => ({ tools: [{}], messages: [{ role: "user", content: text }] });

test("ratio: default x10 — 8x units passes where x5 tripped", async () => {
  const orig = "词".repeat(100); // 100 units; ceiling clamp(100×10, 60, 2000) = 1000
  const out = "词".repeat(800);
  const gw = await mockGateway({ optimize: out });
  try {
    const res = await onRequest(singleUser(orig), ctx(gw.url));
    assert.equal(res.messages[0].content, out);
    assert.equal(readEvents(dir).at(-1).reason, "optimized");
  } finally { gw.close(); }
});

test("ratio: guardRatioLimit=3 — 8x units trips output-guard-long", async () => {
  const orig = "词".repeat(100); // ceiling clamp(100×3, 60, 2000) = 300
  const gw = await mockGateway({ optimize: "词".repeat(800) });
  try {
    assert.equal(await onRequest(singleUser(orig), ctx(gw.url, { guardRatioLimit: 3 })), undefined);
    assert.equal(readEvents(dir).at(-1).reason, "output-guard-long");
  } finally { gw.close(); }
});

test("ratio: 2000-unit hard cap still applies regardless of ratio", async () => {
  const orig = "词".repeat(400); // 400×10 = 4000 → clamped to 2000
  const gw = await mockGateway({ optimize: "词".repeat(2400) });
  try {
    assert.equal(await onRequest(singleUser(orig), ctx(gw.url)), undefined);
    assert.equal(readEvents(dir).at(-1).reason, "output-guard-long");
  } finally { gw.close(); }
});

test("ratio: events carry inputUnits/outputUnits matching countUnits", async () => {
  const orig = "帮我把这个模糊的需求改写成具体提示词";
  const out = "词".repeat(60);
  const gw = await mockGateway({ optimize: out });
  try {
    await onRequest(singleUser(orig), ctx(gw.url));
    const ev = readEvents(dir).filter((e) => e.action === "optimize").at(-1);
    assert.ok(ev, "optimize event recorded");
    assert.equal(ev.inputUnits, countUnits(orig));
    assert.equal(ev.outputUnits, countUnits(out));
    assert.equal(typeof ev.inputChars, "number"); // legacy chars kept
  } finally { gw.close(); }
});

test("ratio: pass events carry inputUnits too", async () => {
  await onRequest(singleUser("短"), ctx("http://127.0.0.1:1", { logSkips: true })); // short-text
  const ev = readEvents(dir).filter((e) => e.reason === "short-text").at(-1);
  assert.ok(ev, "short-text event recorded");
  assert.equal(ev.inputUnits, countUnits("短"));
});

test("teardown", () => rmSync(dir, { recursive: true, force: true }));
