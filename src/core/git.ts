import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, lstat, mkdir, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Baseline } from "./types.js";
import { assert } from "./types.js";
const exec = promisify(execFile);
export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export async function git(root: string, args: string[]) {
  return (
    await exec("git", ["-C", root, ...args], { maxBuffer: 20 * 1024 * 1024 })
  ).stdout.trimEnd();
}
const ignored = new Set([
  ".git",
  ".harness",
  "node_modules",
  "dist",
  ".cache",
  "coverage",
  "test-results",
  "playwright-report",
  ".DS_Store",
]);
async function files(root: string, rel = ""): Promise<string[]> {
  const list: string[] = [];
  for (const entry of await readdir(path.join(root, rel), {
    withFileTypes: true,
  })) {
    if (ignored.has(entry.name)) continue;
    const f = path.join(rel, entry.name);
    if (entry.isDirectory()) list.push(...(await files(root, f)));
    else if (entry.isFile()) list.push(f);
  }
  return list;
}
export async function baseline(root: string): Promise<Baseline> {
  let head = "unversioned";
  let paths: string[];
  try {
    head = await git(root, ["rev-parse", "HEAD"]);
    const raw = await exec(
      "git",
      [
        "-C",
        root,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    paths = raw.stdout.split("\0").filter(Boolean);
  } catch {
    paths = await files(root);
  }
  const h = createHash("sha256");
  for (const p of [...new Set(paths)].sort()) {
    if (p.split("/").some((c) => ignored.has(c))) continue;
    const full = path.join(root, p);
    try {
      const s = await lstat(full);
      if (s.isSymbolicLink()) {
        h.update(p + "\0symlink\0" + (await readlink(full)));
        continue;
      }
      if (!s.isFile()) continue;
      h.update(p);
      h.update("\0");
      h.update(String(Boolean(s.mode & 0o111)));
      h.update(await readFile(full));
    } catch {
      h.update(`deleted:${p}`);
    }
  }
  return { head, digest: h.digest("hex") };
}
export async function createWorktree(root: string, runId: string) {
  const head = await git(root, ["rev-parse", "HEAD"]).catch(() => "");
  assert(
    head,
    "GIT_BASELINE_REQUIRED",
    "请先建立 Git 基线提交，再派发实现任务。现有文件会保留。",
  );
  const dirty = await git(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const codeDirty = dirty
    .split("\n")
    .filter((x) => x && !x.slice(3).startsWith(".harness/"));
  assert(
    codeDirty.length === 0,
    "DIRTY_BASELINE",
    "项目存在未提交代码，请先保存基线后派发；不会替你覆盖或提交现有修改。",
    409,
  );
  const worktree = path.join(root, ".harness", "worktrees", runId);
  await mkdir(path.dirname(worktree), { recursive: true });
  const branch = `harness/${runId}`;
  await git(root, ["worktree", "add", "-b", branch, worktree, head]);
  return { worktree, branch };
}
export async function commitCandidate(root: string, taskTitle: string) {
  await git(root, ["add", "-A"]);
  if (await git(root, ["diff", "--cached", "--name-only"]))
    await git(root, [
      "-c",
      "user.name=Harness",
      "-c",
      "user.email=harness@localhost",
      "commit",
      "-m",
      taskTitle,
    ]);
  return git(root, ["rev-parse", "HEAD"]);
}
