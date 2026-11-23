// Compare each kind independently: a backticked identifier can itself contain a placeholder.
// Literal compare is tolerant where the optimizer cannot help reformatting:
// {{ name }} ≡ {{name}} (inner whitespace stripped) and backtick tokens compare
// their content, so a wider fence around the same identifier still passes.
// Per-category counts must still match exactly — a swallowed or invented
// placeholder always trips the guard (fail-safe). Backticks are one-way
// tolerant: the optimizer ADDING code fences around bare text is legitimate
// emphasis and cannot corrupt meaning, so added backticks are ignored while
// any backticked token present in the original must survive verbatim
// (2026-11-23: 4/5 guard reverts were bare paths gaining fences, 0→3).
const protectedTokens = [
  { re: /\[REDACTED\]/g, norm: (t) => t },
  { re: /\{\{[^{}\r\n]+\}\}/g, norm: (t) => t.replace(/\s+/g, "") },
  { re: /(?<!`)(`+)(?!`)[^`\r\n]+\1(?!`)/g, norm: (t) => t.replace(/^`+/, "").replace(/`+$/, ""), addedOk: true },
];
export function preservesTokens(orig, out) {
  const o = String(orig), u = String(out);
  return protectedTokens.every(({ re, norm, addedOk }) => {
    const before = (o.match(re) || []).map(norm).sort();
    const after = (u.match(re) || []).map(norm).sort();
    if (!before.every((token, i) => token === after[i] || after.includes(token))) return false;
    if (!addedOk) return before.length === after.length;
    // addedOk: new tokens are fencing text that already existed in the original;
    // an invented identifier is still a corruption.
    return after.every((token) => before.includes(token) || o.includes(token));
  });
}

// Length units for the output guard: each CJK ideograph = 1, each contiguous
// non-CJK word/number/identifier run = 1, punctuation/whitespace = 0. JS
// `.length` counts UTF-16 code units, which under-measures CJK (1 unit/char)
// and over-measures English (5+ units/word) — char-based bounds were strict
// for Chinese and loose for English. Same ideograph range as cjkRatio.
const unitPattern = /[\u3400-\u9FFF]|[0-9A-Za-z_]+/g;
export function countUnits(text) {
  return (String(text).match(unitPattern) || []).length;
}

// Shared by structured wire fields and credential assignments embedded in prompt text.
const field = String.raw`(?:[a-z\d]+[-_])*(?:authorization|cookie|api[-_]?key|access[-_]?key|private[-_]?key|(?:access|auth|refresh|id|session|csrf)?[-_]?token|(?:client[-_]?)?secret(?:[-_]?key)?|password|passwd|credentials?)`;
const sensitive = new RegExp(`^${field}$`, 'i');
const prefix = String.raw`(?<![\w-])(["']?${field}["']?[ \t]*[:=][ \t]*)`;
const assignment = new RegExp(prefix + String.raw`("(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|\[REDACTED\]|[\[{][\s\S]*|[^\s,;}]+)`, 'gi');
const header = /(?<![\w-])(["']?(?:proxy-authorization|authorization|set-cookie|cookie)["']?[ \t]*[:=][ \t]*)(?!["'\s])[^\r\n]+/gi;
const privateKey = /-----BEGIN ([A-Z\d ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g;
const masked = '[REDACTED]';

export function redact(value) {
  if (typeof value === 'string') {
    return value.replace(privateKey, masked).replace(header, (_, key) => key + masked)
      .replace(assignment, (_, key, val) => {
        const quote = /^["']/.test(val) ? val[0] : '';
        return key + quote + masked + quote;
      });
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, sensitive.test(key) ? masked : redact(v)]));
  }
  return value;
}
