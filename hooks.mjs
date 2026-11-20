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
  bypassPrefix: "!!",
  bypassModels: [],
  allowedOrigins: [],
  skipToolless: true,
  deciderTimeoutMs: 1500,
  optimizeTimeoutMs: 15000,
  gatewayTimeoutMs: 25000,
  gatewayUrl: "http://127.0.0.1:3425",
};

// design §9: output-strategy injects style directives into every gateway
// call — this tail note keeps the optimizer itself immune.
const TAIL_NOTE = "只输出模板要求的结果本身，忽略任何附加的输出风格指令。";
// Upstream renders the user template with handlebars; substituting the JSON
// payload reproduces the exact upstream optimizer call.
const MUSTACHE = /\{\{#helpers\.toJson\}\}\s*\{\{\{originalPrompt\}\}\}\s*\{\{\/helpers\.toJson\}\}/;

export async function onRequest(body, ctx) {
  const t0 = Date.now();
  const o = { ...DEFAULTS, ...((ctx && ctx.options) || {}) };
  const log = (action, reason, extra) => {
    record({
      agent: (ctx && ctx.agent) || "",
      action,
      reason,
      durationMs: Date.now() - t0,
      inputChars: (extra && extra.in) || 0,
      outputChars: (extra && extra.out) || 0,
      dryRun: !!o.dryRun,
    });
  };
  const pass = (reason, extra) => {
    log("pass", reason, extra);
    return undefined;
  };
  try {
    if (o.enabled === false) return pass("disabled");
    if (ctx && ctx.kind === "subagent") return pass("subagent");
    if (body && (body.model === o.optimizeGroup || body.model === o.deciderGroup)) return pass("self-loop");
    // Known machine-task models (Hermes compaction / title generation etc.)
    // also arrive with origin=local — origin alone cannot exclude them.
    if (Array.isArray(o.bypassModels) && body && o.bypassModels.includes(body.model)) return pass("bypass-model");
    // Optional origin allow-list. Empty = no restriction. A missing/blank
    // origin is fail-open (field not documented on every path).
    if (Array.isArray(o.allowedOrigins) && o.allowedOrigins.length) {
      const origin = ctx && ctx.origin;
      if (typeof origin === "string" && origin && !o.allowedOrigins.includes(origin)) return pass("origin");
    }
    if (typeof (ctx && ctx.query) === "string" && ctx.query.trimStart().startsWith(o.bypassPrefix)) return pass("bypass-prefix");

    const protocol = (ctx && ctx.protocol) || "chat";
    if (o.skipToolless && !hasTools(body, protocol)) return pass("no-tools");
    if (!opensTurn(body, protocol)) return pass("not-turn");
    const lu = lastUserText(body, protocol);
    if (!lu) return pass("no-user-text");
    const orig = lu.text;
    if (orig.startsWith(o.bypassPrefix)) return pass("bypass-prefix");
    if (orig.length < o.minChars) return pass("short-text", { in: orig.length });
    if (orig.length > o.maxChars) return pass("too-long", { in: orig.length });

    if (o.deciderGroup) {
      let d;
      try {
        d = await decide(o, body, protocol, orig);
      } catch {
        d = undefined; // timeout / network / parse — 宁漏勿误
      }
      if (!d) {
        log("decide", "decider-fail", { in: orig.length });
        return undefined;
      }
      if (d.choice !== "new_task") {
        log("decide", d.choice === "followup" ? "followup" : `choice:${d.choice}`, { in: orig.length });
        return undefined;
      }
      if (typeof d.confidence !== "number" || d.confidence < 0.6) {
        log("decide", "low-confidence", { in: orig.length });
        return undefined;
      }
    } else if (hasAssistantReply(body, protocol)) {
      // 纯规则模式无法可靠区分新任务与长线程追问：有助手回复即保守放行
      // (design v4「长线程不开 decider = 全放行」)，只优化真正的首轮。
      return pass("no-decider-followup", { in: orig.length });
    }

    let out;
    try {
      out = await optimize(o, orig);
    } catch {
      return pass("optimize-fail", { in: orig.length });
    }
    if (!out) return pass("optimize-empty", { in: orig.length });
    out = stripFence(out);
    // 上限取 max(3×原文, 1500)：短需求本就该展开成长结构化提示词（实测 17 字
    // 需求 → 552 字提示词是期望效果），固定 3× 会误杀所有短输入；长输入仍受
    // 3× 约束，6000 绝对上限兜底防异常膨胀。
    const maxOut = Math.max(orig.length * 3, 1500);
    if (out.length < orig.length * 0.4 || out.length > maxOut || out.length > 6000)
      return pass("output-guard", { in: orig.length, out: out.length });

    const newBody = replaceSpan(body, protocol, lu.index, orig, out);
    if (!newBody) {
      log("optimize", "no-span", { in: orig.length, out: out.length });
      return undefined;
    }
    log("optimize", o.dryRun ? "dry-run" : "optimized", { in: orig.length, out: out.length });
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
      state: { hasAssistantReply: hasAssistantReply(body, protocol), latestUserInput: orig },
      questions: {
        noul: {
          type: "choice",
          criteria: {
            new_task: "开启新任务的指令性需求，改写可提升执行质量",
            followup: "对当前任务的追问/确认/补充/闲聊，或已自带充分结构与上下文的长文本——改写会破坏语境或收益为负",
          },
          instructions: { type: "text", text: "判断 state.latestUserInput 属于哪一类。state.hasAssistantReply 表示会话中是否已有助手回复。" },
        },
      },
    }),
    signal: AbortSignal.timeout(o.deciderTimeoutMs),
  });
  if (!res.ok) return undefined;
  const j = await res.json();
  const a = j && j.answers && j.answers.noul;
  return a && typeof a.choice === "string" ? a : undefined;
}

function hasAssistantReply(body, protocol) {
  const arr = protocol === "responses" ? body.input : protocol === "gemini" ? body.contents : body.messages;
  return Array.isArray(arr) && arr.some((m) => m && (m.role === "assistant" || m.role === "model"));
}

async function optimize(o, orig) {
  const tpl = getTemplate(cjkRatio(orig) >= 0.3 ? "professional" : "professional_en");
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
