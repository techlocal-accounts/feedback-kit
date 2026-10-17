// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandValidationAdapter } from "./validation.js";

afterEach(() => vi.unstubAllEnvs());

describe("parent dependency preparation", () => {
  it("rejects unpinned package-manager commands before looking up credentials", () => {
    for (const phase of ["install", "prepare", "focused", "shared"]) {
      const argv = phase === "install" ? ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"] : ["pnpm", "test"];
      expect(() => new CommandValidationAdapter({ install: [], focused: [], shared: [],
        [phase]: [{ argv: argv as [string, ...string[]] }],
      })).toThrow("absolute installed executable");
    }
  });

  it("rejects a relative package-manager pin", () => {
    expect(() => new CommandValidationAdapter({ install: [], focused: [], shared: [],
      packageManagerExecutables: { pnpm: "./pnpm" },
    })).toThrow("absolute installed executable");
  });

  it("uses the parent's installed manager with a shim first on PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-manager-pin-"));
    try {
      const manager = join(root, "pnpm");
      await writeFile(manager, `#!${process.execPath}\nrequire('fs').appendFileSync('manager.jsonl',JSON.stringify({argv:process.argv.slice(2),path:process.env.PATH,network:process.env.COREPACK_ENABLE_NETWORK,token:process.env.NODE_AUTH_TOKEN})+'\\n');`);
      await chmod(manager, 0o700);
      const sandbox = join(root, "codex-fixture");
      await writeFile(sandbox, `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='--version')process.stdout.write('codex-cli 0.162.0');else{const i=a.lastIndexOf('-c')+2;process.exit(require('child_process').spawnSync(a[i],a.slice(i+1),{stdio:'inherit'}).status??1);}`);
      await chmod(sandbox, 0o700);
      vi.stubEnv("PATH", `/unavailable-corepack-shim:${process.env.PATH}`);
      const check = {argv: ["pnpm", "test"] as const};
      const adapter = new CommandValidationAdapter({ install: [], prepare: [check], focused: [check], shared: [check],
        packageManagerExecutables: { pnpm: manager }, sandboxExecutable: sandbox });
      const checkout = {path: root, baseSha: "a".repeat(40)}, signal = new AbortController().signal;
      await adapter.prepare(checkout, signal); await adapter.focused(checkout, [], signal); await adapter.shared(checkout, signal);
      const rows = (await readFile(join(root, "manager.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(rows).toHaveLength(3);
      for (const row of rows) { expect(row.argv).toEqual(["test"]); expect(row.path).toContain("feedback-validation-codex-"); expect(row.path).not.toContain("unavailable-corepack-shim");
        expect(row.network).toBe("0"); expect(row.token).toBeUndefined(); }
    } finally { await rm(root, {recursive:true,force:true}); }
  });

  it.each(["pnpm","pnpm.cjs"])("gives the read token only to a locked script-disabled installer (%s)", async (executableName) => {
    const root = await mkdtemp(join(tmpdir(), "feedback-install-test-"));
    try {
      const installer = join(root, executableName);
      await writeFile(installer, `#!${process.execPath}\nconst {writeFileSync}=require('node:fs');\nwriteFileSync('install.json', JSON.stringify({token:process.env.NODE_AUTH_TOKEN, provider:process.env.OPENAI_API_KEY, queue:process.env.DATABASE_URL, ignore:process.env.npm_config_ignore_scripts, hooksDisabled:process.argv.includes('--ignore-pnpmfile')}));\n`);
      await chmod(installer, 0o700);
      const sandboxExecutable = join(root, "codex-fixture");
      await writeFile(sandboxExecutable, `#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==='--version'){process.stdout.write('codex-cli 0.144.6');}else{require('fs').appendFileSync('sandbox.jsonl',JSON.stringify(args)+'\\n');const index=args.lastIndexOf('-c')+2;const result=require('child_process').spawnSync(args[index],args.slice(index+1),{stdio:'inherit'});process.exit(result.status??1);}\n`);
      await chmod(sandboxExecutable, 0o700);
      vi.stubEnv("NODE_AUTH_TOKEN", "inherited-token-must-not-leak");
      vi.stubEnv("OPENAI_API_KEY", "provider-must-not-leak");
      vi.stubEnv("DATABASE_URL", "queue-must-not-leak");
      const token = vi.fn(async () => "synthetic-package-read-token");
      const cleanCommand = (file: string) => ({ argv: [process.execPath, "-e",
        `require('fs').writeFileSync('${file}', JSON.stringify({token:process.env.NODE_AUTH_TOKEN, provider:process.env.OPENAI_API_KEY, queue:process.env.DATABASE_URL,tmp:process.env.TMPDIR,home:process.env.HOME,output:process.env.FEEDBACK_VALIDATION_OUTPUT_DIR,browserTargets:process.env.BROWSERSLIST_CONFIG}))`] as const });
      const adapter = new CommandValidationAdapter({
        install: [{ argv: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"] }],
        packageManagerExecutables: { pnpm: installer },
        prepare: [cleanCommand("prepare.json")], focused: [cleanCommand("focused.json")], shared: [cleanCommand("shared.json")],
        packageReadToken: token,
        sandboxExecutable,
      });
      const checkout = { path: root, baseSha: "a".repeat(40) };
      await adapter.prepare(checkout, new AbortController().signal);
      await adapter.focused(checkout, [], new AbortController().signal);
      await adapter.shared(checkout, new AbortController().signal);
      expect(token).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(join(root, "install.json"), "utf8"))).toEqual({ token: "synthetic-package-read-token", ignore: "true", hooksDisabled: true });
      for (const file of ["prepare.json", "focused.json", "shared.json"]) {
        const recorded=JSON.parse(await readFile(join(root, file), "utf8"));
        expect(recorded.token).toBeUndefined();expect(recorded.provider).toBeUndefined();expect(recorded.queue).toBeUndefined();
        expect(recorded.tmp.startsWith(root)).toBe(false);
        expect(recorded.home).toBe(recorded.tmp);
        expect(recorded.output).toBe(join(recorded.tmp,"build-output"));
        expect(recorded.browserTargets).toBe(join(recorded.tmp,"browserslist-config"));
        await expect(readFile(recorded.browserTargets)).rejects.toMatchObject({code:"ENOENT"});
      }
      const sandboxCalls = (await readFile(join(root, "sandbox.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(sandboxCalls).toHaveLength(3);
      for (const args of sandboxCalls) {
        expect(args).toEqual(expect.arrayContaining(["sandbox", "--permission-profile", "--include-managed-config"]));
        expect(args.join(" ")).toContain(":minimal");
        expect(args.join(" ")).toContain("node_modules");
        expect(args.join(" ")).not.toContain("synthetic-package-read-token");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects validation directories outside the isolated checkout", async()=>{
    const root=await mkdtemp(join(tmpdir(),"validation-cwd-test-"));
    try {
      const adapter=new CommandValidationAdapter({install:[],focused:[{cwd:"../",argv:[process.execPath,"-e","process.exit(0)"]}],shared:[]});
      await expect(adapter.focused({path:root,baseSha:"a".repeat(40)},[],new AbortController().signal)).rejects.toThrow("escapes checkout");
    } finally {await rm(root,{recursive:true,force:true});}
  });

  it.each([
    ["pnpm", "install", "--frozen-lockfile"],
    ["bun", "install", "--ignore-scripts"],
    ["npm", "install", "--ignore-scripts"],
    ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--config.ignore-scripts=false"],
  ])("rejects mutable or script-running dependency command %j", (...argv) => {
    expect(() => new CommandValidationAdapter({ install: [{ argv: argv as [string, ...string[]] }], focused: [], shared: [] }))
      .toThrow("--ignore-scripts");
  });

  it("does not echo installer diagnostics containing a credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-install-fail-"));
    try {
      const installer = join(root, "bun");
      await writeFile(installer, `#!${process.execPath}\nprocess.stderr.write(process.env.NODE_AUTH_TOKEN);process.exit(1);\n`);
      await chmod(installer, 0o700);
      const adapter = new CommandValidationAdapter({
        install: [{ argv: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"] }],
        packageManagerExecutables: { pnpm: installer }, focused: [], shared: [],
        packageReadToken: async () => "synthetic-secret-not-for-diagnostics",
      });
      await expect(adapter.prepare({ path: root, baseSha: "a".repeat(40) }, new AbortController().signal))
        .rejects.toThrow("Dependency installation failed; no Codex task started");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["NODE_AUTH_TOKEN", "DATABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NODE_OPTIONS", "CODEX_HOME", "OPENSSL_CONF"])(
    "does not accept %s through the safe validation environment", key => {
      expect(() => new CommandValidationAdapter({ install: [], focused: [], shared: [], safeEnvironment: { [key]: "synthetic" } }))
        .toThrow("Unsafe validation environment key");
    });
});
