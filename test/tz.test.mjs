// Local-timezone day bucketing and display (.omp-tz-brief.md): dayFile names
// and prune cutoff use localDay(); the page renders localStamp(). UTC-named
// legacy files stay readable — the day selector just groups by filename.
import { test } from "node:test";
import assert from "node:assert/strict";
import { localDay } from "../lib/stats.mjs";
import { localStamp } from "../lib/stats-page.mjs";

test("localDay: uses the local calendar date, not the UTC one", () => {
  // Constructed in local time — assertions hold regardless of test-machine TZ.
  // 00:30 local on the 22nd is the 22nd locally even though it is still the
  // 21st (or 22nd early) in UTC.
  assert.equal(localDay(new Date(2026, 10, 22, 0, 30)), "2026-11-22");
  // 23:30 local on the 21st is still the 21st locally even in UTC it is the 22nd.
  assert.equal(localDay(new Date(2026, 10, 21, 23, 30)), "2026-11-21");
});

test("localStamp: YYYY-MM-DD HH:mm:ss shape", () => {
  const s = localStamp(new Date(2026, 10, 22, 8, 5, 3).getTime());
  assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(s, "2026-11-22 08:05:03");
});
