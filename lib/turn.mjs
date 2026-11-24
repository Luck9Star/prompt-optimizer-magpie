// Turn detection for gateway requests in four API shapes (ctx.protocol:
// chat, responses, anthropic, gemini). Ported from
// @magpie-community/gateway-notify turn.mjs (MIT); lastUserText is new:
// it walks the trailing run of user entries, drops host-injected blocks
// (Codex <environment_context>, <system-reminder>, compaction summaries,
// notifications, tool results) and returns the last human text with its
// index in the top-level array.

const isObj = (v) => v !== null && typeof v === "object";

// Codex's own blocks, sent with role "user" from the codex binary.
const CODEX_CONTEXT = ["<environment_context>", "<user_instructions>", "# AGENTS.md instructions", "<INSTRUCTIONS>", "<subagent_notification>",
  "<turn_aborted>", "<user_shell_command>", "<skill>", "<model_switch>", "<personality_spec>", "<collaboration_mode>", "<apps_instructions>"]
const CODEX_SUMMARY = "Another language model started to solve this problem"
const CODEX_COMPACT = ["You are performing a CONTEXT CHECKPOINT COMPACTION"]
const CLAUDE_COMPACT = [
  "Your task is to create a detailed summary of the conversation so far",
  "Your task is to create a detailed summary of the RECENT portion of the conversation",
  "Your task is to create a detailed summary of this conversation",
  "Summarize the transcript inside <summary></summary> tags",
]
const CLAUDE_CONTINUED = "This session is being continued from a previous conversation"
const PROGRESS = "Describe your most recent action in 3-5 words"
const NOTIFICATION = "[SYSTEM NOTIFICATION - NOT USER INPUT]"

// Whole-message skip: machine narration, never the user's own words.
const SKIP_NEEDLES = [...CODEX_COMPACT, CODEX_SUMMARY, ...CLAUDE_COMPACT, CLAUDE_CONTINUED, PROGRESS, NOTIFICATION]

// Host-injected block tags stripped from candidate text; text around them
// is the user's own. "# AGENTS.md instructions" is not a tag block; the
// all-blocks check below covers it.
const tag = (name) => new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, "g")
// Host wrapper lines (billion-context / Feishu bridge), not user words.
const ACP_LINE = /<acp tokens="[^"]*"[^>]*>m\d+<\/acp>/g
const REPLYING_TO = /\[Replying to: "[^"]*"\]/g
// billion-context resume note. Three shapes, user text always wins:
// 1) "user text\n\n[billion-context] …" → strip note to end, keep text.
// 2) "[billion-context] …\n\nuser text" → note LEADS; keep what follows it.
// 3) "[billion-context] …" alone → not user text; return "" (caller's
//    `clean || undefined` drops the turn).
// shortcut: a multi-paragraph note's later paragraphs leak into case 2 —
// fail-open (optimizer sees note text), never loses user words.
const BC_RESUME = /(?:^|\n)\n?\[billion-context\][\s\S]*$/
// nanobot host appends a [Runtime Context] sandbox-metadata trailer to the
// user message — host words, never user words, and an optimizer rewrite of
// the span could mangle it. Shape chosen: paired-strip first (keep real
// user text after the closing tag), then trailer-strip to end for unclosed
// or trailing blocks — same fail-open cut as BC_RESUME: keep the text
// before, and a block-only message becomes "" (caller's `clean ||
// undefined` drops the turn).
const RUNTIME_CONTEXT_PAIRED = /(?:^|\n)\n?\[Runtime Context[^\]]*\][\s\S]*?\[\/Runtime Context\][^\S\n]*(?:\n|$)/g
const RUNTIME_CONTEXT_TRAILER = /(?:^|\n)\n?\[Runtime Context[^\]]*\][\s\S]*$/
export function stripBC(text) {
  const m = text.match(BC_RESUME);
  if (!m) return text;
  const before = text.slice(0, m.index);
  if (before.trim()) return before;
  return text.split(/\n\n+/).slice(1).join("\n\n").trim();
}
export function stripRuntimeContext(text) {
  const paired = text.replace(RUNTIME_CONTEXT_PAIRED, "");
  return paired === text ? text.replace(RUNTIME_CONTEXT_TRAILER, "") : paired;
}
// Strip leading host-injected noise (ACP tag lines and [Replying to: "..."]
// blocks) from the FRONT of the text only. Used by bypass-anchor and
// bypass-wrapper leading-match rules: the optimizer still sees the full
// original text; this is solely for the bypass judgment. Idempotent — both
// ACP lines and [Replying to] may appear multiple times in any order.
export function stripLeadingNoise(text) {
  let s = String(text ?? "");
  // Match anchored at the start, after optional whitespace, so the regex
  // `g` flag cannot drift to mid-text matches.
  const re = new RegExp(`^\\s*(?:${ACP_LINE.source}|${REPLYING_TO.source})\\s*`);
  let prev;
  do {
    prev = s;
    s = s.replace(re, "");
  } while (s !== prev);
  return s.trimStart();
}
const STRIP_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  tag("task-notification"),
  tag("environment_context"),
  tag("user_instructions"),
  tag("INSTRUCTIONS"),
  tag("subagent_notification"),
  tag("turn_aborted"),
  tag("user_shell_command"),
  tag("skill"),
  tag("model_switch"),
  tag("personality_spec"),
  tag("collaboration_mode"),
  tag("apps_instructions"),
  // OpenViking memory injection (opencode session-start): 16KB of
  // user-profile + available-memories prepended to real user text.
  tag("openviking-context"),
  // omp (openclaw multiplexer) UI autocomplete ghost text rides along in the
  // first user message; it is prediction noise, never user words.
  tag("composer-prediction"),
]

export function hasTools(body, protocol) {
  if (!isObj(body)) return false
  if (protocol === "gemini") return Array.isArray(body.tools) && body.tools.some((t) => isObj(t) && Object.keys(t).length)
  return Array.isArray(body.tools) && body.tools.length > 0
}

export function opensTurn(body, protocol) {
  if (!isObj(body)) return false
  switch (protocol) {
    case "responses": {
      if (typeof body.input === "string") return body.input.trim() !== ""
      if (!Array.isArray(body.input)) return false
      const last = body.input.at(-1)
      if (!isObj(last)) return false
      if (last.type != null && last.type !== "message") return false
      return last.role === "user" && !codexBlock(texts(last.content)) && !holds(last.content, [CODEX_SUMMARY])
    }
    case "anthropic": {
      const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined
      if (!isObj(last) || last.role !== "user") return false
      if (notificationOnly(last)) return false
      if (typeof last.content === "string") return true
      return Array.isArray(last.content) && !last.content.some((p) => isObj(p) && p.type === "tool_result")
    }
    case "gemini": {
      const last = Array.isArray(body.contents) ? body.contents.at(-1) : undefined
      if (!isObj(last) || (last.role != null && last.role !== "user")) return false
      return Array.isArray(last.parts) && !last.parts.some((p) => isObj(p) && p.functionResponse)
    }
    default: { // chat
      const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined
      return isObj(last) && last.role === "user"
    }
  }
}

// { index, text } of the last human user text, or undefined. index is the
// position in body.messages / body.input / body.contents. Only the trailing
// run of user entries is scanned: past an assistant/tool entry the text is
// a finished turn's, not the current one — returning it would optimize
// stale input.
export function lastUserText(body, protocol) {
  if (!isObj(body)) return undefined
  if (protocol === "responses" && typeof body.input === "string") {
    const t = body.input.trim()
    return t ? { index: 0, text: t } : undefined
  }
  const arr = protocol === "responses" ? body.input : protocol === "gemini" ? body.contents : body.messages
  if (!Array.isArray(arr)) return undefined
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i]
    if (!isObj(m)) break
    if (protocol === "gemini" ? m.role != null && m.role !== "user" : m.role !== "user") break
    if (protocol === "responses" && m.type != null && m.type !== "message") break
    const text = userTextOf(m, protocol)
    if (text) return { index: i, text }
  }
  return undefined
}

// Cleaned text of one user entry, or undefined to keep scanning backward.
function userTextOf(m, protocol) {
  let parts
  if (protocol === "gemini") {
    if (!Array.isArray(m.parts)) return undefined
    parts = m.parts.filter((p) => isObj(p) && typeof p.text === "string" && !p.functionResponse)
  } else {
    const c = m.content
    if (typeof c === "string") parts = [c]
    else if (Array.isArray(c)) parts = c.filter((p) => typeof p === "string" || (isObj(p) && typeof p.text === "string" && p.type !== "tool_result"))
    else return undefined
  }
  const texts = parts.map((p) => (typeof p === "string" ? p : p.text))
  if (!texts.length) return undefined // tool_result-only / functionResponse-only
  if (protocol === "responses" && codexBlock(texts)) return undefined
  if (texts.some((t) => SKIP_NEEDLES.some((n) => t.includes(n)))) return undefined
  let clean = texts.join("")
  for (const re of STRIP_BLOCKS) clean = clean.replace(re, "")
  clean = stripRuntimeContext(stripBC(clean.replace(ACP_LINE, "").replace(REPLYING_TO, "")))
  // Grok CLI wraps the whole user turn in <user_query>…</user_query>; unwrap
  // when it covers the message so the optimizer sees the raw prompt.
  const uq = clean.match(/^\s*<user_query>([\s\S]*?)<\/user_query>\s*$/)
  if (uq) clean = uq[1]
  clean = clean.trim()
  return clean || undefined
}

const texts = (c) => typeof c === "string" ? [c]
  : Array.isArray(c) ? c.flatMap((p) => typeof p === "string" ? [p] : isObj(p) && typeof p.text === "string" && p.type !== "tool_result" ? [p.text] : [])
  : []
const holds = (c, needles) => texts(c).some((t) => needles.some((n) => t.includes(n)))
const codexBlock = (ts) => ts.length > 0 && ts.every((x) => CODEX_CONTEXT.some((p) => x.trimStart().startsWith(p)))

// Claude Code's notification that a background task stopped — not user words.
const REMINDER_ONLY = /^\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+$/
const isNotification = (x) => x.includes(NOTIFICATION) || x.trimStart().startsWith("<task-notification>")
function notificationOnly(last) {
  const t = texts(last.content)
  if (!t.some(isNotification)) return false
  const hasToolResult = Array.isArray(last.content) && last.content.some((p) => isObj(p) && p.type === "tool_result")
  return !hasToolResult && t.every((x) => isNotification(x) || REMINDER_ONLY.test(x))
}
