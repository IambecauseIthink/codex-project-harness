import { spawn } from "node:child_process";
import { readFile, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { baseline, hash } from "./git.js";
import { contained, exists, id, now } from "./store.js";
import type {
  Check,
  CheckResult,
  Evidence,
  Project,
  Run,
  Task,
} from "./types.js";
export function checksDigest(project: Project) {
  return hash(
    JSON.stringify(
      project.checks.map(({ requiredCases, ...c }) =>
        requiredCases?.length ? { ...c, requiredCases } : c,
      ),
    ),
  );
}
export function parseCounts(
  output: string,
): { passed: number; failed: number; skipped: number } | null {
  const tap = /# pass\s+(\d+)/g;
  const hits = [...output.matchAll(tap)];
  if (hits.length)
    return {
      passed: Number(hits.at(-1)![1]),
      failed: Number([...output.matchAll(/# fail\s+(\d+)/g)].at(-1)?.[1] ?? 0),
      skipped: Number(
        [...output.matchAll(/# (?:skipped|skip)\s+(\d+)/g)].at(-1)?.[1] ?? 0,
      ),
    };
  const lines = output.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
  const summary = [...lines]
    .reverse()
    .find((l) => /Tests\s|\d+ passed|test result:/.test(l));
  if (!summary) return null;
  const passed = Number(/(\d+) passed/.exec(summary)?.[1] ?? 0);
  const failed = Number(/(\d+) failed/.exec(summary)?.[1] ?? 0);
  const skipped = Number(/(\d+) (?:skipped|ignored)/.exec(summary)?.[1] ?? 0);
  return passed || failed || skipped ? { passed, failed, skipped } : null;
}
export async function executeCheck(
  root: string,
  check: Check,
): Promise<CheckResult> {
  const start = Date.now();
  let resultPath: string | undefined;
  if (check.resultFile) {
    resultPath = path.resolve(root, check.resultFile);
    if (!resultPath.startsWith(root + path.sep))
      throw new Error("检查结果路径必须位于工作区内");
    await mkdir(path.dirname(resultPath), { recursive: true });
    resultPath = await contained(root, check.resultFile, false);
    if (await exists(resultPath)) await unlink(resultPath);
  }
  const env = { ...process.env, CI: "1", FORCE_COLOR: "0" };
  // A nested Node test process must not inherit its parent's binary reporter channel.
  delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let finished = false;
    const child = spawn(check.command[0], check.command.slice(1), {
      cwd: root,
      shell: false,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (data: Buffer) => {
      output = (output + data.toString()).slice(-1_000_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }, check.timeoutMs || 120000);
    const finish = async (exitCode: number | null, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) output += error.message;
      let counts = parseCounts(output);
      let reportedCases: { name: string; status: string }[] = [];
      for (const line of output.split("\n")) {
        const match = /^\s*ok \d+ - (.+?)(?: #.*)?$/.exec(line);
        if (match && !/# (SKIP|TODO)/i.test(line))
          reportedCases.push({ name: match[1], status: "passed" });
      }
      if (resultPath) {
        try {
          const c = JSON.parse(await readFile(resultPath, "utf8"));
          counts = ["passed", "failed", "skipped"].every(
            (k) => Number.isInteger(c[k]) && c[k] >= 0,
          )
            ? { passed: c.passed, failed: c.failed, skipped: c.skipped }
            : null;
          reportedCases = Array.isArray(c.cases) ? c.cases : [];
        } catch {
          counts = null;
        }
      }
      const behavioral = check.kind === "test" || check.kind === "e2e";
      const missingCases = (check.requiredCases || []).filter(
        (name) =>
          !reportedCases.some((c) => c.name === name && c.status === "passed"),
      );
      const status = timedOut
        ? "timeout"
        : exitCode !== 0 ||
            missingCases.length > 0 ||
            (counts && counts.failed > 0)
          ? "failed"
          : behavioral && (!counts || counts.passed === 0)
            ? "unknown"
            : "passed";
      resolve({
        id: check.id,
        kind: check.kind,
        command: check.command,
        status,
        exitCode,
        ...(counts || { passed: 0, failed: 0, skipped: 0 }),
        durationMs: Date.now() - start,
        missingCases,
        output:
          output.slice(-16000) +
          (missingCases.length
            ? `\n缺失或未通过的必需回归用例：${missingCases.join("、")}`
            : ""),
      });
    };
    child.once("error", (e) => void finish(null, e));
    child.once("close", (code) => void finish(code));
  });
}
export async function verify(
  project: Project,
  task: Task,
  run: Run,
): Promise<Evidence> {
  // Always include all configured checks: v1 deliberately fails closed on incomplete impact maps.
  const before = await baseline(run.worktree);
  const results: CheckResult[] = [];
  for (const check of project.checks)
    results.push(await executeCheck(run.worktree, check));
  const after = await baseline(run.worktree);
  return {
    id: id("evidence"),
    taskId: task.id,
    taskRevision: task.revision,
    runId: run.id,
    baseline: after,
    checksDigest: checksDigest(project),
    results,
    passed:
      results.length > 0 &&
      results.every((r) => r.status === "passed") &&
      results.some((r) => ["test", "e2e"].includes(r.kind) && r.passed > 0) &&
      before.digest === after.digest,
    createdAt: now(),
    location: run.worktree,
  };
}
