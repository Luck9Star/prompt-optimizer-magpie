// onRequest gate chain (design.md §4). Every failure path returns undefined:
// fail-open — the plugin must never block or corrupt a request.
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { questions, mergedSystemPrompt, parseMerged, stripFence, TAIL_NOTE } from "./lib/prompts.mjs";
import { rewriteCacheKey, readRewrite, writeRewrite } from "./lib/rewrite-cache.mjs";
import { countUnits, preservesTokens, redact } from "./lib/rewrite-guard.mjs";
import { assignRollout } from "./lib/rollout.mjs";
import { contentVersion, getTemplate } from "./templates/index.mjs";
import { hasTools, opensTurn, lastUserText } from "./lib/turn.mjs";
import { record } from "./lib/stats.mjs";

const DEFAULTS = {
  enabled: true,
  dryRun: true,
  deciderGroup: "group/route-decider",
  optimizeGroup: "group/prompt-optimize",
  minChars: 6,
  maxChars: 12000,
  bypassPrefix: ["!!", "##"],
  bypassModels: [],
  bypassAgents: [],
  allowedOrigins: [],
  skipToolless: true,
  cacheTtlMs: 60000,
  deciderTimeoutMs: 1500,
  // 输出护栏上限倍率：clamp(origUnits * guardRatioLimit, 60, 2000)。生产
  // 案例 2026-11-22：52 词元原文 ×5 上限 260 误杀 430 词元改写 → 默认 ×10。
  guardRatioLimit: 10,
  optimizeTimeoutMs: 15000,
  // merged 模式：单次 optimize 调用同时完成模板选择 + 改写（首行标记协议）。
  // optimizerMode: "auto"（默认，现行为）| "merged"（跳过 decider，首轮直接 merged）。
  // deciderFallback: auto 模式下 decider 失败时的回落策略——本版实现 "merged"
  // （失败请求转 merged 单次调用）；未实现值按纯规则回落处理。
  optimizerMode: "auto",
  deciderFallback: "rule",
  // gatewayTimeoutMs 有意不在 DEFAULTS：它是网关读取的声明（package.json
  // options / design §5），hook 代码自身从不消费——留在这里只会误导维护者。
  gatewayUrl: "http://127.0.0.1:3425",
  // 日志分级：logSkips=false 不记常规 pass 事件（not-turn/self-loop 等噪音），
  // 但失败类 reason 始终记录——排障时不能瞎。logOptimizes=false 不记 optimize/decide。
  logSkips: true,
  logOptimizes: true,
};

// Render the single JSON interpolation without a Handlebars runtime.
const MUSTACHE = /\{\{#helpers\.toJson\}\}\s*\{\{\{originalPrompt\}\}\}\s*\{\{\/helpers\.toJson\}\}/;

function matchingOverride(rules, agent, model) {
  if (!Array.isArray(rules)) return;
  return rules.find(r => r && typeof r === "object"
    && (r.agent !== undefined || r.model !== undefined)
    && (r.agent === undefined || (typeof r.agent === "string" && r.agent.trim() && r.agent === agent))
    && (r.model === undefined || (typeof r.model === "string" && r.model.trim() && r.model === model))
    && (r.budgetMs !== undefined || r.optimizerMode !== undefined)
    && (r.budgetMs === undefined || (Number.isSafeInteger(r.budgetMs) && r.budgetMs >= 0))
    && (r.optimizerMode === undefined || ["auto", "merged"].includes(r.optimizerMode)));
}

export async function onRequest(body, ctx) {
  const t0 = Date.now();
  const o = { ...DEFAULTS, ...((ctx && ctx.options) || {}) };
  const clip = (text) => {
    const safe = redact(text);
    const n = o.logRewriteChars || 600;
    return safe.length > n ? safe.slice(0, n) + `… +${safe.length - n} chars` : safe;
  };
  const log = (action, reason, x = {}) => {
    const failed = reason.includes("-fail") || reason === "optimize-empty" || reason === "error";
    if (!failed && (action === "pass" ? o.logSkips : o.logOptimizes) === false) return;
    record({
      agent: redact(ctx?.agent || ""),
      action,
      reason,
      durationMs: Date.now() - t0,
      inputChars: x.in || 0,
      outputChars: x.out || 0,
      ...(x.inUnits !== undefined && { inputUnits: x.inUnits }),
      ...(x.outUnits !== undefined && { outputUnits: x.outUnits }),
      dryRun: !!o.dryRun,
      ...(x.decideMs !== undefined && { decideMs: x.decideMs }),
      ...(x.optimizeMs !== undefined && { optimizeMs: x.optimizeMs }),
      ...(o.logRewrites !== false && x.origText !== undefined && { orig: clip(x.origText) }),
      ...(o.logRewrites !== false && x.newText !== undefined && { rewritten: clip(x.newText) }),
    }, o.statsDir);
  };
  let summary;
  const finish = (code, reason, result, finalAction = result ? "apply" : "pass") => {
    if (summary) record({ ...summary, action: "summary", reason, finalAction, durationMs: Date.now() - t0 }, o.statsDir);
    try { ctx?.report?.(code, result ? Buffer.byteLength(JSON.stringify(result)) : 0); } catch {}
    return result;
  };
  const pass = (reason, extra) => {
    log("pass", reason, extra);
    const unavailable = ["merged-fail", "optimize-fail", "optimize-empty", "error"].includes(reason);
    return finish(unavailable ? "unavailable" : "skipped", reason);
  };
  try {
    if (o.enabled === false) return pass("disabled");
    if (ctx && ctx.kind === "subagent") return pass("subagent");
    if (body && (body.model === o.optimizeGroup || body.model === o.deciderGroup)) return pass("self-loop");
    if (Array.isArray(o.bypassAgents) && ctx && o.bypassAgents.includes(ctx.agent)) return pass("bypass-agent");
    // Known machine-task models (Hermes compaction / title generation etc.)
    // also arrive with origin=local — origin alone cannot exclude them.
    if (Array.isArray(o.bypassModels) && body && o.bypassModels.includes(body.model)) return pass("bypass-model");
    // Optional origin allow-list. Empty = no restriction. A missing/blank
    // origin is fail-open (field not documented on every path).
    if (Array.isArray(o.allowedOrigins) && o.allowedOrigins.length) {
      const origin = ctx && ctx.origin;
      if (typeof origin === "string" && origin && !o.allowedOrigins.includes(origin)) return pass("origin");
    }
    const prefixes = [].concat(o.bypassPrefix).filter(Boolean);
    if (typeof (ctx && ctx.query) === "string" && prefixes.some((p) => ctx.query.trimStart().startsWith(p))) return pass("bypass-prefix");

    const protocol = (ctx && ctx.protocol) || "chat";
    if (o.skipToolless && !hasTools(body, protocol)) return pass("no-tools");
    if (!opensTurn(body, protocol)) return pass("not-turn");
    const lu = lastUserText(body, protocol);
    if (!lu) return pass("no-user-text");
    const orig = lu.text;
    if (o.debugDump) {
      try {
        const path = typeof o.debugDump === "string" ? o.debugDump : join(dirname(fileURLToPath(import.meta.url)), "debug-dump.log");
        const header = redact(`agent=${ctx?.agent} model=${body.model} proto=${protocol}`);
        const dump = inspect(redact(body), { depth: 6, maxArrayLength: 10, maxStringLength: 600, breakLength: 200 });
        appendFileSync(path, `=== ${new Date().toISOString()} ${header} origLen=${orig.length} ===\n${dump}\n\n`, { mode: 0o600 });
      } catch {}
    }
    if (prefixes.some((p) => orig.startsWith(p))) return pass("bypass-prefix");
    if (orig.length < o.minChars) return pass("short-text", { in: orig.length, inUnits: countUnits(orig) });
    if (orig.length > o.maxChars) return pass("too-long", { in: orig.length, inUnits: countUnits(orig) });

    const size = { in: orig.length, inUnits: countUnits(orig) };
    const input = { ...size, origText: orig };
    if (protocol === "responses" && body.previous_response_id) return pass("no-decider-followup", size);
    const thread = hasAssistantReply(body, protocol);
    const override = matchingOverride(o.overrides, ctx?.agent, body.model);
    if (!thread && override?.optimizerMode) o.optimizerMode = override.optimizerMode;
    const remaining = () => override?.budgetMs === undefined ? Infinity : override.budgetMs - (Date.now() - t0);
    const assignment = assignRollout(o.rollout, ctx, thread);
    const desired = assignment.group === "baseline" ? o.optimizerMode : assignment.group;
    let mode = desired === "control" ? "direct" : desired === "merged" ? "merged" : o.deciderGroup ? "auto" : "rule";
    summary = {
      ...assignment, version: contentVersion, turn: thread ? "thread" : "first",
      mode, fallbackFrom: "", fromCache: false, modelCalls: 0,
    };
    if (mode === "direct") return pass("experiment-control", size);
    if (remaining() <= 0) return pass("budget-exhausted", size);
    let budgetTimer = false;
    const beginCall = (timeoutKey) => {
      const left = remaining();
      if (left <= 0) return false;
      budgetTimer = Number.isFinite(left) && left <= o[timeoutKey];
      if (budgetTimer) o[timeoutKey] = left;
      summary.modelCalls++;
      return true;
    };
    const expired = error => remaining() <= 0 || (budgetTimer && error?.name === "TimeoutError");
    let tier = "professional";
    let deciderFailed = false;
    if (mode === "auto") {
      let d;
      if (!beginCall("deciderTimeoutMs")) return pass("budget-exhausted", size);
      const tDecide = Date.now();
      try { d = await decide(o, thread, orig, timeoutSignal(ctx, o.deciderTimeoutMs)); } catch (error) {
        if (expired(error)) return pass("budget-exhausted", size);
      } finally { input.decideMs = Date.now() - tDecide; }
      if (remaining() <= 0) return pass("budget-exhausted", size);
      if (!d) {
        if (thread) {
          log("decide", "decider-fail", input);
          return pass("no-decider-followup", size);
        }
        deciderFailed = true;
        summary.fallbackFrom = "auto";
        summary.mode = mode = o.deciderFallback === "merged" ? "merged" : "rule";
      } else {
        if (d.choice !== "new_task" || !Number.isFinite(d.confidence) || d.confidence < 0.6) {
          const reason = d.choice === "new_task" ? "low-confidence" : d.choice === "followup" ? "followup" : redact(`choice:${d.choice}`);
          log("decide", reason, input);
          return finish("skipped", reason.startsWith("choice:") ? "unknown-choice" : reason);
        }
        if (typeof d.tpl?.confidence === "number" && d.tpl.confidence >= 0.5) {
          if (d.tpl.choice === "skip") return pass("tpl-skip", input);
          if (["basic", "planning"].includes(d.tpl.choice)) tier = d.tpl.choice;
        }
      }
    } else if (thread) {
      return pass("no-decider-followup", size);
    }

    let breaker;
    if (mode === "merged") {
      breaker = breakerFor(o);
      if (breaker.until) {
        log("pass", "merged-circuit-open", size);
        summary.fallbackFrom = deciderFailed ? "auto/merged" : "merged";
        summary.mode = mode = "rule";
      }
    }
    if (deciderFailed) log("decide", `decider-fail-${mode}`, input);

    const langSuffix = cjkRatio(orig) >= 0.3 ? "" : "_en";
    const templateId = langSuffix ? "professional_en" : mode === "merged" ? "auto" : tier;
    const key = rewriteCacheKey(ctx?.agent || "", orig, o, mode, templateId);
    let out = readRewrite(o, key);
    const fromCache = out !== undefined;
    summary.fromCache = fromCache;
    if (!fromCache) {
      if (!beginCall("optimizeTimeoutMs")) return pass("budget-exhausted", size);
      if (mode === "merged") {
        let parsed;
        const tOpt = Date.now();
        try {
          const raw = await completion(o, mergedSystemPrompt(langSuffix), orig, timeoutSignal(ctx, o.optimizeTimeoutMs));
          parsed = parseMerged(raw, langSuffix);
        } catch (error) {
          if (expired(error)) return pass("budget-exhausted", size);
        } finally { input.optimizeMs = Date.now() - tOpt; }
        if (remaining() <= 0) return pass("budget-exhausted", size);
        if (!parsed) {
          if (!breaker.until && ++breaker.failures >= 5) breaker.until = Date.now() + 600_000;
          return pass("merged-fail", input);
        }
        if (!breaker.until) breaker.failures = 0;
        if (parsed.passthrough) return pass("merged-passthrough", input);
        out = parsed.rest;
      } else {
        const tOpt = Date.now();
        try { out = await optimize(o, orig, templateId, timeoutSignal(ctx, o.optimizeTimeoutMs)); } catch (error) {
          return pass(expired(error) ? "budget-exhausted" : "optimize-fail", size);
        } finally { input.optimizeMs = Date.now() - tOpt; }
        if (remaining() <= 0) return pass("budget-exhausted", size);
        if (!out) return pass("optimize-empty", size);
        out = stripFence(out);
      }
    }

    const origUnits = countUnits(orig), outUnits = countUnits(out);
    const audit = { ...input, out: out.length, outUnits, newText: out, markCache: fromCache };
    const maxUnits = Math.min(Math.max(origUnits * (o.guardRatioLimit || 10), 60), 2000);
    if (outUnits < origUnits * 0.4) return pass("output-guard-short", audit);
    if (outUnits > maxUnits) return pass("output-guard-long", audit);
    if (!preservesTokens(orig, out)) return pass("output-guard-tokens", audit);
    const newBody = replaceSpan(body, protocol, lu.index, orig, out);
    if (!newBody) {
      log("optimize", "no-span", audit);
      return finish("skipped", "no-span");
    }
    if (remaining() <= 0) return pass("budget-exhausted", size);
    if (!fromCache) writeRewrite(o, key, out);
    const reason = fromCache ? "cache-hit" : o.dryRun ? "dry-run" : mode === "merged" ? "merged-optimized" : "optimized";
    log("optimize", reason, audit);
    return o.dryRun ? finish("skipped", reason, undefined, "dry-run") : finish("ready", reason, newBody);
  } catch {
    return pass("error");
  }
}

// System One decider: is the newest user input a new task or a follow-up?
// `orig` is sent verbatim in state.latestUserInput — without it the model
// has nothing to classify and would just guess.
// Host budget first: combine ctx.signal (magpie giving up on the hook) with
// our own timeout so an abandoned hook stops burning gateway tokens.
function timeoutSignal(ctx, ms) {
  const t = AbortSignal.timeout(ms);
  const host = ctx?.signal;
  return host && AbortSignal.any ? AbortSignal.any([host, t]) : t;
}

async function decide(o, thread, orig, signal) {
  const res = await fetch(`${o.gatewayUrl}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: o.deciderGroup,
      state: { hasAssistantReply: thread, latestUserInput: orig, inputChars: orig.length },
      questions,
    }),
    signal,
  });
  if (!res.ok) return undefined;
  const j = await res.json();
  const a = j && j.answers && j.answers.noul;
  if (!a || typeof a.choice !== "string") return undefined;
  // Attach the template-tier answer when present; callers treat a missing or
  // invalid tier as "fall back to language routing".
  return { ...a, tpl: (j.answers.tpl && typeof j.answers.tpl.choice === "string") ? j.answers.tpl : undefined };
}

function hasAssistantReply(body, protocol) {
  const arr = protocol === "responses" ? body.input : protocol === "gemini" ? body.contents : body.messages;
  return Array.isArray(arr) && arr.some((m) => m && (m.role === "assistant" || m.role === "model"));
}

async function optimize(o, orig, templateId, signal) {
  const tpl = getTemplate(templateId);
  if (!tpl) return undefined;
  const user = MUSTACHE.test(tpl.user) ? tpl.user.replace(MUSTACHE, () => JSON.stringify(orig)) : `${tpl.user}\n\n${orig}`;
  return completion(o, `${tpl.system}\n\n${TAIL_NOTE}`, user, signal);
}

async function completion(o, system, user, signal) {
  const res = await fetch(`${o.gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: o.optimizeGroup,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal,
  });
  if (!res.ok) return undefined;
  const j = await res.json();
  const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return typeof c === "string" && c.trim() ? c : undefined;
}

const cjkRatio = (s) => ((s.match(/[㐀-鿿]/g) || []).length) / Math.max(s.length, 1);

// Calls in flight retain their window's object. After expiry their completions
// cannot change the next window's count or extend the old deadline.
const breakers = new Map();
function breakerFor(o) {
  const key = JSON.stringify([o.gatewayUrl, o.optimizeGroup]);
  let breaker = breakers.get(key);
  if (!breaker || (breaker.until && Date.now() >= breaker.until)) {
    breaker = { failures: 0, until: 0 };
    breakers.set(key, breaker);
  }
  return breaker;
}

// Replace `orig` (the extracted text) with `out` inside message `index`,
// touching only that one text span. Unique verbatim match first, then
// whitespace-normalized; zero or multiple hits → undefined (fail-open).
// Exported for tests.
export function replaceSpan(body, protocol, index, orig, out) {
  const key = protocol === "responses" ? "input" : protocol === "gemini" ? "contents" : "messages";
  const arr = body && body[key];
  if (!orig) return undefined;
  if (protocol === "responses" && typeof arr === "string") {
    if (index !== 0 || arr.trim() !== orig) return undefined;
    return { ...body, input: arr.replace(orig, () => out) };
  }
  if (!Array.isArray(arr) || !(arr[index] instanceof Object)) return undefined;
  const msg = { ...arr[index] };
  const arr2 = arr.slice();
  arr2[index] = msg;

  let slots;
  if (protocol === "gemini") {
    if (!Array.isArray(msg.parts)) return undefined;
    msg.parts = msg.parts.slice();
    slots = msg.parts
      .map((p, i) => (p && typeof p.text === "string" && !p.functionResponse ? { i, text: p.text } : null))
      .filter(Boolean);
  } else if (typeof msg.content === "string") {
    slots = [{ whole: true, text: msg.content }];
  } else if (Array.isArray(msg.content)) {
    msg.content = msg.content.slice();
    slots = msg.content
      .map((p, i) => (typeof p === "string" ? { i, text: p } : (p && typeof p.text === "string" && p.type !== "tool_result" ? { i, text: p.text } : null)))
      .filter(Boolean);
  } else return undefined;
  if (!slots.length) return undefined;

  const apply = (s, fn) => {
    if (s.whole) msg.content = fn(s.text);
    else if (protocol === "gemini") msg.parts[s.i] = { ...msg.parts[s.i], text: fn(s.text) };
    else if (typeof msg.content[s.i] === "string") msg.content[s.i] = fn(s.text);
    else msg.content[s.i] = { ...msg.content[s.i], text: fn(s.text) };
  };

  let total = 0;
  let winner;
  for (const s of slots) {
    for (let i = s.text.indexOf(orig); i !== -1; i = s.text.indexOf(orig, i + orig.length)) {
      total++;
      if (!winner) winner = { s };
    }
  }
  if (total > 1) return undefined;
  if (total === 1) {
    apply(winner.s, (t) => t.replace(orig, () => out));
    return { ...body, [key]: arr2 };
  }

  // Whitespace-normalized: any whitespace run (or none) between orig's
  // non-space chars — the message may reflow/wrap the same text.
  const re = new RegExp(orig.trim().split("").map((ch) => (/\s/.test(ch) ? "\\s+" : escapeRe(ch))).join("\\s*"), "g");
  total = 0;
  let m;
  for (const s of slots) {
    re.lastIndex = 0;
    while ((m = re.exec(s.text)) !== null) {
      total++;
      if (!winner) winner = { s, m: { index: m.index, len: m[0].length } };
    }
  }
  if (total !== 1) return undefined;
  apply(winner.s, (t) => t.slice(0, winner.m.index) + out + t.slice(winner.m.index + winner.m.len));
  return { ...body, [key]: arr2 };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
