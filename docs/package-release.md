# Package release

Project-owned code is MIT licensed. Public npm distribution uses the verified `@techlocal` organization scope; the repository remains `techlocal-accounts/feedback-kit`. Dependencies remain separately licensed. Packages ship compiled project code and do not bundle dependency source.

The current npm release candidates are:

| Package | Version | Change |
| --- | --- | --- |
| `@techlocal/feedback-core` | `0.1.1` | Project-neutral contracts and packaged MIT license. |
| `@techlocal/feedback-web` | `0.1.1` | Project-neutral capture helpers, MIT license and npm core dependency. |
| `@techlocal/feedback-runner` | `0.2.0` | Persistent incident investigations, neutral defaults, MIT license and npm core dependency. |

The corresponding GitHub Packages releases under `@techlocal-accounts` already exist: core/web `0.1.1` and runner `0.2.0`. Earlier core/web `0.1.0` and runner `0.1.0`–`0.1.2` also remain available. These packages are public, but GitHub still requires authentication to download them. Do not overwrite, delete or rename any existing GitHub package or version. Moving an application to npm requires updating dependency names and imports; the APIs and persisted v1 report contracts are unchanged.

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

The pack destination must contain only the three scoped package tarballs. The checker uses the system `tar` utility, checks the file allowlist, includes the project MIT license, verifies npm registry configuration and rewritten workspace dependencies, and scans for common credential patterns without printing values. This bounded static check cannot detect every possible secret. Keep each package's `LICENSE` identical to the root `LICENSE`.

Record the source commit and SHA-256 checksums of the audited tarballs. Preserve dependency licenses and notices when distributing dependencies separately or bundling them in an application. This project's license does not relicense `zod`, `html2canvas-pro` or their dependencies.

## Publish to npm

Verify the maintainer owns the `@techlocal` scope and has an authorized publishing credential or session. Use the approved credential permissions and expiry; do not broaden or renew them automatically. Enter credentials only through a secure user-owned terminal or supported secret handoff, never through chat, source files, command arguments or committed configuration. Leave 2FA bypass disabled unless separately authorized. Any required identity or publishing challenge belongs to the maintainer.

Publish core, then web, then runner to `https://registry.npmjs.org` with public access and lifecycle scripts disabled. Publish exactly the reviewed tarballs:

```sh
npm publish /absolute/path/to/release-tarballs/techlocal-feedback-core-0.1.1.tgz --registry=https://registry.npmjs.org --access=public --ignore-scripts
npm publish /absolute/path/to/release-tarballs/techlocal-feedback-web-0.1.1.tgz --registry=https://registry.npmjs.org --access=public --ignore-scripts
npm publish /absolute/path/to/release-tarballs/techlocal-feedback-runner-0.2.0.tgz --registry=https://registry.npmjs.org --access=public --ignore-scripts
```

Do not publish the private workspace root. Published versions are immutable. Before retrying a partial release, inspect each registry version and compare its integrity with the reviewed tarball; skip an existing identical version and stop on a mismatch. Never delete or overwrite a version to make a retry succeed. Revoke temporary publishing credentials after release completion.

The [legacy GitHub workflow](../.github/workflows/publish-packages.yml) is restricted to `codex/feedback-public-release` at source commit `8d5f9d26be181c4b9b7c00b4055bc193eb91d39e`. It retains the previous registry distribution. It does not publish the new npm scope. Do not push npm release source to that legacy branch or repurpose its repository token.

## Anonymous install verification

Confirm that npm returns each exact package version and that `latest` points to the intended release. Use a new directory, empty user/global npm configuration, a fresh cache and an environment without tokens or npm configuration variables. Install the three pinned versions from `https://registry.npmjs.org` with lifecycle scripts disabled. Import all four public entry points, including `@techlocal/feedback-core/limits`, and typecheck the server integration example against installed core declarations without workspace path aliases. Inspect the installed web/runner dependencies to confirm they resolve to `@techlocal/feedback-core` and contain no legacy scope imports.

Record the actual registry install result before describing the packages as anonymously installable. Local tarball installation alone does not establish registry publication. GitHub public visibility is also insufficient for anonymous installation ([GitHub registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)).

Publication does not release application feedback data. Private screenshots, reports, authentication, reviewer permissions and queue credentials remain application-owned and private.
