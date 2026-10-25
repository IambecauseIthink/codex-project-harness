// Real Codex only: this script never substitutes a model response or a check result.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { initialize } from "../src/core/project.js";
import { HarnessService } from "../src/core/service.js";
import { git } from "../src/core/git.js";

const root = path.resolve(".cache", `live-product-${Date.now()}`);
await mkdir(root, { recursive: true });
await writeFile(
  path.join(root, "calc.mjs"),
  "export const add = (a, b) => a + b;\n",
);
await writeFile(
  path.join(root, "test.mjs"),
  "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { add } from './calc.mjs'; test('existing add',()=>assert.equal(add(2,3),5));\n",
);
await initialize(root, "真实 Codex 算术接入验收");
const service = new HarnessService(root);
const p = await service.store.project();
await service.saveProject({
  expectedRevision: p.revision,
  patch: {
    checks: [
      {
        id: "behavior",
        name: "Node 实际行为测试",
        command: [process.execPath, "--test", "test.mjs"],
        kind: "test",
        timeoutMs: 10000,
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
  "fixture baseline",
]);
await service.start();
const task = await service.saveTask({
  patch: {
    title: "增加乘法并保留加法",
    description:
      "只需在 calc.mjs 新增 multiply(a,b) 导出；在 test.mjs 添加正数、负数、零的真实用例，保留加法原有行为。没有其他需求。Harness 已提供完整上下文，不需要额外 MCP。",
    scopes: ["calc.mjs", "test.mjs"],
    acceptanceCriteria: [
      "multiply(2,3)=6，multiply(-2,3)=-6，multiply(0,3)=0",
      "add(2,3)=5；原测试继续通过",
    ],
  },
});
await service.authorize(task.id, task.revision);
const run = await service.dispatch(task.id);
console.log(JSON.stringify({ root, runId: run.id, threadId: run.threadId }));
let last = "";
const deadline = Date.now() + 12 * 60000;
try {
  while (Date.now() < deadline) {
    const r = await service.store.run(run.id);
    const label = `${r.state}/${r.phase}/${r.repairAttempts || 0}`;
    if (last !== label) {
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          state: label,
          threadId: r.threadId,
          reviewThreadId: r.reviewThreadId,
          error: r.error,
        }),
      );
      last = label;
    }
    if (r.state === "awaiting_input") {
      console.log(JSON.stringify({ pending: r.pendingRequest }));
      throw new Error("真实会话需要输入；保留项目供核对");
    }
    if (["failed", "unknown", "paused"].includes(r.state))
      throw new Error(r.error || r.state);
    if (r.state === "completed") {
      // Test fixture owner acceptance: exercise the shipped module from the candidate, then integration rechecks.
      const calc = await import(path.join(r.worktree, "calc.mjs"));
      if (
        calc.add(2, 3) !== 5 ||
        calc.multiply(2, 3) !== 6 ||
        calc.multiply(-2, 3) !== -6 ||
        calc.multiply(0, 3) !== 0
      )
        throw new Error("Fixture user acceptance failed");
      await service.accept(
        task.id,
        task.revision,
        "验收脚本实际调用加法和乘法入口，正数、负数、零均符合需求。仅为测试项目验收。",
      );
      const snapshot = await service.snapshot();
      await mkdir("docs/evidence", { recursive: true });
      const evidence = {
        at: new Date().toISOString(),
        kind: "real-codex-non-web",
        codex: snapshot.codex,
        root,
        taskId: task.id,
        run: snapshot.runs.find((x) => x.id === r.id),
        task: snapshot.tasks.find((x) => x.id === task.id),
        evidence: snapshot.evidence,
        desktopLinkVerified: false,
      };
      await writeFile(
        "docs/evidence/live-codex.json",
        JSON.stringify(evidence, null, 2),
      );
      console.log("REAL_CODEX_ACCEPTANCE_PASSED");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if ((await service.store.task(task.id)).state !== "done")
    throw new Error("真实执行超时");
} finally {
  await service.stop();
}
