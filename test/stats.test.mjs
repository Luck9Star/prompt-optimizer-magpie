import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { onRequest } from "../hooks.mjs";

const FILE = fileURLToPath(new URL("../stats.ndjson", import.meta.url));

test("stats: events appended with required fields", async () => {
  const body = { tools: [{}], messages: [{ role: "user", content: "帮我把这个模糊的需求优化成具体的提示词描述丁" }] };
  await onRequest(body, { protocol: "chat", agent: "claude-code", kind: "", query: "", options: { gatewayUrl: "http://127.0.0.1:1", deciderGroup: "" } });
  assert.ok(existsSync(FILE), "stats.ndjson created next to plugin root");
  // parallel files append to one stats.ndjson — poll for OUR unique line
  let ev;
  for (let i = 0; i < 40 && !ev; i++) {
    const rows = readFileSync(FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ev = rows.reverse().find((r) => r.agent === "claude-code" && r.reason === "optimize-fail" && r.inputChars === "帮我把这个模糊的需求优化成具体的提示词描述丁".length);
    if (!ev) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (!ev) throw new Error("stats line not found for stats fixture");
  for (const k of ["ts", "agent", "action", "reason", "durationMs", "inputChars", "outputChars", "dryRun"]) assert.ok(k in ev, `missing ${k}`);
  assert.equal(ev.agent, "claude-code");
  assert.equal(ev.action, "pass");
  assert.equal(ev.reason, "optimize-fail"); // dead gateway → fail open
  assert.equal(ev.dryRun, true);
});
