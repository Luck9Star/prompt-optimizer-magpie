import { readFileSync } from "node:fs";
import { arms, kinds } from "./schema.mjs";

const [keyFile, reviewFile] = process.argv.slice(2);
if (!keyFile || !reviewFile) throw new Error("Usage: node eval/summarize.mjs key.json scored-review.json");
const { entries, runMode } = JSON.parse(readFileSync(keyFile, "utf8"));
const reviews = JSON.parse(readFileSync(reviewFile, "utf8"));
const scores = new Map(reviews.map(row => [row.id, row]));
if (!entries.length || scores.size !== reviews.length || scores.size !== entries.length || new Set(entries.map(e => e.id)).size !== entries.length)
  throw new Error("incomplete or duplicate review IDs");
const originalScores = new Map();
for (const { id, sample, arm } of entries) {
  const row = scores.get(id);
  if (!row || typeof row.lostConstraint !== "boolean" || typeof row.addedConstraint !== "boolean" || ![0, 1, 2].includes(row.usability))
    throw new Error(`missing or invalid rating: ${id}`);
  if (arm === "original") originalScores.set(sample, row.usability);
}

function tally(rows) {
  const metric = () => ({ count: 0, denominator: 0, examples: [] });
  const result = { samples: rows.length, shouldPassButRewrote: metric(), lostConstraint: metric(), addedConstraint: metric(), moreUsableThanOriginal: metric() };
  for (const row of rows) {
    const score = scores.get(row.id);
    const count = (value, applies, hit) => {
      if (!applies) return;
      value.denominator++;
      if (hit) {
        value.count++;
        if (value.examples.length < 3) value.examples.push({ sample: row.sample, review: row.id, note: score.note || "" });
      }
    };
    count(result.shouldPassButRewrote, row.expectPass, row.changed);
    count(result.lostConstraint, true, score.lostConstraint);
    count(result.addedConstraint, true, score.addedConstraint);
    count(result.moreUsableThanOriginal, row.arm !== "original", score.usability > originalScores.get(row.sample));
  }
  return result;
}
function acrossArms(rows) {
  return Object.fromEntries(arms.map(arm => [arm, tally(rows.filter(e => e.arm === arm))]));
}
console.log(JSON.stringify({ runMode, all: acrossArms(entries),
  byKind: Object.fromEntries(kinds.map(kind => [kind, acrossArms(entries.filter(e => e.kind === kind))])),
}, null, 2));
