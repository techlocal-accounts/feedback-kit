import { spawn } from "node:child_process";
import { basename } from "node:path";

/** All worker subprocesses belong to a new group that is terminated on completion, abort, or timeout. */
export async function runProcess(input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  stdin?: string;
  stdoutLimit?: number;
  stderrLimit?: number;
}): Promise<{ stdout: string; stderr: string }> {
  if (input.signal?.aborted) throw new Error("Feedback command aborted");
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, [...input.args], {
      cwd: input.cwd, env: input.env, detached: process.platform !== "win32",
      stdio: [input.stdin === undefined ? "ignore" : "pipe", input.stdoutLimit ? "pipe" : "ignore", input.stderrLimit ? "pipe" : "ignore"],
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    let force: NodeJS.Timeout | undefined;
    function kill(signal: NodeJS.Signals) {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") {
          if (signal === "SIGKILL") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
            .once("error", () => child.kill("SIGKILL"));
          else child.kill(signal);
        } else process.kill(-child.pid, signal);
      } catch { /* An already-exited process group needs no further action. */ }
    }
    function stop(reason: string) {
      if (failure) return;
      failure = new Error(reason);
      kill("SIGTERM");
      force = setTimeout(() => kill("SIGKILL"), 1_000);
    }
    const timeout = setTimeout(() => stop(`Feedback command ${basename(input.executable)} timed out`), input.timeoutMs);
    const aborted = () => stop("Feedback command aborted");
    input.signal?.addEventListener("abort", aborted, { once: true });
    // Cover an abort between the initial check and listener registration.
    if (input.signal?.aborted) aborted();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure) return;
      const text = chunk.toString();
      if (stdout.length + text.length > (input.stdoutLimit ?? 0)) stop("Feedback command output exceeded its bound");
      else stdout += text;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-(input.stderrLimit ?? 0));
    });
    function cleanup() {
      clearTimeout(timeout);
      clearTimeout(force);
      input.signal?.removeEventListener("abort", aborted);
      kill("SIGKILL");
    }
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Feedback command ${basename(input.executable)} failed (${code})${stderr ? `: ${stderr}` : ""}`));
      else resolve({ stdout, stderr });
    });
    child.stdin?.on("error", () => stop("Feedback command stopped accepting input"));
    child.stdin?.end(input.stdin);
  });
}
