import { z } from "zod";
import {
  MAX_SCREENSHOTS, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES,
  MAX_SAFE_STATE_FIELDS, MAX_SAFE_STATE_BYTES,
} from "./limits.js";
export {
  MAX_SCREENSHOTS, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES,
  MAX_SAFE_STATE_FIELDS, MAX_SAFE_STATE_BYTES,
} from "./limits.js";

export const FEEDBACK_CONTRACT_VERSION = 1 as const;
const stateBytes = (value: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const feedbackKindSchema = z.enum(["bug", "suggestion"]);
export type FeedbackKind = z.infer<typeof feedbackKindSchema>;

export const releaseIdentitySchema = z.object({
  clientVersion: z.string().min(1).max(64).optional(),
  serverVersion: z.string().min(1).max(64).optional(),
  commitSha: z.string().regex(/^[a-f0-9]{7,64}$/i).optional(),
  channel: z.string().min(1).max(64).optional(),
  nativeBuild: z.string().min(1).max(64).optional(),
  updateId: z.string().min(1).max(128).optional(),
}).strict();
export type ReleaseIdentity = z.infer<typeof releaseIdentitySchema>;

export const feedbackAnnotationSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
  note: z.string().max(1_000).refine(value => value.trim().length > 0),
}).strict().refine(value => value.x + value.width <= 1 && value.y + value.height <= 1,
  "Annotation must fit inside the screenshot");
export type FeedbackAnnotation = z.infer<typeof feedbackAnnotationSchema>;

export const feedbackScreenshotSchema = z.object({
  // An opaque key in private storage, never a signed or public URL.
  privateRef: z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9/_-]*(?:\.[A-Za-z0-9]+)?$/),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  byteSize: z.number().int().positive().max(MAX_IMAGE_BYTES),
  width: z.number().int().positive().max(4_096),
  height: z.number().int().positive().max(4_096),
  annotations: z.array(feedbackAnnotationSchema).max(10).default([]),
}).strict();
export type FeedbackScreenshot = z.infer<typeof feedbackScreenshotSchema>;

export const safeStateValueSchema = z.union([z.string().max(160), z.number().finite(), z.boolean(), z.null()]);
export const feedbackContextSchema = z.object({
  screen: z.string().min(1).max(256),
  workflowStep: z.string().max(100).optional(),
  recentErrorCode: z.string().max(100).optional(),
  ownerExpandedState: z.boolean().optional(),
  device: z.object({
    platform: z.string().max(40),
    osVersion: z.string().max(64).optional(),
    viewportWidth: z.number().int().positive().max(8_192).optional(),
    viewportHeight: z.number().int().positive().max(8_192).optional(),
  }).strict().optional(),
  safeState: z.record(z.string().max(64), safeStateValueSchema).optional(),
}).strict().superRefine((value, ctx) => {
  const state = value.safeState ?? {};
  if (Object.keys(state).length > MAX_SAFE_STATE_FIELDS || stateBytes(state) > MAX_SAFE_STATE_BYTES) {
    ctx.addIssue({code: "custom", path: ["safeState"], message: "Safe state exceeds its limit"});
  }
});
export type FeedbackContext = z.infer<typeof feedbackContextSchema>;

export const feedbackSubmissionV1Schema = z.object({
  schemaVersion: z.literal(FEEDBACK_CONTRACT_VERSION),
  clientSubmissionId: z.uuid(),
  kind: feedbackKindSchema,
  // Deliberately no trim or transformation: the submitter's wording is evidence.
  description: z.string().max(5_000),
  context: feedbackContextSchema,
  observedRelease: releaseIdentitySchema,
  screenshots: z.array(feedbackScreenshotSchema).max(MAX_SCREENSHOTS).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.screenshots.length === 0 && value.description.trim().length < 3) {
    ctx.addIssue({code: "custom", path: ["description"], message: "Describe the feedback or attach a screenshot"});
  }
  if (value.screenshots.reduce((sum, shot) => sum + shot.byteSize, 0) > MAX_TOTAL_IMAGE_BYTES) {
    ctx.addIssue({code: "custom", path: ["screenshots"], message: "Screenshots exceed their combined limit"});
  }
});
export type FeedbackSubmissionV1 = z.infer<typeof feedbackSubmissionV1Schema>;

export const feedbackReceiptV1Schema = z.object({
  schemaVersion: z.literal(FEEDBACK_CONTRACT_VERSION),
  reportId: z.string().min(1).max(128),
  clientSubmissionId: z.uuid(),
  status: z.enum(["queued", "needs_review"]),
  submittedRelease: releaseIdentitySchema,
  submittedAt: z.iso.datetime(),
}).strict();
export type FeedbackReceiptV1 = z.infer<typeof feedbackReceiptV1Schema>;

const verifiedActorBrand: unique symbol = Symbol("verified-feedback-actor");
export type VerifiedActor = Readonly<{
  userId: string;
  tenantId?: string;
  isInternal: boolean;
  isTester: boolean;
  isOwner: boolean;
  [verifiedActorBrand]: true;
}>;

/** Call only after the application's server has verified a signed-in session and roles. */
export function verifiedActorFromSession(value: {
  userId: string; tenantId?: string; isInternal?: boolean; isTester?: boolean; isOwner?: boolean;
}): VerifiedActor {
  if (!value.userId.trim()) throw new Error("A verified user ID is required");
  return Object.freeze({
    userId: value.userId,
    ...(value.tenantId ? {tenantId: value.tenantId} : {}),
    isInternal: value.isInternal === true,
    isTester: value.isTester === true,
    isOwner: value.isOwner === true,
    [verifiedActorBrand]: true as const,
  });
}

export type VisibilityMode = "off" | "internal" | "testers" | "signed_in";
export type VisibilityPolicy = {mode: VisibilityMode};
export function canSubmitFeedback(policy: VisibilityPolicy, actor: VerifiedActor | null): boolean {
  if (!actor || !actor[verifiedActorBrand]) return false;
  switch (policy.mode) {
    case "off": return false;
    case "internal": return actor.isInternal || actor.isOwner;
    case "testers": return actor.isInternal || actor.isTester || actor.isOwner;
    case "signed_in": return true;
  }
}

export type FeedbackRoute = "auto_triage" | "owner_review";
export function routeFeedback(kind: FeedbackKind, automationEnabled: boolean, actor: VerifiedActor): FeedbackRoute {
  if (!actor[verifiedActorBrand]) throw new Error("A verified actor is required");
  return kind === "bug" && automationEnabled ? "auto_triage" : "owner_review";
}

export type SafeState = Record<string, string | number | boolean | null>;
/** Allowlists are app-authored; richer owner fields still pass through the same bounds. */
export function sanitizeSafeState(raw: Record<string, unknown>, allowlist: readonly string[], options?: {
  actor?: VerifiedActor; ownerFields?: readonly string[]; ownerOptIn?: boolean;
}): SafeState {
  const keys = [...new Set([...allowlist, ...(options?.actor?.isOwner && options.ownerOptIn ? options.ownerFields ?? [] : [])])];
  const result: SafeState = {};
  for (const key of keys.slice(0, MAX_SAFE_STATE_FIELDS)) {
    if (!Object.hasOwn(raw, key) || key.length > 64) continue;
    const parsed = safeStateValueSchema.safeParse(raw[key]);
    if (!parsed.success) continue;
    const candidate = {...result, [key]: parsed.data};
    if (stateBytes(candidate) > MAX_SAFE_STATE_BYTES) continue;
    result[key] = parsed.data;
  }
  return result;
}

export type VerifiedDelivery = {
  channel: string;
  release: ReleaseIdentity;
  /** App release adapter confirms this deployed artifact contains the fix commit. */
  coversImplementationCommitSha: string;
  verifiedAt: string;
  evidenceRef: string;
};
export type AvailabilityState = "queued" | "implemented" | "available";
export function releaseAvailability(implementationCommitSha: string | null, delivery: VerifiedDelivery | null): AvailabilityState {
  if (!implementationCommitSha) return "queued";
  if (!delivery || delivery.coversImplementationCommitSha !== implementationCommitSha ||
    !delivery.evidenceRef || !Number.isFinite(Date.parse(delivery.verifiedAt))) return "implemented";
  return "available";
}

export interface FeedbackStorageAdapter {
  /** Check private bucket ownership and tenant against the verified actor before report creation. */
  ownsPrivateScreenshot(actor: VerifiedActor, screenshot: FeedbackScreenshot): Promise<boolean>;
  /** Atomically dedupe by actor + clientSubmissionId; reject a changed payload for the same key. */
  createReport(input: {submission: FeedbackSubmissionV1; actor: VerifiedActor; route: FeedbackRoute;
    submittedRelease: ReleaseIdentity; submittedAt: string}): Promise<{
      id: string; route: FeedbackRoute; submittedRelease: ReleaseIdentity; submittedAt: string;
    }>;
}
export interface FeedbackReviewerAdapter {
  canReview(actor: VerifiedActor, reportId: string): Promise<boolean>;
}
export interface FeedbackReleaseAdapter {
  currentSubmittedRelease(): Promise<ReleaseIdentity>;
  verifyDelivery(reportId: string, implementationCommitSha: string): Promise<VerifiedDelivery | null>;
}
export interface FeedbackIntegrationConfig {
  visibility: VisibilityPolicy;
  automationEnabled: boolean;
  safeStateFields: readonly string[];
  ownerSafeStateFields?: readonly string[];
  screenshotMaskSelectors: readonly string[];
  storage: FeedbackStorageAdapter;
  reviewer: FeedbackReviewerAdapter;
  release: FeedbackReleaseAdapter;
  protectedPaths: readonly string[];
  validationCommands: readonly string[];
}

export class FeedbackForbiddenError extends Error {}
export class FeedbackScreenshotOwnershipError extends Error {}

/** Server boundary. Identity, visibility, storage ownership and submitted release are server-derived. */
export async function acceptFeedbackSubmission(config: FeedbackIntegrationConfig, actor: VerifiedActor | null, raw: unknown): Promise<FeedbackReceiptV1> {
  if (!canSubmitFeedback(config.visibility, actor)) throw new FeedbackForbiddenError("Feedback is not available to this account");
  const parsed = feedbackSubmissionV1Schema.parse(raw);
  const submission: FeedbackSubmissionV1 = {
    ...parsed,
    context: {...parsed.context, safeState: sanitizeSafeState(parsed.context.safeState ?? {}, config.safeStateFields,
      {actor: actor!, ownerFields: config.ownerSafeStateFields, ownerOptIn: parsed.context.ownerExpandedState === true})},
  };
  for (const screenshot of submission.screenshots) {
    if (!await config.storage.ownsPrivateScreenshot(actor!, screenshot)) {
      throw new FeedbackScreenshotOwnershipError("Screenshot does not belong to this account");
    }
  }
  const submittedRelease = releaseIdentitySchema.parse(await config.release.currentSubmittedRelease());
  const submittedAt = new Date().toISOString();
  const route = routeFeedback(submission.kind, config.automationEnabled, actor!);
  const report = await config.storage.createReport({submission, actor: actor!, route, submittedRelease, submittedAt});
  return feedbackReceiptV1Schema.parse({
    schemaVersion: 1, reportId: report.id, clientSubmissionId: submission.clientSubmissionId,
    status: report.route === "auto_triage" ? "queued" : "needs_review",
    submittedRelease: report.submittedRelease, submittedAt: report.submittedAt,
  });
}
