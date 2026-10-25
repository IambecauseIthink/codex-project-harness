import {
  createServer,
  type ServerResponse,
  type IncomingMessage,
} from "node:http";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { HarnessService } from "../core/service.js";
import {
  initialize,
  inspectProject,
  maintain,
  backup,
  restore,
} from "../core/project.js";
import { atomic, exists } from "../core/store.js";
import { HarnessError, assert } from "../core/types.js";
import { prepareContext } from "../core/context.js";
export class Workspace {
  services = new Map<string, HarnessService>();
  constructor(readonly home: string) {}
  async add(root: string, name?: string) {
    const project = await initialize(root, name);
    const previous = this.services.get(project.id);
    assert(
      !previous || previous.root === project.root,
      "DUPLICATE_PROJECT",
      "这个项目编号已在其他目录接入。恢复的备份请在原服务关闭后单独启动。",
      409,
    );
    if (!this.services.has(project.id)) {
      const service = new HarnessService(project.root);
      this.services.set(project.id, service);
      await service.start();
    }
    await this.persist();
    return project;
  }
  async persist() {
    await atomic(
      path.join(this.home, ".harness/runtime/registry.json"),
      JSON.stringify([...this.services.values()].map((s) => s.root)),
    );
  }
  async load() {
    const roots: string[] = JSON.parse(
      await readFile(
        path.join(this.home, ".harness/runtime/registry.json"),
        "utf8",
      ).catch(() => "[]"),
    );
    await this.add(this.home);
    for (const root of roots)
      if (await exists(path.join(root, ".harness/project.yaml")))
        await this.add(root);
  }
  service(projectId: string) {
    const service = this.services.get(projectId);
    assert(service, "NOT_FOUND", "项目未接入", 404);
    return service;
  }
  async projects() {
    return Promise.all(
      [...this.services.values()].map((s) => s.store.project()),
    );
  }
  async close() {
    await Promise.all([...this.services.values()].map((s) => s.stop()));
  }
}
export async function action(
  service: HarnessService,
  name: string,
  input: any,
) {
  switch (name) {
    case "task.save":
      return service.saveTask(input);
    case "task.authorize":
      return service.authorize(input.id, input.expectedRevision);
    case "task.dispatch":
      return service.dispatch(input.id);
    case "task.accept":
      return service.accept(input.id, input.expectedRevision, input.note || "");
    case "search":
      return service.search(input);
    case "task.restore":
      return service.archive(input.id, input.expectedRevision, false);
    case "task.archive":
      return service.archive(input.id, input.expectedRevision);
    case "run.cancel":
      return service.pause(input.id, "用户取消本轮执行，已有工作保留");
    case "run.pause":
      return service.pause(input.id);
    case "run.resume":
      return service.resume(input.id, input.message);
    case "run.reconcile":
      return service.reconcile(input.id);
    case "run.sync":
      return service.syncBaseline(input.id);
    case "run.verify":
      return service.reverify(input.id);
    case "run.respond":
      return service.respond(input.id, input.response);
    case "project.save":
      return service.saveProject(input);
    case "record.save":
      return service.saveRecord(input);
    case "project.inspect":
      return inspectProject(service.root);
    case "context":
      return prepareContext(service.store, await service.store.task(input.id));
    case "maintain": {
      const r = await maintain(service.store, input.archive === true);
      service.changed();
      return r;
    }
    case "backup":
      return backup(service.store, input.destination);
    case "codex.connect":
      await service.codex.connect();
      return {
        connected: service.codex.connected,
        version: service.codex.version,
      };
    default:
      throw new HarnessError("UNKNOWN_ACTION", "未知操作", 404);
  }
}
async function body(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    assert(size <= 1_000_000, "BODY_TOO_LARGE", "请求过大", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw new HarnessError("BAD_JSON", "请求不是有效 JSON");
  }
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
export async function serve(root: string, port = 4317) {
  const workspace = new Workspace(await realpath(root));
  await workspace.load();
  const token = randomBytes(32).toString("hex");
  const clients = new Set<ServerResponse>();
  const broadcast = () => {
    for (const client of clients) client.write("event: change\ndata: {}\n\n");
  };
  const bind = (s: HarnessService) => {
    s.on("changed", broadcast);
    s.on("warning", (message) => {
      console.error(`[harness] ${message}`);
    });
  };
  workspace.services.forEach(bind);
  const publicDir = path.resolve(
    fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts") ? "../../dist/ui" : "../ui",
        import.meta.url,
      ),
    ),
  );
  let serviceUrl = "";
  const saveConnection = async (s: HarnessService) =>
    atomic(
      path.join(s.store.dir, "runtime/server.json"),
      JSON.stringify({
        url: serviceUrl,
        token,
        pid: process.pid,
        projectId: (await s.store.project()).id,
      }),
    );
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    try {
      const host = req.headers.host || "";
      assert(
        /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host),
        "INVALID_HOST",
        "仅接受本机请求",
        403,
      );
      const url = new URL(req.url || "/", `http://${host}`);
      if (url.pathname.startsWith("/api/")) {
        const incoming = (req.headers.authorization || "").replace(
          /^Bearer /,
          "",
        );
        assert(
          incoming.length === token.length &&
            timingSafeEqual(Buffer.from(incoming), Buffer.from(token)),
          "UNAUTHORIZED",
          "需要当前本地服务的访问链接",
          401,
        );
        if (req.headers.origin)
          assert(
            req.headers.origin === `http://${host}`,
            "INVALID_ORIGIN",
            "不允许跨站请求",
            403,
          );
        if (url.pathname === "/api/stop" && req.method === "POST") {
          json(res, 200, { stopped: true });
          setImmediate(() => void close());
          return;
        }
        if (url.pathname === "/api/events" && req.method === "GET") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write("event: connected\ndata: {}\n\n");
          clients.add(res);
          req.on("close", () => clients.delete(res));
          return;
        }
        if (url.pathname === "/api/projects" && req.method === "GET") {
          json(res, 200, await workspace.projects());
          return;
        }
        if (url.pathname === "/api/projects" && req.method === "POST") {
          const data = await body(req);
          assert(
            typeof data.root === "string" && path.isAbsolute(data.root),
            "INVALID_PATH",
            "请提供本机项目绝对路径",
          );
          const p = await workspace.add(data.root, data.name);
          bind(workspace.service(p.id));
          await saveConnection(workspace.service(p.id));
          broadcast();
          json(res, 200, p);
          return;
        }
        const match = /^\/api\/projects\/([^/]+)\/(snapshot|action)$/.exec(
          url.pathname,
        );
        assert(match, "NOT_FOUND", "接口不存在", 404);
        const service = workspace.service(match[1]);
        if (match[2] === "snapshot" && req.method === "GET") {
          json(res, 200, await service.snapshot());
          return;
        }
        assert(req.method === "POST", "METHOD_NOT_ALLOWED", "方法不支持", 405);
        const data = await body(req);
        const result = await action(service, data.action, data.input || {});
        json(res, 200, result);
        return;
      }
      assert(req.method === "GET", "METHOD_NOT_ALLOWED", "方法不支持", 405);
      const rel =
        decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      let target = path.resolve(publicDir, rel);
      assert(
        target.startsWith(publicDir + path.sep),
        "NOT_FOUND",
        "资源不存在",
        404,
      );
      if (!(await exists(target)) && !path.extname(target))
        target = path.join(publicDir, "index.html");
      const content = await readFile(target);
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };
      res.writeHead(200, {
        "Content-Type":
          types[path.extname(target)] || "application/octet-stream",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      });
      res.end(content);
    } catch (error: any) {
      json(res, error.status || (error.name === "ZodError" ? 400 : 500), {
        error: error.message,
        code: error.code || "INTERNAL_ERROR",
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => {
      void workspace.close();
      reject(error);
    });
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  serviceUrl = `http://127.0.0.1:${actualPort}`;
  for (const service of workspace.services.values())
    await saveConnection(service);
  const keepalive = setInterval(() => {
    for (const client of clients) client.write(": ping\n\n");
  }, 15000);
  const close = async () => {
    clearInterval(keepalive);
    clients.forEach((c) => c.end());
    await workspace.close();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return {
    server,
    workspace,
    url: `http://127.0.0.1:${actualPort}`,
    token,
    close,
  };
}
