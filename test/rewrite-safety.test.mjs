import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onRequest } from '../hooks.mjs';
import { readRewrite, rewriteCacheKey, writeRewrite } from '../lib/rewrite-cache.mjs';
import { countUnits, preservesTokens, redact } from '../lib/rewrite-guard.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pom-rewrite-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, cacheFile: join(dir, 'cache'), statsDir: dir, dryRun: false, deciderGroup: '' };
}
const body = (content) => ({ tools: [{}], messages: [{ role: 'user', content }] });
const request = (text, options) => onRequest(body(text), { protocol: 'chat', options });
const completion = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

test('guard compares token multiplicity per category, tolerant of equivalent spelling', () => {
  const orig = 'Keep {{ name }}, `fieldId`, [REDACTED], {{ name }}';
  assert.equal(preservesTokens(orig, 'Use [REDACTED] for {{ name }} and {{name}} in `fieldId`.'), true);
  // backtick token: same content, wider fence (``x`` vs `x`) is equivalent
  assert.equal(preservesTokens('use `fieldId` here', 'use ``fieldId`` here'), true);
  for (const bad of [orig.replace('{{ name }}', ''), orig.replace('[REDACTED]', 'hidden'), orig + ' `otherField`']) {
    assert.equal(preservesTokens(orig, bad), false);
  }
});

test('countUnits: CJK chars, word runs, mixed and empty strings', () => {
  assert.equal(countUnits(''), 0);
  assert.equal(countUnits('帮我把这个模糊的需求改写'), 12);        // pure CJK: 1 unit/char
  assert.equal(countUnits('please fix this bug'), 4);            // words, punctuation/blank = 0
  assert.equal(countUnits('user_id v2.1 是标识符'), 7);          // user_id + v2 + 是标识符(4)
  // production incident 2026-11-22: 182-char CJK orig → 612-char rewrite, must pass
  const orig = '帮我把这个模糊的需求改写成一条结构清晰、可直接执行的中文提示词，包含任务目标、输出格式、约束条件和验收标准。'.repeat(2);
  const out = orig + '补充说明：首先梳理需求要点，其次给出分步执行计划，最后列出需要避免的常见坑与兜底方案，并按优先级排序所有待办事项以便逐项核对。'.repeat(2);
  const origUnits = countUnits(orig), outUnits = countUnits(orig + out);
  assert.ok(origUnits >= 90, `orig ≈ ${origUnits} units`);
  assert.ok(outUnits >= origUnits * 0.4 && outUnits < Math.min(Math.max(origUnits * 5, 60), 2000), 'rewrite sits inside the guard window');
});

test('model and cached candidates both fail open when protected tokens change', async (t) => {
  const o = setup(t);
  const orig = '请保留 `fieldId` 和 {{变量}} 的 [REDACTED]。';
  let answer = orig.replace('fieldId', 'fieldID');
  const fetch = t.mock.method(globalThis, 'fetch', async () => completion(answer));
  assert.equal(await request(orig, o), undefined);
  assert.equal(existsSync(o.cacheFile + '.d'), false);
  answer = '完整说明：' + orig;
  assert.equal((await request(orig, o)).messages[0].content, answer);
  const [entry] = readdirSync(o.cacheFile + '.d');
  writeFileSync(join(o.cacheFile + '.d', entry), answer.replace('{{变量}}', '{{变量二}}'));
  assert.equal(await request(orig, o), undefined);
  assert.equal(fetch.mock.callCount(), 2);
  answer = '[tpl:basic]\n' + orig.replace('[REDACTED]', '未知值');
  assert.equal(await request(orig, { ...o, optimizerMode: 'merged' }), undefined);
});

test('redact masks nested credentials and assignments while preserving the wire body', () => {
  const input = { keys: [{ 'X-Api-Key': 'test-A', sessionToken: 'test-B', Cookie: 'sid=test-C' }],
    max_tokens: 24, content: 'Authorization: Bearer test-D\npassword="test-E with space"; GH_TOKEN=test-F' };
  const clean = redact(input);
  assert.deepEqual(clean.keys, [{ 'X-Api-Key': '[REDACTED]', sessionToken: '[REDACTED]', Cookie: '[REDACTED]' }]);
  assert.equal(clean.content, 'Authorization: [REDACTED]\npassword="[REDACTED]"; GH_TOKEN=[REDACTED]');
  assert.equal(clean.max_tokens, 24);
  assert.equal(input.keys[0].sessionToken, 'test-B');
});

test('audit and debug files redact before clipping or inspecting the wire body', async (t) => {
  const o = setup(t);
  const dump = join(o.dir, 'dump.log');
  const orig = '请说明 password=demo-secret-before-clip 的处理流程';
  const content = '请按步骤说明 password=demo-secret-before-clip 的处理流程';
  t.mock.method(globalThis, 'fetch', async () => completion(content));
  const input = { ...body(orig), metadata: [{ apiKey: 'EXAMPLE-key' }] };
  const out = await onRequest(input, { protocol: 'chat', options: { ...o, logRewriteChars: 27, debugDump: dump } });
  assert.equal(out.messages[0].content, content);
  assert.equal(input.metadata[0].apiKey, 'EXAMPLE-key');
  const log = readFileSync(join(o.dir, readdirSync(o.dir).find((name) => name.endsWith('.ndjson'))), 'utf8');
  for (const stored of [log, readFileSync(dump, 'utf8')]) {
    assert.doesNotMatch(stored, /demo-sec|EXAMPLE/);
    assert.match(stored, /\[REDACTED\]/);
  }
});

test('interleaved misses persist both independent rewrites and replay without another call', async (t) => {
  const o = setup(t);
  const seen = [];
  const both = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', () => {
    const pending = Promise.withResolvers();
    seen.push(pending);
    if (seen.length === 2) both.resolve();
    assert.ok(seen.length <= 2, 'unexpected miss');
    return pending.promise;
  });
  const a = '请说明第一种配置的操作流程';
  const b = '请说明第二种配置的操作流程';
  const first = request(a, o), second = request(b, o);
  await both.promise;
  seen[1].resolve(completion('步骤乙：' + b));
  await second;
  seen[0].resolve(completion('步骤甲：' + a));
  await first;
  assert.equal((await request(a, o)).messages[0].content, '步骤甲：' + a);
  assert.equal((await request(b, o)).messages[0].content, '步骤乙：' + b);
  assert.equal(seen.length, 2);
});

test('cache isolates group, selected tier and merged mode for the same original', async (t) => {
  const o = { ...setup(t), deciderGroup: 'group/route-decider' };
  const orig = '请根据情况说明本次变更的操作流程';
  let tier = 'basic', calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.endsWith('/systemone')) {
      const answers = { noul: { choice: 'new_task', confidence: 1 }, tpl: { choice: tier, confidence: 1 } };
      return { ok: true, json: async () => ({ answers }) };
    }
    ++calls;
    return completion(calls === 4 ? '[passthrough]' : '补充说明：' + orig);
  });
  await request(orig, o);
  await request(orig, { ...o, optimizeGroup: 'group/alternate' });
  tier = 'planning';
  await request(orig, o);
  assert.equal(await request(orig, { ...o, optimizerMode: 'merged' }), undefined);
  assert.equal(calls, 4);
});

test('disabled TTL skips lookup, pruning and publication; legacy blobs do not supply rewrites', (t) => {
  const o = { ...setup(t), cacheTtlMs: 60000 };
  const key = rewriteCacheKey('a|b', 'c', o, 'merged', 'auto');
  assert.notEqual(key, rewriteCacheKey('a', 'b|c', o, 'merged', 'auto'));
  writeFileSync(o.cacheFile, JSON.stringify({ [key]: { ts: Date.now(), out: 'legacy' } }));
  assert.equal(readRewrite(o, key), undefined);
  writeRewrite(o, key, 'current');
  const dir = o.cacheFile + '.d';
  const [entry] = readdirSync(dir);
  const stale = key + '.1.2';
  writeFileSync(join(dir, stale), 'expired');
  for (const ttl of [0, -1]) {
    const disabled = { ...o, cacheTtlMs: ttl };
    assert.equal(readRewrite(disabled, key), undefined);
    writeRewrite(disabled, key, 'unexpected');
    assert.deepEqual(readdirSync(dir).sort(), [entry, stale].sort());
    assert.equal(readFileSync(join(dir, entry), 'utf8'), 'current');
  }
  assert.equal(readRewrite(o, key), 'current');
  assert.deepEqual(readdirSync(dir), [entry]);
});
