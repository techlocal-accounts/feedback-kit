import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep, dirname } from "node:path";
import type { FencedClaim, GitPublicationAdapter, IsolatedCheckout, PublicationGuard } from "./index.js";
import { findProtectedPaths, MovingMainError } from "./index.js";
import { runtimeEnvironment } from "./environment.js";
import { runProcess } from "./process.js";

const shaPattern = /^[a-f0-9]{40}$/;
const unsafeSegments = new Set(["node_modules", ".git", ".feedback-worker", ".feedback-runner-tmp", "dist", "build", ".next"]);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return guardedGit(cwd, undefined, ...args);
}

async function guardedGit(cwd: string, signal: AbortSignal | undefined, ...args: string[]): Promise<string> {
  const { stdout } = await runProcess({ executable: "/usr/bin/git", args: ["-c", "core.hooksPath=/dev/null", ...args],
    cwd, signal, stdoutLimit: 4_000_000, stderrLimit: 4_000, timeoutMs: 120_000,
    env: { ...runtimeEnvironment(), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout.trim();
}

function assertSafeChangedPath(path: string): void {
  if (!path || /[\\\n\r\0]/.test(path) || path.startsWith("/") || path.split("/").some(segment =>
    !segment || segment === "." || segment === ".." || unsafeSegments.has(segment))) {
    throw new Error(`Unsafe publication path: ${path}`);
  }
  if (/\.(?:pem|p12|p8|key|mobileprovision|keystore)$/i.test(path)) {
    throw new Error(`Unsafe publication path: ${path}`);
  }
}

interface CheckoutControls {
  parent: string;
  gitDirectory: string;
  gitFile: string;
  remoteUrl: string;
  baseSha: string;
  controlsDigest: string;
  snapshotSha?: string;
}

async function controlsDigest(controls: CheckoutControls): Promise<string> {
  const [config, exclude] = await Promise.all([
    readFile(join(controls.gitDirectory, "config")), readFile(join(controls.gitDirectory, "info", "exclude")),
  ]);
  return createHash("sha256").update(config).update("\0").update(exclude).digest("hex");
}

/** The model can edit source only. Git controls and publication credentials stay with the parent. */
export class LocalGitPublicationAdapter implements GitPublicationAdapter {
  private readonly checkouts = new Map<string, CheckoutControls>();

  constructor(private readonly input: {
    repositoryPath: string; workingRoot: string; remoteUrl?: string; authorName?: string; authorEmail?: string;
    baseBranch?: string;
    pullRequest?: { branch: string; create(input: { checkout: IsolatedCheckout; headSha: string; signal: AbortSignal }): Promise<void> };
  }) {
    if (!isAbsolute(input.repositoryPath) || !isAbsolute(input.workingRoot)) {
      throw new Error("Git runner paths must be absolute");
    }
    if (!/^[A-Za-z0-9_./-]+$/.test(input.baseBranch ?? "main") || (input.baseBranch ?? "main").includes("..")) throw new Error("Invalid target branch");
    if (input.pullRequest && !/^codex\/[a-z0-9-]{1,100}$/.test(input.pullRequest.branch)) throw new Error("Invalid PR branch");
    for (const value of [input.authorName, input.authorEmail]) {
      if (value !== undefined && (!value.trim() || value.length > 200 || /[\n\r\0]/.test(value))) {
        throw new Error("Invalid feedback commit identity");
      }
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
      await git(path, "fetch", "--no-tags", "origin", `+refs/heads/${this.input.baseBranch ?? "main"}:refs/remotes/origin/main`);
      const baseSha = await git(path, "rev-parse", "refs/remotes/origin/main");
      if (!shaPattern.test(baseSha)) throw new Error("Invalid main commit");
      await git(path, "checkout", "--detach", baseSha);
      await git(path, "remote", "remove", "origin");
      await git(path, "config", "user.name", this.input.authorName ?? "Feedback Runner");
      await git(path, "config", "user.email", this.input.authorEmail ?? "feedback-runner@example.invalid");
      await git(path, "config", "commit.gpgSign", "false");
      await git(path, "config", "core.hooksPath", "/dev/null");
      const gitDirectory = join(parent, "control.git");
      await rename(join(path, ".git"), gitDirectory);
      const gitFile = `gitdir: ${gitDirectory}\n`;
      await writeFile(join(path, ".git"), gitFile);
      const excludePath = join(gitDirectory, "info", "exclude");
      await writeFile(excludePath, `${await readFile(excludePath, "utf8")}\n.feedback-runner-tmp/\nnode_modules/\n`);
      const controls: CheckoutControls = { parent, gitDirectory, gitFile, remoteUrl, baseSha, controlsDigest: "" };
      controls.controlsDigest = await controlsDigest(controls);
      this.checkouts.set(path, controls);
      return { path, baseSha };
    } catch (error) {
      await rm(parent, { recursive: true, force: true });
      throw error;
    }
  }

  private async assertControls(checkout: IsolatedCheckout): Promise<CheckoutControls> {
    const controls = this.checkouts.get(checkout.path);
    if (!controls || controls.baseSha !== checkout.baseSha || await realpath(checkout.path) !== checkout.path) {
      throw new Error("Unknown feedback checkout");
    }
    if (await readFile(join(checkout.path, ".git"), "utf8") !== controls.gitFile ||
        await controlsDigest(controls) !== controls.controlsDigest) {
      throw new Error("Git controls changed during feedback processing");
    }
    return controls;
  }

  async inspect(checkout: IsolatedCheckout): Promise<{ headSha: string; changedPaths: string[] }> {
    const controls = await this.assertControls(checkout);
    const headSha = await git(checkout.path, "rev-parse", "HEAD");
    if (headSha !== (controls.snapshotSha ?? controls.baseSha)) {
      throw new Error("Implementation changed Git history outside the parent snapshot");
    }
    let changedPaths: string[];
    if (controls.snapshotSha) {
      const status = await git(checkout.path, "status", "--porcelain=v1", "--untracked-files=all", "-z");
      if (status) throw new Error("Candidate checkout contains uncommitted files");
      const parents = (await git(checkout.path, "show", "-s", "--format=%P", "HEAD")).split(" ");
      if (parents.length !== 1 || parents[0] !== checkout.baseSha) {
        throw new Error("Feedback fix must be one parent-created commit on the claimed main revision");
      }
      changedPaths = (await git(checkout.path, "diff", "--name-only", "-z", `${checkout.baseSha}..${headSha}`)).split("\0").filter(Boolean);
    } else {
      const [tracked, untracked] = await Promise.all([
        git(checkout.path, "diff", "--name-only", "-z", "HEAD", "--"),
        git(checkout.path, "ls-files", "--others", "--exclude-standard", "-z"),
      ]);
      changedPaths = [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort();
    }
    for (const path of changedPaths) assertSafeChangedPath(path);
    return { headSha, changedPaths };
  }

  async snapshot(checkout: IsolatedCheckout, claim: FencedClaim): Promise<{ headSha: string; changedPaths: string[] }> {
    const controls = await this.assertControls(checkout);
    if (controls.snapshotSha) throw new Error("Feedback candidate was already snapshotted");
    const prepared = await this.inspect(checkout);
    if (!prepared.changedPaths.length) throw new Error("Implementation made no changes");
    if (findProtectedPaths(prepared.changedPaths, []).length) throw new Error("Protected paths require owner review");
    await git(checkout.path, "diff", "--check", "HEAD", "--");
    await git(checkout.path, "add", "--all", "--", ...prepared.changedPaths);
    const modes = await git(checkout.path, "diff", "--cached", "--raw", "HEAD", "--");
    if (modes.split("\n").some(line => /^:[0-9]{6} 120000 /.test(line))) {
      throw new Error("Feedback candidates cannot add or change symbolic links");
    }
    const reportRef = claim.reportId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100);
    if (!reportRef) throw new Error("Invalid feedback report identity");
    await git(checkout.path, "commit", "-m", `fix: implement feedback ${reportRef}`);
    controls.snapshotSha = await git(checkout.path, "rev-parse", "HEAD");
    return this.inspect(checkout);
  }

  async publish(checkout: IsolatedCheckout, expectedHead: string, guard: PublicationGuard): Promise<void> {
    const controls = await this.assertControls(checkout);
    const candidate = await this.inspect(checkout);
    if (!controls.snapshotSha || candidate.headSha !== expectedHead) throw new Error("Candidate changed after review");
    await guardedGit(checkout.path, guard.signal, "fetch", "--no-tags", "--", controls.remoteUrl, `+refs/heads/${this.input.baseBranch ?? "main"}:refs/remotes/origin/main`);
    const currentMain = await guardedGit(checkout.path, guard.signal, "rev-parse", "refs/remotes/origin/main");
    if (currentMain !== checkout.baseSha) throw new MovingMainError("Main moved during feedback review");
    await guard.assertLease();
    if (this.input.pullRequest) {
      await guardedGit(checkout.path, guard.signal, "push", "--", controls.remoteUrl,
        `HEAD:refs/heads/${this.input.pullRequest.branch}`);
      await guard.assertLease();
      await this.input.pullRequest.create({ checkout, headSha: expectedHead, signal: guard.signal });
      return;
    }
    // A concurrent push after fetch is rejected by Git's ordinary non-force push.
    await guardedGit(checkout.path, guard.signal, "push", "--", controls.remoteUrl, "HEAD:refs/heads/main");
  }

  async discard(checkout: IsolatedCheckout): Promise<void> {
    await this.assertControls(checkout);
    const workingRoot = await realpath(this.input.workingRoot);
    const parent = dirname(checkout.path);
    if (!resolve(parent).startsWith(`${workingRoot}${sep}`) || !parent.split(sep).at(-1)?.startsWith("feedback-run-")) {
      throw new Error("Refusing to remove a checkout outside the runner root");
    }
    await rm(parent, { recursive: true, force: true });
    this.checkouts.delete(checkout.path);
  }
}
