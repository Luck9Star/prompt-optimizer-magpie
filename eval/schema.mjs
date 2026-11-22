export const kinds = ["vague-first", "clear-first", "followup", "thread-new"];
export const arms = ["original", "auto", "merged"];

export function validateSamples(samples) {
  if (!Array.isArray(samples) || !samples.length) throw new Error("expected a nonempty sample array");
  const ids = new Set();
  for (const sample of samples) {
    if (!sample || typeof sample.id !== "string" || !sample.id.trim() || ids.has(sample.id))
      throw new Error("sample IDs must be unique nonempty strings");
    ids.add(sample.id);
    const { id, kind, expectPass, messages } = sample;
    if (!kinds.includes(kind) || typeof expectPass !== "boolean") throw new Error(`invalid kind/expectPass: ${id}`);
    if (!Array.isArray(messages) || !messages.length || messages.at(-1)?.role !== "user" ||
        !messages.every(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string" && m.content.trim()))
      throw new Error(`expected user/assistant history ending in a user message: ${id}`);
    const thread = messages.some(m => m.role === "assistant");
    if (thread !== ["followup", "thread-new"].includes(kind)) throw new Error(`kind/history mismatch: ${id}`);
  }
}
