import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initialize } from "../src/core/project.js";
import { git } from "../src/core/git.js";
import { HarnessService } from "../src/core/service.js";
import { CodexClient } from "../src/codex/client.js";

export class FakeCodex extends CodexClient {
  starts: { id: string; cwd: string; readOnly: boolean }[] = [];
  turns: { threadId: string; text: string; schema?: object }[] = [];
  override async connect() {
    this.connected = true;
    this.version = "test-boundary";
  }
  override async start(
    cwd: string,
    _instructions: string,
    _model?: string,
    readOnly = false,
  ) {
    await this.connect();
    const id = `thread-${this.starts.length + 1}`;
    this.starts.push({ id, cwd, readOnly });
    return { thread: { id } };
  }
  override async request() {
    return {};
  }
  override async turn(threadId: string, text: string, schema?: object) {
    this.turns.push({ threadId, text, schema });
    return { turn: { id: `turn-${this.turns.length}` } };
  }
  override async read(threadId: string) {
    return { thread: { id: threadId, status: { type: "idle" } } };
  }
  override async history() {
    return { data: [] };
  }
  override async resume() {
    return {};
  }
  override async interrupt() {
    return {};
  }
  override close() {
    this.connected = false;
  }
  finish(threadId: string, text = "实现完成") {
    this.emit("event", {
      method: "item/completed",
      params: { threadId, item: { type: "agentMessage", text } },
    });
    this.emit("event", {
      method: "turn/completed",
      params: { threadId, turn: { status: "completed" } },
    });
  }
}
export async function fixture(realClient?: CodexClient) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "harness-test-")),
  );
  await writeFile(
    path.join(root, "calc.mjs"),
    "export const add = (a, b) => a + b;\n",
  );
  await writeFile(
    path.join(root, "test.mjs"),
    "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { add } from './calc.mjs'; test('existing add',()=>assert.equal(add(2,3),5));\n",
  );
  await initialize(root, "测试项目");
  const client = realClient || new FakeCodex();
  const service = new HarnessService(root, client);
  const p = await service.store.project();
  await service.saveProject({
    expectedRevision: p.revision,
    patch: {
      checks: [
        {
          id: "behavior",
          name: "真实行为测试",
          kind: "test",
          command: [process.execPath, "--test", "test.mjs"],
          timeoutMs: 10000,
        },
      ],
    },
  });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "baseline",
  ]);
  const task = await service.saveTask({
    patch: {
      title: "增加乘法并保留加法",
      description:
        "在 calc.mjs 导出 multiply(a,b)，添加测试并保留已有 add 的行为。不要修改其他文件。",
      scopes: ["calc"],
      acceptanceCriteria: ["multiply(2,3) 等于 6；add(2,3) 仍等于 5"],
    },
  });
  await service.authorize(task.id, task.revision);
  return {
    root,
    service,
    client: client as FakeCodex,
    task,
    cleanup: async () => {
      await service.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export async function until<T>(
  fn: () => Promise<T | undefined | false>,
  timeout = 10000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("Timed out waiting for observable state");
}
export async function finishCandidate(f: Awaited<ReturnType<typeof fixture>>) {
  const run = await f.service.dispatch(f.task.id);
  await writeFile(
    path.join(run.worktree, "calc.mjs"),
    "export const add = (a, b) => a + b;\nexport const multiply = (a, b) => a * b;\n",
  );
  await writeFile(
    path.join(run.worktree, "test.mjs"),
    "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { add, multiply } from './calc.mjs'; test('existing add',()=>assert.equal(add(2,3),5)); test('new multiply',()=>assert.equal(multiply(2,3),6));\n",
  );
  f.client.finish(run.threadId!);
  const review = await until(async () => {
    const r = await f.service.store.run(run.id);
    if (r.repairAttempts || r.state === "failed")
      throw new Error(
        JSON.stringify({ run: r, evidence: await f.service.store.evidence() }),
      );
    return r.reviewTurnId ? r : undefined;
  });
  f.client.finish(
    review.reviewThreadId!,
    JSON.stringify({ passed: true, summary: "检查了差异与行为", issues: [] }),
  );
  return until(async () => {
    const s = await f.service.snapshot();
    const r = s.runs.find((r) => r.id === run.id)!;
    return r.state === "completed" &&
      s.tasks.find((t) => t.id === f.task.id)?.state === "acceptance"
      ? r
      : undefined;
  });
}
