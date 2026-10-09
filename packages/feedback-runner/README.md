# Local feedback runner

Public npm release candidate: `@techlocal/feedback-runner@0.2.0`. See the [repository release checklist](https://github.com/techlocal-accounts/feedback-kit/blob/main/docs/package-release.md) for publication status. Existing GitHub Packages under `@techlocal-accounts/feedback-runner` retain their published versions.

Version `0.2.0` of `pollFeedbackOnce` coordinates dependency preparation, a local Codex implementation, a parent-created commit, a separate read-only Codex review, focused and shared validation, and a parent-owned fast-forward publication gate. An empty queue poll starts no model process. Suggestions and changes to protected paths return to owner review. A published commit is recorded as implemented; `verifyImplementedFeedback` marks it available only after the app supplies a verified delivery receipt.

The host app must provide a queue adapter whose `claimNext`, `renew`, `owns`, and `finish` operations use the report ID, run ID, and opaque fence in atomic database predicates. A worker must never infer ownership from time alone. Keep raw attachments outside `claim.task`; provide only an app-approved, bounded and redacted task. Persist a publication journal so an interrupted `finish` after Git push can reconcile the commit without rerunning Codex. Resume or inspect failed workspaces before retrying.

`LocalGitPublicationAdapter` clones committed source into an isolated temporary directory and moves its Git metadata outside the model's writable source directory. It removes the model's remote and fingerprints Git controls. Implementation leaves changes uncommitted; the parent inspects protected paths, checks its fenced lease, then calls `snapshot(checkout, claim)` to create one conventional commit with hooks disabled. Modified Git controls, model-created commits, symbolic links, and generated/private paths fail closed. At publication the parent validates the unchanged candidate, fetches main, checks the exact lease again immediately before pushing, and uses a normal non-force push. A moving main fails closed. Successful workspaces are removed; failed and protected workspaces are retained for inspection.

`LocalCodexTaskAdapter` requires macOS and `codex-cli >= 0.144.6`; the current implementation was verified against `0.144.6`. Other platforms and older or unrecognised CLI versions fail before a model starts. It uses separate ephemeral implementation/review processes with strict configuration, ignored user config and exec-policy rules, no approval escalation, and no network. MCP inventory uses an empty temporary Codex home to match the ignored user configuration; all remaining project/system MCP servers are disabled. Apps, hooks, local/remote plugins, computer/browser control, image generation, extra workspace tools, subagents, memories, and shell snapshots are disabled. The environment excludes package/provider/queue credentials and login profiles. An unreadable inventory or legacy project/system sandbox configuration starts no model.

Each run selects a uniquely named [Codex permission profile](https://learn.chatgpt.com/docs/permissions): `:minimal` runtime reads, a denied host home directory, one exact checkout, read-only isolated Git metadata/dependencies, and no network. Checkout `.env*` and private key files are denied. Homebrew reads cover only its tool/runtime directories; service configuration/data directories remain outside the grant. Bun receives an exact executable grant; `OPENSSL_CONF=/dev/null` avoids loading host OpenSSL configuration. Source is writable during implementation and read-only during review. Installed dependency directories are read-only in both roles, and added/removed ignored dependency directories fail the parent check. Legacy `sandbox_mode`, `sandbox_workspace_write`, or config-profile settings are rejected because they can select a broader sandbox. Unsupported enforcement never falls back to host execution.

The configuration guard excludes the ignored user config from its ancestor scan, so checkouts under the home directory still work. Managed, system, and actual project/ancestor controls remain checked.

After building, run `node scripts/verify-runner-sandbox.mjs` from the kit repository on the worker Mac. This no-model check uses synthetic external credentials, a temporary synthetic Keychain item, checkout `.env`, and isolated dependency/Git fixtures. It verifies file/Keychain denial, permitted dependency reads, denied dependency edits, review write denial, and the actual validation lane. It opens the real Codex auth file only to check denied access; it never reads credential bytes. It removes its synthetic fixtures and Keychain item.

## Adapter contract and package access

`ValidationAdapter.prepare(checkout, signal)` is required and runs before implementation. A failure or lost lease starts no model. `focused(checkout, changedPaths, signal)` and `shared(checkout, signal)` must stop their subprocesses when aborted. Custom validation adapters must enforce the same credential read denial, no network, read-only dependencies, and process bounds: changed tests/build scripts are untrusted executable code. Environment stripping alone is insufficient. `GitPublicationAdapter.snapshot(checkout, claim)` is required after protected-path inspection. `publish(checkout, expectedHead, { signal, assertLease })` must call the supplied guard after any fetch or other blocking work and immediately before its push. These methods are required when upgrading an app's custom `0.1.0` adapters; there is no fallback that lets the model commit or publish.

`CommandValidationAdapter` accepts trusted `install`, optional `prepare`, `focused`, and `shared` command arrays. `install` permits only `pnpm install --frozen-lockfile --ignore-scripts`, `bun install --frozen-lockfile --ignore-scripts`, or `npm ci --ignore-scripts`, with the supported offline/audit flags. Its `packageReadToken?: () => Promise<string | undefined>` callback belongs to the app's trusted parent and resolves a read-only token from Keychain/build-secret storage. The token is injected as `NODE_AUTH_TOKEN` only for those host installers, whose output is suppressed; lifecycle scripts are disabled and pnpm also receives `--ignore-pnpmfile` so [its executable hooks](https://pnpm.io/10.x/pnpmfile) cannot read the token. All subsequent `prepare`, focused, and shared commands run inside the same minimal-read, no-network sandbox without that token. A private temporary Codex home keeps validation free of user configuration/auth; temp and Bun caches stay inside the checkout. Do not load package credentials from a report checkout or pass them through `safeEnvironment`; secret and startup-control keys are rejected there. All subprocesses have bounded timeouts and process-group termination with forced escalation on cancellation or timeout.

Both local adapters accept optional trusted `readOnlyPaths` for credential-free isolated Git metadata and app dependencies. Audit scripts can live inside the checkout without an extra host grant. For existing integrations, a compatibility allowlist also accepts one pinned standards bundle under `~/.codex/plugins/cache/tech-local/tech-local-standards/<version>`; installing that tool is optional. Arbitrary tool bundles and broad home/plugin-cache grants are rejected. `CommandValidationAdapter.sandboxExecutable` and `LocalCodexTaskAdapter.executable` select the trusted CLI binary; synthetic executables are only test fixtures.

Package-manager configuration, dependency manifests/lockfiles, worker/governance paths, and `.codex`/`.agents`/`.github`/`.techlocal` controls are always protected. App-specific protected clinical, auth, billing, schema, and release paths add to that minimum; configuration cannot remove it.

The app chooses protected paths, focused and shared checks, release preparation, publication identity, and release verification. Keep existing web/native delivery gates in the trusted parent. Switch workers only after the storage adapters, publication journal and release gates have been tested against the existing queue and the old worker has no claim. This package does not upload native builds or start a hosting-provider release.

Set `LocalGitPublicationAdapter`'s `authorName` and `authorEmail` to your approved automation identity when needed. If omitted, generated commits use `Feedback Runner <feedback-runner@example.invalid>`; they do not borrow a repository owner's identity.

## Persistent incident investigations (0.2.0)

Incident claims use the same fenced orchestration as feedback bugs. `PersistentCodexTaskAdapter`
starts a saved app-server chat and awaits `onThread` before the first model turn. Use a dedicated
minimal config home; share only signed-in auth/session storage and the configured SQLite home.
Never use the primary config home or copy broad sandbox, plugin or MCP settings into this home.
The selected CLI must support the configured model; verify a bounded synthetic turn before activation.
The adapter disables integrations and applies the same minimal-read, denied-home/no-network profile.
Usage updates call `onUsage`; stop at the shared implementation/review `tokenBudget` (max50,000).
One in-flight response can overshoot the threshold before its usage notification arrives. Receipt
failure, lost lease, ambiguous RPC, timeout or budget exhaustion stops the child process group.

Use `LocalGitPublicationAdapter({baseBranch, pullRequest: {branch, create}})` for incidents.
`branch` must begin `codex/`; only that branch is pushed. The trusted `create` callback reconciles
an existing PR and then creates a ready-for-review PR. It must journal the PR before acknowledging
the queue. No merge or deployment is performed. Existing feedback callers retain their original
main publication behavior. `ValidationCommand.cwd` optionally selects a repository subdirectory;
it cannot escape the isolated checkout. The host wrapper supplies app-specific checks and protected
paths, a per-project daily budget, source opt-in and one job per issue episode.

The host application supplies the queue adapter, operational runbook, budget persistence and PR
callback. It can provide both feedback and incident queue adapters without adding a separate
incident-reporting interface to the feedback UI.

## Model selection

Both Codex adapters explicitly default to `gpt-6.1-sol` with `high` reasoning. Set trusted `executionSettings: { model, reasoningEffort }` on either adapter to override this. Saved `gpt-6-sol` choices upgrade to Sol 6.1 without changing reasoning; explicit Luna and Astra choices are preserved. Report content cannot select models.

For a scheduled app-owned controller, launch through a plain Node entrypoint that checks its locked dependencies before starting the TypeScript worker. Restore missing dependencies only in the trusted parent with a frozen, script-disabled install and the existing package reader. Keep installer credentials out of model and validation processes. Empty healthy polls do not install or start models.
