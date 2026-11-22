// Regression: a bind that succeeds after retries must fire the listening
// handler exactly once (the retry loop re-called listen() with a callback,
// stacking one-time 'listening' listeners: 11 logs + 11 service.json writes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { createServer as _cs } from "node:http";
async function freePort() {
  const s = _cs();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((r) => child.once("exit", r));
}

const ROOT = new URL("..", import.meta.url).pathname;

test("serve: single 'listening' fire after retry recovery (leaver exits mid-retry)", async (t) => {
  const PORT = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "pom-single-fire-"));
  writeFileSync(join(dir, "stats.ndjson"), "");
  // hold the port for 0.8s — serve retries same port, then binds when it clears
  const leaver = spawn("node", [
    "-e",
    `const s = require("node:http").createServer(() => {});
     s.listen(${PORT}, "127.0.0.1", () => {
       setTimeout(() => s.close(), 800);
     });`,
  ]);
  await new Promise((r) => setTimeout(r, 150));
  const child = spawn("node", [join(ROOT, "serve.mjs")], {
    env: { ...process.env, PORT: String(PORT), POM_FALLBACK_PORT: String(await freePort()), POM_DATA_DIR: dir, POM_RETAIN_DAYS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  try {
    // wait for the success line (appears once leaver exits ~0.8s in)
    const okLine = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no success line; out=${out}`)), 6000);
      const watch = () => {
        if (new RegExp(`serve: http:\\/\\/127\\.0\\.0\\.1:${PORT}`).test(out)) {
          clearTimeout(t);
          resolve(true);
        } else setTimeout(watch, 50);
      };
      watch();
    });
    assert.ok(okLine);
    // exactly ONE success line, no MaxListeners warning
    await new Promise((r) => setTimeout(r, 300)); // let stray duplicates surface
    const hits = out.split(`serve: http://127.0.0.1:${PORT}`).length - 1;
    assert.equal(hits, 1, `expected 1 success line, got ${hits}; out=${out}`);
    assert.ok(!/MaxListenersExceeded/.test(out), `listener leak warning; out=${out}`);
    const info = JSON.parse(readFileSync(join(dir, "service.json"), "utf8"));
    assert.equal(info.port, PORT);
    const res = await new Promise((resolve, reject) => {
      get(`http://127.0.0.1:${PORT}/api/stats`, (r2) => {
        let b = "";
        r2.on("data", (c) => (b += c));
        r2.on("end", () => resolve({ status: r2.statusCode, body: b }));
      }).on("error", reject);
    });
    assert.equal(res.status, 200);
  } finally {
    child.kill("SIGTERM");
    leaver.kill("SIGKILL");
    await exited(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
