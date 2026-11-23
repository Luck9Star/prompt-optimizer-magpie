import { localDay } from "../lib/stats.mjs";
// Regression tests for the omp full-review findings (2026-11-21).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripBC } from "../lib/turn.mjs";
import { makeStatsServer } from "../lib/stats-service.mjs";
import { get } from "node:http";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("stripBC: note AFTER user text → stripped, text kept", () => {
  assert.equal(stripBC("帮我修这个报错\n\n[billion-context] summary"), "帮我修这个报错");
});

test("stripBC: note BEFORE user text → keep the user text after the note", () => {
  const msg = "[billion-context] summary\n\n帮我修一下这个报错";
  assert.equal(stripBC(msg), "帮我修一下这个报错");
});

test("stripBC: note alone → empty (turn dropped)", () => {
  assert.equal(stripBC("[billion-context] Continue now."), "");
});

test("stats server: foreign Host header → 403, loopback Host → 200", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pom-host-guard-"));
  const server = makeStatsServer({ statsDir: join(dir, "stats") });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const req = (host) => new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/api/stats", headers: { host } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    }).on("error", reject);
  });
  try {
    const evil = await req("evil.example.com");
    assert.equal(evil.status, 403, "rebinding host rejected");
    const okIp = await req("127.0.0.1:12345");
    assert.equal(okIp.status, 200, "loopback ip host accepted");
    const okName = await req("localhost:12345");
    assert.equal(okName.status, 200, "localhost host accepted");
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stats retention: invalid values warn and use seven days; explicit opt-outs keep history", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pom-retain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const warn = t.mock.method(console, "warn", () => {});
  const dayFile = (age) => join(dir, localDay(new Date(Date.now() - age * 86400_000)) + ".ndjson");
  for (const value of ["", "  ", "abc", "1e300", "0", "-1"]) {
    const keep = Number(value) <= 0 && value.trim() !== "";
    writeFileSync(dayFile(8), "");
    writeFileSync(dayFile(7), "");
    const server = makeStatsServer({ statsDir: dir, retainDays: value });
    server.emit("listening");
    server.emit("close");
    assert.equal(existsSync(dayFile(8)), keep, value);
    assert.ok(existsSync(dayFile(7)), value);
  }
  assert.equal(warn.mock.callCount(), 4);
});

test("index.mjs server(): default port falls back to 27497, explicit options.port (incl. 0) survives", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Number\(options\?\.port\) \|\| 27497/);
  assert.match(src, /Number\.isFinite\(Number\(options\?\.port\)\) \? Number\(options\.port\) : 27497/);
});

test("index.mjs server(): port 0 binds ephemeral, returns the actual port, page/port.js carries it", async (t) => {
  const { readFileSync } = await import("node:fs");
  const mod = await import("../index.mjs");
  t.after(() => mod.__testClose());
  const out = await mod.default.server({}, { port: 0 });
  assert.ok(Number.isInteger(out.port) && out.port >= 1 && out.port < 65536, `actual port returned: ${out.port}`);
  const page = readFileSync(new URL("../page/port.js", import.meta.url), "utf8");
  assert.match(page, new RegExp(`window\\.__POM_PORT__ = ${out.port};`));
});

test("page/: app.js navigates to the same-origin service proxy, no port discovery left", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../page/app.js", import.meta.url), "utf8");
  assert.match(src, /location\.replace\("\.\/_magpie\/service\/"\)/);
  assert.doesNotMatch(src, /__POM_PORT__|FALLBACK_PORT|_magpie\/bridge\.js/);
  const html = readFileSync(new URL("../page/index.html", import.meta.url), "utf8");
  assert.match(html, /<script src="\.\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /port\.js|bridge\.js/);
});
