# Feedback Kit

Composable TypeScript building blocks for collecting, reviewing and optionally acting on application feedback.

| Package | Version | Purpose |
| --- | --- | --- |
| [`@techlocal/feedback-core`](packages/feedback-core/README.md) | `0.1.1` | Versioned submission/receipt contracts, visibility and routing policies, safe-state allowlists, and storage/reviewer/release interfaces. |
| [`@techlocal/feedback-web`](packages/feedback-web/README.md) | `0.1.1` | Headless screenshot/file capture with privacy masking and bounded image compression. |
| [`@techlocal/feedback-runner`](packages/feedback-runner/README.md) | `0.2.2` | Optional local Codex processing for fenced feedback and incident queues, isolated validation, independent review and parent-owned Git publication. |

An optional [standard review inbox and action components](registry/feedback-review/README.md) now supplies a reusable receiving UI as a shadcn source block. The core capture packages remain headless.

Your application owns presentation, authentication, tenant isolation, private storage, reviewer access, database schema and release verification. Collection and review work without the runner. The core and web packages are framework-independent; the supplied runner adapters currently require macOS and a supported Codex CLI.

New npm distribution uses the `@techlocal` scope. Existing GitHub Packages under `@techlocal-accounts` remain available to current consumers. The exported API and v1 report contracts are unchanged; switching registries requires updating package names and imports, not migrating persisted reports.

## Getting started

For local development from source:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

The workspace uses the pnpm version declared in `package.json`. Tests use one worker for subprocess and synthetic-repository checks. `pnpm typecheck` also checks the [server integration example](examples/server-integration.ts).

To integrate with an application:

1. Start with tester visibility and automation disabled. Use server-verified identity and roles for both UI capabilities and API authorization.
2. Supply the core storage, reviewer and release adapters. Preserve existing report IDs and enforce atomic, actor/tenant-scoped idempotency in storage.
3. Add an app-owned composer around web capture. Let the submitter preview, annotate and remove images, then upload to private storage through an authenticated endpoint.
4. Validate submission, review and delivery journeys before enabling broader access or optional automation.

See the [integration recipes](docs/integration-recipes.md) for Next.js, TanStack Start, database adapters and runner adoption. The example supplies a server boundary with app-owned adapters; it is not a complete database, upload endpoint or UI.

A future breaking submission shape needs a new schema version/export; persisted v1 reports keep their original IDs and payload meaning. Installing the packages does not imply a data migration.

## Package access

All three `@techlocal` packages are published on the public npm registry. Anonymous installation was verified on 15 October 2026; see the [release receipt](docs/npm-release-2026-10-15.json). Applications can install these pinned versions without a registry credential:

```sh
npm install @techlocal/feedback-core@0.1.1 @techlocal/feedback-web@0.1.1
# Optional local runner:
npm install @techlocal/feedback-runner@0.2.2
```

The versions above passed registry integrity, anonymous install, entry-point and integration-example checks. Future source versions remain release candidates until the same checks pass. Use `@techlocal/feedback-core`, `@techlocal/feedback-core/limits`, `@techlocal/feedback-web` and `@techlocal/feedback-runner` in imports. An existing `@techlocal-accounts` installation must update its dependencies and imports to adopt the npm distribution. Core/web `0.1.1` and runner `0.2.2` preserve the corresponding GitHub release APIs.

### Existing GitHub Packages consumers

The existing `@techlocal-accounts/feedback-*` packages and versions are retained. GitHub requires an access token even to install public npm packages ([registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)). Existing GitHub consumers can keep their package names, imports and registry mapping:

```ini
@techlocal-accounts:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Supply the read credential only through an authorized local secret store or install/build environment. Never commit its value or include it in browser/native bundles. Authorized GitHub Actions consumers can use a job's short-lived `GITHUB_TOKEN` with package-read permission. npm consumers do not need this mapping or credential.

The workspace root remains `private: true` to prevent accidental root-package publication. Publish only the three scoped packages after their release checks; never publish the workspace root.

## Optional Vercel credential sync on macOS

For applications retaining GitHub Packages, the helper requires an already linked Vercel project and an explicitly selected Keychain item:

```sh
node scripts/sync-vercel-package-reader.mjs \
  --root /absolute/path/to/app \
  --project example-app \
  --scope example-team \
  --environment preview \
  --branch codex/feedback-pilot \
  --keychain-service example-feedback-reader \
  --keychain-account example-registry-user
```

This command writes `NODE_AUTH_TOKEN` to the selected Vercel build environment. It checks the existing project link, sends the token without a trailing newline, compares the stored value against Keychain and removes its temporary file. It does not print the token. Use the service/account of your authorized package reader; the helper no longer selects a company-specific item implicitly. Existing invocations must add both options. Other build providers should use their own supported secret stores.

## Invariants

- The UI and receiving API enforce the configured visibility mode. Construct `VerifiedActor` only after verifying a server session and server-side roles. Request JSON cannot grant internal, tester, owner or tenant access.
- Preserve the submitter's wording. A UUID idempotency key scopes retries to the verified actor. Storage must enforce an atomic unique claim and reject different content for the same key.
- Check every screenshot reference against the actor and tenant before saving. Keep screenshots private; store opaque references and normalized annotations in reports.
- Reapply the application's safe-state allowlist on the server. Owner-expanded state requires a verified owner and explicit opt-in; both allowlists remain primitive, bounded and free of secrets or other users' private content.
- Automatic triage requires explicit automation enablement. Suggestions and protected changes return to owner review.
- A published commit means implemented. Only a verified delivery receipt covering that commit makes a fix available. Incident PRs still require the application's review and release workflow.
- Await capture before opening the composer. Users must be able to inspect, annotate and remove screenshots before submission.

The test suite uses synthetic actors, reports and DOM fixtures. It does not establish a production deployment or device QA result. Runner adoption additionally requires the documented no-model sandbox proof and app-specific queue, validation and release checks.

## Licensing

Project-owned code is licensed under the [MIT License](LICENSE), attributed to Tech Local (the verified repository owner/publisher) and contributors. Dependencies retain their own licenses and copyright notices; this project license does not replace their terms.

## Verified automatic workers — 15 October 2026

Runner 0.2.2 is published and verified through an anonymous fresh-cache install and registry
integrity check. It adds a private intent-before-push publication journal, exact-fence recovery,
serialized local polls, and health updates. Empty polls start no model. See the
[npm receipt](docs/npm-runner-0.2.2-release.json).

Stennar and PracticeDay now have installed local workers, enabled intake, tester visibility,
and fresh ready/empty polling evidence. Both explicitly select Sol 6.1. PracticeDay Amplify
job 89 succeeded and its canonical live release matches source `633b01e3`. Its automatic
builds remain off; subsequent fixes still need the explicit release gate. Stennar's native
release policy is unchanged. Local workers pause while the Mac is asleep or signed out.

App receipts: [Stennar](https://github.com/techlocal-accounts/stennar/blob/main/docs/feedback-runner-activation-2026-10-15.json)
and [PracticeDay](https://github.com/techlocal-accounts/practiceday/blob/main/docs/feedback-runner-activation-2026-10-15.json).
Both queues had no eligible production bugs during activation. These receipts prove active
configuration, scheduled polling and validation readiness; they do not claim a new automatic
production report-to-fix journey. Suggestions and protected/clinical changes retain owner review.
