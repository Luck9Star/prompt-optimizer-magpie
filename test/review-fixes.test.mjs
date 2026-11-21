// Regression tests for the omp full-review findings (2026-11-21).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripBC } from "../lib/turn.mjs";
import { makeStatsServer } from "../lib/stats-service.mjs";
import { get } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
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

test("serve.mjs: invalid POM_RETAIN_DAYS falls back to 7 with a warning", async () => {
  // source-level check: the fallback expression must be Number.isFinite, not `|| 0`
  const src = (await import("node:fs")).readFileSync(new URL("../serve.mjs", import.meta.url), "utf8");
  assert.match(src, /Number\.isFinite\(RAW_RETAIN\) \? RAW_RETAIN : 7/);
  assert.doesNotMatch(src, /POM_RETAIN_DAYS \?\? 7\) \|\| 0/);
});

test("index.mjs server(): port 0 must survive (ephemeral), not become 3497", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Number\(options\?\.port\) \|\| 3497/);
  assert.match(src, /Number\.isFinite\(Number\(options\?\.port\)\) \? Number\(options\.port\) : 3497/);
});
