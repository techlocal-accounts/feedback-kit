import { spawn } from "node:child_process";
import type { IsolatedCheckout, ValidationAdapter } from "./index.js";

export interface ValidationCommand { argv: readonly [string, ...string[]]; timeoutMs?: number }

function validationEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const keys = ["PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "CI"];
  return { ...Object.fromEntries(keys.flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])), ...extra };
}

async function runValidation(checkout: IsolatedCheckout, command: ValidationCommand, env: NodeJS.ProcessEnv): Promise<void> {
  if (!command.argv[0] || command.argv[0].includes("\n")) throw new Error("Invalid validation command");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.argv[0], [...command.argv.slice(1)], {
      cwd: checkout.path, env, stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4_000); });
    const timeout = setTimeout(() => child.kill("SIGTERM"), command.timeoutMs ?? 600_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`Validation ${command.argv[0]} failed (${code}): ${stderr}`));
    });
  });
}

/** Commands are app-owned argv, never assembled from report text. */
export class CommandValidationAdapter implements ValidationAdapter {
  constructor(private readonly input: {
    focused: readonly ValidationCommand[];
    shared: readonly ValidationCommand[];
    safeEnvironment?: Record<string, string>;
  }) {}

  async focused(checkout: IsolatedCheckout, _changedPaths: string[]): Promise<void> {
    const env = validationEnvironment(this.input.safeEnvironment ?? {});
    for (const command of this.input.focused) await runValidation(checkout, command, env);
  }

  async shared(checkout: IsolatedCheckout): Promise<void> {
    const env = validationEnvironment(this.input.safeEnvironment ?? {});
    for (const command of this.input.shared) await runValidation(checkout, command, env);
  }
}
