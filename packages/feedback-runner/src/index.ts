import type { ReleaseIdentity, VerifiedDelivery } from "@techlocal-accounts/feedback-core";
export { LocalCodexTaskAdapter } from "./codex-cli.js";
export { LocalGitPublicationAdapter } from "./local-git.js";
export { CommandValidationAdapter, type ValidationCommand } from "./validation.js";

/** Queue methods must check reportId + runId + fence in one atomic write. */
export interface FencedClaim {
  reportId: string;
  runId: string;
  fence: string;
  kind: "bug" | "suggestion";
  /** Redacted, bounded text prepared by the host app. Never include private attachment URLs. */
  task: string;
  observedRelease: ReleaseIdentity;
  leaseMs: number;
}

export type RunnerOutcome =
  | { status: "implemented"; commitSha: string; releaseNote: string; changedPaths: string[] }
  | { status: "needs_review"; reason: string; changedPaths?: string[] }
  | { status: "failed"; reason: string };

export interface FencedQueue {
  /** Empty polls return null without starting a model process. Claim only approved bugs. */
  claimNext(): Promise<FencedClaim | null>;
  renew(claim: FencedClaim): Promise<boolean>;
  owns(claim: FencedClaim): Promise<boolean>;
  finish(claim: FencedClaim, outcome: RunnerOutcome): Promise<boolean>;
  /** Delivery is independently verified after implementation, never inferred from Git. */
  markAvailable(reportId: string, commitSha: string, delivery: VerifiedDelivery): Promise<void>;
}

export interface IsolatedCheckout {
  path: string;
  baseSha: string;
}

export interface GitPublicationAdapter {
  createIsolatedCheckout(claim: FencedClaim): Promise<IsolatedCheckout>;
  /** Refuse uncommitted files, merge commits, unsafe paths, or changes outside the candidate. */
  inspect(checkout: IsolatedCheckout): Promise<{ headSha: string; changedPaths: string[] }>;
  /** Atomically compare current main to base and publish by fast-forward only. */
  publish(checkout: IsolatedCheckout, expectedHead: string): Promise<void>;
  discard(checkout: IsolatedCheckout): Promise<void>;
}

export interface CodexTaskAdapter {
  implement(input: { claim: FencedClaim; checkout: IsolatedCheckout; signal: AbortSignal }): Promise<void>;
  /** Must be a separate Codex run with no write access to the candidate. */
  review(input: { claim: FencedClaim; checkout: IsolatedCheckout; changedPaths: string[]; signal: AbortSignal }): Promise<{
    approved: boolean; reason: string; releaseNote?: string;
  }>;
}

export interface ValidationAdapter {
  focused(checkout: IsolatedCheckout, changedPaths: string[]): Promise<void>;
  shared(checkout: IsolatedCheckout): Promise<void>;
}

export interface LocalFeedbackRunnerConfig {
  queue: FencedQueue;
  git: GitPublicationAdapter;
  codex: CodexTaskAdapter;
  validation: ValidationAdapter;
  protectedPaths: readonly string[];
  /** Check release availability on a separate pass after the app deploys. */
  verifyDelivery(reportId: string, commitSha: string): Promise<VerifiedDelivery | null>;
}

export type PollResult =
  | { kind: "empty" }
  | { kind: "implemented"; reportId: string; commitSha: string }
  | { kind: "needs_review"; reportId: string; reason: string }
  | { kind: "failed"; reportId: string; reason: string }
  | { kind: "lost_lease"; reportId: string };

export class MovingMainError extends Error {}
export class LostLeaseError extends Error {}

function pathMatches(path: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..")) throw new Error("Invalid protected path");
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === normalized || path.startsWith(`${normalized}/`);
}

export function findProtectedPaths(changedPaths: readonly string[], patterns: readonly string[]): string[] {
  return changedPaths.filter(path => patterns.some(pattern => pathMatches(path, pattern)));
}

async function assertLease(queue: FencedQueue, claim: FencedClaim, signal: AbortSignal): Promise<void> {
  if (signal.aborted || !await queue.owns(claim)) throw new LostLeaseError("Feedback claim ownership changed");
}

/** A local parent controls every transition. Model output alone cannot publish or mark availability. */
export async function pollFeedbackOnce(config: LocalFeedbackRunnerConfig): Promise<PollResult> {
  const claim = await config.queue.claimNext();
  if (!claim) return { kind: "empty" };
  if (claim.kind !== "bug") {
    const reason = "Suggestions require owner review";
    await config.queue.finish(claim, { status: "needs_review", reason });
    return { kind: "needs_review", reportId: claim.reportId, reason };
  }
  if (!claim.fence || !claim.runId || claim.leaseMs < 1_000 || claim.leaseMs > 3_600_000) {
    throw new Error("Invalid fenced feedback claim");
  }

  const controller = new AbortController();
  let leaseLost = false;
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void config.queue.renew(claim).then(ok => {
      if (!ok) { leaseLost = true; controller.abort(); }
    }).catch(() => { leaseLost = true; controller.abort(); }).finally(() => { renewing = false; });
  }, Math.max(500, Math.floor(claim.leaseMs / 3)));
  timer.unref?.();

  let checkout: IsolatedCheckout | null = null;
  let published = false;
  try {
    await assertLease(config.queue, claim, controller.signal);
    checkout = await config.git.createIsolatedCheckout(claim);
    await assertLease(config.queue, claim, controller.signal);
    await config.codex.implement({ claim, checkout, signal: controller.signal });
    await assertLease(config.queue, claim, controller.signal);
    const candidate = await config.git.inspect(checkout);
    if (candidate.changedPaths.length === 0) throw new Error("Implementation made no changes");
    const protectedChanges = findProtectedPaths(candidate.changedPaths, config.protectedPaths);
    if (protectedChanges.length > 0) {
      const reason = `Protected paths require owner review: ${protectedChanges.join(", ")}`;
      if (!await config.queue.finish(claim, { status: "needs_review", reason, changedPaths: candidate.changedPaths })) {
        throw new LostLeaseError("Feedback claim ownership changed");
      }
      return { kind: "needs_review", reportId: claim.reportId, reason };
    }
    await config.validation.focused(checkout, candidate.changedPaths);
    await assertLease(config.queue, claim, controller.signal);
    await config.validation.shared(checkout);
    await assertLease(config.queue, claim, controller.signal);
    const review = await config.codex.review({ claim, checkout, changedPaths: candidate.changedPaths, signal: controller.signal });
    await assertLease(config.queue, claim, controller.signal);
    if (!review.approved) {
      const reason = review.reason || "Independent review requested owner attention";
      if (!await config.queue.finish(claim, { status: "needs_review", reason, changedPaths: candidate.changedPaths })) {
        throw new LostLeaseError("Feedback claim ownership changed");
      }
      return { kind: "needs_review", reportId: claim.reportId, reason };
    }
    if (!review.releaseNote?.trim()) throw new Error("Approved fix requires a public release note");
    await assertLease(config.queue, claim, controller.signal);
    await config.git.publish(checkout, candidate.headSha);
    published = true;
    // A failed queue write after publication is recovered by the app's fenced journal.
    if (!await config.queue.finish(claim, { status: "implemented", commitSha: candidate.headSha,
      releaseNote: review.releaseNote, changedPaths: candidate.changedPaths })) {
      throw new LostLeaseError("Feedback was published but claim ownership changed; reconcile the commit");
    }
    await config.git.discard(checkout);
    return { kind: "implemented", reportId: claim.reportId, commitSha: candidate.headSha };
  } catch (error) {
    if (leaseLost || error instanceof LostLeaseError) return { kind: "lost_lease", reportId: claim.reportId };
    const reason = error instanceof Error ? error.message : "Feedback processing failed";
    if (!published) {
      const finished = await config.queue.finish(claim, { status: "failed", reason });
      if (!finished) return { kind: "lost_lease", reportId: claim.reportId };
    }
    return { kind: "failed", reportId: claim.reportId, reason };
  } finally {
    clearInterval(timer);
    // Keep failed and protected workspaces for inspection. Only successful work is discarded.
  }
}

export async function verifyImplementedFeedback(config: LocalFeedbackRunnerConfig, reportId: string, commitSha: string): Promise<boolean> {
  const delivery = await config.verifyDelivery(reportId, commitSha);
  if (!delivery) return false;
  if (!delivery.evidenceRef || delivery.coversImplementationCommitSha !== commitSha ||
    !Number.isFinite(Date.parse(delivery.verifiedAt))) return false;
  await config.queue.markAvailable(reportId, commitSha, delivery);
  return true;
}
