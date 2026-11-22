// Run this as a standalone process. Offline mode supplies deterministic gateway fixtures.
import { randomInt, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { arms, validateSamples } from "./schema.mjs";

const args = process.argv.slice(2);
const live = args[0] === "--live";
if (live || args[0] === "--dry-run") args.shift();
if (args.length !== 2) throw new Error("Usage: node eval/generate.mjs [--dry-run|--live] samples.json NEW_RUN_DIR");
const [source, dest] = args;
const samples = JSON.parse(readFileSync(source, "utf8"));
validateSamples(samples);

const { EVAL_DOWNSTREAM_URL, EVAL_MODEL, EVAL_API_KEY } = process.env;
if (live && (!EVAL_DOWNSTREAM_URL || !EVAL_MODEL)) throw new Error("--live needs EVAL_DOWNSTREAM_URL and EVAL_MODEL");
const model = live ? EVAL_MODEL : "offline-fixture";
const endpoint = live ? EVAL_DOWNSTREAM_URL : "http://offline.invalid/completions";
const system = "请直接完成用户要求的文本任务。仅使用给定的对话材料。";
const conditions = { model, temperature: 0, max_tokens: 800, stream: false };
mkdirSync(dest, { mode: 0o700 });
const scratch = mkdtempSync(join(tmpdir(), "pom-eval-"));
const review = [], entries = [];
let current;
const realFetch = globalThis.fetch;
if (!live) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const original = current.messages.at(-1).content;
    const rewrite = `请完成以下文本任务：${original}`;
    const completion = content => Response.json({ choices: [{ message: { content } }] });
    if (url === endpoint) return completion(`离线占位输出：${body.messages.at(-1).content}`);
    if (new URL(url).pathname === "/v1/systemone")
      return Response.json({ answers: {
        noul: { choice: current.kind === "followup" ? "followup" : "new_task", confidence: 1 },
        tpl: { choice: current.expectPass ? "skip" : "basic", confidence: 1 },
      } });
    if (new URL(url).pathname !== "/v1/chat/completions") throw new Error("unexpected offline endpoint");
    if (body.messages.at(-1).content === original)
      return completion(current.expectPass ? "[passthrough]" : `[tpl:basic]\n${rewrite}`);
    return completion(rewrite);
  };
}
try {
  for (const sample of samples) {
    current = sample;
    const messages = [{ role: "system", content: system }, ...sample.messages.map(({ role, content }) => ({ role, content }))];
    for (const arm of arms) {
      const body = { ...conditions, messages };
      let patched;
      if (arm !== "original") {
        let status;
        patched = await onRequest(body, { agent: "offline-eval", protocol: "chat", report: code => { status = code; }, options: {
          optimizerMode: arm, gatewayUrl: process.env.EVAL_OPTIMIZER_GATEWAY || "http://127.0.0.1:3425",
          dryRun: false, skipToolless: false, logRewrites: false, cacheTtlMs: 0, statsDir: scratch,
        } });
        if (status === "unavailable") throw new Error(`optimizer unavailable: ${sample.id}/${arm}`);
      }
      const request = patched || body;
      const headers = { "content-type": "application/json" };
      if (live && EVAL_API_KEY) headers.authorization = `Bearer ${EVAL_API_KEY}`;
      const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(request), signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`downstream HTTP ${response.status}: ${sample.id}`);
      const answer = (await response.json()).choices?.[0]?.message?.content;
      if (typeof answer !== "string" || !answer.trim()) throw new Error(`missing downstream answer: ${sample.id}`);
      const id = randomUUID();
      const prompt = request.messages.at(-1).content;
      entries.push({ id, sample: sample.id, kind: sample.kind, arm, expectPass: sample.expectPass, changed: prompt !== messages.at(-1).content });
      review.push({ id, sample: sample.id, conversation: messages, prompt, answer, lostConstraint: null, addedConstraint: null, usability: null, note: "" });
    }
  }
  for (let i = review.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [review[i], review[j]] = [review[j], review[i]];
  }
  for (const [file, data] of [["key.json", { runMode: live ? "live" : "offline", conditions: { ...conditions, system }, entries }], ["review.json", review]])
    writeFileSync(join(dest, file), JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
} finally {
  globalThis.fetch = realFetch;
  rmSync(scratch, { recursive: true, force: true });
}
