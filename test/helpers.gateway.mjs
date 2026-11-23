import { createServer } from "node:http";

// Minimal gateway mock: `/v1/chat/completions` returns `{optimize}` as the
// completion content; `/v1/systemone` returns `{decider}` as answers.noul.
// `hang` paths never respond (timeout tests); `raw` returns a literal body.
export function mockGateway({ optimize = "ok", decider = { choice: "new_task", confidence: 0.9 }, hang = [], deciderStatus = 200, deciderRaw, optimizeStatus = 200, finishReason, failDecider, failMerged, failOptimize } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      const body = buf ? JSON.parse(buf) : {};
      seen.push({ path: req.url, body });
      if (hang.includes(req.url)) return; // never respond
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/systemone") {
        res.statusCode = deciderStatus;
        if (failDecider) { res.statusCode = failDecider.status; res.end(JSON.stringify({ error: failDecider.message })); return; }
        const answers = { noul: decider };
        if (decider && decider.tpl) answers.tpl = decider.tpl;
        res.end(deciderRaw !== undefined ? deciderRaw : JSON.stringify({ answers }));
      } else if (failMerged || failOptimize) {
        const f = failMerged || failOptimize;
        res.statusCode = f.status;
        res.end(JSON.stringify({ error: f.message }));
      } else if (optimizeStatus !== 200) {
        res.statusCode = optimizeStatus;
        res.end(JSON.stringify({ error: "mock optimize failure" }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: optimize }, ...(finishReason && { finish_reason: finishReason }) }] }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        seen,
        close: () => server.close(),
      });
    });
  });
}
