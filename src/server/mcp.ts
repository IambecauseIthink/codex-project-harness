import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
export async function connectApi(
  root: string,
  action?: string,
  input: any = {},
) {
  const config = JSON.parse(
    await readFile(path.join(root, ".harness/runtime/server.json"), "utf8"),
  );
  const response = await fetch(
    `${config.url}/api/projects/${config.projectId}/${action ? "action" : "snapshot"}`,
    {
      method: action ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: action ? JSON.stringify({ action, input }) : undefined,
    },
  );
  const data = (await response.json()) as any;
  if (!response.ok) throw new Error(data.error);
  return data;
}
export async function mcp(root: string) {
  const server = new McpServer(
    { name: "project-harness", version: "0.1.0" },
    {
      instructions:
        "项目记录与运行状态通过这些工具获取。先读取概览，再获取具体任务上下文。任务修改使用预期版本；不要把运行结束当作验证通过。产品授权和版本验收只能记录真实用户决定。",
    },
  );
  const result = (v: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(v) }],
  });
  const wrap = async (fn: () => Promise<unknown>) => {
    try {
      return result(await fn());
    } catch (e: any) {
      return { ...result({ error: e.message }), isError: true };
    }
  };
  server.tool(
    "project_overview",
    "获取当前目标、任务、阻塞、质量与知识记录；默认不返回长运行上下文。",
    {},
    async () =>
      wrap(async () => {
        const s = await connectApi(root);
        s.tasks = s.tasks.filter((t: any) => !t.archived);
        s.records = s.records
          .filter((r: any) => !["archived", "superseded"].includes(r.status))
          .slice(0, 100);
        s.runs = s.runs
          .filter((r: any) => s.tasks.some((t: any) => t.currentRunId === r.id))
          .map(({ context, ...r }: any) => r);
        s.tasks = s.tasks.map(({ run, ...t }: any) => ({
          ...t,
          run: run && {
            id: run.id,
            state: run.state,
            threadId: run.threadId,
            error: run.error,
          },
        }));
        return s;
      }),
  );
  server.tool(
    "task_context",
    "获取任务范围内的有效规则、依赖、验收与适用教训；超预算会明确失败。",
    { id: z.string() },
    async ({ id }) => wrap(() => connectApi(root, "context", { id })),
  );
  server.tool(
    "search_records",
    "分页检索当前及归档记录，保留原始编号与状态。",
    {
      query: z.string(),
      includeArchived: z.boolean().default(false),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async (args) => wrap(() => connectApi(root, "search", args)),
  );
  server.tool(
    "save_task",
    "新建或修改任务；修改后需要重新授权。不能设置已验证或已完成。",
    {
      id: z.string().optional(),
      expectedRevision: z.number().optional(),
      patch: z.record(z.unknown()),
    },
    async (args) => wrap(() => connectApi(root, "task.save", args)),
  );
  server.tool(
    "save_record",
    "记录需求、能力、决定、缺陷、教训或复盘，保留事实来源。",
    {
      id: z.string().optional(),
      expectedRevision: z.number().optional(),
      patch: z.record(z.unknown()),
    },
    async (args) => wrap(() => connectApi(root, "record.save", args)),
  );
  server.tool(
    "task_authorize",
    "仅在用户已明确批准该版本目标和验收时，将任务纳入执行计划。",
    { id: z.string(), expectedRevision: z.number() },
    async (args) => wrap(() => connectApi(root, "task.authorize", args)),
  );
  server.tool(
    "run_action",
    "派发、暂停、恢复、核对或重新验证任务。派发必须已有授权。",
    {
      action: z.enum([
        "task.dispatch",
        "run.cancel",
        "run.pause",
        "run.resume",
        "run.reconcile",
        "run.verify",
        "run.sync",
      ]),
      id: z.string(),
      message: z.string().optional(),
    },
    async ({ action, ...input }) => wrap(() => connectApi(root, action, input)),
  );
  server.tool(
    "accept_task",
    "仅在用户已体验并明确验收时记录验收；仍会核对版本、检查与审查，并验证集成结果。",
    { id: z.string(), expectedRevision: z.number(), note: z.string() },
    async (args) => wrap(() => connectApi(root, "task.accept", args)),
  );
  server.tool(
    "maintain_memory",
    "检查引用和教训护栏；可归档已结束的旧版本任务，不删除有效知识。",
    { archive: z.boolean().default(false) },
    async (args) => wrap(() => connectApi(root, "maintain", args)),
  );
  server.tool(
    "configure_project",
    "设置构建与检查命令、当前版本和并发；修改需携带最新版本。",
    { expectedRevision: z.number(), patch: z.record(z.unknown()) },
    async (args) => wrap(() => connectApi(root, "project.save", args)),
  );
  server.tool(
    "archive_task",
    "归档已完成任务；记录可通过历史搜索检索。",
    { id: z.string(), expectedRevision: z.number() },
    async (args) => wrap(() => connectApi(root, "task.archive", args)),
  );
  server.tool(
    "backup_project",
    "将项目源码、Git、长期记录与运行状态备份到新的本地目录。",
    { destination: z.string() },
    async (args) => wrap(() => connectApi(root, "backup", args)),
  );
  await server.connect(new StdioServerTransport());
}
