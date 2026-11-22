import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSamples } from "../eval/schema.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const opts = { cwd: root, encoding: "utf8" };
test("offline comparison executes all three arms, blinds their sources and scores paired deliveries", t => {
  const dir = mkdtempSync(join(tmpdir(), "pom-eval-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dest = join(dir, "run");
  execFileSync(process.execPath, ["eval/generate.mjs", "--dry-run", "eval/samples.json", dest], opts);
  const reviewPath = join(dest, "review.json"), keyPath = join(dest, "key.json");
  const review = JSON.parse(readFileSync(reviewPath, "utf8"));
  const key = JSON.parse(readFileSync(keyPath, "utf8"));
  assert.equal(key.runMode, "offline");
  assert.equal(review.length, 12);
  const byID = new Map(review.map(r => [r.id, r]));
  assert.equal(byID.size, 12);
  for (const { id, changed, arm, kind } of key.entries) {
    const row = byID.get(id);
    assert.equal(Object.hasOwn(row, "arm"), false);
    assert.equal(Object.hasOwn(row, "expectPass"), false);
    assert.equal(row.prompt !== row.conversation.at(-1).content, changed);
    assert.equal(row.answer, `离线占位输出：${row.prompt}`);
    assert.equal(changed, kind === "vague-first" && arm !== "original" || kind === "thread-new" && arm === "auto");
    row.usability = arm === "auto" ? 2 : 1;
    row.lostConstraint = kind === "vague-first" && arm === "merged";
    row.addedConstraint = false;
  }
  const command = ["eval/summarize.mjs", keyPath, reviewPath];
  assert.notEqual(spawnSync(process.execPath, command, opts).status, 0, "unfilled scorecard must fail");
  writeFileSync(reviewPath, JSON.stringify(review));
  const report = JSON.parse(execFileSync(process.execPath, command, opts));
  assert.equal(report.all.auto.moreUsableThanOriginal.count, 4);
  assert.equal(report.all.original.moreUsableThanOriginal.denominator, 0);
  assert.equal(report.all.merged.shouldPassButRewrote.denominator, 2);
  assert.equal(report.byKind["vague-first"].merged.lostConstraint.examples[0].sample, "draft");
  writeFileSync(reviewPath, JSON.stringify([...review.slice(1), review[1]]));
  assert.notEqual(spawnSync(process.execPath, command, opts).status, 0, "duplicate IDs cannot replace a missing score");
});
test("sample validation rejects mislabeled history and duplicate IDs", () => {
  const first = { id: "x", kind: "clear-first", expectPass: true, messages: [{ role: "user", content: "ok" }] };
  assert.throws(() => validateSamples([{ ...first, kind: "thread-new" }]), /history mismatch/);
  assert.throws(() => validateSamples([first, first]), /unique/);
});
