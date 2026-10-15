import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { IsolatedCheckout, ValidationAdapter } from "./index.js";
import { validationEnvironment } from "./environment.js";
import { runProcess } from "./process.js";
import { assertFeedbackDependencyPaths, assertFeedbackPermissionConfiguration, createFeedbackPermissionConfig,
  feedbackDependencyPaths, inlineToml } from "./permissions.js";

export interface ValidationCommand { cwd?: string; argv: readonly [string, ...string[]]; timeoutMs?: number }
const packageManagers = ["pnpm", "pnpx", "npm", "npx", "bun", "bunx", "yarn", "yarnpkg"] as const;
type PackageManager = typeof packageManagers[number];
type PackageManagerExecutables = Readonly<Partial<Record<PackageManager, string>>>;

function pinPackageManager(command: ValidationCommand, executables: PackageManagerExecutables): ValidationCommand {
  const executable = command.argv[0];
  if (!packageManagers.includes(basename(executable) as PackageManager)) return command;
  const pinned = isAbsolute(executable) ? executable : executables[executable as PackageManager];
  if (!pinned || !isAbsolute(pinned) || /[\r\n\0]/.test(pinned)) {
    throw new Error("Package-manager commands require an absolute installed executable; configure packageManagerExecutables in the trusted parent");
  }
  return { ...command, argv: [pinned, ...command.argv.slice(1)] };
}

function assertLockedInstall(command: ValidationCommand): void {
  const [executable, verb, ...flags] = command.argv;
  const manager = basename(executable);
  const allowedFlags = new Set(["--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--offline", "--prefer-offline", "--no-audit", "--no-fund"]);
  if (!((manager === "pnpm" || manager === "bun") && verb === "install" && flags.includes("--frozen-lockfile") ||
        manager === "npm" && verb === "ci") || !flags.includes("--ignore-scripts") ||
      flags.some(flag => !allowedFlags.has(flag))) {
    throw new Error("Dependency install must use locked pnpm/bun install or npm ci with --ignore-scripts");
  }
}

async function runValidation(checkout: IsolatedCheckout, command: ValidationCommand, env: NodeJS.ProcessEnv,
  signal: AbortSignal, credentialed = false, sandboxExecutable = "codex", configuredReads: readonly string[] = []): Promise<void> {
  if (!command.argv[0] || command.argv.some(arg => typeof arg !== "string" || /[\n\r\0]/.test(arg)) ||
      command.timeoutMs !== undefined && (!Number.isFinite(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 3_600_000)) {
    throw new Error("Invalid validation command");
  }
  const commandCwd=command.cwd ? resolve(checkout.path,command.cwd) : checkout.path;
  if(commandCwd!==checkout.path && !commandCwd.startsWith(checkout.path + "/")) throw new Error("Validation directory escapes checkout");
  env = { ...env, COREPACK_ENABLE_NETWORK: "0" };
  let temporary: string | undefined;
  let commandTemporary: string | undefined;
  let dependencies: readonly string[] | undefined;
  try {
    let executable = command.argv[0];
    let args = command.argv.slice(1);
    if (!credentialed) {
      await assertFeedbackPermissionConfiguration(checkout.path);
      const { stdout: version } = await runProcess({ executable: sandboxExecutable, args: ["--version"], cwd: checkout.path, env,
        signal, stdoutLimit: 500, timeoutMs: 30_000 });
      const match = /\bcodex-cli (\d+)\.(\d+)\.(\d+)\b/.exec(version);
      if (!match || !(Number(match[1]) > 0 || Number(match[2]) > 144 || Number(match[2]) === 144 && Number(match[3]) >= 6)) {
        throw new Error("Unverified feedback validation sandbox version");
      }
      const readOnlyPaths: string[] = [...configuredReads];
      try {
        const gitFile = await readFile(join(checkout.path, ".git"), "utf8");
        const reference = /^gitdir: ([^\r\n]+)\n?$/.exec(gitFile);
        if (!reference) throw new Error("Invalid isolated Git metadata reference");
        readOnlyPaths.push(isAbsolute(reference[1]!) ? reference[1]! : resolve(checkout.path, reference[1]!));
      } catch (error) {
        if (!["ENOENT", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      const config = createFeedbackPermissionConfig({ checkoutPath: checkout.path, access: "write", readOnlyPaths });
      dependencies = feedbackDependencyPaths(checkout.path);
      // No user config or auth is needed to run a sandboxed command. Keep this control outside source.
      temporary = await mkdtemp(join(tmpdir(), "feedback-validation-codex-"));
      commandTemporary = await mkdtemp(join(tmpdir(), "feedback-validation-output-"));
      // Parent-owned aliases avoid both Corepack shims and denied home-directory PATH lookups.
      const tools = join(temporary, "bin");
      await mkdir(tools);
      const manager = basename(command.argv[0]);
      if (packageManagers.includes(manager as PackageManager)) await symlink(command.argv[0], join(tools, manager));
      config.permissions[config.default_permissions].filesystem[tools] = "read";
      const validationPath = `${tools}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/opt/homebrew/sbin`;
      // This exact empty parent-owned directory contains no existing private files.
      // Keep checkout credential globs, home and installed dependencies protected.
      config.permissions[config.default_permissions].filesystem[commandTemporary] = "write";
      const browserTargets = join(commandTemporary, "browserslist-config");
      await writeFile(browserTargets, "", {mode:0o600});
      env = { ...env, CODEX_HOME: temporary, HOME: commandTemporary, TMPDIR: commandTemporary,
        FEEDBACK_VALIDATION_OUTPUT_DIR: join(commandTemporary,"build-output"),
        BROWSERSLIST_CONFIG: browserTargets, BUN_INSTALL_CACHE_DIR: join(commandTemporary, "bun-cache") };
      executable = sandboxExecutable;
      args = ["sandbox", "--permission-profile", config.default_permissions, "--include-managed-config", "--cd", commandCwd,
        "-c", `permissions.${config.default_permissions}=${inlineToml(config.permissions[config.default_permissions])}`,
        "/usr/bin/env", `PATH=${validationPath}`, ...command.argv];
    }
    await runProcess({ executable, args, cwd: commandCwd, env,
      signal, timeoutMs: command.timeoutMs ?? 600_000, stderrLimit: credentialed ? 0 : 4_000 });
    if (dependencies) assertFeedbackDependencyPaths(checkout.path, dependencies);
  } catch (error) {
    if (credentialed) throw new Error("Dependency installation failed; no Codex task started");
    throw error;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    if (commandTemporary) await rm(commandTemporary, {recursive:true,force:true});
  }
}

/** Commands are trusted app-owned argv. The package token reaches only script-disabled installers. */
export class CommandValidationAdapter implements ValidationAdapter {
  constructor(private readonly input: {
    install: readonly ValidationCommand[];
    prepare?: readonly ValidationCommand[];
    focused: readonly ValidationCommand[];
    shared: readonly ValidationCommand[];
    safeEnvironment?: Record<string, string>;
    /** Resolve from parent-only Keychain/build secret storage, never a project env file. */
    packageReadToken?: () => Promise<string | undefined>;
    /** Absolute, already installed package managers selected by the trusted parent, never source PATH shims. */
    packageManagerExecutables?: PackageManagerExecutables;
    /** Trusted CLI binary; test fixtures may use a synthetic executable. */
    sandboxExecutable?: string;
    /** Only isolated deps/Git metadata and the pinned standards compatibility allowlist are accepted. */
    readOnlyPaths?: readonly string[];
  }) {
    for (const command of input.install) assertLockedInstall(command);
    validationEnvironment(input.safeEnvironment ?? {});
    const executables = input.packageManagerExecutables ?? {};
    for (const [name, executable] of Object.entries(executables)) {
      if (!packageManagers.includes(name as PackageManager) || !isAbsolute(executable) || /[\r\n\0]/.test(executable)) {
        throw new Error("Package-manager pins require an absolute installed executable");
      }
    }
    const pinCommands = (commands: readonly ValidationCommand[] = []) => commands.map(command => pinPackageManager(command, executables));
    this.input = { ...input, install: pinCommands(input.install), prepare: pinCommands(input.prepare),
      focused: pinCommands(input.focused), shared: pinCommands(input.shared) };
  }

  async prepare(checkout: IsolatedCheckout, signal: AbortSignal): Promise<void> {
    const safe = validationEnvironment(this.input.safeEnvironment ?? {});
    if (this.input.install.length) {
      const token = await this.input.packageReadToken?.();
      const env = { ...safe, NODE_ENV: "development", ...(token ? { NODE_AUTH_TOKEN: token } : {}), npm_config_ignore_scripts: "true" };
      try {
        for (const command of this.input.install) {
          // --ignore-scripts does not suppress pnpmfile hooks, which could otherwise read the token.
          const install = basename(command.argv[0]) === "pnpm" && !command.argv.includes("--ignore-pnpmfile")
            ? { ...command, argv: [...command.argv, "--ignore-pnpmfile"] as [string, ...string[]] } : command;
          await runValidation(checkout, install, env, signal, true);
        }
      } finally {
        delete env.NODE_AUTH_TOKEN;
      }
    }
    for (const command of this.input.prepare ?? []) await runValidation(checkout, command, safe, signal, false, this.input.sandboxExecutable, this.input.readOnlyPaths);
  }

  async focused(checkout: IsolatedCheckout, _changedPaths: string[], signal: AbortSignal): Promise<void> {
    const env = validationEnvironment(this.input.safeEnvironment ?? {});
    for (const command of this.input.focused) await runValidation(checkout, command, env, signal, false, this.input.sandboxExecutable, this.input.readOnlyPaths);
  }

  async shared(checkout: IsolatedCheckout, signal: AbortSignal): Promise<void> {
    const env = validationEnvironment(this.input.safeEnvironment ?? {});
    for (const command of this.input.shared) await runValidation(checkout, command, env, signal, false, this.input.sandboxExecutable, this.input.readOnlyPaths);
  }
}
