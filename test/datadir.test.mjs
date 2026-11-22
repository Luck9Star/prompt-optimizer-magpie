// Data dir outside the package + one-shot legacy migration (v0.2.5).
// resolveStatsDir: default under homedir, POM_STATS_DIR override.
// migrateLegacyStats: copy-once, skip existing, MIGRATED.txt marker, no-op
// when the legacy dir is gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveStatsDir, migrateLegacyStats } from "../lib/stats.mjs";

test("resolveStatsDir: default is ~/.config/magpie/prompt-optimizer-magpie/stats", () => {
  const prev = process.env.POM_STATS_DIR;
  delete process.env.POM_STATS_DIR;
  try {
    assert.equal(resolveStatsDir(), join(homedir(), ".config", "magpie", "prompt-optimizer-magpie", "stats"));
  } finally {
    if (prev !== undefined) process.env.POM_STATS_DIR = prev;
  }
});

test("resolveStatsDir: POM_STATS_DIR overrides", () => {
  const prev = process.env.POM_STATS_DIR;
  process.env.POM_STATS_DIR = "/tmp/pom-override-stats";
  try {
    assert.equal(resolveStatsDir(), "/tmp/pom-override-stats");
  } finally {
    if (prev === undefined) delete process.env.POM_STATS_DIR;
    else process.env.POM_STATS_DIR = prev;
  }
});

test("migrateLegacyStats: copies ndjson files to an empty new dir, once", () => {
  const base = mkdtempSync(join(tmpdir(), "pom-migrate-"));
  const oldDir = join(base, "old");
  const newDir = join(base, "new");
  mkdirSync(oldDir);
  writeFileSync(join(oldDir, "2026-11-20.ndjson"), '{"ts":1,"action":"pass","reason":"test"}\n');
  writeFileSync(join(oldDir, "2026-11-21.ndjson"), '{"ts":2,"action":"pass","reason":"test"}\n');
  writeFileSync(join(oldDir, "stats.ndjson"), "legacy single file — not a day file\n");
  try {
    assert.equal(migrateLegacyStats(oldDir, newDir), true);
    assert.equal(readFileSync(join(newDir, "2026-11-20.ndjson"), "utf8"), '{"ts":1,"action":"pass","reason":"test"}\n');
    assert.ok(existsSync(join(newDir, "2026-11-21.ndjson")));
    assert.ok(!existsSync(join(newDir, "stats.ndjson"))); // only day files move
    assert.ok(existsSync(join(oldDir, "2026-11-20.ndjson"))); // copy, not move
    assert.ok(existsSync(join(oldDir, "MIGRATED.txt")));
    // second run: marker present → no-op even if new data disappeared
    assert.equal(migrateLegacyStats(oldDir, newDir), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("migrateLegacyStats: same-name file in new dir is never overwritten", () => {
  const base = mkdtempSync(join(tmpdir(), "pom-migrate-"));
  const oldDir = join(base, "old");
  const newDir = join(base, "new");
  mkdirSync(oldDir);
  mkdirSync(newDir);
  writeFileSync(join(oldDir, "2026-11-20.ndjson"), "old content\n");
  writeFileSync(join(newDir, "2026-11-20.ndjson"), "newer content\n");
  try {
    assert.equal(migrateLegacyStats(oldDir, newDir), true);
    assert.equal(readFileSync(join(newDir, "2026-11-20.ndjson"), "utf8"), "newer content\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("migrateLegacyStats: missing legacy dir is a no-op", () => {
  const base = mkdtempSync(join(tmpdir(), "pom-migrate-"));
  try {
    assert.equal(migrateLegacyStats(join(base, "nope"), join(base, "new")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
