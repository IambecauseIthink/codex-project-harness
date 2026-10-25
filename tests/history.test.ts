import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fixture, FakeCodex } from "./helpers.js";
import { TaskSchema, RecordSchema } from "../src/core/types.js";
import { prepareContext } from "../src/core/context.js";
import { HarnessService, validateGraph } from "../src/core/service.js";
import { backup, restore } from "../src/core/project.js";
import { serve } from "../src/server/api.js";
import { chromium, expect } from "@playwright/test";

test(
  "模拟两年：7300 任务、1460 知识记录，倒序长依赖、检索、限定上下文与冷启动",
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      const count = 7300;
      const start = Date.now();
      const tasks = [];
      for (let i = 0; i < count; i++) {
        const date = new Date(
          Date.UTC(2024, 9, 25) + Math.floor(i / 10) * 86400000,
        ).toISOString();
        tasks.push(
          TaskSchema.parse({
            id: `historical-${String(i).padStart(5, "0")}`,
            title: `历史事项 ${i}`,
            description: `模拟数据：需求演进 ${i}`,
            revision: 1,
            state: i === count - 1 ? "draft" : "done",
            archived: i < count - 10,
            version: i < count - 10 ? "v0" : "v1",
            dependsOn: i
              ? [`historical-${String(i - 1).padStart(5, "0")}`]
              : [],
            createdAt: date,
            updatedAt: date,
          }),
        );
      }
      validateGraph([...tasks].reverse()); // Long chain must not overflow the JS call stack.
      for (let i = 0; i < tasks.length; i += 32)
        await Promise.all(
          tasks.slice(i, i + 32).map((t) => f.service.store.saveTask(t)),
        );
      const records = Array.from({ length: 1460 }, (_, i) =>
        RecordSchema.parse({
          id: `memory-${i}`,
          kind: i % 2 ? "decision" : "lesson",
          title: `模拟长期记录 ${i}`,
          body: `依据与适用范围 ${i}`,
          revision: 1,
          status: i < 1400 ? "archived" : "active",
          scopes: [i === 1459 ? "calc" : `other/${i}`],
          createdAt: "2024-10-25T00:00:00.000Z",
          updatedAt: "2026-10-24T00:00:00.000Z",
        }),
      );
      for (let i = 0; i < records.length; i += 32)
        await Promise.all(
          records.slice(i, i + 32).map((r) => f.service.store.saveRecord(r)),
        );
      const seededMs = Date.now() - start;
      const readStart = Date.now();
      const snapshot = await f.service.snapshot();
      const snapshotMs = Date.now() - readStart;
      assert.equal(snapshot.tasks.length, count + 1);
      assert.equal(snapshot.records.length, 1461);
      assert.equal(snapshot.tasks.filter((t) => !t.archived).length, 11);
      assert.ok(snapshot.tasks.every((t) => t.assurance === "unknown")); // A simulated historical 'done' is never proof.
      const packet = await prepareContext(f.service.store, f.task);
      assert.ok(packet.text.length < 4000);
      assert.match(packet.text, /1459/);
      assert.doesNotMatch(packet.text, /模拟长期记录 1000/);
      const exact = snapshot.records.find((r) => r.id === "memory-1000");
      assert.equal(exact?.status, "archived");
      await f.service.stop();
      const cold = new HarnessService(f.root, new FakeCodex());
      const coldStart = Date.now();
      await cold.start();
      const recovered = await cold.snapshot();
      assert.equal(recovered.tasks.length, count + 1);
      await cold.stop();
      const coldStartMs = Date.now() - coldStart;
      let graphBrowserVerified = false;
      if (process.env.HARNESS_SCALE_BROWSER === "1") {
        const app = await serve(f.root, 0);
        const browser = await chromium.launch({
          channel: "chrome",
          headless: true,
        });
        try {
          const page = await browser.newPage({
            viewport: { width: 1500, height: 1000 },
          });
          await page.goto(`${app.url}/#token=${app.token}`);
          await page
            .getByRole("button", { name: "依赖网络", exact: true })
            .click();
          await expect(page.locator(".react-flow__node")).toHaveCount(12, {
            timeout: 30000,
          });
          await page.getByLabel("包含归档").check();
          await expect(page.locator(".react-flow__node")).toHaveCount(100, {
            timeout: 30000,
          });
          await page.getByPlaceholder("查找任务…").fill("历史事项 7299");
          await expect(page.locator(".react-flow__node")).toHaveCount(2, {
            timeout: 30000,
          });
          await expect(page.locator(".react-flow__edge")).toHaveCount(1);
          graphBrowserVerified = true;
        } finally {
          await browser.close();
          await app.close();
        }
      }
      const reportDir =
        process.env.HARNESS_EVIDENCE_DIR || ".harness/runtime/test-reports";
      await mkdir(reportDir, { recursive: true });
      await writeFile(
        path.join(reportDir, "history-scale.json"),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            simulatedDays: 730,
            tasks: count,
            knowledgeRecords: records.length,
            seededMs,
            snapshotMs,
            coldStartMs,
            graphBrowserVerified,
            contextChars: packet.chars,
            activeTaskCount: 11,
            note: "模拟规模数据；不能证明实际连续运行两年可靠。",
          },
          null,
          2,
        ),
      );
    } finally {
      await f.cleanup();
    }
  },
);
test("修改保留原任务版本，写入事务中断后恢复完整记录", async () => {
  const f = await fixture();
  try {
    await f.service.saveTask({
      id: f.task.id,
      expectedRevision: 1,
      patch: { title: "new revision" },
    });
    const old = await readFile(
      path.join(
        f.root,
        ".harness/history/backlog/tasks",
        f.task.id,
        "rev-1.md",
      ),
      "utf8",
    );
    assert.match(old, /增加乘法/);
    await writeFile(
      path.join(f.root, ".harness/runtime/transaction.json"),
      JSON.stringify([
        { relative: "archive/recovery-note.md", content: "durable-intent" },
      ]),
    );
    await f.service.store.recover();
    assert.equal(
      await readFile(
        path.join(f.root, ".harness/archive/recovery-note.md"),
        "utf8",
      ),
      "durable-intent",
    );
  } finally {
    await f.cleanup();
  }
});
