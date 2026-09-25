import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep, dirname } from "node:path";
import { promisify } from "node:util";
import type { FencedClaim, GitPublicationAdapter, IsolatedCheckout } from "./index.js";
import { MovingMainError } from "./index.js";

const runFile = promisify(execFile);
const shaPattern = /^[a-f0-9]{40}$/;
const unsafeSegments = new Set(["node_modules", ".git", ".feedback-worker", "dist", "build", ".next"]);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await runFile("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, maxBuffer: 4_000_000,
  });
  return stdout.trim();
}

function assertSafeChangedPath(path: string): void {
  if (!path || path.includes("\\") || path.startsWith("/") || path.split("/").some(segment =>
    !segment || segment === "." || segment === ".." || segment.startsWith(".env") || unsafeSegments.has(segment))) {
    throw new Error(`Unsafe publication path: ${path}`);
  }
  if (/\.(?:pem|p12|p8|key|mobileprovision|keystore)$/i.test(path)) {
    throw new Error(`Unsafe publication path: ${path}`);
  }
}

/** Clones only committed history and pushes only a checked, fast-forward main update. */
export class LocalGitPublicationAdapter implements GitPublicationAdapter {
  constructor(private readonly input: { repositoryPath: string; workingRoot: string; remoteUrl?: string }) {
    if (!isAbsolute(input.repositoryPath) || !isAbsolute(input.workingRoot)) {
      throw new Error("Git runner paths must be absolute");
    }
  }

  async createIsolatedCheckout(_claim: FencedClaim): Promise<IsolatedCheckout> {
    const repositoryPath = await realpath(this.input.repositoryPath);
    const workingRoot = await realpath(this.input.workingRoot);
    const parent = await mkdtemp(join(workingRoot, "feedback-run-"));
    const path = join(parent, "repo");
    try {
      await git(workingRoot, "clone", "--no-local", "--no-checkout", "--", repositoryPath, path);
      const remoteUrl = this.input.remoteUrl ?? await git(repositoryPath, "remote", "get-url", "origin");
      await git(path, "remote", "set-url", "origin", remoteUrl);
      await git(path, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
      const baseSha = await git(path, "rev-parse", "refs/remotes/origin/main");
      if (!shaPattern.test(baseSha)) throw new Error("Invalid main commit");
      await git(path, "checkout", "--detach", baseSha);
      return { path, baseSha };
    } catch (error) {
      await rm(parent, { recursive: true, force: true });
      throw error;
    }
  }

  async inspect(checkout: IsolatedCheckout): Promise<{ headSha: string; changedPaths: string[] }> {
    const status = await git(checkout.path, "status", "--porcelain=v1", "--untracked-files=all");
    if (status) throw new Error("Candidate checkout contains uncommitted files");
    const headSha = await git(checkout.path, "rev-parse", "HEAD");
    if (!shaPattern.test(headSha) || headSha === checkout.baseSha) throw new Error("No committed fix found");
    const parents = (await git(checkout.path, "show", "-s", "--format=%P", "HEAD")).split(" ");
    if (parents.length !== 1 || parents[0] !== checkout.baseSha) {
      throw new Error("Feedback fix must be one commit on the claimed main revision");
    }
    const changedPaths = (await git(checkout.path, "diff", "--name-only", `${checkout.baseSha}..${headSha}`))
      .split("\n").filter(Boolean);
    for (const path of changedPaths) assertSafeChangedPath(path);
    return { headSha, changedPaths };
  }

  async publish(checkout: IsolatedCheckout, expectedHead: string): Promise<void> {
    const candidate = await this.inspect(checkout);
    if (candidate.headSha !== expectedHead) throw new Error("Candidate changed after review");
    await git(checkout.path, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
    const currentMain = await git(checkout.path, "rev-parse", "refs/remotes/origin/main");
    if (currentMain !== checkout.baseSha) throw new MovingMainError("Main moved during feedback review");
    // A concurrent push after fetch is rejected by Git's ordinary non-force push.
    await git(checkout.path, "push", "origin", "HEAD:refs/heads/main");
  }

  async discard(checkout: IsolatedCheckout): Promise<void> {
    const workingRoot = await realpath(this.input.workingRoot);
    const parent = dirname(checkout.path);
    if (!resolve(parent).startsWith(`${workingRoot}${sep}`) || !parent.split(sep).at(-1)?.startsWith("feedback-run-")) {
      throw new Error("Refusing to remove a checkout outside the runner root");
    }
    await rm(parent, { recursive: true, force: true });
  }
}
