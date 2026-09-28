// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./process.js";
import { runtimeEnvironment } from "./environment.js";

describe("bounded worker process groups", () => {
  it("escalates a timeout when a process and its child ignore SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-process-test-"));
    try {
      const executable = join(root, "ignores-term.cjs");
      await writeFile(executable, `const fs=require('fs'),{spawn}=require('child_process');if(process.argv[2]==='child'){process.on('SIGTERM',()=>{});setInterval(()=>{},100);}else{const child=spawn(process.execPath,[__filename,'child'],{stdio:'inherit'});fs.writeFileSync('child.pid',String(child.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100);}\n`);
      const started = performance.now();
      await expect(runProcess({ executable: process.execPath, args: [executable], cwd: root,
        env: runtimeEnvironment(), timeoutMs: 500, stderrLimit: 4_000 })).rejects.toThrow("timed out");
      expect(performance.now() - started).toBeLessThan(3_000);
      const pid = Number(await readFile(join(root, "child.pid"), "utf8"));
      // Group termination must also remove the descendant, not just its parent.
      await expect.poll(() => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      }, { timeout: 1_000 }).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("runs no subprocess when a claim is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runProcess({ executable: "/does-not-exist", args: [], cwd: tmpdir(), env: runtimeEnvironment(),
      signal: controller.signal, timeoutMs: 1_000 })).rejects.toThrow("aborted");
  });
});
