# Runner validation repair — 15 October 2026

## Failure and correction

A runtime PATH can select an uncached Corepack pnpm shim inside network-denied validation.
An inherited home-directory PATH entry can also deny shell lookup before a supported tool is found.
Runner 0.2.1 requires an absolute installed package-manager executable, directly or through
`packageManagerExecutables`, before any dependency token is resolved or model is started.
Sandboxed package scripts use a read-only parent-owned manager alias and bounded macOS runtime
PATH. Corepack bootstrap networking is disabled. Installation remains frozen and script-disabled;
validation still receives no package, provider or queue credentials.

## Evidence

- Before: two new constructor regressions failed; the real installed pnpm script also failed with
  `spawn EPERM` on an inherited inaccessible PATH entry.
- After: all 97 kit tests passed, with typecheck and package builds passing.
- `node scripts/verify-runner-sandbox.mjs --pnpm /opt/homebrew/bin/pnpm` passed on this Mac.
  It runs a real offline package script with a failing shim first on the original PATH, no model
  and no package token. Its manager alias is read-only. Existing host/private-env/Keychain denial,
  read-only review/dependencies/Git controls and spoofed dependency-directory rejection remain checked.
- Scoped delivery standards audit passed, including the whole-repository critical security scan.
- Core 0.1.1, web 0.1.1 and runner 0.2.1 tarballs passed the package content/license/dependency scan.

## Distribution

Runner 0.2.1 is a source release candidate until registry publication and anonymous installation
are verified. This Mac had no npm maintainer login during preparation. Existing GitHub packages
remain unchanged. Apps using older runners can adopt the equivalent fix immediately by supplying
absolute installed commands and a bounded runtime PATH; this does not require a data migration.
