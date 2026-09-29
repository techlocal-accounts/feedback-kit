#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const root = resolve(argument('--root') ?? process.cwd());
const project = argument('--project');
const scope = argument('--scope');
const environment = argument('--environment');
const branch = argument('--branch');

if (!project || !scope || !['production', 'preview', 'development'].includes(environment)
  || (branch && environment !== 'preview')) {
  console.error('Usage: sync-vercel-package-reader --root <linked repo> --project <name> --scope <team> --environment <production|preview|development> [--branch <preview branch>]');
  process.exit(2);
}

const linkPath = join(root, '.vercel', 'project.json');
if (!existsSync(linkPath)) {
  console.error('The repository must already be linked to the intended Vercel project.');
  process.exit(2);
}

let link;
try {
  link = JSON.parse(readFileSync(linkPath, 'utf8'));
} catch {
  console.error('The Vercel project link is invalid.');
  process.exit(2);
}
if (link.projectName !== project || !/^prj_[A-Za-z0-9]+$/.test(link.projectId ?? '')
  || !/^team_[A-Za-z0-9]+$/.test(link.orgId ?? '')) {
  console.error('The linked Vercel project does not match --project.');
  process.exit(2);
}

let token;
try {
  token = execFileSync('security', [
    'find-generic-password', '-w', '-s', 'techlocal-feedback-kit-read',
    '-a', 'techlocal-accounts',
  ], { encoding: 'utf8' }).trim();
} catch {
  console.error('The approved package reader is unavailable in Keychain.');
  process.exit(1);
}
if (!/^ghp_[A-Za-z0-9_]{20,200}$/.test(token)) {
  console.error('The Keychain package reader has an unexpected format.');
  process.exit(1);
}

const baseArgs = ['--scope', scope];
const add = spawnSync('vercel', [
  'env', 'add', 'NODE_AUTH_TOKEN', environment,
  ...(branch ? [branch] : []), '--force', '--yes', ...baseArgs,
], { cwd: root, input: token, encoding: 'utf8' });
if (add.error || add.status !== 0) {
  console.error('Vercel rejected the package-reader update.');
  process.exit(1);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'feedback-vercel-reader-'));
try {
  const destination = join(temporaryDirectory, 'pulled.env');
  const pull = spawnSync('vercel', [
    'env', 'pull', destination, '--environment', environment,
    ...(branch ? ['--git-branch', branch] : []), '--yes', ...baseArgs,
  ], { cwd: root, encoding: 'utf8' });
  if (pull.error || pull.status !== 0) throw new Error('pull failed');

  const line = readFileSync(destination, 'utf8').split('\n')
    .find((candidate) => candidate.startsWith('NODE_AUTH_TOKEN='));
  const saved = line ? JSON.parse(line.slice('NODE_AUTH_TOKEN='.length)) : '';
  const expectedBytes = Buffer.from(token);
  const savedBytes = Buffer.from(saved);
  if (expectedBytes.length !== savedBytes.length
    || !timingSafeEqual(expectedBytes, savedBytes)) throw new Error('value differs');
  console.log(`Verified package reader for ${project} (${environment}${branch ? `: ${branch}` : ''}).`);
} catch {
  console.error('The Vercel package reader could not be verified against Keychain.');
  process.exitCode = 1;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
