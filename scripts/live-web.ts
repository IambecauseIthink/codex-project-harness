import { chromium, expect } from "@playwright/test";
import { mkdir, cp, writeFile } from "node:fs/promises";
import path from "node:path";
import { initialize } from "../src/core/project.js";
import { serve } from "../src/server/api.js";
import { git } from "../src/core/git.js";

const root = path.resolve(".cache", `live-web-${Date.now()}`);
await mkdir(root, { recursive: true });
await cp("examples/web", root, { recursive: true });
const project = await initialize(root, "真实 Web 产品验收");
const app = await serve(root, 0);
const service = app.workspace.service(project.id);
const p = await service.store.project();
await service.saveProject({
  expectedRevision: p.revision,
  patch: {
    checks: [
      {
        id: "http",
        name: "真实 HTTP 流程",
        kind: "e2e",
        command: [process.execPath, "--test", "test.mjs"],
        timeoutMs: 20000,
      },
    ],
  },
});
await git(root, ["init", "-b", "main"]);
await git(root, ["add", "."]);
await git(root, [
  "-c",
  "user.name=Harness acceptance",
  "-c",
  "user.email=harness@localhost",
  "commit",
  "-m",
  "web baseline",
]);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
try {
  await page.goto(`${app.url}/#token=${app.token}`);
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByLabel("任务标题").fill("按名字生成问候，保留默认问候");
  await page
    .getByLabel("目标与范围")
    .fill(
      "修改 server.mjs 的 /api/greeting，读取 name 参数；非空名字返回 你好，<名字>，空白或缺省返回原有 你好，朋友。页面已有表单与 fetch，请保证完整流程连通。在 test.mjs 添加中文、空白、特殊字符的真实 HTTP 用例，保留原测试。无需其他功能。Harness 已提供上下文，不需额外 MCP。",
    );
  await page
    .getByLabel("验收条件")
    .fill(
      "页面填写 小林 后生成 你好，小林\n空白和缺省仍为 你好，朋友\n输入 <script> 不执行脚本，原样作为文本显示",
    );
  await page.getByRole("button", { name: "保存任务" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "任务看板" }).click();
  await page.locator(".task-card").click();
  await page.getByRole("button", { name: "确认范围并纳入计划" }).click();
  await page.locator(".task-card").click();
  await page.getByRole("button", { name: "派发到新会话" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const task = (await service.store.tasks())[0];
  const started = await service.store.run(task.currentRunId!);
  console.log(
    JSON.stringify({ root, runId: started.id, threadId: started.threadId }),
  );
  await page.locator(".task-card").click();
  await expect(
    page.getByRole("link", { name: "打开 Codex 会话" }),
  ).toHaveAttribute("href", `codex://threads/${started.threadId}`);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const deadline = Date.now() + 12 * 60000;
  let last = "";
  while (Date.now() < deadline) {
    const r = await service.store.run(started.id);
    if (last !== r.state) {
      console.log(
        JSON.stringify({
          state: r.state,
          reviewThreadId: r.reviewThreadId,
          error: r.error,
        }),
      );
      last = r.state;
    }
    if (["failed", "unknown", "paused", "awaiting_input"].includes(r.state))
      throw new Error(
        JSON.stringify({ error: r.error, pending: r.pendingRequest }),
      );
    if (r.state === "completed") {
      const product = (await import(path.join(r.worktree, "server.mjs"))).app();
      await new Promise<void>((resolve) =>
        product.listen(0, "127.0.0.1", resolve),
      );
      try {
        const productPage = await browser.newPage();
        await productPage.goto(`http://127.0.0.1:${product.address().port}`);
        for (const [name, output] of [
          ["小林", "你好，小林"],
          ["  ", "你好，朋友"],
          ["<script>alert(1)</script>", "你好，<script>alert(1)</script>"],
        ]) {
          await productPage.getByLabel("你的名字").fill(name);
          await productPage.getByRole("button", { name: "生成问候" }).click();
          await expect(productPage.getByRole("status")).toHaveText(output);
        }
        await productPage.close();
      } finally {
        await new Promise<void>((resolve) => product.close(resolve));
      }
      await page.locator(".task-card").click();
      await expect(
        page.getByRole("button", { name: "已体验，验收并集成" }),
      ).toBeVisible({ timeout: 20000 });
      await page.getByRole("button", { name: "已体验，验收并集成" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const snapshot = await service.snapshot();
      if (snapshot.tasks[0].state !== "done")
        throw new Error("Integration did not complete");
      await mkdir("docs/evidence", { recursive: true });
      await writeFile(
        "docs/evidence/live-web.json",
        JSON.stringify(
          {
            at: new Date().toISOString(),
            kind: "real-codex-web",
            root,
            task: snapshot.tasks[0],
            runs: snapshot.runs,
            evidence: snapshot.evidence,
            browser: {
              version: await browser.version(),
              cases: 3,
              dispatchFromBoard: true,
              acceptedFromBoard: true,
              deepLinkMatchesThread: true,
              desktopOpened: false,
            },
          },
          null,
          2,
        ),
      );
      await page.getByRole("button", { name: "执行追踪", exact: true }).click();
      await page.screenshot({
        path: "docs/evidence/live-trace.png",
        fullPage: true,
      });
      console.log("REAL_WEB_BOARD_ACCEPTANCE_PASSED");
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if ((await service.store.task(task.id)).state !== "done")
    throw new Error("Live web deadline exceeded");
} finally {
  await browser.close();
  await app.close();
}
