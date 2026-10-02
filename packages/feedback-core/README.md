# Feedback core

Public npm release candidate: `@techlocal/feedback-core@0.1.1`. See the [repository release checklist](https://github.com/techlocal-accounts/feedback-kit/blob/main/docs/package-release.md) for publication status. Existing GitHub Packages under `@techlocal-accounts/feedback-core` retain their published versions.

`feedbackSubmissionV1Schema` and `feedbackReceiptV1Schema` are the durable JSON boundary. The submission contains `schemaVersion`, `clientSubmissionId`, `kind`, unchanged `description`, safe `context`, `observedRelease`, and up to three private screenshot references with normalized annotations. Screenshot-only feedback may have an empty description; no placeholder wording is synthesized. The receipt contains the report ID, original submission key, initial queue status, and server-derived submitted release and timestamp.

`acceptFeedbackSubmission(config, actor, raw)` is the server entry point. Obtain `actor` by calling `verifiedActorFromSession` only after validating the application session and roles on the server. The helper checks visibility, validates the payload, reapplies safe-state allowlists, checks screenshot ownership, routes bugs/suggestions, and calls the app storage adapter. The adapter implements atomic idempotency and returns the original route/release/timestamp for repeat submissions.

`releaseAvailability(commit, verifiedDelivery)` returns `queued`, `implemented`, or `available`. Supply delivery only from the app's own deployment verification, never from a client claim.
