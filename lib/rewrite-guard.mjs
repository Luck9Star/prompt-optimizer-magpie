// Compare each kind independently: a backticked identifier can itself contain a placeholder.
const protectedTokens = [/\[REDACTED\]/g, /\{\{[^{}\r\n]+\}\}/g, /(?<!`)(`+)(?!`)[^`\r\n]+\1(?!`)/g];
export function preservesTokens(orig, out) {
  return protectedTokens.every((pattern) => {
    const before = (orig.match(pattern) || []).sort();
    const after = (out.match(pattern) || []).sort();
    return before.length === after.length && before.every((token, i) => token === after[i]);
  });
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
