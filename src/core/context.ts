import { readFile } from "node:fs/promises";
import { Store, contained } from "./store.js";
import { hash, baseline } from "./git.js";
import { assert, type Task } from "./types.js";
import { roleInstructions } from "./project.js";
export async function prepareContext(store: Store, task: Task) {
  const project = await store.project();
  const records = await store.records();
  const tasks = await store.tasks();
  const relevant = records.filter(
    (r) =>
      !["archived", "superseded"].includes(r.status) &&
      (task.recordIds.includes(r.id) ||
        r.scopes.some((s) =>
          task.scopes.some(
            (t) => t === s || t.startsWith(s + "/") || s.startsWith(t + "/"),
          ),
        ) ||
        (["capability", "requirement", "decision", "lesson"].includes(r.kind) &&
          r.scopes.length === 0)),
  );
  const parts = [
    `# ${project.name} / ${task.title}`,
    `任务 ${task.id}，版本 ${task.revision}。角色：${task.role}。`,
    roleInstructions[task.role],
    `## 产品当前目标\n${project.description || "尚未补充产品级目标。"}\n\n## 任务目标\n${task.description}`,
    `## 验收条件\n${task.acceptanceCriteria.map((x) => `- ${x}`).join("\n")}`,
    `## 范围\n${task.scopes.join(", ") || "未限定模块；按任务目标最小改动。"}`,
    "## 工作纪律\n只改业务源码和任务需要的测试/文档。不得修改 .harness、任务授权、检查命令或删除检查来凑绿。不要 git commit、合并、部署或发布。保留现有行为；发现范围冲突就说明阻塞。测试结果须说明实际命令与未验证范围。",
  ];
  const current = await baseline(store.root);
  parts.push(
    `## 当前代码基线\nGit ${current.head}\n源码指纹 ${current.digest}`,
  );
  const ruleSources: string[] = [];
  for (const dep of task.dependsOn) {
    const t = tasks.find((x) => x.id === dep);
    parts.push(
      `## 前置 ${dep}\n${t?.title ?? "缺失"}：${t?.state ?? "unknown"}\n${t?.acceptance?.note ?? ""}`,
    );
  }
  for (const r of relevant) {
    let source = "";
    if (r.sourcePath) {
      const p = await contained(store.root, r.sourcePath);
      source = "\n原文：\n" + (await readFile(p, "utf8"));
    }
    parts.push(
      `## ${r.kind} · ${r.title} [${r.id}]\n状态 ${r.status}，记录版本 ${r.revision}\n${r.body}${source}\n护栏：${r.guards.join(", ")}`,
    );
    if (["capability", "requirement", "decision", "lesson"].includes(r.kind))
      ruleSources.push(JSON.stringify(r) + source);
  }
  parts.push(
    `## 必须运行的检查\n${project.checks.map((c) => `${c.id}: ${JSON.stringify(c.command)}`).join("\n") || "尚未配置，不能宣称验证通过。"}`,
  );
  const text = parts.join("\n\n");
  assert(
    text.length <= project.contextMaxChars,
    "CONTEXT_TOO_LARGE",
    "必要上下文超过预算；请缩小任务或整理相关文档。系统不会静默截断约束。",
  );
  return {
    text,
    digest: hash(text),
    knowledgeDigest: hash(
      JSON.stringify({ goal: project.description, rules: ruleSources }),
    ),
    recordIds: relevant.map((r) => r.id),
    chars: text.length,
  };
}
