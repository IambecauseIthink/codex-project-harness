import { chromium, expect } from "@playwright/test";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { HarnessService } from "../src/core/service.js";

const previous = JSON.parse(
  await readFile("docs/evidence/live-web.json", "utf8"),
);
const root = previous.root;
const service = new HarnessService(root);
await service.start();
const first = (await service.store.tasks())[0];
const task = await service.saveTask({
  patch: {
    title: "第二轮：增加英文问候，保留所有中文行为",
    description:
      "在已验收的问候产品上，给页面增加带可访问标签「语言」的 select，值 zh/en，默认 zh。表单发送 lang 参数。lang=en 时返回 Hello, <名字>，空名使用 friend；zh 或缺省沿用原有 你好，<名字> 和默认 朋友。为 HTTP 添加英文用例，保留已有全部用例和文本安全处理。只改 server.mjs、test.mjs。无需额外 MCP。",
    scopes: ["server.mjs", "test.mjs"],
    dependsOn: [first.id],
    acceptanceCriteria: [
      "中文既有问候、默认问候保持不变",
      "选择英文并输入 Ada 后返回 Hello, Ada",
      "英文空白名字返回 Hello, friend",
      "含 HTML 的名字仍只作为文本",
    ],
  },
});
await service.authorize(task.id, 1);
const run = await service.dispatch(task.id);
console.log(JSON.stringify({ root, taskId: task.id, threadId: run.threadId }));
try {
  const deadline = Date.now() + 12 * 60000;
  let last = "";
  while (Date.now() < deadline) {
    const r = await service.store.run(run.id);
    if (r.state !== last) {
      console.log(r.state, r.error || "");
      last = r.state;
    }
    if (["failed", "paused", "unknown", "awaiting_input"].includes(r.state))
      throw new Error(JSON.stringify(r.pendingRequest || r.error));
    if (r.state === "completed") {
      const product = (await import(path.join(r.worktree, "server.mjs"))).app();
      await new Promise<void>((resolve) =>
        product.listen(0, "127.0.0.1", resolve),
      );
      const browser = await chromium.launch({
        channel: "chrome",
        headless: true,
      });
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${product.address().port}`);
        for (const [language, name, output] of [
          ["zh", "小林", "你好，小林"],
          ["zh", " ", "你好，朋友"],
          ["en", "Ada", "Hello, Ada"],
          ["en", " ", "Hello, friend"],
          ["en", "<img onerror=alert(1)>", "Hello, <img onerror=alert(1)>"],
        ]) {
          await page.getByLabel("语言").selectOption(language);
          await page.getByLabel("你的名字").fill(name);
          await page.getByRole("button", { name: "生成问候" }).click();
          await expect(page.getByRole("status")).toHaveText(output);
        }
      } finally {
        await browser.close();
        await new Promise<void>((resolve) => product.close(resolve));
      }
      await service.accept(
        task.id,
        1,
        "第二轮真实产品验收：中文原流程、英文、空名和 HTML 文本共 5 个浏览器场景通过。",
      );
      const snapshot = await service.snapshot();
      await writeFile(
        "docs/evidence/live-change.json",
        JSON.stringify(
          {
            at: new Date().toISOString(),
            kind: "real-second-change-same-web-project",
            root,
            tasks: snapshot.tasks,
            runs: snapshot.runs,
            evidence: snapshot.evidence,
            browserCases: 5,
            modelMocked: false,
          },
          null,
          2,
        ),
      );
      console.log("REAL_SECOND_CHANGE_ACCEPTANCE_PASSED");
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if ((await service.store.task(task.id)).state !== "done")
    throw new Error("Second change deadline exceeded");
} finally {
  await service.stop();
}
