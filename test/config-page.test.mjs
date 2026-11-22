// .omp-config-brief.md — config sub-page + atomic plugins.json writeback.
// Uses the same request() harness style as stats-service.test.mjs but with a
// real listening server (POST needs the evented body path).
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { makeStatsServer } from "../lib/stats-service.mjs";
import { CONFIG_FIELDS, parseConfigForm, writeConfig, readPluginsJson } from "../lib/config-store.mjs";

const mkPlugins = (opts) => {
  const dir = mkdtempSync(join(tmpdir(), "pom-cfg-"));
  const file = join(dir, "plugins.json");
  writeFileSync(file, JSON.stringify({
    plugins: [
      { spec: "/root/some-other-plugin", options: { keepMe: true } },
      { spec: "/root/prompt-optimizer-magpie", options: { ...opts } },
    ],
  }, null, 2));
  return { dir, file };
};

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
function http(server, { method = "GET", path = "/", body = null }) {
  const addr = server.address();
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: addr.port, method, path, headers: body ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {} }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("config 1: GET — configPage off → 404 notice; on → whitelist fields prefilled", async () => {
  const { dir, file } = mkPlugins({ minChars: 12, enabled: false });
  const off = makeStatsServer({ statsDir: dir, pluginsFile: file });
  await listen(off);
  const r0 = await http(off, { path: "/?page=config" });
  assert.match(r0.body, /配置页未开放/);
  off.close();


  const on = makeStatsServer({ statsDir: dir, pluginsFile: file, options: { configPage: true } });
  await listen(on);
  const r1 = await http(on, { path: "/?page=config" });
  assert.equal(r1.status, 200);
  for (const f of CONFIG_FIELDS) assert.ok(r1.body.includes(`name="${f.key}"`), f.key);
  assert.match(r1.body, /name="minChars" value="12"/);       // 现值预填
  assert.match(r1.body, /name="enabled"/);                    // bool checkbox
  assert.match(r1.body, /name="maxChars" value="12000"/);     // DEFAULTS 值
  assert.match(r1.body, /默认/);                              // 默认标注
  assert.match(r1.body, /<form method="POST" action="\?page=config">/);
  // 白名单外字段不出现
  assert.ok(!r1.body.includes('name="gatewayUrl"'));
  on.close();
  rmSync(dir, { recursive: true, force: true });
});

test("config 2: POST valid → atomic update (whitelist keys changed, foreign kept, indent 2) + 302", async () => {
  const { dir, file } = mkPlugins({ minChars: 6, gatewayUrl: "http://x", custom: 42 });
  const srv = await listen(makeStatsServer({ statsDir: dir, pluginsFile: file, options: { configPage: true } }));
  const body = "enabled=on&dryRun=&optimizerMode=merged&minChars=33&maxChars=9000&logSkips=on&logOptimizes=&deciderGroup=group%2Fd&optimizeGroup=group%2Fo&deciderTimeoutMs=1500&optimizeTimeoutMs=30000";
  const r = await http(srv, { method: "POST", path: "/?page=config", body });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, "?page=config&saved=1");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const mine = doc.plugins.find((p) => p.spec === "/root/prompt-optimizer-magpie");
  assert.equal(mine.options.minChars, 33);
  assert.equal(mine.options.optimizerMode, "merged");
  assert.equal(mine.options.dryRun, false);        // absent checkbox → false
  assert.equal(mine.options.gatewayUrl, "http://x"); // 非白名单键原样保留
  assert.equal(mine.options.custom, 42);
  const other = doc.plugins.find((p) => p.spec === "/root/some-other-plugin");
  assert.equal(other.options.keepMe, true);
  assert.match(readFileSync(file, "utf8"), /\n  "plugins"/); // indent 2
  // 原子：无残留 tmp 文件
  assert.equal(readdirSync(dir).filter((n) => n.includes(".tmp")).length, 0);
  // 302 后带 saved=1 的 GET 显示绿色提示条
  const r2 = await http(srv, { path: "/?page=config&saved=1" });
  assert.match(r2.body, /已保存。需重载插件/);
  srv.close();
  rmSync(dir, { recursive: true, force: true });
});

test("config 3: POST invalid (minChars=0, optimizerMode=hack) → 400 re-render, file untouched", async () => {
  const { dir, file } = mkPlugins({ minChars: 6 });
  const before = readFileSync(file, "utf8");
  const srv = await listen(makeStatsServer({ statsDir: dir, pluginsFile: file, options: { configPage: true } }));
  const body = "optimizerMode=hack&minChars=0&maxChars=9000&deciderGroup=g&optimizeGroup=o&deciderTimeoutMs=1500&optimizeTimeoutMs=30000";
  const r = await http(srv, { method: "POST", path: "/?page=config", body });
  assert.equal(r.status, 400);
  assert.match(r.body, /超出允许范围/);       // minChars=0
  assert.match(r.body, /不是合法选项/);       // optimizerMode=hack
  assert.equal(readFileSync(file, "utf8"), before, "file untouched");
  srv.close();
  rmSync(dir, { recursive: true, force: true });
});

test("config 4: broken plugins.json → 500 error page, file untouched", async () => {
  const { dir, file } = mkPlugins({});
  writeFileSync(file, "{ not json !!!");
  const before = readFileSync(file, "utf8");
  const srv = await listen(makeStatsServer({ statsDir: dir, pluginsFile: file, options: { configPage: true } }));
  const g = await http(srv, { path: "/?page=config" });
  assert.equal(g.status, 500);
  assert.match(g.body, /解析失败/);
  const p = await http(srv, { method: "POST", path: "/?page=config", body: "minChars=10&maxChars=9000&deciderGroup=g&optimizeGroup=o&deciderTimeoutMs=1500&optimizeTimeoutMs=30000" });
  assert.equal(p.status, 500);
  assert.equal(readFileSync(file, "utf8"), before, "file untouched after failed POST");
  srv.close();
  rmSync(dir, { recursive: true, force: true });
});

test("config 5: two concurrent POSTs serialize; final file is valid JSON with last write", async () => {
  const { dir, file } = mkPlugins({ minChars: 6 });
  const srv = await listen(makeStatsServer({ statsDir: dir, pluginsFile: file, options: { configPage: true } }));
  const mk = (n) => `enabled=on&optimizerMode=auto&minChars=${n}&maxChars=9000&deciderGroup=g&optimizeGroup=o&deciderTimeoutMs=1500&optimizeTimeoutMs=30000`;
  const [a, b] = await Promise.all([
    http(srv, { method: "POST", path: "/?page=config", body: mk(11) }),
    http(srv, { method: "POST", path: "/?page=config", body: mk(22) }),
  ]);
  assert.equal(a.status, 302);
  assert.equal(b.status, 302);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const mine = doc.plugins.find((p) => p.spec === "/root/prompt-optimizer-magpie");
  assert.ok([11, 22].includes(mine.options.minChars), "last serialized write wins");
  assert.equal(readdirSync(dir).filter((n) => n.includes(".tmp")).length, 0);
  srv.close();
  rmSync(dir, { recursive: true, force: true });
});

// unit: parseConfigForm ignores non-whitelist keys entirely
test("config unit: parseConfigForm drops unknown keys", () => {
  const r = parseConfigForm("minChars=9&gatewayUrl=http%3A%2F%2Fevil&enabled=on");
  assert.equal(r.ok, true);
  assert.equal(r.values.enabled, true);
  assert.equal(r.values.dryRun, false, "absent checkbox resolves false");
  assert.ok(!("gatewayUrl" in r.values));
});

// unit: writeConfig parse-back verification never renames a bad serialization
test("config unit: readPluginsJson error paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "pom-cfg2-"));
  const missing = join(dir, "none.json");
  assert.equal(readPluginsJson(missing).error, "cfgErrNoFile");
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "]]]");
  assert.equal(readPluginsJson(bad).error, "cfgErrBadFile");
  const nospec = join(dir, "nospec.json");
  writeFileSync(nospec, JSON.stringify({ plugins: [{ spec: "/root/other" }] }));
  assert.equal(readPluginsJson(nospec).error, "cfgErrNoSpec");
  rmSync(dir, { recursive: true, force: true });
});
