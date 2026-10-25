import path from "node:path";
import {
  mkdir,
  readFile,
  readdir,
  cp,
  writeFile,
  realpath,
  stat,
  unlink,
  rm,
} from "node:fs/promises";
import { Store, atomic, exists, id, now, contained } from "./store.js";
import { ProjectSchema, RecordSchema, assert, type Project } from "./types.js";
import { git, hash } from "./git.js";
const roleInstructions: Record<string, string> = {
  delivery:
    "负责澄清范围、任务依赖、集成和阻塞。只在产品语义冲突、授权边界变化或版本验收时找产品负责人。不要用聊天总结代替证据。",
  product:
    "负责用户流程、业务边界和可执行验收条件。区分期望行为与已交付行为。产品承诺变化需要用户决定。",
  architect:
    "负责领域模型、接口、数据演进和变更影响。先读有效决策和被拒绝方案；记录持久取舍，不制造重复规范。",
  engineer:
    "只实施当前任务；保留已确认的业务行为。先复现缺陷，运行相应检查。不要自行修改验收要求、降低断言、关闭质量检查或集成到主分支。",
  quality:
    "独立检查任务要求、真实差异和回归风险。寻找可复现问题。明确证据证明范围，不修改被审代码。",
  knowledge:
    "维护当前规则、决策、缺陷与教训。只归档已经结束且不再需要常驻读取的内容；保留理由、来源及有效护栏。",
};
export async function initialize(rootPath: string, name?: string) {
  await mkdir(rootPath, { recursive: true });
  const root = await realpath(rootPath);
  const store = new Store(root);
  if (await exists(path.join(store.dir, "project.yaml")))
    return store.project();
  await mkdir(store.dir, { recursive: true });
  const time = now();
  const project = ProjectSchema.parse({
    schemaVersion: 1,
    id: id("project"),
    name: name || path.basename(root),
    root,
    revision: 1,
    createdAt: time,
    updatedAt: time,
  });
  await store.saveProject(project);
  for (const folder of [
    "docs",
    "backlog/tasks",
    "records",
    "runs",
    "evidence",
    "archive",
    "runtime",
  ])
    await mkdir(path.join(store.dir, folder), { recursive: true });
  await atomic(
    path.join(store.dir, "README.md"),
    "# 项目入口\n\nproject.yaml 是配置权威；backlog/tasks 是任务权威；records 是需求、能力、决策、缺陷和教训的权威。runs 是执行事实，evidence 是检查事实，均不能单独证明产品可用。\n\n每个新任务先通过 Harness 获取上下文和最新任务版本。文档只链接事实拥有者；历史不默认进入上下文。运行中修改任务会使旧成果失效。归档使用状态，不复制记录。\n",
  );
  await atomic(
    path.join(store.dir, "docs/map.md"),
    "# 文档职责地图\n\n当前产品目标：../project.yaml 的 description。\n\n需求、现有能力、业务规则、决策、缺陷和教训：../records 的带类型记录。已有产品文档通过 sourcePath 登记，保留原位权威。\n\n任务与 Backlog：../backlog/tasks。执行事实：../runs。真实检查证据：../evidence。旧记录版本：../history。归档是显式状态，默认上下文不加载。\n\n每次版本收尾先更新当前事实，再提炼有范围的教训，最后运行 maintain 检查引用与归档。不要在这张地图重复业务规则。\n",
  );
  const marker = "<!-- project-harness -->";
  const agentPath = path.join(root, "AGENTS.md");
  const before = await readFile(agentPath, "utf8").catch(() => "");
  if (!before.includes(marker))
    await atomic(
      agentPath,
      `${before.trimEnd()}\n\n${marker}\n项目开发由 Harness 协调。开始前读取 .harness/README.md，通过 harness MCP 获取当前任务与上下文。新任务不要默认读取全部历史；不要自行修改任务授权、证据或验收状态。\n`,
    );
  const ignorePath = path.join(root, ".gitignore");
  const ignore = await readFile(ignorePath, "utf8").catch(() => "");
  const ignores = [".harness/runtime/", ".harness/worktrees/"];
  await atomic(
    ignorePath,
    `${ignore.trimEnd()}\n${ignores.filter((v) => !ignore.split("\n").includes(v)).join("\n")}\n`,
  );
  for (const [role, instructions] of Object.entries(roleInstructions)) {
    const p = path.join(root, ".codex/agents", `harness-${role}.toml`);
    if (!(await exists(p)))
      await atomic(
        p,
        `name = "harness_${role}"\ndescription = ${JSON.stringify(instructions)}\ndeveloper_instructions = ${JSON.stringify(instructions + " 必须读取本任务的 Harness 上下文；只按授权范围行动。")}\n`,
      );
  }
  const skillPath = path.join(root, ".agents/skills/harness-work/SKILL.md");
  if (!(await exists(skillPath)))
    await atomic(
      skillPath,
      "---\nname: harness-work\ndescription: 在已接入 Harness 的项目中开发、修复、审查和整理项目记忆。\n---\n\n开工先获取项目概览与当前任务上下文；任务必须属于已授权范围。核对需求、现有能力、有效决策、依赖结果与相关教训。通过 Harness 工具更新任务和记录，变更使用预期版本。只对有独立结果的工作使用已配置的角色分工；实现与审查分开。运行真实检查并保留失败；不要弱化检查以求绿。结束时返回变化、证据与未验证项；产品验收交给用户。\n",
    );
  const candidates = [
    "README.md",
    "docs/architecture.md",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
  ];
  const found: string[] = [];
  for (const p of candidates)
    if (await exists(path.join(root, p))) found.push(p);
  await store.saveRecord(
    RecordSchema.parse({
      id: id("note"),
      kind: "note",
      title: "项目接入盘点",
      body: `接入时发现：${found.length ? found.join("、") : "尚无项目资料"}。\n\n这些文件的存在不证明功能可用。下一步：梳理用户流程和现有能力，配置检查命令并运行基线验证。\n\n现有文件保持原位，新增记录引用其路径。`,
      status: "unknown",
      revision: 1,
      createdAt: time,
      updatedAt: time,
    }),
  );
  return project;
}
export async function inspectProject(root: string) {
  const detected: { name: string; command: string[]; kind: string }[] = [];
  try {
    const pkg = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    for (const [name] of Object.entries(pkg.scripts || {}))
      if (/^(test|build|lint|check)(:|$)/.test(name))
        detected.push({
          name,
          command: ["npm", "run", name],
          kind: name.startsWith("test")
            ? "test"
            : name.startsWith("build")
              ? "build"
              : "lint",
        });
  } catch {}
  if (await exists(path.join(root, "pyproject.toml")))
    detected.push({
      name: "Python tests",
      command: ["python3", "-m", "pytest"],
      kind: "test",
    });
  if (await exists(path.join(root, "Cargo.toml")))
    detected.push({
      name: "Rust tests",
      command: ["cargo", "test"],
      kind: "test",
    });
  return {
    detected,
    gitHead: await git(root, ["rev-parse", "HEAD"]).catch(() => null),
    dirty: await git(root, ["status", "--short"]).catch(() => null),
  };
}
export async function backup(store: Store, destination: string) {
  const dest = path.resolve(destination);
  assert(
    dest !== store.root && !dest.startsWith(store.root + path.sep),
    "BACKUP_LOCATION",
    "备份应位于项目目录之外，避免递归复制",
  );
  assert(!(await exists(dest)), "DESTINATION_EXISTS", "备份目标必须是新的目录");
  return store.lock(async () => {
    assert(
      !(await store.runs()).some((r) =>
        [
          "running",
          "reviewing",
          "verifying",
          "starting",
          "awaiting_input",
        ].includes(r.state),
      ),
      "BACKUP_ACTIVE",
      "请先暂停运行再备份，避免拷贝期间源码继续变化",
    );
    await mkdir(dest, { recursive: true });
    await cp(store.dir, path.join(dest, ".harness"), {
      recursive: true,
      dereference: false,
      filter: (s) =>
        !s.includes(`${path.sep}worktrees`) &&
        ![
          "write.lock",
          "service.lock",
          "server.json",
          "registry.json",
        ].includes(path.basename(s)),
    });
    await cp(store.root, path.join(dest, "source"), {
      recursive: true,
      dereference: false,
      filter: (s) =>
        s === store.root ||
        ![".harness", "node_modules", ".cache", "dist"].includes(
          path.basename(s),
        ),
    });
    const runs = await store.runs();
    // In-flight working trees are copied as independent files, not as fragile .git pointers.
    for (const run of runs)
      if (
        (await exists(run.worktree)) &&
        run.worktree.startsWith(path.join(store.dir, "worktrees") + path.sep)
      )
        await cp(run.worktree, path.join(dest, "worktrees", run.id), {
          recursive: true,
          filter: (s) =>
            ![".git", "node_modules", ".harness"].includes(path.basename(s)),
          dereference: false,
        });
    await atomic(
      path.join(dest, "manifest.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          projectId: (await store.project()).id,
          root: store.root,
          at: now(),
          head: await git(store.root, ["rev-parse", "HEAD"]).catch(() => null),
          worktrees: runs.map((r) => ({ id: r.id, branch: r.branch })),
        },
        null,
        2,
      ),
    );
    return { destination: dest };
  });
}
export async function restore(source: string, destination: string) {
  const dest = path.resolve(destination);
  assert(
    !(await exists(path.join(dest, ".harness"))),
    "DESTINATION_EXISTS",
    "恢复目标不能已有 Harness 数据",
  );
  const manifest = JSON.parse(
    await readFile(path.join(source, "manifest.json"), "utf8"),
  );
  assert(
    manifest.schemaVersion === 1,
    "SCHEMA_UNSUPPORTED",
    "不支持的备份格式",
  );
  await mkdir(dest, { recursive: true });
  assert(
    (await readdir(dest)).length === 0,
    "DESTINATION_NOT_EMPTY",
    "恢复目标必须为空，避免覆盖现有源码",
  );
  if (await exists(path.join(source, "source")))
    await cp(path.join(source, "source"), dest, {
      recursive: true,
      dereference: false,
    });
  await cp(path.join(source, ".harness"), path.join(dest, ".harness"), {
    recursive: true,
    dereference: false,
  });
  const store = new Store(await realpath(dest));
  await store.recover();
  const project = await store.project();
  await store.saveProject({
    ...project,
    root: store.root,
    autoDispatch: false,
    updatedAt: now(),
  });
  // The backup owns this fresh copy. Remove stale linked-worktree administrative pointers only in it.
  await rm(path.join(dest, ".git/worktrees"), { recursive: true, force: true });
  for (const run of await store.runs()) {
    const saved = path.join(source, "worktrees", run.id);
    if (await exists(saved)) {
      const target = path.join(store.dir, "worktrees", run.id);
      await git(dest, [
        "worktree",
        "add",
        "--detach",
        target,
        run.resultCommit || run.baseline.head,
      ]);
      for (const name of await readdir(target))
        if (name !== ".git")
          await rm(path.join(target, name), { recursive: true, force: true });
      await cp(saved, target, { recursive: true, dereference: false });
      run.worktree = target;
    }
    run.state = "unknown";
    run.error =
      "备份已恢复；运行不会自动重放。请先核对原会话；恢复会话时会使用这个恢复工作区。";
    delete run.pendingRequest;
    await store.saveRun(run);
  }
  return store.project();
}
export async function maintain(store: Store, archive = false) {
  return store.lock(async () => {
    const tasks = await store.tasks();
    const records = await store.records();
    const project = await store.project();
    const warnings: string[] = [];
    const ids = new Set([
      ...tasks.map((t) => t.id),
      ...records.map((r) => r.id),
    ]);
    const checks = new Set(project.checks.map((c) => c.id));
    for (const r of records) {
      for (const link of r.links)
        if (!ids.has(link)) warnings.push(`${r.title}：引用 ${link} 不存在`);
      for (const guard of r.guards)
        if (!checks.has(guard))
          warnings.push(`${r.title}：护栏 ${guard} 已缺失`);
      if (r.sourcePath) {
        try {
          await contained(store.root, r.sourcePath);
        } catch {
          warnings.push(`${r.title}：原文路径不可用`);
        }
      }
    }
    const pendingDependencies = new Set(
      tasks.filter((t) => t.state !== "done").flatMap((t) => t.dependsOn),
    );
    let archived = 0;
    let removedTemporaryFiles = 0;
    if (archive)
      for (const t of tasks)
        if (
          t.state === "done" &&
          t.version !== project.currentVersion &&
          !t.archived &&
          !pendingDependencies.has(t.id)
        ) {
          await store.saveTask({ ...t, archived: true, updatedAt: now() });
          archived++;
        }
    const references = JSON.stringify([
      ...tasks,
      ...records,
      ...(await store.runs()),
      ...(await store.evidence()),
    ]);
    for (const folder of ["cache", "logs"]) {
      const directory = path.join(store.dir, "runtime", folder);
      if (!(await exists(directory))) continue;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const relative = `.harness/runtime/${folder}/${entry.name}`;
        const file = await contained(store.root, relative);
        const info = await stat(file);
        if (
          Date.now() - info.mtimeMs > 30 * 86400000 &&
          !references.includes(relative) &&
          !references.includes(file)
        ) {
          await unlink(file);
          removedTemporaryFiles++;
        }
      }
    }
    return {
      warnings,
      archived,
      removedTemporaryFiles,
      policy: "仅归档已结束旧版本任务；有效决策、教训和证据不按年龄删除。",
    };
  });
}
export { roleInstructions };
