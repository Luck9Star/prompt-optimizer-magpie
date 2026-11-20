import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { onRequest } from "../hooks.mjs";

const FILE = fileURLToPath(new URL("../stats.ndjson", import.meta.url));

test("stats: events appended with required fields", async () => {
  const body = { tools: [{}], messages: [{ role: "user", content: "帮我把这个模糊的需求优化成具体的提示词描述" }] };
  await onRequest(body, { protocol: "chat", agent: "claude-code", kind: "", query: "", options: { gatewayUrl: "http://127.0.0.1:1", deciderGroup: "" } });
  assert.ok(existsSync(FILE), "stats.ndjson created next to plugin root");
  const ev = JSON.parse(readFileSync(FILE, "utf8").trim().split("\n").at(-1));
  for (const k of ["ts", "agent", "action", "reason", "durationMs", "inputChars", "outputChars", "dryRun"]) assert.ok(k in ev, `missing ${k}`);
  assert.equal(ev.agent, "claude-code");
  assert.equal(ev.action, "pass");
  assert.equal(ev.reason, "optimize-fail"); // dead gateway → fail open
  assert.equal(ev.dryRun, true);
});
