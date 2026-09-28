// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertFeedbackPermissionConfiguration, createFeedbackPermissionConfig } from "./permissions.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
const actualHome = homedir();
afterEach(() => vi.mocked(homedir).mockReturnValue(actualHome));

describe("feedback read boundaries", () => {
  it("grants minimal runtime and explicit checkout paths, with host-home and env denial", () => {
    const config = createFeedbackPermissionConfig({ checkoutPath: "/private/tmp/feedback-run/repo", access: "write",
      readOnlyPaths: ["/private/tmp/feedback-run/control.git"] });
    const profile = config.permissions[config.default_permissions]!;
    expect(profile.network.enabled).toBe(false);
    expect(profile.filesystem[":minimal"]).toBe("read");
    expect(profile.filesystem[":root"]).toBeUndefined();
    expect(profile.filesystem["/opt/homebrew"]).toBeUndefined();
    expect(profile.filesystem["/opt/homebrew/var"]).toBeUndefined();
    expect(profile.filesystem["/opt/homebrew/etc"]).toBeUndefined();
    expect(profile.filesystem[homedir()]).toBe("deny");
    expect(profile.filesystem["/private/tmp/feedback-run/repo"]).toMatchObject({ ".": "write", ".git": "read", "node_modules": "read", "**/.env*": "deny" });
    expect(profile.filesystem["/private/tmp/feedback-run/control.git"]).toBe("read");
    const review = createFeedbackPermissionConfig({ checkoutPath: "/private/tmp/feedback-run/repo", access: "read" });
    expect(review.permissions[review.default_permissions]!.filesystem["/private/tmp/feedback-run/repo"]).toMatchObject({ ".": "read" });
    expect(review.default_permissions).not.toBe(config.default_permissions);
  });

  it.each(["/", homedir(), "relative/repo"])("refuses a broad or relative checkout %s", checkoutPath => {
    expect(() => createFeedbackPermissionConfig({ checkoutPath, access: "write" })).toThrow("bounded absolute");
  });

  it.each([homedir(), join(homedir(), ".codex"), join(homedir(), ".config", "node_modules")])(
    "does not turn %s into an additional readable root", path => {
      expect(() => createFeedbackPermissionConfig({ checkoutPath: "/private/tmp/feedback-run/repo", access: "write", readOnlyPaths: [path] }))
        .toThrow("app dependencies, isolated Git metadata");
    });

  it("fails closed on project legacy sandbox configuration before model startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-legacy-config-"));
    try {
      await mkdir(join(root, ".codex"));
      await writeFile(join(root, ".codex", "config.toml"), "sandbox_mode = 'workspace-write'\n");
      await expect(assertFeedbackPermissionConfiguration(root)).rejects.toThrow("Legacy sandbox/config profiles");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("ignores the canonical user config while verifying a checkout under the home directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-home-config-"));
    try {
      vi.mocked(homedir).mockReturnValue(root);
      const checkout = join(root, "projects", "feedback-run", "repo");
      await mkdir(checkout, { recursive: true });
      await mkdir(join(root, ".codex"));
      await writeFile(join(root, ".codex", "config.toml"), "sandbox_mode = 'workspace-write'\n");
      await expect(assertFeedbackPermissionConfiguration(checkout)).resolves.toBeUndefined();
      await mkdir(join(root, "projects", ".codex"));
      await writeFile(join(root, "projects", ".codex", "config.toml"), "sandbox_mode = 'workspace-write'\n");
      await expect(assertFeedbackPermissionConfiguration(checkout)).rejects.toThrow("Legacy sandbox/config profiles");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("grants only exact nested dependency and pinned standards paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-dependency-profile-"));
    try {
      await mkdir(join(root, "apps", "web", "node_modules"), { recursive: true });
      const standards = join(homedir(), ".codex", "plugins", "cache", "tech-local", "tech-local-standards", "0.2.0+pinned");
      const config = createFeedbackPermissionConfig({ checkoutPath: root, access: "write", readOnlyPaths: [standards] });
      const filesystem = config.permissions[config.default_permissions]!.filesystem;
      expect(filesystem[root]).toMatchObject({ "node_modules": "read", "apps/web/node_modules": "read" });
      expect(filesystem[standards]).toBe("read");
      expect(JSON.stringify(filesystem)).not.toContain("**/node_modules");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
