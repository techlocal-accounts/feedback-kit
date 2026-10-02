import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const script = join(process.cwd(), 'scripts', 'sync-vercel-package-reader.mjs');
const token = `ghp_${'a'.repeat(36)}`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'feedback-reader-test-'));
  const binaries = join(root, 'bin');
  mkdirSync(binaries);
  mkdirSync(join(root, '.vercel'));
  writeFileSync(join(root, '.vercel', 'project.json'), JSON.stringify({
    projectId: 'prj_test123', orgId: 'team_test123', projectName: 'pilot',
  }));
  const keychainArgs = join(root, 'keychain-args');
  writeFileSync(join(binaries, 'security'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${keychainArgs}'\nprintf '%s\\n' '${token}'\n`, { mode: 0o755 });
  writeFileSync(join(binaries, 'vercel'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = process.env.MOCK_VERCEL_STATE;
if (args[0] !== 'env') process.exit(2);
if (args[1] === 'add') fs.writeFileSync(state, fs.readFileSync(0, 'utf8'));
else if (args[1] === 'pull') fs.writeFileSync(args[2], 'NODE_AUTH_TOKEN=' + JSON.stringify(process.env.MOCK_STALE ? '' : fs.readFileSync(state, 'utf8')) + '\\n');
else process.exit(2);
`, { mode: 0o755 });
  const state = join(root, 'saved-token');
  const run = (extra = [], environment = {}) => spawnSync(process.execPath, [
    script, '--root', root, '--project', 'pilot', '--scope', 'team',
    '--environment', 'preview', '--branch', 'codex/pilot', ...extra,
  ], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, ...environment, PATH: `${binaries}:${process.env.PATH}`, MOCK_VERCEL_STATE: state },
  });
  const selectedReader = ['--keychain-service', 'example-feedback-reader', '--keychain-account', 'example-registry-user'];
  return { root, state, keychainArgs, run, selectedReader, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('copies the exact newline-free reader into the linked preview project', () => {
  const f = fixture();
  try {
    const result = f.run(f.selectedReader);
    expect(result.status).toBe(0);
    expect(readFileSync(f.state, 'utf8')).toBe(token);
    expect(result.stdout).toContain('Verified package reader for pilot');
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(readFileSync(f.keychainArgs, 'utf8').split('\n')).toEqual([
      'find-generic-password', '-w', '-s', 'example-feedback-reader', '-a', 'example-registry-user', '',
    ]);
  } finally { f.close(); }
});

test('refuses a mismatched linked project before touching Vercel', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, '.vercel', 'project.json'), JSON.stringify({
      projectId: 'prj_test123', orgId: 'team_test123', projectName: 'someone-else',
    }));
    const result = f.run(f.selectedReader);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('does not match');
    expect(() => readFileSync(f.state)).toThrow();
  } finally { f.close(); }
});

test('fails closed when Vercel returns a different saved value', () => {
  const f = fixture();
  try {
    const result = f.run(f.selectedReader, { MOCK_STALE: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not be verified');
    expect(result.stdout + result.stderr).not.toContain(token);
  } finally { f.close(); }
});

test('requires an explicit Keychain service and account before reading credentials', () => {
  const f = fixture();
  try {
    for (const args of [[], ['--keychain-service', 'example-feedback-reader'], ['--keychain-account', 'example-registry-user']]) {
      const result = f.run(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--keychain-service');
      expect(() => readFileSync(f.keychainArgs)).toThrow();
      expect(() => readFileSync(f.state)).toThrow();
    }
  } finally { f.close(); }
});
