#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/check-package-contents.mjs <tarball-directory>');
const root = process.cwd();
const license = readFileSync(join(root, 'LICENSE'), 'utf8');
const names = ['feedback-core', 'feedback-web', 'feedback-runner'];
const packages = names.map(name => JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8')));
const files = readdirSync(directory).filter(file => file.endsWith('.tgz'));
if (files.length !== packages.length) throw new Error('Expected exactly the three scoped release tarballs');
const credentialPatterns = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:sk_live_|sk-proj-|sk-ant-)[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /(?:https?|postgres(?:ql)?|mongodb(?:\+srv)?|redis):\/\/[^\s/@:"'<>]+:[^\s/@"'<>]+@/,
];
const seen = new Set();
for (const file of files) {
  const archive = resolve(directory, file);
  const entries = execFileSync('tar', ['-tzf', archive], {encoding: 'utf8'}).trim().split('\n');
  const modes = execFileSync('tar', ['-tvzf', archive], {encoding: 'utf8'}).trim().split('\n');
  if (new Set(entries).size !== entries.length || modes.some(line => !line.startsWith('-'))) {
    throw new Error('Package entries must be unique regular files');
  }
  if (entries.some(entry => !/^package\/(?:package\.json|README\.md|LICENSE|dist\/[A-Za-z0-9_-]+\.(?:d\.ts|js))$/.test(entry))) {
    throw new Error('Unexpected packaged file; no package contents were printed');
  }
  const contents = new Map(entries.map(entry => [entry,
    execFileSync('tar', ['-xOf', archive, entry], {encoding: 'utf8'})]));
  for (const text of contents.values()) {
    if (credentialPatterns.some(pattern => pattern.test(text))) throw new Error('Credential-pattern match; no value was printed');
  }
  const manifest = JSON.parse(contents.get('package/package.json'));
  const expected = packages.find(candidate => candidate.name === manifest.name);
  if (!expected || seen.has(manifest.name) || manifest.version !== expected.version || manifest.license !== 'MIT') {
    throw new Error('Unexpected package identity, version or license');
  }
  if (contents.get('package/LICENSE') !== license) throw new Error('Packaged MIT license differs from the project license');
  if (manifest.publishConfig?.registry !== 'https://registry.npmjs.org' || manifest.publishConfig?.access !== 'public') {
    throw new Error('Package publication configuration is not the approved npm registry/public access');
  }
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    const workspacePackage = packages.find(candidate => candidate.name === name);
    if (workspacePackage && version !== workspacePackage.version) throw new Error('Workspace dependency was not rewritten to its release version');
    if (String(version).startsWith('workspace:')) throw new Error('Unresolved workspace dependency in tarball');
  }
  seen.add(manifest.name);
  console.log(`PASS ${manifest.name}@${manifest.version}: ${entries.length} allowed files, MIT license, resolved dependencies, no credential-pattern matches`);
}
