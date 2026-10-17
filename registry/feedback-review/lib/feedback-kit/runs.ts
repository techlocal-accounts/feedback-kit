import { z } from "zod";
import { reviewSchema, type FeedbackReviewDraft } from "./review";
// Public receipts exclude task text, fence, actor and lease controls.
export const runSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum([
      "queued",
      "running",
      "pr_ready",
      "needs_review",
      "failed",
      "cancelled",
    ]),
    thread_id: z.string().nullable(),
    review_thread_id: z.string().nullable(),
    pull_request_url: z
      .string()
      .regex(
        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/,
      )
      .nullable(),
    outcome: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strip();
export type FeedbackRun = z.infer<typeof runSchema>;
export const runColumns =
  "id,status,thread_id,review_thread_id,pull_request_url,outcome,created_at,updated_at";
export const runActive = (run: FeedbackRun | null) =>
  run?.status === "queued" || run?.status === "running";
export async function startFeedbackWork(
  id: string,
  draft: FeedbackReviewDraft,
  expectedRevision: number,
  requestId: string,
) {
  const response = await fetch(`/api/feedback-kit/reports/${id}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...draft, expectedRevision, requestId }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error || "Couldn’t start work. Try again.");
  return z.object({ review: reviewSchema, run: runSchema }).parse(body);
}
export async function loadFeedbackRun(id: string) {
  const response = await fetch(`/api/feedback-kit/reports/${id}/runs`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Couldn’t check work. Try again.");
  const body = await response.json();
  return runSchema.nullable().parse(body.run);
}
export async function cancelFeedbackWork(id: string, runId: string) {
  const response = await fetch(`/api/feedback-kit/reports/${id}/runs`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("Couldn’t stop work. Try again.");
}
