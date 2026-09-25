import {describe, expect, it, vi} from "vitest";
import {
  acceptFeedbackSubmission, canSubmitFeedback, feedbackSubmissionV1Schema,
  FeedbackForbiddenError, FeedbackScreenshotOwnershipError, releaseAvailability,
  routeFeedback, sanitizeSafeState, verifiedActorFromSession,
  type FeedbackIntegrationConfig, type FeedbackSubmissionV1,
} from "./index";

const actor = verifiedActorFromSession({userId: "u1", tenantId: "tenant-one", isTester: true});
const owner = verifiedActorFromSession({userId: "owner", isOwner: true});
const submission = {
  schemaVersion: 1,
  clientSubmissionId: "c7356ce0-aad6-4bdb-9043-3de5201ec034",
  kind: "bug",
  description: "  Button won't save.\nPlease fix it.  ",
  context: {screen: "/work", safeState: {step: "submit", token: "secret"}},
  observedRelease: {clientVersion: "1.2.3", channel: "beta"},
  screenshots: [],
} satisfies FeedbackSubmissionV1;

function config(overrides: Partial<FeedbackIntegrationConfig> = {}): FeedbackIntegrationConfig {
  return {
    visibility: {mode: "testers"}, automationEnabled: true, safeStateFields: ["step"],
    screenshotMaskSelectors: [], protectedPaths: ["src/auth/**"], validationCommands: ["pnpm test"],
    storage: {ownsPrivateScreenshot: vi.fn(async () => true), createReport: vi.fn(async input => ({
      id: "r1", route: input.route, submittedAt: input.submittedAt, submittedRelease: input.submittedRelease,
    }))},
    reviewer: {canReview: vi.fn(async () => false)},
    release: {currentSubmittedRelease: vi.fn(async () => ({serverVersion: "1.2.4", channel: "web"})),
      verifyDelivery: vi.fn(async () => null)},
    ...overrides,
  };
}

describe("versioned feedback contract", () => {
  it("preserves submitted wording byte for byte and rejects client identity", () => {
    expect(feedbackSubmissionV1Schema.parse(submission).description).toBe(submission.description);
    expect(feedbackSubmissionV1Schema.safeParse({...submission, userId: "owner"}).success).toBe(false);
    expect(feedbackSubmissionV1Schema.safeParse({...submission, schemaVersion: 2}).success).toBe(false);
  });

  it("accepts screenshot-only feedback without inventing description text", () => {
    const shot = {privateRef: "tenant-one/feedback/image.jpg", mimeType: "image/jpeg", byteSize: 100,
      width: 200, height: 100, annotations: []};
    expect(feedbackSubmissionV1Schema.parse({...submission, description: "", screenshots: [shot]}).description).toBe("");
    expect(feedbackSubmissionV1Schema.safeParse({...submission, description: "", screenshots: []}).success).toBe(false);
  });

  it("bounds screenshot totals, annotations and private references", () => {
    const shot = {privateRef: "tenant-one/feedback/image.jpg", mimeType: "image/jpeg", byteSize: 900_000,
      width: 1_280, height: 720, annotations: [{x: 0.9, y: 0.1, width: 0.2, height: 0.2, note: "Here"}]};
    expect(feedbackSubmissionV1Schema.safeParse({...submission, screenshots: [shot]}).success).toBe(false);
    expect(feedbackSubmissionV1Schema.safeParse({...submission, screenshots: [
      {...shot, annotations: []}, {...shot, annotations: []}, {...shot, annotations: []},
    ]}).success).toBe(false);
    expect(feedbackSubmissionV1Schema.safeParse({...submission, screenshots: [
      {...shot, privateRef: "https://public.example/image.jpg", annotations: []},
    ]}).success).toBe(false);
  });
});

describe("server policy", () => {
  it("enforces all four visibility modes from verified roles", () => {
    expect(canSubmitFeedback({mode: "off"}, owner)).toBe(false);
    expect(canSubmitFeedback({mode: "internal"}, actor)).toBe(false);
    expect(canSubmitFeedback({mode: "testers"}, actor)).toBe(true);
    expect(canSubmitFeedback({mode: "signed_in"}, actor)).toBe(true);
    expect(canSubmitFeedback({mode: "signed_in"}, null)).toBe(false);
  });

  it("routes only bugs into enabled automation", () => {
    expect(routeFeedback("bug", true, actor)).toBe("auto_triage");
    expect(routeFeedback("bug", false, actor)).toBe("owner_review");
    expect(routeFeedback("suggestion", true, actor)).toBe("owner_review");
  });

  it("keeps app state allowlisted, bounded, and owner expansion verified", () => {
    const raw = {step: "submit", token: "secret", ownerDiagnostic: "safe diagnostic", long: "x".repeat(500)};
    expect(sanitizeSafeState(raw, ["step", "long"], {actor, ownerFields: ["ownerDiagnostic"]})).toEqual({step: "submit"});
    expect(sanitizeSafeState(raw, ["step"], {actor: owner, ownerFields: ["ownerDiagnostic"]}))
      .toEqual({step: "submit"});
    expect(sanitizeSafeState(raw, ["step"], {actor: owner, ownerFields: ["ownerDiagnostic"], ownerOptIn: true}))
      .toEqual({step: "submit", ownerDiagnostic: "safe diagnostic"});
  });

  it("checks private screenshot ownership and strips client-supplied unsafe state", async () => {
    const integration = config();
    const shot = {privateRef: "tenant-one/feedback/image.jpg", mimeType: "image/jpeg" as const, byteSize: 500,
      width: 200, height: 100, annotations: []};
    const receipt = await acceptFeedbackSubmission(integration, actor, {...submission, screenshots: [shot]});
    expect(receipt.status).toBe("queued");
    expect(receipt.submittedRelease).toEqual({serverVersion: "1.2.4", channel: "web"});
    expect(integration.storage.ownsPrivateScreenshot).toHaveBeenCalledWith(actor, shot);
    const saved = vi.mocked(integration.storage.createReport).mock.calls[0]?.[0];
    expect(saved?.submission.description).toBe(submission.description);
    expect(saved?.submission.context.safeState).toEqual({step: "submit"});
    expect(saved?.actor.tenantId).toBe("tenant-one");
  });

  it("denies unauthorized actors before storage and cross-tenant screenshots before create", async () => {
    const integration = config({visibility: {mode: "internal"}});
    await expect(acceptFeedbackSubmission(integration, actor, submission)).rejects.toBeInstanceOf(FeedbackForbiddenError);
    expect(integration.storage.createReport).not.toHaveBeenCalled();
    const denied = config({storage: {ownsPrivateScreenshot: vi.fn(async () => false), createReport: vi.fn()}});
    await expect(acceptFeedbackSubmission(denied, actor, {...submission, screenshots: [{privateRef: "other/shot.jpg",
      mimeType: "image/jpeg", byteSize: 10, width: 10, height: 10, annotations: []}]}))
      .rejects.toBeInstanceOf(FeedbackScreenshotOwnershipError);
    expect(denied.storage.createReport).not.toHaveBeenCalled();
  });

  it("returns original release and timestamp from idempotent storage retry", async () => {
    const original = {serverVersion: "1.0.0"};
    const integration = config({storage: {ownsPrivateScreenshot: vi.fn(async () => true),
      createReport: vi.fn(async () => ({id: "existing", route: "owner_review" as const,
        submittedAt: "2026-01-01T00:00:00.000Z", submittedRelease: original}))}});
    const receipt = await acceptFeedbackSubmission(integration, actor, submission);
    expect(receipt).toMatchObject({reportId: "existing", status: "needs_review", submittedRelease: original,
      submittedAt: "2026-01-01T00:00:00.000Z"});
  });
});

describe("release availability", () => {
  it("requires independent verification before saying available", () => {
    expect(releaseAvailability(null, null)).toBe("queued");
    expect(releaseAvailability("a123456", null)).toBe("implemented");
    expect(releaseAvailability("a123456", {channel: "web", release: {}, coversImplementationCommitSha: "a123456",
      verifiedAt: "bad", evidenceRef: "x"}))
      .toBe("implemented");
    expect(releaseAvailability("a123456", {channel: "web", release: {}, coversImplementationCommitSha: "b123456",
      verifiedAt: "2026-09-25T00:00:00.000Z", evidenceRef: "vercel/deployment-id"}))
      .toBe("implemented");
    expect(releaseAvailability("a123456", {channel: "web", release: {serverVersion: "1.2.4"},
      coversImplementationCommitSha: "a123456", verifiedAt: "2026-09-25T00:00:00.000Z",
      evidenceRef: "vercel/deployment-id"})).toBe("available");
  });
});
