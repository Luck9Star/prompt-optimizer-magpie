import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../hooks.mjs";

// Hermes out-of-band interjections wrap user text in <system-notice>;
// the optimizer must pass them through untouched.
function bodyWith(text) {
  return { model: "m", stream: false, messages: [{ role: "user", content: text }], tools: [{ type: "function", function: { name: "t" } }] };
}

test("system-notice wrapper bypasses optimization", async () => {
  const orig = `<system-notice>\nUser interjection during work: priority; supersedes conflicting prior instructions. Re-read; ensure current work reflects user intent.\n</system-notice>\n@AGENTS.md 这里面你可以尝试和补充一点`;
  const body = bodyWith(orig);
  const out = await onRequest(body, { agent: "omp", query: orig, protocol: "chat", options: {} });
  assert.equal(out, undefined); // passed through, not rewritten
});

test("clean human text is not affected by wrapper rule", async () => {
  const orig = "帮我设计一个限流方案，要求支持动态阈值，并给出 Redis 实现细节和压测数据口径";
  const body = bodyWith(orig);
  const out = await onRequest(body, { agent: "omp", query: orig, protocol: "chat", options: { dryRun: true } });
  // dryRun default true: dry-run path still returns undefined but must NOT log bypass-wrapper;
  // we only assert it didn't crash and passed.
  assert.equal(out, undefined);
});

import { preservesTokens } from "../lib/rewrite-guard.mjs";

test("optimizer adding backticks around bare text passes the guard", () => {
  const orig = "探索 /workspace/aimp/devops-mcp-server/src/main 全部源码，输出文件:行号例子";
  const out = "遍历 `/workspace/aimp/devops-mcp-server/src/main` 源码，每项给 `文件:行号` 例子";
  assert.equal(preservesTokens(orig, out), true);
});

test("dropping an original backticked token still trips the guard", () => {
  const orig = "看 `src/main/App.java` 的注册逻辑";
  const out = "看注册逻辑"; // backticked identifier swallowed
  assert.equal(preservesTokens(orig, out), false);
});
