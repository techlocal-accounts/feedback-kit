import { z } from "zod";

// Matches the pinned feedback runner execution-settings contract.
export const feedbackModels = {
  "gpt-6.1-sol": "Sol 6.1",
  "gpt-6-luna": "Luna 6",
  "gpt-6-astra": "Astra 6",
} as const;

export const reviewStatuses = {
  needs_review: "Needs review",
  planned: "Planned",
  in_progress: "In progress",
  closed: "Closed",
} as const;
export const feedbackReasoningLevels = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
} as const;
const reasoningSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const subagentsSchema = z.enum(["off", "auto"]);
function compatibleReasoning(
  value: { model?: string; reasoningEffort?: string },
  context: z.RefinementCtx,
) {
  if (value.model === "gpt-6-luna" && value.reasoningEffort === "ultra")
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasoningEffort"],
      message: "Luna supports reasoning up to Max.",
    });
}
const reviewFieldsSchema = z
  .object({
    title: z.string().max(160),
    kind: z.enum(["bug", "suggestion"]),
    status: z.enum(["needs_review", "planned", "in_progress", "closed"]),
    notes: z.string().max(5000),
    reasoningEffort: reasoningSchema.default("high"),
    subagents: subagentsSchema.default("off"),
    model: z
      .enum(["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"])
      .default("gpt-6.1-sol"),
  })
  .strict();
export const reviewDraftSchema =
  reviewFieldsSchema.superRefine(compatibleReasoning);
export const reviewSchema = reviewFieldsSchema
  .extend({
    revision: z.number().int().min(0),
    updatedAt: z.string().nullable(),
  })
  .strict()
  .superRefine(compatibleReasoning);
export const reviewUpdateSchema = reviewFieldsSchema
  .extend({
    model: reviewFieldsSchema.shape.model.removeDefault().optional(),
    reasoningEffort: reasoningSchema.optional(),
    subagents: subagentsSchema.optional(),
    expectedRevision: z.number().int().min(0).max(2147483646),
  })
  .strict()
  .superRefine(compatibleReasoning);
export const reviewStartSchema = reviewFieldsSchema
  .extend({
    expectedRevision: z.number().int().min(0).max(2147483646),
    requestId: z.string().uuid(),
  })
  .strict()
  .superRefine(compatibleReasoning);
export type FeedbackReviewDraft = z.infer<typeof reviewDraftSchema>;
export type FeedbackReview = z.infer<typeof reviewSchema>;
export type FeedbackReviewHistory = {
  revision: number;
  created_at: string;
  review: FeedbackReviewDraft;
};
export function initialReview(kind: "bug" | "suggestion"): FeedbackReview {
  return {
    title: "",
    kind,
    status: "needs_review",
    notes: "",
    model: "gpt-6.1-sol",
    reasoningEffort: "high",
    subagents: "off",
    revision: 0,
    updatedAt: null,
  };
}
export async function saveFeedbackReview(
  id: string,
  draft: FeedbackReviewDraft,
  expectedRevision: number,
): Promise<FeedbackReview> {
  const response = await fetch(`/api/feedback-kit/reports/${id}/review`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...draft, expectedRevision }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error || "Couldn’t save changes. Try again.");
  return reviewSchema.parse(body);
}
