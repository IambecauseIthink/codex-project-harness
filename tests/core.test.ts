import test from "node:test";
import { request } from "node:http";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fixture, finishCandidate, until, FakeCodex } from "./helpers.js";
import { initialize, backup, restore, maintain } from "../src/core/project.js";
import { HarnessService } from "../src/core/service.js";
import { Store, contained } from "../src/core/store.js";
import { baseline, git } from "../src/core/git.js";
import { executeCheck, verify } from "../src/core/verify.js";
import { prepareContext } from "../src/core/context.js";
import { serve } from "../src/server/api.js";

test("旧项目接入保留文档和现有配置，重复接入幂等，能力未知", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-onboard-"));
  try {
    await writeFile(path.join(root, "README.md"), "existing authority");
    await writeFile(path.join(root, "AGENTS.md"), "existing rules");
    const p = await initialize(root);
    const first = await readFile(path.join(root, "AGENTS.md"), "utf8");
    assert.match(first, /existing rules/);
    assert.equal((await initialize(root)).id, p.id);
    assert.equal(await readFile(path.join(root, "AGENTS.md"), "utf8"), first);
    assert.equal(
      await readFile(path.join(root, "README.md"), "utf8"),
      "existing authority",
    );
    assert.equal((await new Store(root).records())[0].status, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("循环、缺失任务与并发版本冲突明确报错，不能伪造完成状态", async () => {
  const f = await fixture();
  try {
    const b = await f.service.saveTask({
      patch: { title: "B", dependsOn: [f.task.id] },
    });
    await assert.rejects(
      f.service.saveTask({
        id: f.task.id,
        expectedRevision: 1,
        patch: { dependsOn: [b.id] },
      }),
      { code: "DEPENDENCY_CYCLE" },
    );
    await assert.rejects(
      f.service.saveTask({
        patch: { title: "ghost", dependsOn: ["not-real"] },
      }),
      { code: "MISSING_DEPENDENCY" },
    );
    const results = await Promise.allSettled(
      [1, 2].map((i) =>
        f.service.saveTask({
          id: f.task.id,
          expectedRevision: 1,
          patch: { title: `edit ${i}`, state: "done" },
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await f.service.store.task(f.task.id)).state, "draft");
  } finally {
    await f.cleanup();
  }
});
test("重复派发只有一个原生会话，相同模块串行", async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([
      f.service.dispatch(f.task.id),
      f.service.dispatch(f.task.id),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(f.client.starts.length, 1);
    const t = await f.service.saveTask({
      patch: {
        title: "conflicting",
        scopes: ["calc/sub"],
        acceptanceCriteria: ["x"],
      },
    });
    await f.service.authorize(t.id, 1);
    await assert.rejects(f.service.dispatch(t.id), { code: "SCOPE_CONFLICT" });
  } finally {
    await f.cleanup();
  }
});
test("真实检查、不同审查会话、集成后再次验证才完成；代码改动使证据过期", async () => {
  const f = await fixture();
  try {
    const run = await finishCandidate(f);
    assert.notEqual(run.threadId, run.reviewThreadId);
    assert.equal(f.client.starts[1].readOnly, true);
    assert.equal((await f.service.store.task(f.task.id)).state, "acceptance");
    await f.service.accept(f.task.id, 1, "已体验算术入口");
    const s = await f.service.snapshot();
    assert.equal(s.tasks[0].state, "done");
    assert.equal(s.tasks[0].assurance, "verified");
    await writeFile(
      path.join(f.root, "calc.mjs"),
      "export const add = () => 0;\n",
    );
    assert.equal((await f.service.snapshot()).tasks[0].assurance, "stale");
  } finally {
    await f.cleanup();
  }
});
test("运行中更改目标不会让旧结果推进新任务", async () => {
  const f = await fixture();
  try {
    const run = await f.service.dispatch(f.task.id);
    await f.service.saveTask({
      id: f.task.id,
      expectedRevision: 1,
      patch: { title: "新版需求" },
    });
    f.client.finish(run.threadId!);
    await until(
      async () => (await f.service.store.run(run.id)).state === "failed",
    );
    assert.equal((await f.service.store.task(f.task.id)).state, "draft");
    await assert.rejects(f.service.accept(f.task.id, 2, ""), {
      code: "NOT_ACCEPTABLE",
    });
  } finally {
    await f.cleanup();
  }
});
test("暂停后迟到的完成事件不复活执行；重启保留未知运行而不重派", async () => {
  const f = await fixture();
  try {
    const run = await f.service.dispatch(f.task.id);
    await f.service.pause(run.id);
    f.client.finish(run.threadId!);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await f.service.store.run(run.id)).state, "paused");
    await f.service.resume(run.id);
    await f.service.stop();
    const nextClient = new FakeCodex();
    const next = new HarnessService(f.root, nextClient);
    try {
      await next.start();
      const s = await next.snapshot();
      assert.equal(s.runs[0].state, "unknown");
      await next.tick();
      assert.equal(nextClient.starts.length, 0);
      assert.equal((await next.dispatch(f.task.id)).id, run.id);
      const second = new HarnessService(f.root, new FakeCodex());
      await assert.rejects(second.start(), { code: "ALREADY_RUNNING" });
    } finally {
      await next.stop();
    }
  } finally {
    await f.cleanup();
  }
});
test("回归失败保存缺陷，自动修复两次仍失败便阻塞", async () => {
  const f = await fixture();
  try {
    const run = await f.service.dispatch(f.task.id);
    await writeFile(
      path.join(run.worktree, "calc.mjs"),
      "export const add = () => 0;",
    );
    for (let i = 0; i < 3; i++) {
      f.client.finish(run.threadId!);
      await until(async () => {
        const r = await f.service.store.run(run.id);
        return i < 2
          ? r.repairAttempts === i + 1 && r.state === "running"
          : r.state === "failed";
      });
    }
    const r = await f.service.store.run(run.id);
    assert.equal(r.repairAttempts, 2);
    assert.equal(f.client.turns.length, 3);
    assert.equal(
      (await f.service.store.records()).filter((r) => r.kind === "bug").length,
      1,
    );
    assert.ok((await f.service.store.evidence()).every((e) => !e.passed));
    await assert.rejects(f.service.accept(f.task.id, 1, ""), {
      code: "NOT_ACCEPTABLE",
    });
  } finally {
    await f.cleanup();
  }
});
test("未执行、全跳过、超时均不能通过，构建成功不代表行为验证", async () => {
  const f = await fixture();
  try {
    const run = await f.service.dispatch(f.task.id);
    for (const [code, expected] of [
      ["console.log('built')", "unknown"],
      ["console.log('# pass 0\\n# fail 0\\n# skipped 4')", "unknown"],
      ["setTimeout(()=>{},10000)", "timeout"],
    ] as const) {
      const result = await executeCheck(run.worktree, {
        id: "negative",
        name: "negative",
        kind: "test",
        command: [process.execPath, "-e", code],
        timeoutMs: 200,
      });
      assert.equal(result.status, expected);
    }
    const p = await f.service.store.project();
    p.checks = [
      {
        id: "build",
        name: "build",
        kind: "build",
        requiredCases: [],
        command: [process.execPath, "-e", "process.exit(0)"],
        timeoutMs: 1000,
      },
    ];
    assert.equal((await verify(p, f.task, run)).passed, false);
  } finally {
    await f.cleanup();
  }
});
test("事故关联的具体用例消失或被跳过时，即使其他用例通过也不能冒绿", async () => {
  const f = await fixture();
  try {
    const base = {
      id: "guard",
      name: "事故回归",
      kind: "test" as const,
      timeoutMs: 1000,
      requiredCases: ["prevent incident"],
    };
    const good = await executeCheck(f.root, {
      ...base,
      command: [
        process.execPath,
        "-e",
        `console.log(${JSON.stringify("ok 1 - prevent incident\n# pass 1\n# fail 0")})`,
      ],
    });
    assert.equal(good.status, "passed");
    const deleted = await executeCheck(f.root, {
      ...base,
      command: [
        process.execPath,
        "-e",
        `console.log(${JSON.stringify("ok 1 - unrelated\n# pass 1\n# fail 0")})`,
      ],
    });
    assert.equal(deleted.status, "failed");
    assert.deepEqual(deleted.missingCases, ["prevent incident"]);
    const skipped = await executeCheck(f.root, {
      ...base,
      command: [
        process.execPath,
        "-e",
        `console.log(${JSON.stringify("ok 1 - prevent incident # SKIP\nok 2 - unrelated\n# pass 1\n# fail 0")})`,
      ],
    });
    assert.equal(skipped.status, "failed");
  } finally {
    await f.cleanup();
  }
});
test("检查配置或候选内容改变后不能验收", async () => {
  const f = await fixture();
  try {
    const run = await finishCandidate(f);
    const p = await f.service.store.project();
    await f.service.saveProject({
      expectedRevision: p.revision,
      patch: { checks: p.checks.map((c) => ({ ...c, timeoutMs: 20000 })) },
    });
    await assert.rejects(f.service.accept(f.task.id, 1, ""), {
      code: "STALE_EVIDENCE",
    });
    assert.equal((await f.service.snapshot()).tasks[0].assurance, "stale");
    await writeFile(path.join(run.worktree, "calc.mjs"), "// modified");
    await assert.rejects(f.service.accept(f.task.id, 1, ""), {
      code: "STALE_EVIDENCE",
    });
  } finally {
    await f.cleanup();
  }
});
test("有效教训保护检查，外部删除检查也被维护检查发现，归档可追溯", async () => {
  const f = await fixture();
  try {
    await f.service.saveRecord({
      patch: {
        kind: "lesson",
        title: "保留加法回归",
        body: "曾被乘法修改破坏；只适用于算术模块",
        guards: ["behavior"],
        scopes: ["calc"],
        links: [f.task.id],
      },
    });
    const p = await f.service.store.project();
    await assert.rejects(
      f.service.saveProject({
        expectedRevision: p.revision,
        patch: { checks: [] },
      }),
      { code: "GUARD_REMOVED" },
    );
    await f.service.store.saveProject({ ...p, checks: [] });
    assert.match((await maintain(f.service.store)).warnings.join(), /behavior/);
    await f.service.store.saveProject(p);
    await finishCandidate(f);
    await f.service.accept(f.task.id, 1, "通过");
    await f.service.archive(f.task.id, 1);
    assert.equal((await f.service.store.task(f.task.id)).archived, true);
    assert.equal(
      (await f.service.store.records()).filter((r) => r.kind === "lesson")
        .length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});
test("上下文只含相关有效知识，超预算不悄悄截掉约束，拒绝越界原文", async () => {
  const f = await fixture();
  try {
    await f.service.saveRecord({
      patch: {
        kind: "decision",
        title: "old secret history",
        body: "old",
        status: "archived",
        scopes: ["calc"],
      },
    });
    await f.service.saveRecord({
      patch: {
        kind: "lesson",
        title: "current rule",
        body: "retain behavior",
        scopes: ["calc"],
      },
    });
    const packet = await prepareContext(f.service.store, f.task);
    assert.match(packet.text, /current rule/);
    assert.doesNotMatch(packet.text, /old secret history/);
    await f.service.saveRecord({
      patch: { kind: "requirement", title: "huge", body: "x".repeat(30000) },
    });
    await assert.rejects(prepareContext(f.service.store, f.task), {
      code: "CONTEXT_TOO_LARGE",
    });
    await symlink(os.tmpdir(), path.join(f.root, "outside"));
    await assert.rejects(contained(f.root, "outside"), { code: "PATH_ESCAPE" });
  } finally {
    await f.cleanup();
  }
});
test("备份带源码和未结束工作，恢复不覆盖目标且不自动重放，不泄露服务令牌", async () => {
  const f = await fixture();
  const temp = await mkdtemp(path.join(os.tmpdir(), "harness-backup-"));
  try {
    const run = await f.service.dispatch(f.task.id);
    await writeFile(
      path.join(run.worktree, "work-in-progress.txt"),
      "preserve me",
    );
    await f.service.pause(run.id);
    await writeFile(
      path.join(f.root, ".harness/runtime/server.json"),
      '{"token":"secret"}',
    );
    const dest = path.join(temp, "backup");
    await backup(f.service.store, dest);
    await assert.rejects(
      readFile(path.join(dest, ".harness/runtime/server.json")),
    );
    const restored = path.join(temp, "restored");
    await restore(dest, restored);
    assert.equal(
      await readFile(path.join(restored, "calc.mjs"), "utf8"),
      await readFile(path.join(f.root, "calc.mjs"), "utf8"),
    );
    const store = new Store(restored);
    const r = await store.run(run.id);
    assert.equal(r.state, "unknown");
    assert.equal(
      await readFile(path.join(r.worktree, "work-in-progress.txt"), "utf8"),
      "preserve me",
    );
    assert.equal((await store.project()).autoDispatch, false);
    await assert.rejects(restore(dest, restored), {
      code: "DESTINATION_EXISTS",
    });
  } finally {
    await f.cleanup();
    await rm(temp, { recursive: true, force: true });
  }
});
test("API 拒绝无令牌、跨站和越权 Host，正常操作与核心共享校验", async () => {
  const f = await fixture();
  const app = await serve(f.root, 0);
  try {
    const p = await f.service.store.project();
    const endpoint = `${app.url}/api/projects/${p.id}/action`;
    assert.equal((await fetch(`${app.url}/api/projects`)).status, 401);
    const headers = {
      Authorization: `Bearer ${app.token}`,
      "Content-Type": "application/json",
    };
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.test" },
          body: "{}",
        })
      ).status,
      403,
    );
    const hostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          `${app.url}/api/projects`,
          { headers: { ...headers, Host: "evil.test" } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    assert.equal(hostStatus, 403);
    const r = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "task.save",
        input: { patch: { title: "bad", dependsOn: ["missing"] } },
      }),
    });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as any).code, "MISSING_DEPENDENCY");
    assert.equal((await fetch(app.url)).status, 200);
  } finally {
    await app.close();
    await f.cleanup();
  }
});
