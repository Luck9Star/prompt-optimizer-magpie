import { createHash } from "node:crypto";

export function assignRollout(rollout, ctx, thread) {
  const baseline = { group: "baseline", experimentId: "", assignment: "off" };
  if (rollout == null) return baseline;
  const { experimentId, agents, autoPercent, mergedPercent } = rollout;
  if (typeof experimentId !== "string" || !experimentId.trim()
      || !Array.isArray(agents) || !agents.length || !agents.every((a) => typeof a === "string" && a.trim())
      || !Number.isFinite(autoPercent) || autoPercent < 0 || !Number.isFinite(mergedPercent) || mergedPercent < 0
      || autoPercent + mergedPercent >= 100) return { ...baseline, assignment: "invalid" };
  baseline.experimentId = experimentId;
  if (!agents.includes(ctx?.agent)) return { ...baseline, assignment: "out-of-scope" };
  if (thread) return { ...baseline, assignment: "thread" };
  if (typeof ctx.session !== "string" || !ctx.session.trim()) return { ...baseline, assignment: "no-session" };

  // Using opposite ends keeps the other arm stable when one percentage changes.
  const digest = createHash("sha256").update(JSON.stringify([experimentId, ctx.agent, ctx.session])).digest();
  const bucket = digest.readUIntBE(0, 6) / 2 ** 48 * 100;
  let group = "control";
  if (bucket < autoPercent) group = "auto";
  else if (bucket >= 100 - mergedPercent) group = "merged";
  return { group, experimentId, assignment: "bucketed" };
}
