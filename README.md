# Tech Local feedback kit

Private, versioned building blocks extracted from BibleGrid's feedback behavior:

- `@techlocal-accounts/feedback-core@0.1.0`: the v1 submission/receipt contract, verified-actor visibility and routing policy, safe-state allowlist, server submission boundary, and storage/reviewer/release adapter interfaces.
- `@techlocal-accounts/feedback-web@0.1.0`: headless viewport and file capture with clone-time privacy masking and a required clinical mask guard.
- `@techlocal-accounts/feedback-runner@0.1.1`: local Codex processing with credential-isolated dependency preparation, parent snapshots, and lease-guarded publication.

React and SwiftUI presentation, authentication, private storage, reviewer access, release verification, and database schema remain app-owned. The packages contain no production credentials or customer data. See [adapter recipes](docs/integration-recipes.md).

## Local development and private publishing

Run `pnpm install`, `pnpm test`, `pnpm typecheck`, and `pnpm build`. Tests use one worker to keep the subprocess and synthetic-repository checks reliable alongside other local app checks. Publish packages from this computer after the package gates and local adapter checks pass. Consumers then install the published versions and complete deployed tester journeys before broader rollout. The packages target GitHub Packages using their scoped `publishConfig`; authenticate the publishing CLI through a private environment/Keychain-backed token. A committed `.npmrc` may contain only registry mapping and an environment placeholder, never a token value. Consumers need a read-only GitHub Packages credential in server/build secrets. Do not put that credential in web or native bundles.

The runner's `0.1.1` adapter contract requires parent `prepare` and `snapshot` methods, cancellable validation, and a publication guard checked after fetching main and immediately before pushing. Implementers leave changes uncommitted. On the verified macOS/CLI platform, custom minimal-read permission profiles deny host credentials and Keychain access, protect installed dependencies, and sandbox both model tools and changed-source validation. The model process does not inherit global Codex configuration, MCP/app access, package credentials, login-shell grants, or network access. Run the documented no-model sandbox proof on the worker host and read the [runner integration contract](packages/feedback-runner/README.md) before upgrading a custom adapter.

Package versions are explicit. A future breaking submission shape uses `schemaVersion: 2` with a new schema/export; persisted v1 reports keep their original IDs and payload meaning. No data migration is implied by installation.

## Invariants

- The UI and receiving API both enforce the configured visibility mode. The API constructs `VerifiedActor` only from a verified server session and server-side role lookup. Request JSON cannot grant internal, tester, or owner access.
- The submission keeps the submitter's description unchanged. A UUID idempotency key scopes retries to the verified actor. Storage must enforce one atomic unique claim and reject different content for the same key.
- The server checks each screenshot reference against the actor and tenant before saving. Screenshots live in private storage; attachment IDs, annotations, and safe state go in the report.
- The server re-applies the app safe-state allowlist. Owner-expanded state requires a verified owner and explicit `context.ownerExpandedState` opt-in; it remains primitive and bounded. Exclude secrets and other users' customer or clinical content from both allowlists.
- A bug reaches automatic triage only when automation is enabled. Suggestions enter owner review. Protected changes still require runner escalation.
- A commit on `main` means implemented. Only an app release adapter's verified delivery receipt that covers that commit makes the inbox say available.
- `captureBeforeComposerOpen` awaits screenshot capture before opening an app-owned composer. The user must be able to inspect, annotate, and remove the screenshot before submission.

The test suite uses synthetic actors, reports, and DOM only. It does not establish a production deployment or device QA result.
