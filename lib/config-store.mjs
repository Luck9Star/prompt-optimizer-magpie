// Config sub-page store: read/locate/atomic-writeback of this plugin's
// `options` inside magpie's plugins.json. Brief: .omp-config-brief.md.
//
// Hard rules implemented here:
// - whitelist-only key coverage; foreign keys pass through untouched
// - atomic write: same-dir temp file + renameSync, with a parse-back
//   verification of our own serialized JSON before the rename
// - writes serialized through a module-level promise chain (simple mutex)
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

export const SPEC = "/root/prompt-optimizer-magpie";

// Whitelist + validation (brief 需求 1 表格). `type` drives form rendering;
// `check` returns an error string (keyed for T lookup) or null.
export const CONFIG_FIELDS = [
  { key: "enabled", type: "bool", def: true },
  { key: "dryRun", type: "bool", def: false },
  { key: "optimizerMode", type: "enum", def: "auto", choices: ["auto", "merged"] },
  { key: "minChars", type: "int", def: 6, min: 1, max: 200 },
  { key: "maxChars", type: "int", def: 12000, min: 1000, max: 100000 },
  { key: "logSkips", type: "bool", def: true },
  { key: "logOptimizes", type: "bool", def: true },
  { key: "deciderGroup", type: "string", def: "group/prompt-decide", maxLen: 200 },
  { key: "optimizeGroup", type: "string", def: "group/prompt-optimize", maxLen: 200 },
  { key: "deciderTimeoutMs", type: "int", def: 4000, min: 500, max: 60000 },
  { key: "optimizeTimeoutMs", type: "int", def: 60000, min: 500, max: 60000 },
];
const BY_KEY = Object.fromEntries(CONFIG_FIELDS.map((f) => [f.key, f]));

// Parse one form value per field type; returns { ok, value, err }.
// `err` is a T key suffix ("cfgErrInt" etc.) — page renders it bilingual.
export function parseConfigValue(field, raw) {
  if (field.type === "bool") {
    // checkbox semantics: absent = false, any of on/true/1 = true
    const v = raw === "on" || raw === "true" || raw === "1";
    return { ok: true, value: v };
  }
  const s = String(raw ?? "").trim();
  if (field.type === "enum") {
    return field.choices.includes(s)
      ? { ok: true, value: s }
      : { ok: false, err: "cfgErrEnum" };
  }
  if (field.type === "int") {
    if (!/^-?\d+$/.test(s)) return { ok: false, err: "cfgErrInt" };
    const n = Number(s);
    if (n < field.min || n > field.max) return { ok: false, err: "cfgErrRange" };
    return { ok: true, value: n };
  }
  // string: non-empty, ≤ maxLen
  if (!s) return { ok: false, err: "cfgErrEmpty" };
  if (s.length > field.maxLen) return { ok: false, err: "cfgErrLen" };
  return { ok: true, value: s };
}

// Parse a full form body (URLSearchParams). Returns
// { ok: true, values } or { ok: false, errors: {key: errKey}, values: partial }.
// Non-whitelist keys in the body are ignored entirely.
export function parseConfigForm(body) {
  const params = new URLSearchParams(body);
  const values = {};
  const errors = {};
  for (const f of CONFIG_FIELDS) {
    const raw = f.type === "bool" ? (params.get(f.key) ?? "") : params.get(f.key);
    if (raw === null) continue; // field not submitted → leave untouched
    const r = parseConfigValue(f, raw);
    if (r.ok) values[f.key] = r.value;
    else errors[f.key] = r.err;
  }
  return { ok: Object.keys(errors).length === 0, values, errors };
}

export function readPluginsJson(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { error: "cfgErrNoFile" };
  }
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.plugins))
      return { error: "cfgErrBadFile" };
    const entry = doc.plugins.find((p) => p && p.spec === SPEC);
    if (!entry || typeof entry.options !== "object" || entry.options === null)
      return { error: "cfgErrNoSpec" };
    return { doc, entry, options: entry.options };
  } catch {
    return { error: "cfgErrBadFile" };
  }
}

// Module-level mutex: serialize all writebacks (brief 需求 2).
let chain = Promise.resolve();
export function writeConfig(file, values) {
  const run = async () => {
    const cur = readPluginsJson(file);
    if (cur.error) return cur;
    // whitelist-only overlay; foreign keys survive untouched
    const next = { ...cur.entry.options };
    for (const [k, v] of Object.entries(values)) if (BY_KEY[k]) next[k] = v;
    cur.entry.options = next;
    const text = JSON.stringify(cur.doc, null, 2);
    // parse-back verification of our own serialization before any rename
    try { JSON.parse(text); } catch { return { error: "cfgErrVerify" }; }
    const tmp = join(dirname(file), `.plugins.json.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, text, "utf8");
      renameSync(tmp, file);
    } catch (e) {
      try { unlinkSync(tmp); } catch {}
      return { error: "cfgErrWrite", detail: e?.code ?? String(e) };
    }
    return { ok: true };
  };
  const result = chain.then(run, run);
  // keep the chain alive even if a write fails
  chain = result.then(() => {}, () => {});
  return result;
}
