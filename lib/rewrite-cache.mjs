import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { contentVersion } from "../templates/index.mjs";

const defaultCache = fileURLToPath(new URL("../.cache.json", import.meta.url));
const cacheDir = (o) => (o.cacheFile || defaultCache) + ".d";

export function rewriteCacheKey(agent, orig, o, mode, templateId) {
  const parts = [contentVersion, agent, orig, o.gatewayUrl, !!o.dryRun, o.optimizeGroup, o.optimizerMode, mode, templateId];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function readRewrite(o, key) {
  if (!(o.cacheTtlMs > 0)) return;
  const dir = cacheDir(o);
  const now = Date.now();
  let latest = -1, found;
  try {
    for (const name of readdirSync(dir)) {
      const entry = /^([a-f0-9]{64})\.(\d+)\.(\d+)(\.[a-f0-9-]+\.tmp)?$/.exec(name);
      if (!entry) continue;
      const [, hash, created, expires, pending] = entry;
      const path = join(dir, name);
      if (Number(expires) <= now) {
        // The expiration is part of the name, so pruning cannot unlink a fresh rewrite.
        try { unlinkSync(path); } catch {}
      } else if (!pending && hash === key && now - Number(created) < o.cacheTtlMs && Number(created) > latest) {
        found = path;
        latest = Number(created);
      }
    }
    if (found) return readFileSync(found, "utf8");
  } catch { /* Cold, read-only, or unavailable cache: keep processing the request. */ }
}

export function writeRewrite(o, key, out) {
  if (!(o.cacheTtlMs > 0)) return;
  const dir = cacheDir(o);
  const now = Date.now();
  const expires = Math.ceil(now + Number(o.cacheTtlMs));
  if (!Number.isSafeInteger(expires)) return;
  const path = join(dir, `${key}.${now}.${expires}`);
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(temp, out, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } catch {
    try { unlinkSync(temp); } catch {}
  }
}
