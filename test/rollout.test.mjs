import assert from "node:assert/strict";
import test from "node:test";
import { assignRollout } from "../lib/rollout.mjs";

const config = { experimentId: "trial", agents: ["cli"], autoPercent: 15.5, mergedPercent: 20.25 };
const ctx = { agent: "cli", session: "s1" };

test("rollout: valid first turns require an allowlisted agent and stable session", () => {
  for (const [o, c, thread, assignment] of [
    [undefined, ctx, false, "off"], [null, ctx, false, "off"],
    [config, { ...ctx, agent: "batch" }, false, "out-of-scope"],
    [config, undefined, false, "out-of-scope"], [config, ctx, true, "thread"],
    [config, { agent: "cli" }, false, "no-session"], [config, { ...ctx, session: "  " }, false, "no-session"],
    [config, { ...ctx, session: { id: 1 } }, false, "no-session"],
  ]) {
    assert.deepEqual(assignRollout(o, c, thread), { group: "baseline", experimentId: o?.experimentId || "", assignment });
  }
});

test("rollout: unusable configuration preserves the baseline", () => {
  for (const patch of [
    { experimentId: " " }, { agents: [] }, { agents: ["cli", null] }, { autoPercent: "5" },
    { mergedPercent: NaN }, { autoPercent: undefined }, { autoPercent: -1 }, { mergedPercent: Infinity },
    { autoPercent: 50, mergedPercent: 50 }, { autoPercent: 90, mergedPercent: 11 },
  ]) {
    assert.deepEqual(assignRollout({ ...config, ...patch }, ctx, false), {
      group: "baseline", experimentId: "", assignment: "invalid",
    });
  }
});

test("rollout: stable fractional arms, independent rollback and a direct control", () => {
  const count = { auto: 0, merged: 0, control: 0 };
  const differentExperiment = new Set(), differentAgent = new Set();
  for (let i = 0; i < 2000; i++) {
    const client = { ...ctx, session: 'sample-' + i };
    const result = assignRollout(config, client, false);
    assert.deepEqual(result, assignRollout(config, { ...client, query: "retry" }, false));
    const { group } = result;
    assert.equal(result.assignment, "bucketed");
    count[group]++;
    differentExperiment.add(assignRollout({ ...config, experimentId: "other" }, client, false).group === group);
    differentAgent.add(assignRollout({ ...config, agents: ["batch"] }, { ...client, agent: "batch" }, false).group === group);
    assert.equal(assignRollout({ ...config, mergedPercent: 0 }, client, false).group, group === "merged" ? "control" : group);
    assert.equal(assignRollout({ ...config, autoPercent: 0 }, client, false).group, group === "auto" ? "control" : group);
  }
  assert.equal(differentExperiment.size, 2);
  assert.equal(differentAgent.size, 2);
  assert.ok(Math.abs(count.auto - 310) < 70 && Math.abs(count.merged - 405) < 70 && count.control > 0);
  assert.equal(assignRollout({ ...config, autoPercent: 0, mergedPercent: 0 }, ctx, false).group, "control");
});
