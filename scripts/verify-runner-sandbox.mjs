import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { CommandValidationAdapter, createFeedbackPermissionConfig } from "../packages/feedback-runner/dist/index.js";

const options = process.argv.slice(2);
if (options.length && (options.length !== 2 || options[0] !== "--pnpm" || !isAbsolute(options[1]))) {
  throw new Error("Usage: node scripts/verify-runner-sandbox.mjs [--pnpm /absolute/installed/pnpm]");
}
const installedPnpm = options[1];
if (process.platform !== "darwin") throw new Error("The feedback sandbox probe requires macOS");
const root = realpathSync(mkdtempSync(join(tmpdir(), "feedback-permission-probe-")));
const workspace = join(root, "repo");
const metadata = join(root, "control.git");
const outside = join(root, "outside");
for (const path of [workspace, metadata, outside]) mkdirSync(path);
writeFileSync(join(workspace, "safe.txt"), "synthetic safe fixture");
writeFileSync(join(workspace, ".env.local"), "synthetic fixture");
writeFileSync(join(workspace, ".git"), `gitdir: ${metadata}\n`);
writeFileSync(join(metadata, "config"), "synthetic isolated metadata");
writeFileSync(join(outside, "credential.txt"), "synthetic fixture");
mkdirSync(join(workspace, "node_modules"));
writeFileSync(join(workspace, "node_modules", "fixture.txt"), "synthetic dependency");
const service = `feedback-kit.runner.probe.${randomUUID()}`;
const account = "synthetic-feedback-probe";
let itemCreated = false;
function inlineToml(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}=${inlineToml(entry)}`).join(",")}}`;
}
try {
  execFileSync("/usr/bin/security", ["add-generic-password", "-a", account, "-s", service, "-w",
    "synthetic-feedback-probe-not-a-secret", "-T", "/usr/bin/security"], { stdio: "ignore" });
  itemCreated = true;
  const probe = join(workspace, "probe.cjs");
  writeFileSync(probe, `const fs=require('fs'),{spawnSync}=require('child_process');
const denied=(path,flags='r')=>{try{const fd=fs.openSync(path,flags);fs.closeSync(fd);return false;}catch(error){return ['EACCES','EPERM'].includes(error.code);}};
const keychain=spawnSync('/usr/bin/security',${JSON.stringify(["find-generic-password", "-a", account, "-s", service, "-w"])},{stdio:'ignore'});
const evidence={safeRead:fs.readFileSync('safe.txt','utf8')==='synthetic safe fixture',
externalCredentialDenied:denied(${JSON.stringify(join(outside, "credential.txt"))}),
workspaceEnvDenied:denied(${JSON.stringify(join(workspace, ".env.local"))}),
codexAuthDenied:denied(${JSON.stringify(join(homedir(), ".codex", "auth.json"))}),
keychainDenied:keychain.status!==0,
metadataRead:fs.readFileSync(${JSON.stringify(join(metadata, "config"))},'utf8')==='synthetic isolated metadata',
metadataWriteDenied:denied(${JSON.stringify(join(metadata, "config"))},'r+'),
dependencyWriteDenied:denied(${JSON.stringify(join(workspace, "node_modules", "fixture.txt"))},'r+')};
evidence.dependencyRead=fs.readFileSync('node_modules/fixture.txt','utf8')==='synthetic dependency';
try{fs.writeFileSync('allowed-write','yes');evidence.workspaceWrite=true;}catch{evidence.workspaceWrite=false;}
if(process.argv[2]==='validation')fs.writeFileSync('validation-evidence.json',JSON.stringify(evidence));else process.stdout.write(JSON.stringify(evidence));`);
  const evidence = {};
  for (const access of ["write", "read"]) {
    const config = createFeedbackPermissionConfig({ checkoutPath: workspace, access, readOnlyPaths: [metadata] });
    const args = ["sandbox", "--permission-profile", config.default_permissions, "--include-managed-config", "--cd", workspace,
      "-c", `permissions.${config.default_permissions}=${inlineToml(config.permissions[config.default_permissions])}`,
      process.execPath, probe];
    const output = execFileSync("codex", args, { cwd: workspace, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, OPENSSL_CONF: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] });
    evidence[access] = JSON.parse(output);
    if (Object.entries(evidence[access]).some(([key, value]) => value !== (key === "workspaceWrite" ? access === "write" : true))) {
      throw new Error("Feedback sandbox read or write boundary was not enforced");
    }
  }
  const validation = new CommandValidationAdapter({ install: [],
    focused: [{ argv: [process.execPath, probe, "validation"] }], shared: [] });
  await validation.focused({ path: workspace, baseSha: "a".repeat(40) }, [], new AbortController().signal);
  evidence.validation = JSON.parse(readFileSync(join(workspace, "validation-evidence.json"), "utf8"));
  if (Object.values(evidence.validation).some(value => value !== true)) throw new Error("Validation sandbox isolation failed");
  const spoof = new CommandValidationAdapter({ install: [], focused: [{ argv: [process.execPath, "-e",
    "require('fs').mkdirSync('spoof-app/node_modules',{recursive:true})"] }], shared: [] });
  try {
    await spoof.focused({ path: workspace, baseSha: "a".repeat(40) }, [], new AbortController().signal);
    throw new Error("Validation accepted a newly spoofed dependency directory");
  } catch (error) {
    if (!error.message.includes("changed isolated dependency directories")) throw error;
    evidence.validationRejectsSpoofedDependencies = true;
    rmSync(join(workspace,"spoof-app"),{recursive:true,force:true});
  }
  if (installedPnpm) {
    const shim = join(workspace, "shadow-shim");
    mkdirSync(shim);
    writeFileSync(join(shim, "pnpm"), "#!/bin/sh\nexit 99\n", {mode:0o700});
    writeFileSync(join(workspace, "package.json"), JSON.stringify({private:true,
      scripts:{"feedback:probe":"node package-manager-probe.cjs"}}));
    writeFileSync(join(workspace, "package-manager-probe.cjs"), `const fs=require('fs');
      const tools=process.env.PATH.split(':').find(path=>path.includes('feedback-validation-codex-')&&path.endsWith('/bin'));
      let aliasWriteDenied=false;
      try{fs.writeFileSync(require('path').join(tools,'unexpected-tool'),'no');}catch(error){aliasWriteDenied=['EACCES','EPERM'].includes(error.code);}
      fs.writeFileSync('manager-evidence.json',JSON.stringify({
      offline:process.env.COREPACK_ENABLE_NETWORK==='0',credentialAbsent:!process.env.NODE_AUTH_TOKEN,
      shadowShimBypassed:!process.env.PATH.includes('shadow-shim'),aliasWriteDenied}));`);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${shim}:${previousPath ?? ""}`;
      const manager = new CommandValidationAdapter({install:[],
        focused:[{argv:["pnpm","run","feedback:probe"]}], shared:[],
        packageManagerExecutables:{pnpm:installedPnpm}});
      await manager.focused({path:workspace,baseSha:"a".repeat(40)},[],new AbortController().signal);
      evidence.installedPackageManager = JSON.parse(readFileSync(join(workspace,"manager-evidence.json"),"utf8"));
      if (Object.values(evidence.installedPackageManager).some(value => value !== true)) throw new Error("Installed package-manager proof failed");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  if (itemCreated) execFileSync("/usr/bin/security", ["delete-generic-password", "-a", account, "-s", service], { stdio: "ignore" });
  rmSync(root, { recursive: true, force: true });
}
