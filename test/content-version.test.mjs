import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { contentVersion } from "../templates/index.mjs";
import { readRewrite, rewriteCacheKey, writeRewrite } from "../lib/rewrite-cache.mjs";

test("published prompt content isolates cached rewrites; identical content replays after rollback", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pom-content-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = { cacheFile: join(dir, "cache"), cacheTtlMs: 60000 };
  const args = ["agent", "请帮我写一份说明", options, "rule", "basic"];
  writeRewrite(options, rewriteCacheKey(...args), "original version");
  assert.match(contentVersion, /^[a-f0-9]{64}$/);

  const copies = [
    ["templates/index.mjs", "用一两句自然的指令"], // generated template
    ["lib/prompts.mjs", "只输出模板要求的结果本身"], // classic tail
    ["lib/prompts.mjs", "inputChars 仅供参考"], // decider
    ["lib/prompts.mjs", "正文使用英文"], // merged English
    ["lib/prompts.mjs", "改写正文使用中文"], // merged Chinese
    ["lib/prompts.mjs", "(professional|basic|planning)"], // receiving grammar
    [], // unchanged content in a fresh install
  ];
  for (const [i, [target, before]] of copies.entries()) {
    const copy = join(dir, String(i));
    for (const file of ["lib/prompts.mjs", "templates/index.mjs", "lib/rewrite-cache.mjs"]) {
      let src = readFileSync(new URL("../" + file, import.meta.url), "utf8");
      if (file === target) {
        assert.ok(src.includes(before));
        src = src.replace(before, before + "x");
      }
      mkdirSync(join(copy, file.split("/")[0]), { recursive: true });
      writeFileSync(join(copy, file), src);
    }
    const { contentVersion: version } = await import(pathToFileURL(join(copy, "templates/index.mjs")));
    const { rewriteCacheKey: key } = await import(pathToFileURL(join(copy, "lib/rewrite-cache.mjs")));
    assert.equal(version === contentVersion, !target);
    assert.equal(readRewrite(options, key(...args)), target ? undefined : "original version");
  }
});
