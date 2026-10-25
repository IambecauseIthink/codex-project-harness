import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "./helpers.js";
import { serve } from "../src/server/api.js";

test("真实 stdio MCP 客户端：发现工具、创建任务、执行同一份版本与依赖校验", async () => {
  const f = await fixture();
  const app = await serve(f.root, 0);
  const client = new Client({ name: "acceptance-client", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/cli.js"), "mcp", "--project", f.root],
  });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.ok(list.tools.some((t) => t.name === "task_context"));
    assert.ok(list.tools.some((t) => t.name === "backup_project"));
    const good: any = await client.callTool({
      name: "save_task",
      arguments: {
        patch: { title: "通过 MCP 创建", acceptanceCriteria: ["可独立验收"] },
      },
    });
    assert.equal(good.isError, undefined);
    const created = JSON.parse(good.content[0].text);
    assert.equal(created.state, "draft");
    const conflict: any = await client.callTool({
      name: "save_task",
      arguments: {
        id: created.id,
        expectedRevision: 999,
        patch: { title: "stale" },
      },
    });
    assert.equal(conflict.isError, true);
    const invalid: any = await client.callTool({
      name: "save_task",
      arguments: { patch: { title: "invalid", dependsOn: ["ghost"] } },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await app.close();
    await f.cleanup();
  }
});
