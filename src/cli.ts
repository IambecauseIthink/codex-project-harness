#!/usr/bin/env node
import path from "node:path";
import { readFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  initialize,
  inspectProject,
  backup,
  restore,
  maintain,
} from "./core/project.js";
import { Store, atomic, exists } from "./core/store.js";
import { serve } from "./server/api.js";
import { mcp, connectApi } from "./server/mcp.js";
import { findCodex, CodexClient } from "./codex/client.js";
const args = process.argv.slice(2);
const command = args.shift() || "help";
function option(key: string) {
  const index = args.indexOf(key);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}
const projectArg = option("--project");
const portArg = option("--port");
const jsonArg = option("--json");
const root = path.resolve(projectArg || process.cwd());
const print = (data: unknown) => console.log(JSON.stringify(data, null, 2));
async function main() {
  switch (command) {
    case "start": {
      await initialize(root);
      const connectionPath = path.join(root, ".harness/runtime/server.json");
      const healthy = async () => {
        try {
          const c = JSON.parse(await readFile(connectionPath, "utf8"));
          const r = await fetch(`${c.url}/api/projects`, {
            headers: { Authorization: `Bearer ${c.token}` },
            signal: AbortSignal.timeout(1500),
          });
          return r.ok ? c : undefined;
        } catch {
          return undefined;
        }
      };
      const existing = await healthy();
      if (existing) {
        console.log(`${existing.url}/#token=${existing.token}`);
        break;
      }
      const log = await open(
        path.join(root, ".harness/runtime/service.log"),
        "a",
        0o600,
      );
      const cli = fileURLToPath(import.meta.url);
      const prefix = cli.endsWith(".ts") ? ["--import", "tsx"] : [];
      const child = spawn(
        process.execPath,
        [
          ...prefix,
          cli,
          "serve",
          "--project",
          root,
          "--port",
          portArg || "4317",
        ],
        { detached: true, stdio: ["ignore", log.fd, log.fd], cwd: root },
      );
      child.unref();
      await log.close();
      let connection;
      const end = Date.now() + 15000;
      while (!connection && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 200));
        connection = await healthy();
      }
      if (!connection)
        throw new Error(
          "服务未启动，请查看 .harness/runtime/service.log；工作和记录已保留。",
        );
      console.log(
        `Harness 后台服务已启动，关闭看板不会终止运行。\n${connection.url}/#token=${connection.token}`,
      );
      break;
    }
    case "stop": {
      const c = JSON.parse(
        await readFile(path.join(root, ".harness/runtime/server.json"), "utf8"),
      );
      const r = await fetch(`${c.url}/api/stop`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.token}` },
      });
      if (!r.ok) throw new Error("服务停止失败");
      console.log("本地服务已停止；运行、记录和工作区已保留。");
      break;
    }
    case "init":
      print(await initialize(path.resolve(args[0] || root), args[1]));
      break;
    case "serve": {
      await initialize(root);
      const app = await serve(root, portArg ? Number(portArg) : 4317);
      console.log(
        `Harness 已启动\n${app.url}/#token=${app.token}\n本地服务关闭后停止派发；运行与工作区会保留。`,
      );
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await app.close();
        process.exit(0);
      };
      process.on("SIGTERM", () => void stop());
      process.on("SIGINT", () => void stop());
      break;
    }
    case "mcp":
      await mcp(root);
      break;
    case "connect": {
      const file = path.join(root, ".codex/config.toml");
      const before = await readFile(file, "utf8").catch(() => "");
      if (before.includes("[mcp_servers.project_harness]")) {
        console.log("已有 Harness MCP 配置，保留原配置。");
        break;
      }
      const cli = fileURLToPath(import.meta.url);
      const launchArgs = cli.endsWith(".ts")
        ? ["--import", "tsx", cli, "mcp", "--project", root]
        : [cli, "mcp", "--project", root];
      await atomic(
        file,
        `${before.trimEnd()}\n\n[mcp_servers.project_harness]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(launchArgs)}\n`,
      );
      console.log(
        "项目 MCP 配置已添加。启动 Harness 本地服务，然后在 Codex 中重新加载项目。",
      );
      break;
    }
    case "status":
      print(await connectApi(root));
      break;
    case "inspect":
      print(await inspectProject(root));
      break;
    case "doctor": {
      const client = new CodexClient();
      try {
        await client.connect();
        print({
          connected: client.connected,
          version: client.version,
          binary: await findCodex(),
          project: await exists(path.join(root, ".harness/project.yaml")),
        });
      } finally {
        client.close();
      }
      break;
    }
    case "backup":
      if (!args[0]) throw new Error("需要新的备份目录");
      print(await backup(new Store(root), args[0]));
      break;
    case "restore":
      if (!args[0] || !args[1])
        throw new Error("用法：harness restore <备份目录> <目标项目>");
      print(await restore(args[0], args[1]));
      break;
    case "maintain":
      print(await maintain(new Store(root), args.includes("--archive")));
      break;
    case "action":
      if (!args[0]) throw new Error("需要操作名称");
      print(
        await connectApi(root, args[0], JSON.parse(jsonArg || args[1] || "{}")),
      );
      break;
    default:
      console.log(
        "Project Harness\n\n  harness init [项目目录] [名称]\n  harness serve --project <目录> [--port 4317]\n  harness connect --project <目录>\n  harness mcp --project <目录>\n  harness status | inspect | doctor\n  harness action <操作> --json <JSON>\n  harness maintain [--archive]\n  harness backup <新目录>\n  harness restore <备份> <目标项目>",
      );
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
