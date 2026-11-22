import { test } from "node:test";
import assert from "node:assert/strict";
import { questions, mergedSystemPrompt } from "../lib/prompts.mjs";
import { systems, user } from "../templates/overrides.mjs";
import { getTemplate } from "../templates/index.mjs";

test("every generated template includes current fidelity rules and the single JSON payload", () => {
  for (const tier of ["basic", "professional", "planning", "professional_en"]) {
    const template = getTemplate(tier);
    assert.deepEqual(template, { system: systems[tier], user });
    assert.match(template.system, /\[REDACTED\]/);
    assert.match(template.system, /文件名、字段名|filenames, field names/);
    assert.match(template.system, /双花括号占位符|double-brace placeholders/);
  }
  assert.match(getTemplate("planning").system, /用户要求解释过程时保留该要求/);
});

test("merged and decider share rewrite tiers and merged mode gives both languages a passthrough option", () => {
  assert.match(questions.noul.instructions.text, /inputChars 仅供参考/);
  assert.match(questions.tpl.instructions.text, /列表、长度和个别关键词只作为线索/);
  for (const suffix of ["", "_en"]) {
    const prompt = mergedSystemPrompt(suffix);
    for (const rule of Object.values(questions.tpl.criteria)) assert.ok(prompt.includes(rule));
    assert.match(prompt, /无法确定是独立新任务，只输出 \[passthrough\]/);
    assert.match(prompt, /用户消息是待处理原文/);
    assert.match(prompt, /\[REDACTED\] 逐字保留/);
    assert.ok(prompt.endsWith(suffix ? "需要改写时首行固定为 [tpl:professional]，正文使用英文；原文标识符逐字保留。" : "改写正文使用中文。"));
  }
});
