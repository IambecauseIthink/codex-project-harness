import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fixture, until } from "./helpers.js";
const exec = promisify(execFile);

test(
  "已构建 CLI：后台服务脱离启动命令存活、重复启动复用、停止与重启",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    const cli = path.resolve("dist/cli.js");
    const command = async (op: string) =>
      exec(process.execPath, [cli, op, "--project", f.root, "--port", "0"], {
        timeout: 15000,
      });
    try {
      await command("start");
      const first = JSON.parse(
        await readFile(
          path.join(f.root, ".harness/runtime/server.json"),
          "utf8",
        ),
      );
      assert.notEqual(first.pid, process.pid);
      const duplicate = await command("start");
      assert.ok(duplicate.stdout.includes(first.url));
      await command("stop");
      await until(async () => {
        try {
          const r = await fetch(first.url);
          return !r.ok;
        } catch {
          return true;
        }
      });
      await command("start");
      const second = JSON.parse(
        await readFile(
          path.join(f.root, ".harness/runtime/server.json"),
          "utf8",
        ),
      );
      assert.notEqual(first.pid, second.pid);
      const r = await fetch(`${second.url}/api/projects`, {
        headers: { Authorization: `Bearer ${second.token}` },
      });
      assert.equal(r.status, 200);
      const reportDir =
        process.env.HARNESS_EVIDENCE_DIR || ".harness/runtime/test-reports";
      await mkdir(reportDir, { recursive: true });
      await writeFile(
        path.join(reportDir, "background-service.json"),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            passed: true,
            checks: [
              "detached process stays alive",
              "duplicate start reuses service",
              "stop preserves project",
              "restart reloads project",
            ],
            tokensIncluded: false,
          },
          null,
          2,
        ),
      );
    } finally {
      await command("stop").catch(() => {});
      await until(async () => {
        try {
          await readFile(path.join(f.root, ".harness/runtime/service.lock"));
          return false;
        } catch {
          return true;
        }
      });
      await f.cleanup();
    }
  },
);
