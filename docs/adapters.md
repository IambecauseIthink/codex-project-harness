# 接入与适配

## 接入步骤

1. `harness init <绝对目录> <名称>`：建立 `.harness`、角色与技能导航；保留已有文档和配置。
2. `harness inspect --project <目录>`：只读发现 npm / Python / Rust 的常见检查入口，不把文件存在当作能力通过。
3. 在看板配置检查命令，梳理已有能力；有效文档通过记录 `sourcePath` 引用。
4. 保存 Git 基线。任务在独立 worktree 中执行，未提交源码不会被自动合并进执行副本。
5. `harness connect --project <目录>`：加入项目级 MCP 配置。`harness start --project <目录>` 启动后台服务，`serve` 用于前台。
6. 使用 Codex 讨论目标和验收后授权任务，打开自动派发或点击卡片派发。

UI 接入向导接受本机绝对路径和项目名，已有项目只增加 Harness 命名空间和简短导航。接管复杂旧项目时，应先建立一个“盘点现有完整用户流程”的任务；无证据的能力保持 unknown。

## 检查适配

在 `project.yaml` 的 `checks` 配置参数数组。不会通过 shell 执行字符串；需要 shell 语义时应明确使用项目脚本，并将脚本纳入 Git。

```yaml
checks:
  - id: regression
    name: 核心用户流程
    kind: e2e
    command: [node, --test, --test-reporter=tap, test.mjs]
    timeoutMs: 120000
    requiredCases: [订单取消后库存恢复]
  - id: build
    name: 生产构建
    kind: build
    command: [npm, run, build]
    timeoutMs: 180000
```

支持 TAP 和常见 pytest / Vitest / Rust 测试摘要计数。`requiredCases` 使用 TAP 已通过的用例名称，或使用下述 JSON 中的 cases。未知输出不会猜测为通过。

对于自定义检查，设置 `resultFile: .harness/runtime/results.json`。执行前删除旧结果，执行后读取：

```json
{
  "passed": 2,
  "failed": 0,
  "skipped": 0,
  "cases": [
    { "name": "订单取消后库存恢复", "status": "passed" },
    { "name": "重复提交不重复扣款", "status": "passed" }
  ]
}
```

计数必须是非负整数，至少一个行为用例通过，进程退出码必须为 0。代码指纹在检查前后保持一致。结果文件放在忽略目录，避免检查自身的临时产物改变源码指纹。超时会终止整个检查进程组。关键原始报告可另行保存并登记引用，内置证据保留输出尾部和统计。

安装依赖、数据库迁移、服务启动与清理应由项目的检查脚本负责。worktree 不共享父项目的 node_modules；脚本应执行锁定安装或使用项目已约定的环境。不要把不完整的接口探针标成“完整业务流程”。

`examples/web/` 是无需第三方依赖的真实 HTTP 项目；`examples/non-web/` 是普通 JavaScript 模块。两者都可配置 `node --test test.mjs`。真实 Codex 验收另在 `.cache/live-*` 中保留完整项目、Git 与工作区，不修改示例源文件。

## CLI / HTTP

通用入口：

```sh
harness action task.save --project /项目 --json '{"patch":{"title":"完善订单取消","acceptanceCriteria":["取消后库存恢复"]}}'
harness action task.authorize --project /项目 --json '{"id":"真实任务编号","expectedRevision":1}'
harness action task.dispatch --project /项目 --json '{"id":"真实任务编号"}'
harness action search --project /项目 --json '{"query":"库存","includeArchived":true,"limit":50}'
```

网页和 MCP 都使用 `POST /api/projects/:id/action`，请求体 `{ "action": "…", "input": { … } }`。读取使用 `/api/projects` 与 `/api/projects/:id/snapshot`；SSE `/api/events` 只通知变化，再读取权威快照。API 需要当前服务令牌，禁止跨站调用。

操作名：`project.save`、`project.inspect`、`task.save`、`task.authorize`、`task.dispatch`、`task.accept`、`task.archive`、`task.restore`、`record.save`、`run.pause`、`run.cancel`、`run.resume`、`run.reconcile`、`run.verify`、`run.sync`、`run.respond`、`context`、`search`、`maintain`、`backup`、`codex.connect`。

典型错误码：`CONFLICT`、`DEPENDENCY_CYCLE`、`MISSING_DEPENDENCY`、`NOT_READY`、`SCOPE_CONFLICT`、`DIRTY_BASELINE`、`STALE_EVIDENCE`、`BASE_MOVED`、`GUARD_REMOVED`、`GUARD_WEAKENED`、`UNKNOWN_CREATION`。错误不改变任务目标，不自动覆盖用户代码。

## MCP

提供 `project_overview`、`task_context`、`search_records`、`save_task`、`save_record`、`configure_project`、`task_authorize`、`run_action`、`accept_task`、`archive_task`、`maintain_memory`、`backup_project`。由真正的 MCP stdio Client 验收工具发现和调用，工具错误以 `isError` 返回。

MCP 概览不返回完整执行上下文，默认排除归档，只返回前 100 条当前知识；精确检索使用分页 search。需要完整任务上下文时按 ID 获取。授权和验收必须对应用户真实决定。
