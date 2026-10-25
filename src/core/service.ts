import { EventEmitter } from "node:events";
import path from "node:path";
import { readFile, open, unlink } from "node:fs/promises";
import { Store, now, id, encode, atomic, exists } from "./store.js";
import { baseline, hash, createWorktree, commitCandidate, git } from "./git.js";
import {
  ProjectSchema,
  TaskSchema,
  RecordSchema,
  assert,
  HarnessError,
  type Task,
  type Run,
  type Snapshot,
  type KnowledgeRecord,
  type Evidence,
} from "./types.js";
import { CodexClient, type RpcEvent } from "../codex/client.js";
import { prepareContext } from "./context.js";
import { checksDigest, verify } from "./verify.js";
import { maintain } from "./project.js";
const reviewSchema = {
  type: "object",
  properties: {
    passed: { type: "boolean" },
    summary: { type: "string" },
    issues: { type: "array", items: { type: "string" } },
  },
  required: ["passed", "summary", "issues"],
  additionalProperties: false,
};
const active = new Set([
  "starting",
  "running",
  "reviewing",
  "verifying",
  "awaiting_input",
  "unknown",
]);
const scopeConflict = (a: string[], b: string[]) =>
  !a.length ||
  !b.length ||
  a.some((x) =>
    b.some((y) => x === y || x.startsWith(y + "/") || y.startsWith(x + "/")),
  );
export function validateGraph(tasks: Task[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const counts = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const t of tasks) {
    counts.set(t.id, t.dependsOn.length);
    for (const dep of t.dependsOn) {
      assert(byId.has(dep), "MISSING_DEPENDENCY", `前置任务不存在：${dep}`);
      const list = children.get(dep) || [];
      list.push(t.id);
      children.set(dep, list);
    }
  }
  const queue = tasks.filter((t) => !t.dependsOn.length).map((t) => t.id);
  let seen = 0;
  for (let i = 0; i < queue.length; i++) {
    seen++;
    for (const child of children.get(queue[i]) || []) {
      const next = counts.get(child)! - 1;
      counts.set(child, next);
      if (!next) queue.push(child);
    }
  }
  assert(seen === tasks.length, "DEPENDENCY_CYCLE", "任务依赖形成循环");
}
export class HarnessService extends EventEmitter {
  readonly store: Store;
  readonly codex: CodexClient;
  private ticking = false;
  private ownsLease = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private events: Promise<void> = Promise.resolve();
  private completing = new Set<string>();
  constructor(
    readonly root: string,
    codex?: CodexClient,
  ) {
    super();
    this.store = new Store(root);
    this.codex = codex || new CodexClient();
    this.codex.on("event", (e: RpcEvent) => {
      this.events = this.events
        .then(() => this.onEvent(e))
        .catch((error) => {
          this.emit("warning", String(error));
        });
    });
    this.codex.on("disconnect", () => {
      void this.disconnected();
    });
  }
  changed() {
    this.emit("changed");
  }
  async start() {
    await this.store.recover();
    const leasePath = path.join(this.store.dir, "runtime/service.lock");
    try {
      const pid = Number(await readFile(leasePath, "utf8"));
      if (pid) {
        try {
          process.kill(pid, 0);
          throw new HarnessError(
            "ALREADY_RUNNING",
            "项目已有本地服务，请使用原服务地址",
            409,
          );
        } catch (e: any) {
          if (e.code !== "ESRCH") throw e;
          await unlink(leasePath);
        }
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    const lease = await open(leasePath, "wx", 0o600);
    await lease.writeFile(String(process.pid));
    await lease.close();
    this.ownsLease = true;
    this.codex.binary =
      (await this.store.project()).codexBin || this.codex.binary;
    // Uncertain execution is never replayed automatically after a restart.
    await this.store.lock(async () => {
      for (const run of await this.store.runs())
        if (active.has(run.state)) {
          run.state = "unknown";
          run.error = "服务重启：先核对原会话与工作区，再继续；尚未重复派发。";
          delete run.pendingRequest;
          await this.store.saveRun(run);
        }
    });
    this.timer = setInterval(
      () => void this.tick().catch((e) => this.emit("warning", e.message)),
      3000,
    );
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.codex.close();
    await this.events;
    await this.disconnected();
    if (this.ownsLease) {
      await unlink(path.join(this.store.dir, "runtime/service.lock")).catch(
        () => {},
      );
      this.ownsLease = false;
    }
  }
  async snapshot(locked = false): Promise<Snapshot> {
    if (!locked) return this.store.lock(() => this.snapshot(true));
    const [project, tasks, records, runs, evidence, current] =
      await Promise.all([
        this.store.project(),
        this.store.tasks(),
        this.store.records(),
        this.store.runs(),
        this.store.evidence(),
        baseline(this.root),
      ]);
    const warnings: string[] = [];
    try {
      validateGraph(tasks);
    } catch (e: any) {
      warnings.push(e.message);
    }
    const checks = new Set(project.checks.map((c) => c.id));
    for (const r of records)
      if (!["archived", "superseded"].includes(r.status))
        for (const guard of r.guards)
          if (!checks.has(guard))
            warnings.push(`${r.title}：防复发检查 ${guard} 已缺失`);
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const runMap = new Map(runs.map((r) => [r.id, r]));
    const evidenceMap = new Map(evidence.map((e) => [e.id, e]));
    const configDigest = checksDigest(project);
    const taskViews = tasks.map((t) => {
      const run = runMap.get(t.currentRunId || "");
      const e = evidenceMap.get(run?.evidenceId || "");
      const blocked = t.dependsOn
        .filter((d) => {
          const dep = taskMap.get(d);
          return !dep || dep.state !== "done" || !dep.acceptance;
        })
        .map((d) => `等待 ${taskMap.get(d)?.title ?? d}`);
      if (t.authorizedRevision !== t.revision)
        blocked.push("当前任务版本尚未授权");
      if (run && ["failed", "unknown", "paused"].includes(run.state))
        blocked.push(run.error || "执行已暂停");
      const assurance = !e
        ? ("unknown" as const)
        : !e.passed
          ? ("failed" as const)
          : e.taskRevision !== t.revision ||
              e.checksDigest !== configDigest ||
              (run?.integrated && e.baseline.digest !== current.digest)
            ? ("stale" as const)
            : ("verified" as const);
      return {
        ...t,
        run,
        blocked,
        assurance,
        ready:
          !t.archived &&
          t.state === "queued" &&
          blocked.length === 0 &&
          !warnings.length,
      };
    });
    return {
      project,
      tasks: taskViews,
      records,
      runs,
      evidence,
      warnings,
      codex: {
        connected: this.codex.connected,
        version: this.codex.version,
        error: this.codex.lastError,
      },
      at: now(),
    };
  }
  async search(input: {
    query?: string;
    includeArchived?: boolean;
    offset?: number;
    limit?: number;
  }) {
    const query = (input.query || "").toLowerCase();
    const offset = Math.max(0, Math.floor(input.offset || 0));
    const limit = Math.min(200, Math.max(1, Math.floor(input.limit || 50)));
    const items = [
      ...(await this.store.tasks()),
      ...(await this.store.records()),
    ].filter(
      (r) =>
        (input.includeArchived ||
          !("archived" in r
            ? r.archived
            : ["archived", "superseded"].includes(r.status))) &&
        JSON.stringify(r).toLowerCase().includes(query),
    );
    return {
      total: items.length,
      items: items.slice(offset, offset + limit),
      nextOffset: offset + limit < items.length ? offset + limit : null,
    };
  }
  async saveProject(input: any) {
    const result = await this.store.lock(async () => {
      const p = await this.store.project();
      assert(
        input.expectedRevision === p.revision,
        "CONFLICT",
        "项目配置已更新，请刷新后再改",
        409,
      );
      const next = ProjectSchema.parse({
        ...p,
        ...input.patch,
        id: p.id,
        root: p.root,
        createdAt: p.createdAt,
        schemaVersion: p.schemaVersion,
        revision: p.revision + 1,
        updatedAt: now(),
      });
      assert(
        new Set(next.checks.map((c) => c.id)).size === next.checks.length,
        "DUPLICATE_CHECK",
        "检查编号必须唯一",
      );
      const protectedGuards = (await this.store.records())
        .filter((r) => !["superseded", "archived"].includes(r.status))
        .flatMap((r) => r.guards);
      assert(
        protectedGuards.every((g) => next.checks.some((c) => c.id === g)),
        "GUARD_REMOVED",
        "配置移除了有效教训关联的检查。请先明确记录替代或退役依据。",
      );
      for (const guard of protectedGuards) {
        const before = p.checks.find((c) => c.id === guard);
        const after = next.checks.find((c) => c.id === guard)!;
        assert(
          !before ||
            (before.requiredCases.every((name) =>
              after.requiredCases.includes(name),
            ) &&
              (!["test", "e2e"].includes(before.kind) ||
                ["test", "e2e"].includes(after.kind))),
          "GUARD_WEAKENED",
          "不能删除有效教训的必需回归用例或把行为检查改为构建检查",
        );
      }
      await this.store.saveProject(next);
      return next;
    });
    if (input.patch?.currentVersion) await maintain(this.store, true);
    this.changed();
    return result;
  }
  async saveTask(input: any) {
    const result = await this.store.lock(async () => {
      const tasks = await this.store.tasks();
      const project = await this.store.project();
      const old = input.id ? tasks.find((t) => t.id === input.id) : undefined;
      if (input.id) assert(old, "NOT_FOUND", "任务不存在", 404);
      if (old)
        assert(
          old.revision === input.expectedRevision,
          "CONFLICT",
          "任务已被其他入口修改，请刷新",
          409,
        );
      const time = now();
      const patch = input.patch || input;
      const permitted = Object.fromEntries(
        [
          "title",
          "description",
          "role",
          "priority",
          "version",
          "scopes",
          "dependsOn",
          "recordIds",
          "checkIds",
          "acceptanceCriteria",
        ]
          .filter((k) => patch[k] !== undefined)
          .map((k) => [k, patch[k]]),
      );
      const task = TaskSchema.parse({
        ...old,
        ...permitted,
        id: old?.id || id("task"),
        revision: (old?.revision || 0) + 1,
        state: "draft",
        authorizedRevision: null,
        acceptance: undefined,
        currentRunId: old?.currentRunId || null,
        version: permitted.version || old?.version || project.currentVersion,
        createdAt: old?.createdAt || time,
        updatedAt: time,
      });
      validateGraph([...tasks.filter((t) => t.id !== task.id), task]);
      const records = await this.store.records();
      assert(
        task.recordIds.every((x) => records.some((r) => r.id === x)),
        "MISSING_RECORD",
        "关联记录不存在",
      );
      assert(
        task.checkIds.every((x) => project.checks.some((c) => c.id === x)),
        "MISSING_CHECK",
        "关联检查不存在",
      );
      await this.store.saveTask(task);
      return task;
    });
    this.changed();
    return result;
  }
  async authorize(taskId: string, expectedRevision: number) {
    const task = await this.store.lock(async () => {
      const t = await this.store.task(taskId);
      assert(
        t.revision === expectedRevision,
        "CONFLICT",
        "任务版本已变化",
        409,
      );
      assert(t.acceptanceCriteria.length, "NO_ACCEPTANCE", "请先写清验收条件");
      assert(
        t.state === "draft" || t.state === "queued",
        "INVALID_STATE",
        "当前任务不能重新授权",
      );
      t.authorizedRevision = t.revision;
      t.state = "queued";
      t.updatedAt = now();
      if (t.currentRunId) {
        const run = await this.store.run(t.currentRunId);
        assert(
          !active.has(run.state),
          "RUN_ACTIVE",
          "旧版本仍在执行，请先暂停旧会话",
        );
        t.currentRunId = null;
      }
      await this.store.saveTask(t);
      return t;
    });
    this.changed();
    return task;
  }
  async saveRecord(input: any) {
    const result = await this.store.lock(async () => {
      const records = await this.store.records();
      const old = input.id ? records.find((r) => r.id === input.id) : undefined;
      if (input.id) assert(old, "NOT_FOUND", "记录不存在", 404);
      if (old)
        assert(
          old.revision === input.expectedRevision,
          "CONFLICT",
          "记录已更新，请刷新",
          409,
        );
      const time = now();
      const record = RecordSchema.parse({
        ...old,
        ...input.patch,
        id: old?.id || id("record"),
        revision: (old?.revision || 0) + 1,
        createdAt: old?.createdAt || time,
        updatedAt: time,
      });
      if (record.kind === "bug" && record.status === "verified") {
        const tasks = await this.store.tasks();
        const runs = await this.store.runs();
        const proofs = await this.store.evidence();
        assert(
          record.links.some((l) =>
            tasks.some(
              (t) =>
                t.id === l &&
                t.state === "done" &&
                t.acceptance &&
                runs.some(
                  (r) =>
                    r.id === t.acceptance!.runId &&
                    r.taskRevision === t.revision &&
                    r.integrated &&
                    r.review?.passed &&
                    proofs.some((e) => e.id === r.evidenceId && e.passed),
                ),
            ),
          ),
          "BUG_NOT_VERIFIED",
          "缺陷必须关联有真实证据、独立审查和验收的修复任务",
        );
      }
      if (record.status === "superseded")
        assert(
          record.supersededBy &&
            records.some(
              (r) =>
                r.id !== record.id &&
                r.id === record.supersededBy &&
                !["superseded", "archived"].includes(r.status),
            ),
          "MISSING_SUCCESSOR",
          "被替代记录必须指向新的有效记录",
        );
      if (
        old?.guards.length &&
        (old.guards.some((g) => !record.guards.includes(g)) ||
          ["archived", "superseded"].includes(record.status))
      )
        assert(
          record.body.trim() !== old.body.trim(),
          "RETIREMENT_REASON",
          "请在正文写明防复发检查替代或退役的依据",
        );
      await this.store.saveRecord(record);
      return record;
    });
    this.changed();
    return result;
  }
  async dispatch(taskId: string) {
    const reservation = await this.store.lock(async () => {
      const view = await this.snapshot(true);
      const task = view.tasks.find((t) => t.id === taskId);
      assert(task, "NOT_FOUND", "任务不存在", 404);
      if (task.run && active.has(task.run.state)) return { existing: task.run };
      assert(
        task.ready,
        "NOT_READY",
        task.blocked.join("；") || "任务未进入待执行状态",
      );
      assert(
        view.runs.filter((r) => active.has(r.state)).length <
          view.project.maxConcurrent,
        "CAPACITY",
        "并发名额已满",
        409,
      );
      for (const r of view.runs.filter((r) => active.has(r.state))) {
        const other = view.tasks.find((t) => t.id === r.taskId);
        assert(
          !other || !scopeConflict(task.scopes, other.scopes),
          "SCOPE_CONFLICT",
          "相同模块正在执行，等待前一任务完成",
          409,
        );
      }
      assert(
        view.project.checks.some((c) => ["test", "e2e"].includes(c.kind)),
        "NO_BEHAVIOR_CHECK",
        "请先配置至少一条能统计实际通过用例数的行为检查",
      );
      const context = await prepareContext(this.store, task);
      const runId = id("run");
      const workspace = await createWorktree(this.root, runId);
      const run: Run = {
        id: runId,
        taskId,
        taskRevision: task.revision,
        state: "starting",
        phase: "implementation",
        createdAt: now(),
        updatedAt: now(),
        ...workspace,
        baseline: await baseline(workspace.worktree),
        context: context.text,
        contextDigest: context.digest,
        knowledgeDigest: context.knowledgeDigest,
        events: [],
      };
      const {
        run: _run,
        blocked: _blocked,
        assurance: _assurance,
        ready: _ready,
        ...plain
      } = task;
      const updated = {
        ...plain,
        state: "running" as const,
        currentRunId: runId,
        updatedAt: now(),
      };
      const { description, ...taskMeta } = updated;
      await this.store.transact([
        { relative: `runs/${run.id}.md`, content: encode(run) },
        {
          relative: `backlog/tasks/${taskId}.md`,
          content: encode(taskMeta, description),
        },
      ]);
      return { run, task: updated, project: view.project };
    });
    if (reservation.existing) return reservation.existing;
    const { run, task, project } = reservation;
    try {
      this.codex.binary = project!.codexBin || this.codex.binary;
      const response = await this.codex.start(
        run!.worktree,
        "你正在执行用户通过 Harness 授权的独立开发任务。只按任务上下文行动。",
        project!.model,
      );
      await this.store.lock(async () => {
        const latest = await this.store.run(run!.id);
        latest.threadId = response.thread.id;
        if (latest.state === "starting") latest.state = "running";
        latest.updatedAt = now();
        await this.store.saveRun(latest);
      });
      await this.codex.request("thread/name/set", {
        threadId: response.thread.id,
        name: `${project!.name} · ${task!.title}`,
      });
      await this.assertContinuing(run!.id);
      const turn = await this.codex.turn(response.thread.id, run!.context);
      await this.store.lock(async () => {
        const latest = await this.store.run(run!.id);
        latest.turnId = turn.turn.id;
        await this.store.saveRun(latest);
      });
    } catch (error: any) {
      await this.fail(
        run!.id,
        error.message,
        /TIMEOUT|DISCONNECTED/.test(error.code || "") ? "unknown" : "failed",
      );
    }
    this.changed();
    return this.store.run(run!.id);
  }
  async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const snapshot = await this.snapshot();
      for (const run of snapshot.runs)
        if (
          ["running", "reviewing"].includes(run.state) &&
          Date.now() - Date.parse(run.createdAt) > snapshot.project.runTimeoutMs
        )
          await this.pause(run.id, "执行时间达到项目上限，已暂停并保留工作");
      if (
        snapshot.project.autoDispatch &&
        !snapshot.warnings.length &&
        !snapshot.runs.some((r) =>
          /requires a newer|unsupported|not supported|method not found/i.test(
            r.error || "",
          ),
        )
      )
        for (const task of snapshot.tasks
          .filter((t) => t.ready)
          .sort((a, b) => a.priority - b.priority)) {
          try {
            await this.dispatch(task.id);
          } catch (error: any) {
            if (!["CAPACITY", "SCOPE_CONFLICT"].includes(error.code))
              this.emit("warning", error.message);
          }
        }
    } finally {
      this.ticking = false;
    }
  }
  private async onEvent(event: RpcEvent) {
    const tid = event.params?.threadId;
    if (!tid) {
      if (event.id !== undefined)
        this.codex.reject(event.id, "Unsupported project request");
      return;
    }
    const run = (await this.store.runs()).find(
      (r) => r.threadId === tid || r.reviewThreadId === tid,
    );
    if (!run) {
      if (event.id !== undefined)
        this.codex.reject(event.id, "Unknown execution");
      return;
    }
    if (["paused", "failed", "unknown", "completed"].includes(run.state)) {
      if (event.id !== undefined)
        this.codex.reject(event.id, "Execution is not active");
      return;
    }
    const expectedThread =
      run.phase === "review" ? run.reviewThreadId : run.threadId;
    if (tid !== expectedThread) return;
    const expectedTurn = run.phase === "review" ? run.reviewTurnId : run.turnId;
    if (
      event.method === "turn/completed" &&
      event.params.turn?.id &&
      expectedTurn &&
      event.params.turn.id !== expectedTurn
    )
      return;
    await this.store.lock(async () => {
      const current = await this.store.run(run.id);
      if (event.method === "turn/started") {
        if (tid === current.reviewThreadId)
          current.reviewTurnId = event.params.turn.id;
        else current.turnId = event.params.turn.id;
      }
      if (event.id !== undefined) {
        current.pendingRequest = {
          id: event.id,
          method: event.method,
          params: event.params,
        };
        current.state = "awaiting_input";
      }
      if (
        event.method === "item/completed" &&
        event.params.item?.type === "agentMessage"
      )
        current.summary = event.params.item.text;
      if (event.method === "error")
        current.error = event.params.error?.message || "Codex 执行错误";
      if (!event.method.endsWith("/delta"))
        current.events = [
          ...current.events,
          {
            at: now(),
            type: event.method,
            threadId: tid,
            turnId:
              event.params.turn?.id || event.params.turnId || expectedTurn,
            text: event.method === "error" ? current.error : undefined,
          },
        ].slice(-400);
      current.updatedAt = now();
      await this.store.saveRun(current);
    });
    this.changed();
    if (event.method === "turn/completed") {
      const outcome = event.params.turn;
      if (outcome.status === "interrupted")
        await this.fail(run.id, "会话已中断，工作区保留", "paused");
      else if (outcome.status !== "completed")
        await this.fail(run.id, outcome.error?.message || "执行未成功");
      else if (!this.completing.has(run.id)) {
        this.completing.add(run.id);
        void this.completePhase(run.id)
          .catch((e) => this.phaseFailure(run.id, e))
          .finally(() => this.completing.delete(run.id));
      }
    }
  }
  async fail(runId: string, message: string, state: Run["state"] = "failed") {
    await this.store.lock(async () => {
      const r = await this.store.run(runId);
      r.state = state;
      r.error = message;
      r.updatedAt = now();
      delete r.pendingRequest;
      await this.store.saveRun(r);
    });
    this.changed();
  }
  private async assertContinuing(runId: string) {
    const run = await this.store.run(runId);
    const task = await this.store.task(run.taskId);
    assert(
      !this.stopped && !["paused", "unknown", "failed"].includes(run.state),
      "RUN_STOPPED",
      "执行已停止，保留结果但不继续推进",
    );
    assert(
      task.revision === run.taskRevision &&
        task.authorizedRevision === task.revision &&
        task.currentRunId === run.id,
      "STALE_RUN",
      "任务已更新，旧版本结果不能验收",
    );
    if (run.knowledgeDigest)
      assert(
        run.knowledgeDigest ===
          (await prepareContext(this.store, task)).knowledgeDigest,
        "STALE_CONTEXT",
        "相关业务规则或决定已变化；请核对新规则后重新验证或恢复任务",
      );
    return { run, task };
  }
  private async updatePhase(
    runId: string,
    patch: Partial<Run>,
    taskState?: Task["state"],
  ) {
    return this.store.lock(async () => {
      const { run, task } = await this.assertContinuing(runId);
      Object.assign(run, patch, { updatedAt: now() });
      if (taskState) {
        task.state = taskState;
        task.updatedAt = now();
        const { description, ...meta } = task;
        await this.store.transact([
          { relative: `runs/${run.id}.md`, content: encode(run) },
          {
            relative: `backlog/tasks/${task.id}.md`,
            content: encode(meta, description),
          },
        ]);
      } else await this.store.saveRun(run);
      this.changed();
      return run;
    });
  }
  private async phaseFailure(runId: string, error: any) {
    if (error.code === "RUN_STOPPED") return;
    const run = await this.store.run(runId);
    if (["paused", "unknown"].includes(run.state)) return;
    const repairable = ["CHECKS_FAILED", "REVIEW_FAILED"].includes(error.code);
    if (repairable) {
      await this.store.lock(async () => {
        const bugId = `bug-${run.id}`;
        const old = (await this.store.records()).find((r) => r.id === bugId);
        await this.store.saveRecord(
          RecordSchema.parse({
            ...old,
            id: bugId,
            kind: "bug",
            title: `执行检查发现问题 · ${(await this.store.task(run.taskId)).title}`,
            status: "reproduced",
            body: `${error.message}\n\n运行 ${run.id}；证据 ${run.evidenceId || "独立审查"}。修复后必须重验并由用户验收。`,
            links: [run.taskId],
            scopes: (await this.store.task(run.taskId)).scopes,
            revision: (old?.revision || 0) + 1,
            createdAt: old?.createdAt || now(),
            updatedAt: now(),
          }),
        );
      });
      if ((run.repairAttempts || 0) < 2 && run.threadId) {
        const evidence = (await this.store.evidence()).find(
          (e) => e.id === run.evidenceId,
        );
        try {
          await this.updatePhase(
            runId,
            {
              phase: "implementation",
              state: "running",
              repairAttempts: (run.repairAttempts || 0) + 1,
              error: error.message,
              review: undefined,
            },
            "running",
          );
          await this.codex.resume(run.threadId);
          const result = await this.codex.turn(
            run.threadId,
            `上次验证失败。只修复这些问题，不弱化测试或删除检查；这是最多两次自动修复中的第 ${(run.repairAttempts || 0) + 1} 次。\n${error.message}\n${JSON.stringify(evidence?.results || [])}`,
          );
          await this.updatePhase(runId, { turnId: result.turn.id });
          return;
        } catch (e: any) {
          if (e.code === "RUN_STOPPED") return;
          error = e;
        }
      }
    }
    await this.fail(
      runId,
      `${error.message}${repairable ? " 自动修复次数已用完，等待重新定位。" : ""}`,
    );
  }
  private async completePhase(runId: string) {
    let { run, task } = await this.assertContinuing(runId);
    const project = await this.store.project();
    if (run.phase === "review") {
      let verdict: any;
      try {
        verdict = JSON.parse(run.summary || "");
      } catch {
        throw new HarnessError(
          "INVALID_REVIEW",
          "审查没有返回可核对的结构化结论",
        );
      }
      assert(
        typeof verdict.passed === "boolean" &&
          typeof verdict.summary === "string" &&
          Array.isArray(verdict.issues),
        "INVALID_REVIEW",
        "审查结果格式不正确",
      );
      await this.updatePhase(runId, { review: verdict });
      assert(
        verdict.passed && verdict.issues.length === 0,
        "REVIEW_FAILED",
        `审查未通过：${verdict.summary} ${verdict.issues.join("；")}`,
      );
      const after = await baseline(run.worktree);
      assert(
        after.digest === run.candidate?.digest,
        "REVIEW_CHANGED_CODE",
        "审查期间代码发生变化，需要重新验证",
      );
      const proof = (await this.store.evidence()).find(
        (e) => e.id === run.evidenceId,
      );
      assert(
        proof?.checksDigest === checksDigest(project),
        "STALE_EVIDENCE",
        "检查配置已变化，需要重新验证",
      );
      await this.updatePhase(
        runId,
        { state: "completed", error: undefined },
        "acceptance",
      );
      return;
    }
    run = await this.updatePhase(runId, { state: "verifying" }, "verifying");
    const evidence = await verify(project, task, run);
    await this.store.saveEvidence(evidence);
    run = await this.updatePhase(runId, {
      evidenceId: evidence.id,
      candidate: evidence.baseline,
    });
    assert(
      evidence.passed,
      "CHECKS_FAILED",
      "真实检查未通过或无法证明有用例实际执行。请查看验证证据后修复。",
    );
    const resultCommit = await commitCandidate(
      run.worktree,
      `harness: ${task.title}`,
    );
    run = await this.updatePhase(runId, {
      resultCommit,
      candidate: await baseline(run.worktree),
      phase: "review",
      state: "reviewing",
      summary: undefined,
    });
    const reviewer = await this.codex.start(
      run.worktree,
      "你是独立质量审查者。只读审查，不编辑任何文件。基于任务验收、真实差异和测试结果判断。",
      project.model,
      true,
    );
    // Persist the actual ID even if the task was paused while thread/start was pending.
    await this.store.lock(async () => {
      const latest = await this.store.run(runId);
      latest.reviewThreadId = reviewer.thread.id;
      latest.reviewThreadIds = [
        ...new Set([...(latest.reviewThreadIds || []), reviewer.thread.id]),
      ];
      latest.events.push({
        at: now(),
        type: "review/thread-created",
        threadId: reviewer.thread.id,
      });
      await this.store.saveRun(latest);
    });
    await this.assertContinuing(runId);
    await this.codex.request("thread/name/set", {
      threadId: reviewer.thread.id,
      name: `${project.name} · 审查 · ${task.title}`,
    });
    const turn = await this.codex.turn(
      reviewer.thread.id,
      `${run.context}\n\n独立审查从 ${run.baseline.head} 到 ${resultCommit} 的真实差异。检查已有功能是否回归，接口是否连通，验收是否满足。已运行检查：${JSON.stringify(evidence.results.map(({ output, ...r }) => r))}。返回结构化结论；若发现问题 passed=false，列出可核对位置与原因。`,
      reviewSchema,
    );
    await this.store.lock(async () => {
      const latest = await this.store.run(runId);
      latest.reviewTurnId = turn.turn.id;
      await this.store.saveRun(latest);
    });
    this.changed();
  }
  async pause(runId: string, reason = "用户暂停") {
    const run = await this.store.run(runId);
    assert(run.state !== "completed", "INVALID_STATE", "已完成执行不能暂停");
    await this.fail(runId, reason, "paused");
    const tid = run.phase === "review" ? run.reviewThreadId : run.threadId;
    const turn = run.phase === "review" ? run.reviewTurnId : run.turnId;
    if (tid && turn) {
      await this.codex.connect();
      await this.codex.interrupt(tid, turn);
    }
    await this.fail(runId, reason, "paused");
    return this.store.run(runId);
  }
  async reconcile(runId: string) {
    const run = await this.store.run(runId);
    const tid = run.phase === "review" ? run.reviewThreadId : run.threadId;
    assert(
      tid,
      "UNKNOWN_CREATION",
      "创建结果未知：请人工核对 Codex 会话，不能自动重建",
    );
    const [metadata, history] = await Promise.all([
      this.codex.read(tid),
      this.codex.history(tid),
    ]);
    return {
      run,
      thread: metadata.thread,
      turns: history.data,
      guidance:
        "核对后可继续原会话或重新验证；历史 completed 本身不证明任务成功。",
    };
  }
  async resume(
    runId: string,
    message = "继续原任务，先检查已有改动与失败证据。不要重复已完成的工作。",
  ) {
    const run = await this.store.lock(async () => {
      const r = await this.store.run(runId);
      const task = await this.store.task(r.taskId);
      assert(
        task.revision === r.taskRevision &&
          task.authorizedRevision === task.revision,
        "STALE_RUN",
        "任务版本或授权已变化，请重新规划",
      );
      assert(
        ["paused", "failed", "unknown"].includes(r.state),
        "INVALID_STATE",
        "当前执行不能恢复",
      );
      const tid = r.phase === "review" ? r.reviewThreadId : r.threadId;
      assert(tid, "UNKNOWN_CREATION", "没有确定会话编号，不能盲目重新创建");
      const meta = await this.codex.read(tid);
      assert(
        meta.thread.status?.type !== "active",
        "RUN_ACTIVE",
        "原会话仍在运行，不再启动第二轮",
      );
      r.state = r.phase === "review" ? "reviewing" : "running";
      const context = await prepareContext(this.store, task);
      r.context = context.text;
      r.contextDigest = context.digest;
      r.knowledgeDigest = context.knowledgeDigest;
      delete r.error;
      await this.store.saveRun(r);
      return r;
    });
    const tid = (run.phase === "review" ? run.reviewThreadId : run.threadId)!;
    try {
      await this.codex.resume(tid, run.worktree);
      await this.assertContinuing(runId);
      const result = await this.codex.turn(
        tid,
        `${run.context}\n\n${message}`,
        run.phase === "review" ? reviewSchema : undefined,
      );
      await this.store.lock(async () => {
        const latest = await this.store.run(runId);
        if (run.phase === "review") latest.reviewTurnId = result.turn.id;
        else latest.turnId = result.turn.id;
        await this.store.saveRun(latest);
      });
    } catch (e: any) {
      await this.fail(runId, e.message, "unknown");
      throw e;
    }
    this.changed();
    return this.store.run(runId);
  }
  async respond(runId: string, response: any) {
    const run = await this.store.run(runId);
    const req = run.pendingRequest;
    assert(req, "NO_PENDING_REQUEST", "没有待回答的请求");
    assert(
      this.codex.connected,
      "CONNECTION_LOST",
      "连接已丢失，请先核对并恢复会话，不能回答失效请求",
    );
    if (
      req.method === "item/commandExecution/requestApproval" ||
      req.method === "item/fileChange/requestApproval"
    ) {
      assert(
        ["accept", "decline", "cancel"].includes(response.decision),
        "INVALID_DECISION",
        "无效操作决定",
      );
      this.codex.respond(req.id, { decision: response.decision });
    } else if (
      req.method === "item/tool/requestUserInput" ||
      req.method === "tool/requestUserInput"
    )
      this.codex.respond(req.id, { answers: response.answers });
    else {
      this.codex.reject(req.id, "当前 Harness 不支持此交互，请在 Codex 中处理");
      throw new HarnessError(
        "UNSUPPORTED_REQUEST",
        `暂不支持交互：${req.method}`,
      );
    }
    delete run.pendingRequest;
    run.state = run.phase === "review" ? "reviewing" : "running";
    await this.store.saveRun(run);
    this.changed();
    return run;
  }
  async reverify(runId: string) {
    const run = await this.store.lock(async () => {
      const run = await this.store.run(runId);
      const task = await this.store.task(run.taskId);
      assert(
        ![
          "running",
          "reviewing",
          "starting",
          "verifying",
          "awaiting_input",
        ].includes(run.state),
        "RUN_ACTIVE",
        "先停止执行再验证",
      );
      assert(task.revision === run.taskRevision, "STALE_RUN", "任务版本不同");
      if (run.state === "unknown") {
        const tid = run.phase === "review" ? run.reviewThreadId : run.threadId;
        assert(tid, "UNKNOWN_CREATION", "先核对原生会话");
        const meta = await this.codex.read(tid);
        assert(
          meta.thread.status?.type !== "active",
          "RUN_ACTIVE",
          "原生会话仍在执行，不能并发验证",
        );
      }
      const context = await prepareContext(this.store, task);
      run.context = context.text;
      run.contextDigest = context.digest;
      run.knowledgeDigest = context.knowledgeDigest;
      run.phase = "implementation";
      run.state = "verifying";
      delete run.review;
      await this.store.saveRun(run);
      return run;
    });
    await this.completePhase(run.id).catch((e) => this.phaseFailure(run.id, e));
    return this.store.run(run.id);
  }
  async syncBaseline(runId: string) {
    const run = await this.store.lock(async () => {
      const run = await this.store.run(runId);
      const task = await this.store.task(run.taskId);
      assert(
        !active.has(run.state),
        "RUN_ACTIVE",
        "请先暂停或等待当前执行结束",
      );
      assert(task.revision === run.taskRevision, "STALE_RUN", "任务版本已变化");
      assert(
        (await git(run.worktree, ["status", "--porcelain"])) === "",
        "DIRTY_WORKTREE",
        "工作区仍有未保存改动；先在原会话保存候选结果",
      );
      const dirty = await git(this.root, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      assert(
        !dirty
          .split("\n")
          .some((line) => line && !line.slice(3).startsWith(".harness/")),
        "DIRTY_BASELINE",
        "主目录仍有未提交源码，请先保存基线",
      );
      const current = await baseline(this.root);
      try {
        await git(run.worktree, [
          "-c",
          "user.name=Harness",
          "-c",
          "user.email=harness@localhost",
          "merge",
          "--no-edit",
          current.head,
        ]);
      } catch (e: any) {
        run.state = "failed";
        run.error = `合并基线失败，工作区保留供解决冲突：${e.message}`;
        await this.store.saveRun(run);
        throw e;
      }
      const context = await prepareContext(this.store, task);
      Object.assign(run, {
        baseline: current,
        phase: "implementation",
        state: "verifying",
        integrated: false,
        context: context.text,
        contextDigest: context.digest,
        knowledgeDigest: context.knowledgeDigest,
      });
      delete run.review;
      delete run.integrationIntent;
      delete run.error;
      await this.store.saveRun(run);
      return run;
    });
    this.changed();
    await this.completePhase(run.id).catch((e) => this.phaseFailure(run.id, e));
    return this.store.run(runId);
  }
  async accept(taskId: string, expectedRevision: number, note: string) {
    return this.store.lock(async () => {
      const task = await this.store.task(taskId);
      assert(
        task.revision === expectedRevision,
        "CONFLICT",
        "任务版本已变化",
        409,
      );
      assert(
        task.state === "acceptance" && task.currentRunId,
        "NOT_ACCEPTABLE",
        "任务尚未完成验证和独立审查",
      );
      const project = await this.store.project();
      const run = await this.store.run(task.currentRunId);
      if (run.knowledgeDigest)
        assert(
          run.knowledgeDigest ===
            (await prepareContext(this.store, task)).knowledgeDigest,
          "STALE_CONTEXT",
          "业务规则已变化，请重新验证",
        );
      const evidence = (await this.store.evidence()).find(
        (e) => e.id === run.evidenceId,
      );
      assert(
        run.state === "completed" && run.review?.passed && evidence?.passed,
        "NOT_VERIFIED",
        "缺少通过的检查或独立审查",
      );
      assert(
        task.revision === run.taskRevision &&
          evidence.taskRevision === task.revision &&
          evidence.checksDigest === checksDigest(project),
        "STALE_EVIDENCE",
        "验证配置或任务已变化，需要重新验证",
      );
      assert(
        (await baseline(run.worktree)).digest === evidence.baseline.digest,
        "STALE_EVIDENCE",
        "候选代码已变化，需要重新验证",
      );
      assert(
        (await baseline(this.root)).digest === run.baseline.digest ||
          (run.integrationIntent === run.resultCommit &&
            (await baseline(this.root)).digest === run.candidate?.digest),
        "BASE_MOVED",
        "主项目已变化。请先把最新基线合入工作区并重新验证，不能直接集成。",
        409,
      );
      const dirty = await git(this.root, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      assert(
        !dirty
          .split("\n")
          .some((x) => x && !x.slice(3).startsWith(".harness/")),
        "DIRTY_BASELINE",
        "主项目有未保存改动，不能自动合并",
      );
      assert(run.resultCommit, "NO_COMMIT", "缺少候选提交");
      run.integrationIntent = run.resultCommit;
      await this.store.saveRun(run);
      await git(this.root, ["merge", "--ff-only", run.resultCommit]);
      run.integrated = true;
      run.integrationHead = await git(this.root, ["rev-parse", "HEAD"]);
      run.updatedAt = now();
      await this.store.saveRun(run);
      const integrated = await verify(project, task, {
        ...run,
        worktree: this.root,
      });
      await this.store.saveEvidence(integrated);
      run.evidenceId = integrated.id;
      if (!integrated.passed) {
        run.state = "failed";
        run.error = "集成后的真实检查未通过，未完成验收；保留提交并进入修复。";
        await this.store.saveRun(run);
        this.changed();
        throw new HarnessError("INTEGRATION_FAILED", run.error);
      }
      task.state = "done";
      task.acceptance = { by: "product-owner", note, at: now(), runId: run.id };
      task.updatedAt = now();
      const { description, ...meta } = task;
      await this.store.transact([
        { relative: `runs/${run.id}.md`, content: encode(run) },
        {
          relative: `backlog/tasks/${task.id}.md`,
          content: encode(meta, description),
        },
      ]);
      this.changed();
      return task;
    });
  }
  async archive(taskId: string, expectedRevision: number, archived = true) {
    const result = await this.store.lock(async () => {
      const t = await this.store.task(taskId);
      assert(t.revision === expectedRevision, "CONFLICT", "任务版本已变化");
      assert(t.state === "done", "NOT_DONE", "只能归档已结束的任务");
      assert(
        !(await this.store.tasks()).some(
          (x) => x.state !== "done" && x.dependsOn.includes(t.id),
        ),
        "STILL_REFERENCED",
        "仍有未完成任务依赖此任务",
      );
      t.archived = archived;
      await this.store.saveTask(t);
      return t;
    });
    this.changed();
    return result;
  }
  private async disconnected() {
    await this.store
      .lock(async () => {
        for (const run of await this.store.runs())
          if (
            ["running", "reviewing", "starting", "awaiting_input"].includes(
              run.state,
            )
          ) {
            run.state = "unknown";
            run.error = "Codex 连接丢失，执行结果未知；需要核对原会话。";
            delete run.pendingRequest;
            await this.store.saveRun(run);
          }
      })
      .catch(() => {});
    this.changed();
  }
}
