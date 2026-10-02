# Package release

The project-owned code is MIT licensed. The package names remain unchanged so existing consumers can select a new version without renaming imports or migrating persisted reports. Dependencies remain separately licensed; packages ship compiled project code and do not bundle dependency source.

The current release candidates are:

| Package | Version | Change |
| --- | --- | --- |
| `@techlocal-accounts/feedback-core` | `0.1.1` | Project-neutral description and packaged MIT license. |
| `@techlocal-accounts/feedback-web` | `0.1.1` | Project-neutral description, packaged MIT license and core dependency update. |
| `@techlocal-accounts/feedback-runner` | `0.2.0` | First release of persistent incident investigations, with neutral defaults and a packaged MIT license. |

Core/web `0.1.0` and runner `0.1.0`–`0.1.2` already exist in GitHub Packages. Published versions are immutable; do not overwrite or delete them. Publishing a new version and changing the package's GitHub visibility are separate steps.

## Build and inspect

From a reviewed commit and a clean checkout, run:

```sh
pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile
pnpm test
pnpm typecheck
pnpm build
pnpm --filter './packages/*' pack --pack-destination /absolute/path/to/release-tarballs
node scripts/check-package-contents.mjs /absolute/path/to/release-tarballs
```

The pack destination must contain only the three scoped package tarballs. The checker uses the system `tar` utility, checks the file allowlist, includes the project MIT license, checks rewritten workspace dependencies, and scans for common credential patterns without printing values. This is a bounded static check, not a guarantee that every possible secret is detectable. Keep each package's `LICENSE` identical to the root `LICENSE`.

Preserve dependency licenses and notices when distributing dependencies separately or bundling them in an application. Changing this project's license does not relicense `zod`, `html2canvas-pro` or their dependencies.

## Publish and visibility

Publish core, then web, then runner to `https://npm.pkg.github.com` using an authorized package-write credential or an approved repository-scoped GitHub Actions job. Publish only the audited tarballs. Do not publish the private workspace root. Record the source commit and tarball checksums, and verify the registry's returned versions before retrying a partially completed release.

The prepared [release workflow](../.github/workflows/publish-packages.yml) runs only on `codex/feedback-public-release`. Pushing a reviewed commit to that dedicated branch is the explicit publication action; ordinary cleanup-branch pushes do not run it. The validation job has content-read permission only, and a separate publication job uses the repository's automatic short-lived token with package-write permission. No personal access token is required. The jobs are serialized, use pinned official actions, and publish checked tarballs with lifecycle scripts disabled. Publishing from this branch does not merge the cleanup PR. Run this workflow only after its token permissions and the publication action have been approved.

In each GitHub package's settings, change visibility only after auditing **all** existing versions that will become public. A manifest's `publishConfig.access` does not change an existing package's GitHub visibility. Existing read-only credentials must not be repurposed for publication or administrative changes.

## Install verification

GitHub's npm registry requires an access token even for public npm packages ([GitHub documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)). Verify public package visibility separately from authenticated installation. Do not describe public GitHub Packages as anonymous downloads.

For credential-free registry installs, also publish the same names/versions to a registry that supports anonymous reads, such as npmjs, after verifying ownership of the npm scope and obtaining an authorized publishing session. That is a separate registry setup step; do not silently rename packages or remove the existing GitHub distribution. Once that publication succeeds, test a clean environment with no npm config/token, no installed dependencies and a fresh cache, then import all package entry points and typecheck the server example against the installed core package.

Publication is not a release of application feedback data. Private screenshots, reports, authentication, reviewer permissions and queue credentials remain application-owned and private.
