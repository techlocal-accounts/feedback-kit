import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

type Access = "read" | "write" | "deny";
export interface FeedbackPermissionConfig {
  default_permissions: string;
  permissions: Record<string, { filesystem: Record<string, Access | Record<string, Access>>; network: { enabled: false } }>;
}

/** Do not follow source symlinks or descend into dependencies and generated caches. */
export function feedbackDependencyPaths(checkoutPath: string): string[] {
  const paths = new Set([join(resolve(checkoutPath), "node_modules")]);
  let entriesSeen = 0;
  const visit = (directory: string) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("Could not verify isolated dependency directories");
    }
    for (const entry of entries) {
      if (++entriesSeen > 100_000) throw new Error("Feedback checkout dependency inspection exceeds its bound");
      const path = join(directory, entry.name);
      if (entry.name === "node_modules") { paths.add(path); continue; }
      if (entry.isDirectory() && ![".git", ".next", "dist", "build", ".feedback-runner-tmp"].includes(entry.name)) visit(path);
    }
  };
  visit(resolve(checkoutPath));
  return [...paths].sort();
}

export function assertFeedbackDependencyPaths(checkoutPath: string, expected: readonly string[]): void {
  if (JSON.stringify(feedbackDependencyPaths(checkoutPath)) !== JSON.stringify(expected)) {
    throw new Error("Feedback task changed isolated dependency directories");
  }
}

/** Minimal host reads; only app-owned source, dependencies, and credential-free Git metadata may be added. */
export function createFeedbackPermissionConfig(input: {
  checkoutPath: string;
  access: "read" | "write";
  readOnlyPaths?: readonly string[];
}): FeedbackPermissionConfig {
  const checkoutPath = resolve(input.checkoutPath);
  const home = homedir();
  if (!isAbsolute(input.checkoutPath) || checkoutPath === parse(checkoutPath).root || checkoutPath === home) {
    throw new Error("Feedback permission checkout must be a bounded absolute directory");
  }
  const filesystem: Record<string, Access | Record<string, Access>> = {
    ":minimal": "read",
    [home]: "deny",
    [checkoutPath]: {
      ".": input.access, ".git": "read", ".codex": "read", ".agents": "read", ".github": "read", ".techlocal": "read",
      "**/.env*": "deny", "**/*.pem": "deny", "**/*.p8": "deny", "**/*.p12": "deny", "**/*.key": "deny",
    },
  };
  const source = filesystem[checkoutPath] as Record<string, Access>;
  for (const path of feedbackDependencyPaths(checkoutPath)) source[relative(checkoutPath, path)] = "read";
  if (process.platform === "darwin") {
    for (const path of ["/opt/homebrew/bin", "/opt/homebrew/lib", "/opt/homebrew/Cellar", "/opt/homebrew/opt", "/opt/homebrew/share",
      "/Applications/Xcode.app", "/Library/Developer/CommandLineTools"]) filesystem[path] = "read";
    // Bun's standard installer keeps one self-contained executable here, without a wider home grant.
    filesystem[join(home, ".bun", "bin", "bun")] = "read";
  }
  for (const path of input.readOnlyPaths ?? []) {
    const normalized = resolve(path);
    const pinnedStandards = normalized.startsWith(join(home, ".codex", "plugins", "cache", "tech-local", "tech-local-standards") + "/") &&
      /^[^/]+(?:\/scripts(?:\/[^/]+)?)?$/.test(relative(join(home, ".codex", "plugins", "cache", "tech-local", "tech-local-standards"), normalized));
    if (!isAbsolute(path) || !(["node_modules", "control.git", "repo.git"].includes(basename(normalized)) || pinnedStandards) ||
        /(^|\/)(?:\.config|\.ssh|\.aws|\.azure|Keychains|\.env[^/]*)(?:\/|$)/.test(path)) {
      throw new Error("Feedback read-only paths must be app dependencies, isolated Git metadata, or a pinned standards tool");
    }
    filesystem[normalized] = "read";
  }
  // A nonce prevents another config layer's similarly named profile from adding host grants.
  const name = `feedback_${input.access}_${randomUUID().replaceAll("-", "")}`;
  return { default_permissions: name, permissions: { [name]: { filesystem, network: { enabled: false } } } };
}

/** Legacy sandbox keys select broad reads instead of a permission profile; reject that ambiguity. */
export async function assertFeedbackPermissionConfiguration(cwd: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Feedback credential isolation requires the verified macOS permission-profile sandbox");
  }
  const paths = new Set(["/etc/codex/config.toml", "/etc/codex/managed_config.toml",
    join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "managed_config.toml")]);
  let directory = resolve(cwd);
  while (true) {
    paths.add(join(directory, ".codex", "config.toml"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const path of paths) {
    let config: string;
    try { config = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Could not verify feedback permission configuration; no Codex task started");
    }
    if (/\b(?:sandbox_mode|sandbox_workspace_write|profile|profiles)\b/.test(config)) {
      throw new Error("Legacy sandbox/config profiles prevent feedback credential isolation; no Codex task started");
    }
    if (path === join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "managed_config.toml") && /\bmcp_servers\b/.test(config)) {
      throw new Error("User-home managed MCP grants cannot be isolated; no Codex task started");
    }
  }
}

export function inlineToml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unsupported feedback permission setting");
  return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}=${inlineToml(entry)}`).join(",")}}`;
}
