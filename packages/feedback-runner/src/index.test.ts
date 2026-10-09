// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { findProtectedPaths, pollFeedbackOnce, verifyImplementedFeedback,
  LostLeaseError, type FencedClaim, type IsolatedCheckout, type LocalFeedbackRunnerConfig, type PublicationGuard } from "./index.js";
import { LocalGitPublicationAdapter } from "./local-git.js";
import { LocalCodexTaskAdapter } from "./codex-cli.js";
import { CommandValidationAdapter } from "./validation.js";
import * as subprocess from "./process.js";

const claim: FencedClaim = {
  reportId: "report-1", runId: "run-1", fence: "fence-1", kind: "bug", task: "Fix broken save",
  observedRelease: { clientVersion: "1.0" }, leaseMs: 60_000,
};

function harness(claimed: FencedClaim | null = claim) {
  const queue = {
    claimNext: vi.fn(async () => claimed), renew: vi.fn(async () => true), owns: vi.fn(async () => true),
    finish: vi.fn(async () => true), markAvailable: vi.fn(async () => undefined),
  };
  const git = {
    createIsolatedCheckout: vi.fn(async () => ({ path: "/tmp/fake", baseSha: "a".repeat(40) })),
    inspect: vi.fn(async () => ({ headSha: "b".repeat(40), changedPaths: ["src/save.ts", "src/save.test.ts"] })),
    snapshot: vi.fn(async () => ({ headSha: "b".repeat(40), changedPaths: ["src/save.ts", "src/save.test.ts"] })),
    publish: vi.fn(async (_checkout: IsolatedCheckout, _head: string, _guard: PublicationGuard) => undefined), discard: vi.fn(async () => undefined),
  };
  const codex = {
    implement: vi.fn(async () => undefined),
    review: vi.fn(async () => ({ approved: true, reason: "Reviewed", releaseNote: "Saving works again." })),
  };
  const validation = { prepare: vi.fn(async (_checkout: IsolatedCheckout, _signal: AbortSignal) => undefined),
    focused: vi.fn(async (_checkout: IsolatedCheckout, _paths: string[], _signal: AbortSignal) => undefined),
    shared: vi.fn(async (_checkout: IsolatedCheckout, _signal: AbortSignal) => undefined) };
  const config: LocalFeedbackRunnerConfig = {
    queue, git, codex, validation, protectedPaths: ["src/auth/**", "db/**"],
    verifyDelivery: vi.fn(async () => null),
  };
  return { queue, git, codex, validation, config };
}

describe("local feedback runner", () => {
  it("does not start Codex or Git work for an empty poll", async () => {
    const h = harness(null);
    expect(await pollFeedbackOnce(h.config)).toEqual({ kind: "empty" });
    expect(h.codex.implement).not.toHaveBeenCalled();
    expect(h.git.createIsolatedCheckout).not.toHaveBeenCalled();
    expect(h.validation.prepare).not.toHaveBeenCalled();
  });

  it("implements an approved bug only after focused, shared, and independent review", async () => {
    const h = harness();
    expect(await pollFeedbackOnce(h.config)).toEqual({ kind: "implemented", reportId: "report-1", commitSha: "b".repeat(40) });
    expect(h.validation.focused).toHaveBeenCalledOnce();
    expect(h.validation.shared).toHaveBeenCalledOnce();
    expect(h.codex.review).toHaveBeenCalledOnce();
    expect(h.git.publish).toHaveBeenCalledOnce();
    expect(h.queue.finish).toHaveBeenCalledWith(claim, expect.objectContaining({ status: "implemented" }));
    expect(h.queue.markAvailable).not.toHaveBeenCalled();
    expect(h.validation.prepare.mock.invocationCallOrder[0]).toBeLessThan(h.codex.implement.mock.invocationCallOrder[0]);
    expect(h.git.snapshot.mock.invocationCallOrder[0]).toBeGreaterThan(h.git.inspect.mock.invocationCallOrder[0]);
    expect(h.git.snapshot.mock.invocationCallOrder[0]).toBeLessThan(h.validation.focused.mock.invocationCallOrder[0]);
  });

  it("does not start a model or snapshot when dependency preparation fails", async () => {
    const h = harness();
    h.validation.prepare.mockRejectedValue(new Error("Dependencies unavailable"));
    expect(await pollFeedbackOnce(h.config)).toEqual({ kind: "failed", reportId: "report-1", reason: "Dependencies unavailable" });
    expect(h.codex.implement).not.toHaveBeenCalled();
    expect(h.codex.review).not.toHaveBeenCalled();
    expect(h.git.snapshot).not.toHaveBeenCalled();
    expect(h.git.publish).not.toHaveBeenCalled();
  });

  it("sends suggestions to owner review without a model run", async () => {
    const h = harness({ ...claim, kind: "suggestion" });
    expect((await pollFeedbackOnce(h.config)).kind).toBe("needs_review");
    expect(h.codex.implement).not.toHaveBeenCalled();
  });

  it("escalates protected changes before validation or publication", async () => {
    const h = harness();
    h.git.inspect.mockResolvedValue({ headSha: "b".repeat(40), changedPaths: ["src/auth/session.ts"] });
    expect((await pollFeedbackOnce(h.config)).kind).toBe("needs_review");
    expect(h.validation.focused).not.toHaveBeenCalled();
    expect(h.git.publish).not.toHaveBeenCalled();
    expect(h.git.snapshot).not.toHaveBeenCalled();
  });

  it.each([".npmrc", ".pnpmfile.cjs", "apps/web/package.json", "pnpm-lock.yaml", "AGENTS.md", "apps/apple/AGENTS.md", ".codex/config.toml", ".github/workflows/release.yml", ".techlocal/standards.yml"])(
    "always escalates runner governance or dependency changes to %s", async path => {
      const h = harness();
      h.config.protectedPaths = [];
      h.git.inspect.mockResolvedValue({ headSha: "a".repeat(40), changedPaths: [path] });
      expect((await pollFeedbackOnce(h.config)).kind).toBe("needs_review");
      expect(h.git.snapshot).not.toHaveBeenCalled();
      expect(h.validation.focused).not.toHaveBeenCalled();
    });

  it("checks ownership after preparation and before starting Codex", async () => {
    const h = harness();
    h.validation.prepare.mockImplementation(async () => { h.queue.owns.mockResolvedValue(false); });
    expect((await pollFeedbackOnce(h.config)).kind).toBe("lost_lease");
    expect(h.codex.implement).not.toHaveBeenCalled();
    expect(h.git.snapshot).not.toHaveBeenCalled();
  });

  it("fails validation without publishing", async () => {
    const h = harness();
    h.validation.shared.mockRejectedValue(new Error("Typecheck failed"));
    expect((await pollFeedbackOnce(h.config)).kind).toBe("failed");
    expect(h.codex.review).not.toHaveBeenCalled();
    expect(h.git.publish).not.toHaveBeenCalled();
  });

  it("halts when a lease is lost", async () => {
    const h = harness();
    h.queue.owns.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await pollFeedbackOnce(h.config)).kind).toBe("lost_lease");
    expect(h.git.publish).not.toHaveBeenCalled();
    expect(h.queue.finish).not.toHaveBeenCalled();
  });

  it("aborts validation when claim renewal fails and never reviews or publishes", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ ...claim, leaseMs: 1_000 });
      h.queue.renew.mockResolvedValue(false);
      h.validation.shared.mockImplementation(async (_checkout, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Validation stopped")), { once: true });
      }));
      const result = pollFeedbackOnce(h.config);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.validation.shared).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(500);
      expect(await result).toEqual({ kind: "lost_lease", reportId: claim.reportId });
      expect(h.codex.review).not.toHaveBeenCalled();
      expect(h.git.publish).not.toHaveBeenCalled();
      expect(h.queue.finish).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("rechecks its fenced lease at the publication adapter's final push boundary", async () => {
    const h = harness();
    h.git.publish.mockImplementation(async (_checkout, _head, guard) => {
      h.queue.owns.mockResolvedValue(false);
      await guard.assertLease();
    });
    expect((await pollFeedbackOnce(h.config)).kind).toBe("lost_lease");
    expect(h.queue.finish).not.toHaveBeenCalled();
  });

  it("never marks a Git commit available until delivery is verified", async () => {
    const h = harness();
    expect(await verifyImplementedFeedback(h.config, claim.reportId, "b".repeat(40))).toBe(false);
    expect(h.queue.markAvailable).not.toHaveBeenCalled();
    h.config.verifyDelivery = vi.fn(async () => ({ channel: "web", release: { commitSha: "b".repeat(40) },
      coversImplementationCommitSha: "b".repeat(40),
      verifiedAt: new Date().toISOString(), evidenceRef: "deploy-123" }));
    expect(await verifyImplementedFeedback(h.config, claim.reportId, "b".repeat(40))).toBe(true);
    expect(h.queue.markAvailable).toHaveBeenCalledOnce();
  });

  it("matches protected directory paths exactly", () => {
    expect(findProtectedPaths(["src/auth/a.ts", "src/authentic/a.ts"], ["src/auth/**"])).toEqual(["src/auth/a.ts"]);
  });
});

function run(cwd: string, ...args: string[]): string {
  return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8" }).trim();
}

describe("synthetic Git publication", () => {
  it("completes a report, uncommitted fix, parent snapshot, validation, review, and publication journey", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-journey-test-"));
    try {
      const bare = join(root, "remote.git");
      const source = join(root, "source");
      const runs = join(root, "runs");
      await mkdir(runs);
      run(root, "init", "--bare", bare);
      run(root, "clone", bare, source);
      run(source, "config", "user.name", "Synthetic Test");
      run(source, "config", "user.email", "test@example.com");
      run(source, "checkout", "-b", "main");
      await writeFile(join(source, "save.cjs"), "module.exports = () => false;\n");
      run(source, "add", "save.cjs");
      run(source, "commit", "-m", "chore: synthetic broken save");
      run(source, "push", "origin", "main");
      const executable = join(root, "codex-fixture");
      await writeFile(executable, `#!${process.execPath}\nconst fs=require('fs'),args=process.argv.slice(2);if(args[0]==='--version'){process.stdout.write('codex-cli 0.162.0');}else if(args[0]==='mcp'){process.stdout.write('[]');}else if(args[0]==='sandbox'){const index=args.lastIndexOf('-c')+2;process.exit(require('child_process').spawnSync(args[index],args.slice(index+1),{stdio:'inherit'}).status??1);}else{process.stdin.resume();process.stdin.on('end',()=>{const reviewing=args.some(arg=>arg.includes('feedback_read_'));if(!reviewing){fs.writeFileSync('save.cjs','module.exports = () => true;\\n');fs.writeFileSync('save.test.cjs',\"require('node:assert/strict').equal(require('./save.cjs')(), true);\\n\");}fs.writeFileSync(args[args.indexOf('--output-last-message')+1],reviewing?JSON.stringify({approved:true,reason:'Synthetic scope and checks reviewed',releaseNote:'Saving works again.'}):'Prepared');});}\n`);
      await chmod(executable, 0o700);
      const h = harness();
      const result = await pollFeedbackOnce({ ...h.config,
        git: new LocalGitPublicationAdapter({ repositoryPath: source, workingRoot: runs, remoteUrl: bare }),
        codex: new LocalCodexTaskAdapter({ executable }),
        validation: new CommandValidationAdapter({ install: [], sandboxExecutable: executable,
          focused: [{ argv: [process.execPath, "--test", "save.test.cjs"] }],
          shared: [{ argv: [process.execPath, "--check", "save.cjs"] }],
        }),
      });
      expect(result.kind).toBe("implemented");
      if (result.kind !== "implemented") throw new Error(JSON.stringify(result));
      expect(run(root, "--git-dir", bare, "rev-parse", "refs/heads/main")).toBe(result.commitSha);
      expect(h.queue.finish).toHaveBeenCalledWith(claim, expect.objectContaining({ status: "implemented", releaseNote: "Saving works again." }));
      expect(h.queue.markAvailable).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("publishes incidents only to their PR branch with a prod base", async () => {
    const root=await mkdtemp(join(tmpdir(),"incident-pr-test-"));
    try {
      const bare=join(root,"remote.git"), source=join(root,"source"), runs=join(root,"runs");
      await mkdir(runs);run(root,"init","--bare",bare);run(root,"clone",bare,source);
      run(source,"config","user.name","Synthetic Test");run(source,"config","user.email","test@example.com");
      run(source,"checkout","-b","prod");await writeFile(join(source,"README.md"),"before\n");
      run(source,"add",".");run(source,"commit","-m","chore: fixture");run(source,"push","origin","prod");
      const before=run(source,"rev-parse","HEAD");const create=vi.fn(async()=>undefined);
      const adapter=new LocalGitPublicationAdapter({repositoryPath:source,workingRoot:runs,remoteUrl:bare,baseBranch:"prod",pullRequest:{branch:"codex/incident-fixture",create}});
      const checkout=await adapter.createIsolatedCheckout({...claim,kind:"incident"});
      await writeFile(join(checkout.path,"README.md"),"fixed\n");const candidate=await adapter.snapshot(checkout,claim);
      await adapter.publish(checkout,candidate.headSha,{signal:new AbortController().signal,assertLease:async()=>undefined});
      expect(run(root,"--git-dir",bare,"rev-parse","refs/heads/prod")).toBe(before);
      expect(run(root,"--git-dir",bare,"rev-parse","refs/heads/codex/incident-fixture")).toBe(candidate.headSha);
      expect(create).toHaveBeenCalledOnce();await adapter.discard(checkout);
    } finally {await rm(root,{recursive:true,force:true});}
  });

  it("publishes one reviewed fast-forward commit and rejects moving main", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-git-test-"));
    const bare = join(root, "remote.git");
    const source = join(root, "source");
    const runs = join(root, "runs");
    try {
      await import("node:fs/promises").then(fs => fs.mkdir(runs));
      run(root, "init", "--bare", bare);
      run(root, "clone", bare, source);
      run(source, "config", "user.name", "Test");
      run(source, "config", "user.email", "test@example.com");
      run(source, "checkout", "-b", "main");
      await import("node:fs/promises").then(fs => fs.writeFile(join(source, "README.md"), "start\n"));
      run(source, "add", "README.md");
      run(source, "commit", "-m", "chore: start");
      run(source, "push", "origin", "main");

      const adapter = new LocalGitPublicationAdapter({ repositoryPath: source, workingRoot: runs, remoteUrl: bare });
      const checkout = await adapter.createIsolatedCheckout(claim);
      expect(run(checkout.path, "remote")).toBe("");
      expect(await readFile(join(checkout.path, ".git"), "utf8")).toContain("gitdir:");
      await import("node:fs/promises").then(fs => fs.writeFile(join(checkout.path, "README.md"), "fixed\n"));
      expect((await adapter.inspect(checkout)).headSha).toBe(checkout.baseSha);
      const inspected = await adapter.snapshot(checkout, claim);
      expect(inspected.changedPaths).toEqual(["README.md"]);
      expect(run(checkout.path, "log", "-1", "--format=%an <%ae>")).toBe("Feedback Runner <feedback-runner@example.invalid>");
      const guard = { signal: new AbortController().signal, assertLease: vi.fn(async () => undefined) };
      await adapter.publish(checkout, inspected.headSha, guard);
      expect(guard.assertLease).toHaveBeenCalledOnce();
      expect(run(root, "--git-dir", bare, "rev-parse", "refs/heads/main")).toBe(inspected.headSha);
      await adapter.discard(checkout);

      const stale = await adapter.createIsolatedCheckout(claim);
      await import("node:fs/promises").then(fs => fs.writeFile(join(stale.path, "README.md"), "stale\n"));
      const staleHead = (await adapter.snapshot(stale, claim)).headSha;
      run(source, "pull", "--ff-only", "origin", "main");
      await import("node:fs/promises").then(fs => fs.writeFile(join(source, "README.md"), "new main\n"));
      run(source, "add", "README.md");
      run(source, "commit", "-m", "fix: another change");
      run(source, "push", "origin", "main");
      await expect(adapter.publish(stale, staleHead, guard)).rejects.toThrow("Main moved");

      const withheld = await adapter.createIsolatedCheckout(claim);
      await writeFile(join(withheld.path, "README.md"), "withheld\n");
      const withheldHead = (await adapter.snapshot(withheld, claim)).headSha;
      const beforeWithheld = run(root, "--git-dir", bare, "rev-parse", "refs/heads/main");
      await expect(adapter.publish(withheld, withheldHead, { signal: new AbortController().signal,
        assertLease: async () => { throw new LostLeaseError("Lease lost during fetch"); } })).rejects.toThrow("Lease lost during fetch");
      expect(run(root, "--git-dir", bare, "rev-parse", "refs/heads/main")).toBe(beforeWithheld);
      const controller = new AbortController();
      const realProcess = subprocess.runProcess;
      const spy = vi.spyOn(subprocess, "runProcess").mockImplementation(async input => {
        const result = await realProcess(input);
        if (input.signal === controller.signal && input.args.includes("fetch")) controller.abort();
        return result;
      });
      try {
        await expect(adapter.publish(withheld, withheldHead, { signal: controller.signal, assertLease: async () => undefined }))
          .rejects.toThrow("aborted");
      } finally { spy.mockRestore(); }
      expect(run(root, "--git-dir", bare, "rev-parse", "refs/heads/main")).toBe(beforeWithheld);

      const tampered = await adapter.createIsolatedCheckout(claim);
      run(tampered.path, "remote", "add", "origin", "https://example.invalid/attacker.git");
      await writeFile(join(tampered.path, "README.md"), "tampered\n");
      await expect(adapter.inspect(tampered)).rejects.toThrow("Git controls changed");

      const unsafe = await adapter.createIsolatedCheckout(claim);
      await writeFile(join(unsafe.path, "package.json"), "{}\n");
      await expect(adapter.snapshot(unsafe, claim)).rejects.toThrow("Protected paths");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
