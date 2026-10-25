import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { exists } from "../core/store.js";
import { HarnessError } from "../core/types.js";
export interface RpcEvent {
  method: string;
  params: any;
  id?: number | string;
}
export async function findCodex(explicit?: string) {
  if (explicit) return explicit;
  if (process.env.HARNESS_CODEX_BIN) return process.env.HARNESS_CODEX_BIN;
  for (const p of [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ])
    if (await exists(p)) return p;
  return "codex";
}
export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private requests = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private connecting?: Promise<void>;
  connected = false;
  version?: string;
  lastError?: string;
  constructor(public binary?: string) {
    super();
  }
  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open()
      .catch(async (error) => {
        await this.close();
        this.lastError = error.message;
        throw error;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }
  private async open() {
    const executable = await findCodex(this.binary);
    const child = spawn(executable, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child = child;
    // Drain stderr. It can contain user-specific configuration, so don't forward it to the browser.
    child.stderr.on("data", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.child !== child) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.lastError = "Codex 返回了无效协议行";
        return;
      }
      if (msg.id !== undefined && !msg.method) {
        const entry = this.requests.get(msg.id);
        if (!entry) return;
        this.requests.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error)
          entry.reject(
            new HarnessError(
              "CODEX_RPC",
              msg.error.message || JSON.stringify(msg.error),
              502,
            ),
          );
        else entry.resolve(msg.result);
      } else if (msg.method) this.emit("event", msg as RpcEvent);
    });
    const lost = (error: string) => {
      if (this.child !== child) return;
      this.connected = false;
      this.lastError = error;
      for (const r of this.requests.values()) {
        clearTimeout(r.timer);
        r.reject(new HarnessError("CODEX_DISCONNECTED", error, 503));
      }
      this.requests.clear();
      this.emit("disconnect", error);
    };
    child.once("error", (e) => lost(e.message));
    child.once("exit", (code) =>
      lost(`Codex 连接已关闭（${code ?? "signal"}）`),
    );
    const result = await this.request("initialize", {
      clientInfo: {
        name: "project_harness",
        title: "Project Harness",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.version = result.userAgent;
    this.notify("initialized");
    this.connected = true;
    this.lastError = undefined;
  }
  request(method: string, params: any = {}, timeout = 30000): Promise<any> {
    if (!this.child || !this.child.stdin.writable)
      return Promise.reject(
        new HarnessError("CODEX_DISCONNECTED", "Codex 尚未连接", 503),
      );
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(
          new HarnessError(
            "CODEX_TIMEOUT",
            `${method} 响应超时；结果未知，不能直接重试派发`,
            504,
          ),
        );
      }, timeout);
      this.requests.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  notify(method: string, params?: unknown) {
    this.child?.stdin.write(JSON.stringify({ method, params }) + "\n");
  }
  respond(id: number | string, result: unknown) {
    this.child?.stdin.write(JSON.stringify({ id, result }) + "\n");
  }
  reject(id: number | string, message: string) {
    this.child?.stdin.write(
      JSON.stringify({ id, error: { code: -32000, message } }) + "\n",
    );
  }
  async start(
    cwd: string,
    instructions: string,
    model?: string,
    readOnly = false,
  ) {
    await this.connect();
    return this.request("thread/start", {
      cwd,
      approvalPolicy: "on-request",
      sandbox: readOnly ? "read-only" : "workspace-write",
      ephemeral: false,
      model,
      developerInstructions: instructions,
    });
  }
  async turn(threadId: string, text: string, outputSchema?: object) {
    return this.request(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        outputSchema,
      },
      60000,
    );
  }
  async read(threadId: string) {
    await this.connect();
    return this.request("thread/read", { threadId });
  }
  async history(threadId: string) {
    await this.connect();
    return this.request("thread/turns/list", {
      threadId,
      limit: 20,
      itemsView: "full",
    });
  }
  async resume(threadId: string, cwd?: string) {
    await this.connect();
    return this.request("thread/resume", { threadId, cwd, excludeTurns: true });
  }
  async interrupt(threadId: string, turnId: string) {
    return this.request("turn/interrupt", { threadId, turnId });
  }
  close(): Promise<void> | void {
    const child = this.child;
    this.child = undefined;
    this.connected = false;
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(
        new HarnessError("CODEX_DISCONNECTED", "Codex 连接已关闭", 503),
      );
    }
    this.requests.clear();
    if (child && child.exitCode === null && child.signalCode === null)
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      });
  }
}
