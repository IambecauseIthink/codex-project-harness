import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  stat,
  open,
  unlink,
  lstat,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  HarnessError,
  ProjectSchema,
  TaskSchema,
  RecordSchema,
  type Project,
  type Task,
  type Run,
  type Evidence,
  type KnowledgeRecord,
} from "./types.js";
export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}-${randomUUID()}`;
export async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
export async function atomic(p: string, text: string) {
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${randomUUID()}.tmp`;
  const fd = await open(tmp, "wx", 0o600);
  try {
    await fd.writeFile(text);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(tmp, p);
}
export function encode(meta: object, body = "") {
  return `---\n${stringify(meta)}---\n\n${body.trim()}\n`;
}
export function decode(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new HarnessError("INVALID_RECORD", "记录缺少结构化头部");
  return { meta: parse(match[1]), body: match[2].trim() };
}
export async function contained(
  root: string,
  relative: string,
  mustExist = true,
) {
  const p = path.resolve(root, relative);
  if (p !== root && !p.startsWith(root + path.sep))
    throw new HarnessError("PATH_ESCAPE", "路径必须位于项目内");
  const target = mustExist
    ? await realpath(p)
    : await realpath(path.dirname(p)).then((parent) =>
        path.join(parent, path.basename(p)),
      );
  if (target !== root && !target.startsWith(root + path.sep))
    throw new HarnessError("PATH_ESCAPE", "符号链接不能越出项目");
  return target;
}
export class Store {
  readonly dir: string;
  constructor(readonly root: string) {
    this.dir = path.join(root, ".harness");
  }
  async lock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(path.join(this.dir, "runtime"), { recursive: true });
    const p = path.join(this.dir, "runtime", "write.lock");
    const started = Date.now();
    let fd;
    while (!fd) {
      try {
        fd = await open(p, "wx", 0o600);
        await fd.writeFile(String(process.pid));
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        try {
          const pid = Number(await readFile(p, "utf8"));
          if (pid) {
            try {
              process.kill(pid, 0);
            } catch (e: any) {
              if (e.code === "ESRCH") {
                await unlink(p).catch(() => {});
                continue;
              }
            }
          }
        } catch {}
        if (Date.now() - started > 10000)
          throw new HarnessError("BUSY", "项目正在更新，请重试", 409);
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    try {
      return await fn();
    } finally {
      await fd.close();
      await unlink(p);
    }
  }
  async project(): Promise<Project> {
    return ProjectSchema.parse(
      parse(await readFile(path.join(this.dir, "project.yaml"), "utf8")),
    );
  }
  async saveProject(p: Project) {
    await atomic(
      path.join(this.dir, "project.yaml"),
      stringify(ProjectSchema.parse(p)),
    );
  }
  private folder(kind: string) {
    return path.join(this.dir, kind);
  }
  async readAll<T>(kind: string): Promise<T[]> {
    const folder = this.folder(kind);
    if (!(await exists(folder))) return [];
    const files = (await readdir(folder)).filter((f) => f.endsWith(".md"));
    const results: T[] = [];
    for (let i = 0; i < files.length; i += 32)
      results.push(
        ...(await Promise.all(
          files.slice(i, i + 32).map(async (f) => {
            const { meta, body } = decode(
              await readFile(path.join(folder, f), "utf8"),
            );
            if (kind === "backlog/tasks")
              return TaskSchema.parse({ ...meta, description: body }) as T;
            if (kind === "records")
              return RecordSchema.parse({ ...meta, body }) as T;
            return meta as T;
          }),
        )),
      );
    return results;
  }
  async tasks() {
    return this.readAll<Task>("backlog/tasks");
  }
  async records() {
    return this.readAll<KnowledgeRecord>("records");
  }
  async runs() {
    return this.readAll<Run>("runs");
  }
  async evidence() {
    return this.readAll<Evidence>("evidence");
  }
  private validId(value: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(value))
      throw new HarnessError("INVALID_ID", "无效记录编号");
  }
  async task(taskId: string) {
    this.validId(taskId);
    const p = path.join(this.dir, "backlog/tasks", `${taskId}.md`);
    if (!(await exists(p)))
      throw new HarnessError("NOT_FOUND", "任务不存在", 404);
    const { meta, body } = decode(await readFile(p, "utf8"));
    return TaskSchema.parse({ ...meta, description: body });
  }
  async run(runId: string) {
    this.validId(runId);
    const { meta } = decode(
      await readFile(path.join(this.dir, "runs", `${runId}.md`), "utf8"),
    );
    return meta as Run;
  }
  private async retainVersion(relative: string, revision: number) {
    const p = path.join(this.dir, relative);
    if (await exists(p)) {
      const old = await readFile(p, "utf8");
      const { meta } = decode(old);
      if (meta.revision !== revision)
        await atomic(
          path.join(
            this.dir,
            "history",
            relative.replace(/\.md$/, ""),
            `rev-${meta.revision}.md`,
          ),
          old,
        );
    }
  }
  async saveTask(t: Task) {
    this.validId(t.id);
    await this.retainVersion(`backlog/tasks/${t.id}.md`, t.revision);
    const { description, ...meta } = TaskSchema.parse(t);
    await atomic(
      path.join(this.dir, "backlog/tasks", `${t.id}.md`),
      encode(meta, description),
    );
  }
  async saveRecord(r: KnowledgeRecord) {
    this.validId(r.id);
    await this.retainVersion(`records/${r.id}.md`, r.revision);
    const { body, ...meta } = RecordSchema.parse(r);
    await atomic(
      path.join(this.dir, "records", `${r.id}.md`),
      encode(meta, body),
    );
  }
  async saveRun(r: Run) {
    this.validId(r.id);
    await atomic(
      path.join(this.dir, "runs", `${r.id}.md`),
      encode(r, `# ${r.id}\n\n执行记录是运行事实，不等于产品已验收。`),
    );
  }
  async saveEvidence(e: Evidence) {
    this.validId(e.id);
    await atomic(
      path.join(this.dir, "evidence", `${e.id}.md`),
      encode(e, `# 验证证据\n\n代码指纹：${e.baseline.digest}`),
    );
  }
  async transact(writes: { relative: string; content: string }[]) {
    // Write-ahead intent makes multi-record promotion recoverable; callers hold the project lock.
    const p = path.join(this.dir, "runtime", "transaction.json");
    await atomic(p, JSON.stringify(writes));
    for (const w of writes)
      await atomic(await this.safeWritePath(w.relative), w.content);
    await unlink(p);
  }
  private async safeWritePath(relative: string) {
    const p = path.resolve(this.dir, relative);
    if (!p.startsWith(this.dir + path.sep))
      throw new HarnessError("PATH_ESCAPE", "无效事务路径");
    await mkdir(path.dirname(p), { recursive: true });
    return contained(this.dir, relative, false);
  }
  async recover() {
    return this.lock(async () => {
      const p = path.join(this.dir, "runtime", "transaction.json");
      if (!(await exists(p))) return;
      const writes = JSON.parse(await readFile(p, "utf8"));
      for (const w of writes)
        await atomic(await this.safeWritePath(w.relative), w.content);
      await unlink(p);
    });
  }
}
