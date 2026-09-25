import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { findProtectedPaths, pollFeedbackOnce, verifyImplementedFeedback,
  type FencedClaim, type LocalFeedbackRunnerConfig } from "./index.js";
import { LocalGitPublicationAdapter } from "./local-git.js";

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
    publish: vi.fn(async () => undefined), discard: vi.fn(async () => undefined),
  };
  const codex = {
    implement: vi.fn(async () => undefined),
    review: vi.fn(async () => ({ approved: true, reason: "Reviewed", releaseNote: "Saving works again." })),
  };
  const validation = { focused: vi.fn(async () => undefined), shared: vi.fn(async () => undefined) };
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
      run(checkout.path, "config", "user.name", "Test");
      run(checkout.path, "config", "user.email", "test@example.com");
      await import("node:fs/promises").then(fs => fs.writeFile(join(checkout.path, "README.md"), "fixed\n"));
      run(checkout.path, "add", "README.md");
      run(checkout.path, "commit", "-m", "fix: save feedback");
      const inspected = await adapter.inspect(checkout);
      expect(inspected.changedPaths).toEqual(["README.md"]);
      await adapter.publish(checkout, inspected.headSha);
      expect(run(root, "--git-dir", bare, "rev-parse", "refs/heads/main")).toBe(inspected.headSha);
      await adapter.discard(checkout);

      const stale = await adapter.createIsolatedCheckout(claim);
      run(stale.path, "config", "user.name", "Test");
      run(stale.path, "config", "user.email", "test@example.com");
      await import("node:fs/promises").then(fs => fs.writeFile(join(stale.path, "README.md"), "stale\n"));
      run(stale.path, "add", "README.md");
      run(stale.path, "commit", "-m", "fix: stale attempt");
      const staleHead = (await adapter.inspect(stale)).headSha;
      run(source, "pull", "--ff-only", "origin", "main");
      await import("node:fs/promises").then(fs => fs.writeFile(join(source, "README.md"), "new main\n"));
      run(source, "add", "README.md");
      run(source, "commit", "-m", "fix: another change");
      run(source, "push", "origin", "main");
      await expect(adapter.publish(stale, staleHead)).rejects.toThrow("Main moved");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
