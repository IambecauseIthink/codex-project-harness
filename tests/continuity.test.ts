import test from "node:test";
import assert from "node:assert/strict";
import { chmod, writeFile, readFile, mkdir, utimes } from "node:fs/promises";
import path from "node:path";
import { fixture, finishCandidate, until } from "./helpers.js";
import { baseline, git } from "../src/core/git.js";
import { maintain } from "../src/core/project.js";

test("规则变化使旧候选验收失效；恢复先重新装入当前规则", async () => {
  const f = await fixture();
  try {
    const run = await finishCandidate(f);
    await f.service.saveRecord({
      patch: {
        kind: "requirement",
        title: "新增溢出规则",
        body: "乘法遇到溢出必须报告错误",
        scopes: ["calc"],
      },
    });
    await assert.rejects(f.service.accept(f.task.id, 1, "old"), {
      code: "STALE_CONTEXT",
    });
    await f.service.reverify(run.id);
    const current = await f.service.store.run(run.id);
    assert.match(current.context, /新增溢出规则/);
  } finally {
    await f.cleanup();
  }
});
test("工作区与主目录仅读写权限不同不误报，执行位变化仍失效", async () => {
  const f = await fixture();
  try {
    const original = await baseline(f.root);
    await chmod(path.join(f.root, "AGENTS.md"), 0o644);
    assert.equal((await baseline(f.root)).digest, original.digest);
    await chmod(path.join(f.root, "calc.mjs"), 0o755);
    assert.notEqual((await baseline(f.root)).digest, original.digest);
  } finally {
    await f.cleanup();
  }
});
test("只修改 Harness 配置不污染源码基线；保留 Git porcelain 的前导空格", async () => {
  const f = await fixture();
  try {
    const p = await f.service.store.project();
    await f.service.saveProject({
      expectedRevision: p.revision,
      patch: { name: "updated project" },
    });
    const run = await f.service.dispatch(f.task.id);
    assert.ok(run.threadId);
  } finally {
    await f.cleanup();
  }
});
test("并行候选必须合入新主线再重验，合并后的两个功能均保留", async () => {
  const f = await fixture();
  try {
    const run = await finishCandidate(f);
    await writeFile(
      path.join(f.root, "another-module.mjs"),
      "export const other = 42;",
    );
    await git(f.root, ["add", "another-module.mjs"]);
    await git(f.root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-m",
      "parallel completed work",
    ]);
    await assert.rejects(f.service.accept(f.task.id, 1, "old baseline"), {
      code: "BASE_MOVED",
    });
    await f.service.syncBaseline(run.id);
    const reviewing = await until(async () => {
      const r = await f.service.store.run(run.id);
      return r.reviewTurnId && r.reviewThreadId !== run.reviewThreadId
        ? r
        : undefined;
    });
    f.client.finish(
      reviewing.reviewThreadId!,
      JSON.stringify({
        passed: true,
        summary: "合并基线后再次检查",
        issues: [],
      }),
    );
    await until(
      async () =>
        (await f.service.snapshot()).tasks.find((t) => t.id === f.task.id)
          ?.state === "acceptance",
    );
    await f.service.accept(f.task.id, 1, "two modules checked");
    assert.match(
      await readFile(path.join(f.root, "calc.mjs"), "utf8"),
      /multiply/,
    );
    assert.match(
      await readFile(path.join(f.root, "another-module.mjs"), "utf8"),
      /42/,
    );
  } finally {
    await f.cleanup();
  }
});
test("记忆清理只删未引用过期临时文件，保留引用与长期知识", async () => {
  const f = await fixture();
  try {
    const dir = path.join(f.root, ".harness/runtime/logs");
    await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - 40 * 86400000);
    for (const name of ["unused.log", "kept.log"]) {
      const file = path.join(dir, name);
      await writeFile(file, name);
      await utimes(file, old, old);
    }
    await f.service.saveRecord({
      patch: {
        kind: "postmortem",
        title: "仍需要原始证据",
        body: "参见 .harness/runtime/logs/kept.log",
      },
    });
    const result = await maintain(f.service.store);
    assert.equal(result.removedTemporaryFiles, 1);
    assert.equal(
      await readFile(path.join(dir, "kept.log"), "utf8"),
      "kept.log",
    );
    await assert.rejects(readFile(path.join(dir, "unused.log")));
    assert.ok(
      (await f.service.store.records()).some(
        (r) => r.title === "仍需要原始证据",
      ),
    );
  } finally {
    await f.cleanup();
  }
});
