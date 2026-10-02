import {
  acceptFeedbackSubmission, canSubmitFeedback, FeedbackForbiddenError,
  verifiedActorFromSession,
  type FeedbackIntegrationConfig, type FeedbackReceiptV1,
} from "@techlocal/feedback-core";

// The application must validate the session and look up roles/tenant on its server.
// Never construct this value from submitted feedback JSON.
type VerifiedSession = Parameters<typeof verifiedActorFromSession>[0];
type ApplicationAdapters = Pick<FeedbackIntegrationConfig, "storage" | "reviewer" | "release"> & {
  verifySession(request: Request): Promise<VerifiedSession | null>;
};

/** Framework-neutral wiring. The app owns HTTP body limits, rate limits and error mapping. */
export function createFeedbackEndpoint(adapters: ApplicationAdapters) {
  const config: FeedbackIntegrationConfig = {
    visibility: {mode: "testers"},
    automationEnabled: false,
    safeStateFields: ["workflowStep", "hasUnsavedChanges"],
    screenshotMaskSelectors: ["[data-feedback-private]"],
    protectedPaths: ["src/auth/**", "db/**", "src/billing/**"],
    validationCommands: ["pnpm test", "pnpm typecheck"],
    storage: adapters.storage,
    reviewer: adapters.reviewer,
    release: adapters.release,
  };

  return async (request: Request): Promise<FeedbackReceiptV1> => {
    const session = await adapters.verifySession(request);
    const actor = session ? verifiedActorFromSession(session) : null;
    // Deny access before reading the body; recheck at the core submission boundary.
    if (!canSubmitFeedback(config.visibility, actor)) {
      throw new FeedbackForbiddenError("Feedback is not available to this account");
    }
    return acceptFeedbackSubmission(config, actor, await request.json());
  };
}
