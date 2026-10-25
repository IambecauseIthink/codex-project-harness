import { chromium, expect } from "@playwright/test";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fixture } from "../tests/helpers.js";
import { serve } from "../src/server/api.js";

const reportDir =
  process.env.HARNESS_EVIDENCE_DIR || ".harness/runtime/test-reports";
const f = await fixture();
const app = await serve(f.root, 0);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(`${app.url}/#token=${app.token}`);
  await expect(
    page.getByRole("heading", { name: "把每一次改动，接起来。" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByLabel("任务标题").fill("浏览器创建：完整结账流程");
  await page
    .getByLabel("目标与范围")
    .fill("保留已有购物车，完成付款后返回订单确认。");
  await page
    .getByLabel("验收条件")
    .fill("提交订单后看到确认页\n原购物车流程继续通过");
  await page.getByLabel("前置任务").selectOption([f.task.id]);
  await page.getByRole("button", { name: "保存任务" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "任务看板" }).click();
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", { name: "浏览器创建：完整结账流程" }),
    })
    .click();
  await page.getByRole("button", { name: "确认范围并纳入计划" }).click();
  await expect(
    page.locator(".task-card").filter({ hasText: "浏览器创建" }),
  ).toContainText("等待 增加乘法");
  await page.getByRole("button", { name: "依赖网络", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await mkdir(reportDir, { recursive: true });
  await page.screenshot({
    path: path.join(reportDir, "dependencies.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "项目记忆", exact: true }).click();
  await page.getByRole("button", { name: "添加记录", exact: true }).click();
  await page.getByLabel("标题", { exact: true }).fill("付款回归教训");
  await page.getByLabel("类型").selectOption("lesson");
  await page
    .getByLabel("内容", { exact: true })
    .fill("重构支付时保留购物车。必须执行行为回归。");
  await page.getByLabel("防复发检查").selectOption("behavior");
  await page.getByLabel("关联任务或记录").selectOption(f.task.id);
  await page.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "付款回归教训" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "影响地图", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(4);
  await page.getByRole("button", { name: "配置与接入", exact: true }).click();
  await expect(page.getByLabel("质量检查配置")).toContainText("behavior");
  await page.getByRole("button", { name: "项目总览", exact: true }).click();
  await page.screenshot({
    path: path.join(reportDir, "dashboard.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 850, height: 1000 });
  await expect(page.getByLabel("当前项目")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "接入项目", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "任务看板" }).click();
  await expect(page.locator(".board")).toBeVisible();
  if (errors.length) throw new Error(errors.join("\n"));
  await writeFile(
    path.join(reportDir, "browser.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        engine: await browser.version(),
        passed: true,
        checks: [
          "真实页面创建和授权任务",
          "依赖阻塞显示",
          "React Flow 节点与边",
          "教训记录和检查关联",
          "项目设置",
          "850px 布局",
          "无浏览器异常",
        ],
        desktopDeepLinkOpened: false,
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(reportDir, "browser-result.json"),
    JSON.stringify({ passed: 7, failed: 0, skipped: 0 }),
  );
  console.log("BROWSER_SMOKE_PASSED");
} finally {
  await browser.close();
  await app.close();
  await f.cleanup();
}
