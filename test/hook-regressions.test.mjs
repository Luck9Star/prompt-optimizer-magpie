import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { onRequest } from "../hooks.mjs";
import { getTemplate } from "../templates/index.mjs";

const orig = "请帮我整理项目需求";
const rewritten = "请列出项目需求，并整理成三段说明。";
const body = { tools: [{}], messages: [{ role: "user", content: orig }] };
const completion = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

function context(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pom-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reports = [];
  return { reports, report: (...args) => reports.push(args), options: {
    optimizerMode: "merged", dryRun: false, statsDir: dir, cacheFile: join(dir, "cache"),
    gatewayUrl: "http://gateway.invalid", ...options,
  } };
}

test("fallback shares the cache and reports only the final body, including thread and dry-run", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(new URL(url).pathname);
    return url.endsWith("systemone") ? { ok: false } : completion(`[tpl:basic]\n${rewritten}`);
  });
  for (const dryRun of [false, true]) {
    const c = context(t, { optimizerMode: "auto", deciderFallback: "merged", dryRun });
    calls.length = 0;
    for (let i = 0; i < 2; i++) {
      const result = await onRequest(body, c);
      assert.equal(result?.messages[0].content, dryRun ? undefined : rewritten);
      assert.deepEqual(c.reports.splice(0), [dryRun ? ["skipped", 0] : ["ready", Buffer.byteLength(JSON.stringify(result))]]);
    }
    const thread = { ...body, messages: [{ role: "assistant", content: "刚才的回答" }, ...body.messages] };
    assert.equal(await onRequest(thread, c), undefined);
    assert.deepEqual(c.reports, [["skipped", 0]]);
    assert.deepEqual(calls, ["/v1/systemone", "/v1/chat/completions", "/v1/systemone", "/v1/systemone"]);
    const log = readFileSync(join(c.options.statsDir, new Date().toISOString().slice(0, 10) + ".ndjson"), "utf8");
    assert.deepEqual(log.trim().split("\n").map(s => JSON.parse(s).reason), [
      "decider-fail-merged", dryRun ? "dry-run" : "merged-optimized",
      "decider-fail-merged", "cache-hit", "decider-fail", "no-decider-followup",
    ]);
  }
});

test("Responses string input retains whitespace and other fields; continuation bypasses all models", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => completion(`[tpl:basic]\n${rewritten} $&`));
  const c = { ...context(t), protocol: "responses" };
  const request = { tools: [{}], model: "test", input: ` \t${orig}\n ` };
  const result = await onRequest(request, c);
  assert.deepEqual(result, { ...request, input: ` \t${rewritten} $&\n ` });
  assert.equal(request.input, ` \t${orig}\n `);
  for (const optimizerMode of ["auto", "merged"]) {
    c.options.optimizerMode = optimizerMode;
    assert.equal(await onRequest({ ...request, previous_response_id: "resp_123" }, c), undefined);
  }
  assert.equal(fetch.mock.callCount(), 1);
});

test("merged rejects malformed framing and accepts standalone passthrough with trailing whitespace", async t => {
  const c = context(t, { cacheTtlMs: 0 });
  let response;
  t.mock.method(globalThis, "fetch", async () => completion(response));
  const cases = [`\n[tpl:basic]\n${rewritten}`, ` [tpl:basic]\n${rewritten}`, `[TPL:basic]\n${rewritten}`,
    "[tpl:basic]", "[tpl:basic]\r\n  ", "[passthrough]\n正文", `[tpl:basic]\n${rewritten}\r\n [passthrough] \r\n`,
    `[tpl:basic]\n[tpl:professional]\n${rewritten}`, "[passthrough]\t\r\n"];
  for (const [i, value] of cases.entries()) {
    c.options.optimizeGroup = "protocol-" + i;
    response = value;
    assert.equal(await onRequest(body, c), undefined);
    assert.deepEqual(c.reports.splice(0), [[value === cases.at(-1) ? "skipped" : "unavailable", 0]]);
  }
});

test("an open breaker keeps its deadline and expired failures cannot open the new window", async t => {
  const c = context(t, { cacheTtlMs: 0 });
  let now = Date.now();
  const release = [];
  t.mock.method(Date, "now", () => now);
  const classic = [];
  t.mock.method(globalThis, "fetch", async (url, req) => {
    classic.push(JSON.parse(req.body).messages[0].content.startsWith(getTemplate("professional").system));
    if (classic.length === 1 || classic.length === 2) return new Promise(resolve => release.push(resolve));
    return completion("wrong protocol; sufficiently long as a classic reply");
  });
  const pending1 = onRequest(body, c), pending2 = onRequest(body, c);
  for (let i = 0; i < 5; i++) await onRequest(body, c);
  now += 500_000;
  release[0](completion("[tpl:basic]"));
  await pending1;
  await onRequest(body, c);
  assert.equal(classic.at(-1), true);
  await onRequest(body, { ...c, options: { ...c.options, optimizeGroup: "another-group" } });
  assert.equal(classic.at(-1), false);
  now += 100_000;
  await onRequest(body, c);
  assert.equal(classic.at(-1), false);
  release[1](completion("[tpl:basic]"));
  await pending2;
  for (let i = 0; i < 4; i++) {
    await onRequest(body, c);
    assert.equal(classic.at(-1), false);
  }
  await onRequest(body, c);
  assert.equal(classic.at(-1), true);
});

test("debugDump=true writes a redacted dump beside the installed hook", async t => {
  const c = context(t, { debugDump: true });
  for (const file of ["hooks.mjs", "lib", "templates"])
    cpSync(new URL("../" + file, import.meta.url), join(c.options.statsDir, file), { recursive: true });
  const { onRequest: installed } = await import(pathToFileURL(join(c.options.statsDir, "hooks.mjs")));
  await installed({ ...body, credentials: "synthetic-private-value", messages: [{ role: "user", content: "short" }] }, c);
  const dump = readFileSync(join(c.options.statsDir, "debug-dump.log"), "utf8");
  assert.match(dump, /\[REDACTED\]/);
  assert.doesNotMatch(dump, /synthetic-private-value/);
});
