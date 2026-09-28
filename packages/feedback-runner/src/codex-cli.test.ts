// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCodexTaskAdapter } from "./codex-cli.js";
import type { FencedClaim } from "./index.js";

const claim: FencedClaim = {
  reportId: "report-1", runId: "run-1", fence: "fence-1", kind: "bug", task: "Fix a synthetic broken save",
  observedRelease: { clientVersion: "1.0" }, leaseMs: 60_000,
};
afterEach(() => vi.unstubAllEnvs());

describe("isolated Codex process", () => {
  it("disables inherited capabilities and credentials in separate implementation and review runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-codex-test-"));
    try {
      const executable = join(root, "codex-fixture");
      await writeFile(executable, `#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2);if(args[0]==='--version'){process.stdout.write('codex-cli 0.144.6');}else if(args[0]==='mcp'){process.stdout.write(JSON.stringify([{name:'global-database',env:{TOKEN:'inventory-secret'}},{name:'project.server'}]));}else{let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{const file=args[args.indexOf('--output-last-message')+1];const mode=args.some(arg=>arg.includes('feedback_write_'))?'workspace-write':'read-only';fs.writeFileSync(mode+'.json',JSON.stringify({args,prompt,token:process.env.NODE_AUTH_TOKEN,database:process.env.DATABASE_URL,startup:process.env.BASH_ENV,node:process.env.NODE_OPTIONS}));fs.writeFileSync(file,mode==='read-only'?JSON.stringify({approved:true,reason:'Synthetic review',releaseNote:'Saving works again.'}):'Prepared');});}\n`);
      await chmod(executable, 0o700);
      vi.stubEnv("NODE_AUTH_TOKEN", "synthetic-package-token");
      vi.stubEnv("DATABASE_URL", "synthetic-private-database");
      vi.stubEnv("BASH_ENV", "/private/credential-loader");
      vi.stubEnv("NODE_OPTIONS", "--require=/private/credential-loader");
      const adapter = new LocalCodexTaskAdapter({ executable });
      const input = { claim, checkout: { path: root, baseSha: "a".repeat(40) }, signal: new AbortController().signal };
      await adapter.implement(input);
      await expect(adapter.review({ ...input, changedPaths: ["src/save.ts"] })).resolves.toMatchObject({ approved: true });
      for (const mode of ["workspace-write", "read-only"]) {
        const result = JSON.parse(await readFile(join(root, `${mode}.json`), "utf8"));
        expect(result.token).toBeUndefined();
        expect(result.database).toBeUndefined();
        expect(result.startup).toBeUndefined();
        expect(result.node).toBeUndefined();
        expect(result.args).toEqual(expect.arrayContaining([
          "--ignore-user-config", "--ignore-rules", "--strict-config", "apps", "hooks", "remote_plugin", "shell_snapshot",
          "approval_policy=\"never\"", "allow_login_shell=false", "shell_environment_policy.inherit=\"none\"",
          "plugins", "computer_use", "browser_use", "in_app_browser", "image_generation", "workspace_dependencies", "multi_agent",
          "mcp_servers.\"global-database\".enabled=false", "mcp_servers.\"project.server\".enabled=false",
        ]));
        expect(result.args).not.toContain("--sandbox");
        expect(JSON.stringify(result.args)).toContain(":minimal");
        expect(JSON.stringify(result.args)).toContain("deny");
        expect(JSON.stringify(result.args)).not.toContain("inventory-secret");
        expect(result.prompt).toContain("untrusted");
      }
      const prepared = JSON.parse(await readFile(join(root, "workspace-write.json"), "utf8"));
      expect(prepared.prompt).toContain("leave the focused change uncommitted");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("starts no model task if the MCP inventory cannot be checked", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-codex-inventory-fail-"));
    try {
      const executable = join(root, "codex-fixture");
      await writeFile(executable, `#!${process.execPath}\nif(process.argv[2]==='--version'){process.stdout.write('codex-cli 0.144.6');}else if(process.argv[2]==='mcp'){process.stdout.write('invalid inventory');}else{require('fs').writeFileSync('model-started','yes');}\n`);
      await chmod(executable, 0o700);
      const adapter = new LocalCodexTaskAdapter({ executable });
      await expect(adapter.implement({ claim, checkout: { path: root, baseSha: "a".repeat(40) }, signal: new AbortController().signal }))
        .rejects.toThrow("Could not verify Codex version and disabled MCP configuration");
      await expect(readFile(join(root, "model-started"))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("starts no model task on a CLI predating the verified permission profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-codex-version-fail-"));
    try {
      const executable = join(root, "codex-fixture");
      await writeFile(executable, `#!${process.execPath}\nif(process.argv[2]==='--version'){process.stdout.write('codex-cli 0.137.0');}else{require('fs').writeFileSync('model-started','yes');}\n`);
      await chmod(executable, 0o700);
      await expect(new LocalCodexTaskAdapter({ executable }).implement({ claim,
        checkout: { path: root, baseSha: "a".repeat(40) }, signal: new AbortController().signal }))
        .rejects.toThrow("Could not verify Codex version and disabled MCP configuration");
      await expect(readFile(join(root, "model-started"))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a model-created ignored dependency directory before validation or snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-codex-spoofed-deps-"));
    try {
      const executable = join(root, "codex-fixture");
      await writeFile(executable, `#!${process.execPath}\nconst fs=require('fs'),args=process.argv.slice(2);if(args[0]==='--version'){process.stdout.write('codex-cli 0.144.6');}else if(args[0]==='mcp'){process.stdout.write('[]');}else{fs.mkdirSync('ignored-app/node_modules',{recursive:true});fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'Prepared');}\n`);
      await chmod(executable, 0o700);
      await expect(new LocalCodexTaskAdapter({ executable }).implement({ claim,
        checkout: { path: root, baseSha: "a".repeat(40) }, signal: new AbortController().signal }))
        .rejects.toThrow("changed isolated dependency directories");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
