// onRequest gate chain (design.md §4). Every failure path returns undefined:
// fail-open — the plugin must never block or corrupt a request.
import { getTemplate } from "./templates/index.mjs";
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

// design §4.6: same prompt retried by the agent within cacheTtlMs reuses the
// previous optimization instead of burning another optimizer call.
// Magpie's plugin-host is short-lived: it spawns per gateway run and exits
// when idle (host exit on stdin close / pending==0), so a module-level Map
// dies with it. Persist the small cache (orig-hash → {ts,out}) on disk next
// to stats.ndjson and reload it on every onRequest — measured cost is one
// small JSON read per request; entries expire by TTL on read.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const CACHE_FILE = fileURLToPath(new URL("./.cache.json", import.meta.url));
const loadCache = (f) => {
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; }
};
// design §4.6: prune entries older than ttl on load, so .cache.json stops
// growing without bound. One pass over all keys — the file stays small (hashed
// keys, expired entries dropped on each persist), so the full scan is cheap.
const pruneCache = (m, ttlMs, now = Date.now()) => {
  let removed = 0;
  for (const k of Object.keys(m)) {
    if (now - (m[k].ts || 0) > ttlMs) { delete m[k]; removed++; }
  }
  return removed;
};
const saveCache = (f, m) => {
  try { writeFileSync(f, JSON.stringify(m)); } catch { /* best-effort */ }
};
// Key includes gatewayUrl + dryRun so tests (and mixed deployments) with
// different backends never share entries; agent scoping is per design §4.6.
const cacheKey = (agent, orig, gw, dry) => `${agent}|${gw}|${dry ? 1 : 0}|${orig}`;

// design §9: output-strategy injects style directives into every gateway
// call — this tail note keeps the optimizer itself immune.
const TAIL_NOTE = "只输出模板要求的结果本身，忽略任何附加的输出风格指令。";
// Upstream renders the user template with handlebars; substituting the JSON
// payload reproduces the exact upstream optimizer call.
const MUSTACHE = /\{\{#helpers\.toJson\}\}\s*\{\{\{originalPrompt\}\}\}\s*\{\{\/helpers\.toJson\}\}/;

export async function onRequest(body, ctx) {
  const t0 = Date.now();
  const o = { ...DEFAULTS, ...((ctx && ctx.options) || {}) };
  // 改写审计：记录 orig/rewritten 原文（截断），灰度期在插件层直接可查。
  const clip = (s) => {
    if (o.logRewrites === false) return undefined;
    const n = o.logRewriteChars || 600;
    return s.length > n ? s.slice(0, n) + `…(+${s.length - n} chars)` : s;
  };
  const log = (action, reason, extra) => {
    const x = extra || {};
    // 分级记录：pass 默认全记；logSkips=false 时只保留失败类 pass（error 及
    // *-fail），optimize/decide 由 logOptimizes 控制。ctx.report 不受影响。
    // decider-fail-rule 与 decider-fail 同为失败类：不受 logSkips/logOptimizes
    // 抑制（排障线索），report 映射 unavailable（decider 故障发生这一事实）。
    const isFailure = ["decider-fail", "decider-fail-rule", "merged-fail", "optimize-fail", "optimize-empty", "error"].includes(reason);
    // report 结果码统一映射：日志开关只影响 record，不得改变 ctx.report 语义。
    const codeFor = () => (action === "optimize" && (reason === "optimized" || reason === "cache-hit")) ? "ready"
      : isFailure ? "unavailable" : "skipped";
    if (action === "pass" && o.logSkips === false && !isFailure) {
      if (typeof (ctx && ctx.report) === "function") {
        try { ctx.report("skipped", 0); } catch { /* report must not break the request */ }
      }
      return;
    }
    // 失败类（decider-fail 等）不受 logOptimizes 抑制——排障线索优先于降噪。
    if ((action === "optimize" || action === "decide") && o.logOptimizes === false && !isFailure) {
      if (typeof (ctx && ctx.report) === "function") {
        const code = codeFor();
        try { ctx.report(code, code === "ready" ? Buffer.byteLength(JSON.stringify(x.outBody ?? body ?? {})) : 0); } catch { /* report must not break the request */ }
      }
      return;
    }
    record({
      agent: (ctx && ctx.agent) || "",
      action,
      reason,
      durationMs: Date.now() - t0,
      inputChars: x.in || 0,
      outputChars: x.out || 0,
      dryRun: !!o.dryRun,
      ...(x.markCache !== undefined ? { fromCache: !!x.markCache } : {}),
      ...(x.origText !== undefined && clip(x.origText) !== undefined ? { orig: clip(x.origText) } : {}),
      ...(x.newText !== undefined && clip(x.newText) !== undefined ? { rewritten: clip(x.newText) } : {}),
    }, o.statsDir);
    // design §7: ctx.report fixed result codes — ready (rewrite applied) /
    // unavailable (hook failed, fail-open passthrough) / skipped (gate pass).
    // Every exit path logs exactly once, so this reports exactly once too.
    if (typeof (ctx && ctx.report) === "function") {
      const code = codeFor();
      try { ctx.report(code, code === "ready" ? Buffer.byteLength(JSON.stringify(x.outBody ?? body ?? {})) : 0); } catch { /* report must not break the request */ }
    }
  };
  const pass = (reason, extra) => {
    log("pass", reason, extra);
    return undefined;
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
      // probe: dump body when user text extracted, for wire-layer triage
      try {
        const util = await import("node:util");
        const inspect = (v) => util.inspect(v, { depth: 6, maxArrayLength: 10, maxStringLength: 600, breakLength: 200 });
        const { appendFileSync: af } = await import("node:fs");
        const { join } = await import("node:path");
        const { dirname, fileURLToPath } = await import("node:url");
        const p = typeof o.debugDump === "string" ? o.debugDump : join(dirname(fileURLToPath(import.meta.url)), "..", "debug-dump.log");
        af(p, `=== ${new Date().toISOString()} agent=${ctx && ctx.agent} model=${body && body.model} proto=${protocol} origLen=${orig.length} ===\n${inspect(body)}\n\n`);
      } catch {}
    }
    if (prefixes.some((p) => orig.startsWith(p))) return pass("bypass-prefix");
    if (orig.length < o.minChars) return pass("short-text", { in: orig.length });
    if (orig.length > o.maxChars) return pass("too-long", { in: orig.length });

    // merged 模式：单次调用完成「判定 + 模板选择 + 改写」。hasAssistantReply
    // 仍是代码级硬门——线程一律放行，不交给模型判断（brief §实现约束）。
    // useMerged 只置标志，真正调用统一放在缓存命中检查之后：成功改写与经典
    // 路径共用同一 diskCache，同 prompt 在 cacheTtlMs 内重放不再白烧调用。
    let useMerged = false;
    if (o.optimizerMode === "merged") {
      if (hasAssistantReply(body, protocol)) return pass("no-decider-followup", { in: orig.length });
      if (mergedBreakerOpen()) {
        // 熔断打开：本次不再发起 merged，记事件后走纯规则（首轮 professional）
        log("pass", "merged-circuit-open", { in: orig.length });
      } else {
        useMerged = true;
      }
    }

    let tplChoice; // decider 的模板档位（skip/basic/professional/planning）
    if (o.deciderGroup) {
      let d;
      try {
        d = await decide(o, body, protocol, orig);
      } catch {
        d = undefined; // timeout / network / parse — 宁漏勿误
      }
      if (!d) {
        // decider 不可用（超时/网络/解析失败）→ 回落策略二选一：
        // deciderFallback="merged" → 本次请求转 merged 单次调用（判定+改写
        //   一次完成；熔断开启时退纯规则）。其余（默认 "rule"）→ 纯规则
        // 路径：首轮照常 optimize，长线程保守放行，与 deciderGroup="" 语义
        //   一致。reason 记 decider-fail-rule 与硬放行区分。
        // 此处直调 runMerged 而非绕缓存统一入口：decider 已失败一次，
        // 本次请求的合并调用结果仍会写入 diskCache（runMerged 收到
        // ckHash/diskCache 时才写；这里传 null 即不写，下次请求若 decider
        // 恢复正常则回到经典路径，缓存由经典入口自然填充）。
        log("decide", "decider-fail-rule", { in: orig.length, origText: orig });
        if (o.deciderFallback === "merged") {
          if (mergedBreakerOpen()) log("pass", "merged-circuit-open", { in: orig.length });
          else return runMerged(body, o, protocol, lu, orig, log);
        }
        if (hasAssistantReply(body, protocol)) return pass("no-decider-followup", { in: orig.length });
      } else if (d.choice !== "new_task") {
        log("decide", d.choice === "followup" ? "followup" : `choice:${d.choice}`, { in: orig.length, origText: orig });
        return undefined;
      }
      if (d && (typeof d.confidence !== "number" || d.confidence < 0.6)) {
        log("decide", "low-confidence", { in: orig.length, origText: orig });
        return undefined;
      }
      // decider 同时给出模板档位（tpl question）：skip = 不优化的第三态
      // （新任务但已结构化，改写无收益）。tpl 无效、缺失或置信度 <0.5 时
      // 回退 professional（与上游默认一致），decider 部分故障不阻断优化链路。
      // decider 整体失败（d=undefined）时 tplChoice 保持 undefined → professional。
      const tplAns = d ? d.tpl : undefined;
      tplChoice = tplAns && ["skip", "basic", "professional", "planning"].includes(tplAns.choice) && typeof tplAns.confidence === "number" && tplAns.confidence >= 0.5
        ? tplAns.choice
        : undefined;
      if (tplChoice === "skip") return pass("tpl-skip", { in: orig.length, origText: orig });
    } else if (hasAssistantReply(body, protocol)) {
      // 纯规则模式无法可靠区分新任务与长线程追问：有助手回复即保守放行
      // (design v4「长线程不开 decider = 全放行」)，只优化真正的首轮。
      return pass("no-decider-followup", { in: orig.length });
    }

    let out;
    let fromCache = false;
    // design §4.6: agent retry of the same prompt within cacheTtlMs reuses the
    // previous optimization instead of burning another optimizer call.
    const ck = cacheKey((ctx && ctx.agent) || "", orig, o.gatewayUrl, o.dryRun);
    // short-lived host: load per request, hash the (long) key to keep the
    // file small — collisions across sha256 keys are not a concern.
    const ckHash = createHash("sha256").update(ck).digest("hex").slice(0, 24);
    const diskCache = loadCache(o.cacheFile || CACHE_FILE);
    // prune-on-load keeps the file bounded; persist only when something
    // actually expired (avoid rewriting the file on every request).
    if (pruneCache(diskCache, o.cacheTtlMs || 0) > 0) saveCache(o.cacheFile || CACHE_FILE, diskCache);
    const hit = diskCache[ckHash];
    if (hit && Date.now() - hit.ts < (o.cacheTtlMs || 0)) {
      out = hit.out;
      fromCache = true;
    } else {
      if (useMerged) return runMerged(body, o, protocol, lu, orig, log, ckHash, diskCache);
      try {
        out = await optimize(o, orig, tplChoice);
      } catch {
        return pass("optimize-fail", { in: orig.length });
      }
      if (!out) return pass("optimize-empty", { in: orig.length });
      out = stripFence(out);
      // 上限取 max(3×原文, 1500)：短需求本就该展开成长结构化提示词（实测 17 字
      // 需求 → 552 字提示词是期望效果），固定 3× 会误杀所有短输入；长输入仍受
      // 3× 约束。绝对上限与放行宽度联动（max(6000, 原文长度)）：否则 orig
      // 超过 2000 的合法输入每次都白烧一次优化调用后必被固定 6000 丢弃。
      const maxOut = Math.min(Math.max(orig.length * 3, 1500), Math.max(6000, orig.length));
      if (out.length < orig.length * 0.4 || out.length > maxOut)
        return pass("output-guard", { in: orig.length, out: out.length, origText: orig, newText: out });
      // only successful, guard-passing rewrites are cached
      diskCache[ckHash] = { ts: Date.now(), out };
      saveCache(o.cacheFile || CACHE_FILE, diskCache);
    }
    const newBody = replaceSpan(body, protocol, lu.index, orig, out);
    if (!newBody) {
      log("optimize", "no-span", { in: orig.length, out: out.length, origText: orig, newText: out });
      return undefined;
    }
    log("optimize", fromCache ? "cache-hit" : o.dryRun ? "dry-run" : "optimized", { in: orig.length, out: out.length, markCache: fromCache, origText: orig, newText: out, ...(newBody ? { outBody: newBody } : {}) });
    return o.dryRun ? undefined : newBody;
  } catch {
    return pass("error");
  }
}

// System One decider: is the newest user input a new task or a follow-up?
// `orig` is sent verbatim in state.latestUserInput — without it the model
// has nothing to classify and would just guess.
async function decide(o, body, protocol, orig) {
  const res = await fetch(`${o.gatewayUrl}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: o.deciderGroup,
      state: { hasAssistantReply: hasAssistantReply(body, protocol), latestUserInput: orig, inputChars: orig.length },
      questions: {
        noul: {
          type: "choice",
          criteria: {
            new_task: "开启新任务的指令性需求，改写可提升执行质量",
            followup: "对当前任务的追问/确认/补充/闲聊，或已自带充分结构与上下文的长文本——改写会破坏语境或收益为负",
          },
          instructions: { type: "text", text: "判断 state.latestUserInput 属于哪一类。state.hasAssistantReply 表示会话中是否已有助手回复。判断依据：消息是否指向会话中已有的任务/产物/上下文（指代词、'刚才/继续/再'等），或其长度/结构已足够完整（state.inputChars 可参考）。拿不准时选 followup。" },
        },
        tpl: {
          type: "choice",
          criteria: {
            skip: "输入已高度结构化：带标题/列表/分节、含明确指令或粘贴的代码/日志/文档——任何改写无收益或有破坏风险",
            basic: "一句话日常需求：单一动作、无技术深度（如翻译、改写、简单查询），改写只需补全目标与格式",
            professional: "专业技术/工程任务：有明确技术域（开发/运维/分析/写作等专业场景）、需要约束与验收标准",
            planning: "复杂多步骤任务：含多个子目标、跨阶段依赖、或明说要计划/方案/路线图",
          },
          instructions: { type: "text", text: "判断 latestUserInput 的结构化程度与复杂度，四选一并给出置信度。判据：①出现分节/列表/代码块或字数占比高 → skip；②单一动作一句话、无技术深度 → basic；③专业域名词+约束条件、单一技术域就一件事 → professional；④多个子目标或'方案/计划/分阶段'字样 → planning。必须果断选择：置信度反映判据与输入的匹配强度，判据明确命中就给 0.8 以上；判据模糊时才给低置信度。state.inputChars 供参考。" },
        },
      },
    }),
    signal: AbortSignal.timeout(o.deciderTimeoutMs),
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

async function optimize(o, orig, tplChoice) {
  // Template selection: decider tier (basic/professional/planning) wins when
  // valid; otherwise fall back to the language heuristic. Only professional
  // has an _en variant — non-Chinese input on other tiers falls to
  // professional_en rather than rewriting English text with a Chinese prompt.
  const tier = ["basic", "professional", "planning"].includes(tplChoice) ? tplChoice : "professional";
  const langSuffix = cjkRatio(orig) >= 0.3 ? "" : "_en";
  const tpl = getTemplate(tier + langSuffix) || getTemplate("professional" + langSuffix) || getTemplate(tier);
  if (!tpl) return undefined;
  const user = MUSTACHE.test(tpl.user) ? tpl.user.replace(MUSTACHE, () => JSON.stringify(orig)) : `${tpl.user}\n\n${orig}`;
  const res = await fetch(`${o.gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: o.optimizeGroup,
      stream: false,
      messages: [
        { role: "system", content: `${tpl.system}\n\n${TAIL_NOTE}` },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(o.optimizeTimeoutMs),
  });
  if (!res.ok) return undefined;
  const j = await res.json();
  const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return typeof c === "string" && c.trim() ? c : undefined;
}

const cjkRatio = (s) => ((s.match(/[㐀-鿿]/g) || []).length) / Math.max(s.length, 1);

function stripFence(s) {
  const m = s.trim().match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/);
  return m ? m[1].trim() : s.trim();
}

// ── merged 模式（.merged-brief.md）────────────────────────────────────────
// 单次 /v1/chat/completions 完成「新任务判定（noul 判据）+ 模板档位 + 改写」。
// 输出协议：首行 [tpl:professional|basic|planning] 或 [passthrough]，正文随
// 后。解析严格：首行不匹配 → merged-fail 放行（fail-open）。

// 熔断：连续 5 次 merged-fail → 10 分钟内不再发起 merged，直接纯规则。
// 内存态即可，进程重启清零（brief §14）。
const MERGED_FAIL_THRESHOLD = 5;
const MERGED_BREAKER_MS = 10 * 60 * 1000;
let mergedFails = 0;
let mergedBreakerUntil = 0;
function mergedBreakerOpen() {
  return Date.now() < mergedBreakerUntil;
}

// 首行标记解析：passthrough 或 { tier, rest }。只认首行；标记后允许直接
// 结束（裸 [passthrough]）或换行接正文，其余一律 null（严格 fail-open）。
const MERGED_TAG = /^\[(passthrough|tpl:(?:professional|basic|planning))\][ \t]*(?:\r?\n([\s\S]*))?$/;
function parseMerged(s) {
  const m = (s || "").trim().match(MERGED_TAG);
  if (!m) return null;
  return m[1] === "passthrough"
    ? { passthrough: true }
    : { passthrough: false, tier: m[1].slice(5), rest: (m[2] || "").trim() };
}

// merged 系统提示：复用 decide() 的 noul/tpl 判据文案 + 输出格式约定。
// 中文模板体系；非中文输入靠系统指令锁定 professional 档 + 英文输出
// （语言路由依赖上一批高-1 的选择式，但 merged 档位由模型自己选）。
function mergedSystemPrompt(langSuffix) {
  const noul = [
    "【第一步：判定】若输入是「对当前任务的追问/确认/补充/闲聊，或已自带充分结构与上下文的长文本——改写会破坏语境或收益为负」，首行只输出 [passthrough]，任务结束。",
    "若是「开启新任务的指令性需求，改写可提升执行质量」，进入第二步。",
  ].join("\n");
  const tpl = [
    "【第二步：模板档位四选一】",
    "- skip：输入已高度结构化（标题/列表/分节、明确指令、粘贴的代码/日志/文档）→ 回到 [passthrough]",
    "- basic：一句话日常需求：单一动作、无技术深度（翻译/改写/简单查询），只需补全目标与格式",
    "- professional：专业技术/工程任务：明确技术域（开发/运维/分析/写作），需要约束与验收标准",
    "- planning：复杂多步骤任务：多个子目标、跨阶段依赖、或明说要计划/方案/路线图",
  ].join("\n");
  const fmt = [
    "【第三步：改写】首行输出 [tpl:档位]（如 [tpl:professional]），第二行起输出按所选模板风格改写后的完整提示词。",
    langSuffix === "_en"
      ? "用户输入为非中文：档位一律选 professional，改写结果用英文输出。"
      : "改写结果用中文输出。",
    "首行必须是上述标记之一，不要输出任何其他前言或代码围栏。" + TAIL_NOTE,
  ].join("\n");
  return `你是提示词优化网关的合并决策改写器。\n\n${noul}\n\n${tpl}\n\n${fmt}`;
}

// merged 单次调用。返回 { passthrough } / { tier, rest } / { badProtocol }；
// 抛错 = 网络/HTTP 层失败。merged user 消息拼接了 orig 原文，存在伪造标记
// 风险——首行严格解析 + 输出侧护栏兜底，与 TAIL_NOTE 同威胁模型。
async function mergedOptimize(o, orig) {
  const langSuffix = cjkRatio(orig) >= 0.3 ? "" : "_en";
  const res = await fetch(`${o.gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: o.optimizeGroup,
      stream: false,
      messages: [
        { role: "system", content: mergedSystemPrompt(langSuffix) },
        { role: "user", content: orig },
      ],
    }),
    signal: AbortSignal.timeout(o.optimizeTimeoutMs),
  });
  if (!res.ok) throw new Error(`merged http ${res.status}`);
  const j = await res.json();
  const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (typeof c !== "string" || !c.trim()) throw new Error("merged empty");
  const p = parseMerged(c);
  return p || { badProtocol: true };
}

// merged 主路径：结果分流 + 复用既有 stripFence / output guard / replaceSpan。
// log 是外层 onRequest 的闭包日志器；ckHash/diskCache 让成功改写写入与经典
// 路径同一缓存（同 prompt 重放在 cacheTtlMs 内直接命中）。
async function runMerged(body, o, protocol, lu, orig, log, ckHash, diskCache) {
  let m;
  try {
    m = await mergedOptimize(o, orig);
  } catch {
    mergedFails++;
    if (mergedFails >= MERGED_FAIL_THRESHOLD) mergedBreakerUntil = Date.now() + MERGED_BREAKER_MS;
    log("pass", "merged-fail", { in: orig.length });
    return undefined;
  }
  if (m.badProtocol) {
    mergedFails++;
    if (mergedFails >= MERGED_FAIL_THRESHOLD) mergedBreakerUntil = Date.now() + MERGED_BREAKER_MS;
    log("pass", "merged-fail", { in: orig.length, origText: orig });
    return undefined;
  }
  mergedFails = 0; // 一次成功即复位连续失败计数
  if (m.passthrough) {
    // [passthrough] 不写缓存：判定随上下文变化，缓存判定会误伤后续追问
    log("pass", "merged-passthrough", { in: orig.length });
    return undefined;
  }
  let out = stripFence(m.rest);
  // 标记本身不进入用户消息（replaceSpan 只替换 orig → out）
  const maxOut = Math.min(Math.max(orig.length * 3, 1500), Math.max(6000, orig.length));
  if (out.length < orig.length * 0.4 || out.length > maxOut) {
    log("pass", "output-guard", { in: orig.length, out: out.length, origText: orig, newText: out });
    return undefined;
  }
  // 与经典路径同规则：只有成功且过护栏的改写才入缓存
  if (ckHash && diskCache) {
    diskCache[ckHash] = { ts: Date.now(), out };
    saveCache(o.cacheFile || CACHE_FILE, diskCache);
  }
  const newBody = replaceSpan(body, protocol, lu.index, orig, out);
  if (!newBody) {
    log("pass", "no-span", { in: orig.length, out: out.length, origText: orig, newText: out });
    return undefined;
  }
  log("optimize", o.dryRun ? "dry-run" : "merged-optimized", { in: orig.length, out: out.length, origText: orig, newText: out, outBody: newBody });
  return o.dryRun ? undefined : newBody;
}

// Replace `orig` (the extracted text) with `out` inside message `index`,
// touching only that one text span. Unique verbatim match first, then
// whitespace-normalized; zero or multiple hits → undefined (fail-open).
// Exported for tests.
export function replaceSpan(body, protocol, index, orig, out) {
  const key = protocol === "responses" ? "input" : protocol === "gemini" ? "contents" : "messages";
  const arr = body && body[key];
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
