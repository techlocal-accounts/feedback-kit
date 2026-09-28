# Integration recipes

These are wiring recipes, not copy-ready migrations. Keep existing report IDs, reviewer tables, attachment storage, and release catalogs. Add fields and adapters without rewriting history.

## Next.js with Neon or Supabase

1. Add the packages as pinned private dependencies. Configure the scoped GitHub Packages read token in the deployment's build secret. Exclude it from `NEXT_PUBLIC_*`, client manifests, and runtime responses.
2. Build the branded feedback trigger and responsive Dialog/Drawer in the app. Gate its visibility using server-returned capability data. On click, call `captureBeforeComposerOpen` and then show the screenshot preview and annotation/removal controls.
3. Upload the selected JPEG blob to the existing private bucket through an authenticated, bounded upload endpoint. Return an opaque key. On report submission, call `acceptFeedbackSubmission` in a server route after resolving auth and roles. Construct `VerifiedActor` there, never from request JSON. Do not trust a client-supplied tenant ID or owner flag.
4. In Neon, implement `ownsPrivateScreenshot` with tenant/user-scoped SQL and `createReport` in a transaction with a unique `(tenant_id, user_id, client_submission_id)` index and stored payload digest. In Supabase, use an equivalent RLS-backed private bucket and transactional server-side persistence; verify that public/anon roles cannot read another account's report or attachment.
5. Wire the current app release catalog into `currentSubmittedRelease` and `verifyDelivery`; persist verified channel, release identity, availability timestamp, and evidence reference separately from the implementation commit. Keep existing native build/review gates.

## TanStack Start with Neon

1. Use the existing server function or API route for auth, screenshot upload, and submission. The same `acceptFeedbackSubmission` boundary applies; perform capability checks again server-side even if the client hides the trigger.
2. Capture before the TanStack feedback overlay mounts. Allow the user to inspect, annotate, or remove the image. Pass `screen` as a route pathname, plus only app-approved workflow state and flags through `sanitizeSafeState`; avoid query strings that may contain tokens.
3. In the Neon adapter, keep row-level tenant predicates on every review and screenshot lookup, use a least-privileged application role, and prove cross-tenant denial in tests. Do not expose raw attachments to automatic Codex tasks.
4. Run the local runner only for signed-in bug reports when enabled. Suggestions and protected changes return to owner review. Publish through the app's existing release workflow and mark available only after checking the deployed route or installed native update.

## Validation before broad rollout

Start with `visibility.mode = "testers"`. Test UI and API denial for anonymous, non-tester, and cross-tenant users; changed-content idempotency conflicts; failed upload and retry; private screenshot ownership; clinical clone masking; reviewer access; and verified release availability. Then test the affected app journeys at representative phone/tablet/desktop widths, keyboard and screen-reader behavior, production-equivalent builds, and actual deployment receipts. Change to `signed_in` only after each pilot works end to end.

## Local runner (`0.1.2`)

1. Pin core/web at `0.1.0` and runner at `0.1.2`. Publish after local package and adapter gates; then install the registry versions and complete deployed pilot checks. Keep any existing worker unscheduled until its last claim is resolved and the new full fix journey passes.
2. Provide `ValidationAdapter.prepare(checkout, signal)` before implementation. With `CommandValidationAdapter`, configure `install` as a frozen, script-disabled pnpm/bun install or npm ci. Resolve `packageReadToken` through the trusted parent's Keychain/build-secret provider. It reaches only that host installer; further `prepare`, focused, and shared commands run without credentials inside the minimal-read, no-network sandbox. Forward cancellation through all checks. Custom validation adapters must enforce the same read boundary because tests/build scripts execute changed source. If the offline audit tool lives outside source, add its exact pinned standards bundle to `readOnlyPaths` on each command adapter; broader home/plugin-cache paths are rejected.
3. Use the required parent `GitPublicationAdapter.snapshot(checkout, claim)` after the runner inspects protected changes and checks its lease. The model leaves files uncommitted. Forward the required `{ signal, assertLease }` publication guard, checking it after fetching main immediately before any push. The supplied local Git adapter keeps metadata outside the source sandbox and refuses changed controls, candidate changes, or moving main.
4. Use the verified macOS host with `codex-cli >= 0.144.6`; older/unrecognised versions, unsupported platforms, and legacy project/system sandbox settings fail closed. Run `pnpm build` and `node scripts/verify-runner-sandbox.mjs` in the kit repository to verify real credential/Keychain denial and the validation lane without a model. The named profile grants minimal runtime reads and one exact checkout; it denies host home/private env/key files, protects dependencies and Git controls, and supplies only bounded tool reads. Keep automatic Codex processes free of global MCP/apps/plugins, browser/computer control, inherited environment grants, package credentials, and network/release access. Use `LocalCodexTaskAdapter`'s separate ephemeral implementation/read-only review runs. Preserve app-specific release preparation and independent availability checks in the trusted parent.
